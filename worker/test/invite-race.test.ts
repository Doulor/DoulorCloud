/**
 * 回归测试：邀请码在**并发注册**下不能被超额使用（2026-09-25 审计 P0-5）。
 *
 * 漏洞原貌：
 *   原实现把「条件消费邀请码」和 5 条 INSERT 放进**同一个 D1 batch**，
 *   然后在 batch **之后**检查 `results[0].meta.changes === 0`，注释写着
 *   「整个 batch 已回滚」。但 D1 的 batch() 只在语句**抛错**时回滚 ——
 *   条件 UPDATE 影响 0 行是**成功**（`changes: 0`），不是错误。
 *
 *   于是并发打同一个码时：第 1 个请求的 batch 正常提交（used_count=1、建号），
 *   第 2 个请求的 batch 里 UPDATE 命中 0 行但 5 条 INSERT 照样提交 ——
 *   用户已经建好、密码由攻击者所设，代码随后才抛 400。
 *   结果：一个 max_uses=1 的邀请码可以并发注册出任意多个账号，
 *   每个还附带该码里的模块权限（r2/ai/frp/proxy）、子域名、邮箱与 Email Routing 规则。
 *
 * 这个测试之所以必须存在：它是**唯一**能证明「条件消费真的生效」的手段。
 * 单线程调用永远看不出问题（顺序执行时 used_count 已经 +1，UPDATE 自然命中 0 行）。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { fetchSelf } from "./helpers"

/** 直接插一个邀请码（绕过管理接口，避免依赖权限） */
async function makeInvite(maxUses: number, code: string): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, max_uses, used_count, created_at) VALUES (?, ?, ?, 0, ?)"
  )
    .bind(uuid(), code, maxUses, new Date().toISOString())
    .run()
  return code
}

function registerRequest(
  username: string,
  email: string,
  inviteCode: string,
  ip: string
): Request {
  return new Request("https://cloud.doulor.cn/api/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 每个请求给不同 IP，避免撞上注册接口 60 次/小时/IP 的限流
      // （限流是另一层防护，不应干扰本测试要验证的「邀请码原子消费」）
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ username, email, password: "pass12345", inviteCode }),
  })
}

async function countUsersLike(prefix: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE username LIKE ?"
  )
    .bind(`${prefix}%`)
    .first<{ c: number }>()
  return row?.c ?? 0
}

async function usedCount(code: string): Promise<number> {
  const row = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
    .bind(code)
    .first<{ used_count: number }>()
  return row?.used_count ?? -1
}

/**
 * 断言「邀请码并发消费」的安全不变量。
 *
 * 为什么不直接断言「成功数 == max_uses」：并发跑 5–6 个注册时，每个请求都要做
 * PBKDF2 10 万轮哈希，在整仓测试并行执行、CPU 争抢的情况下偶发瞬时 500
 * （与邀请码逻辑无关）。用 HTTP 状态码计数就会因此变成 flaky。
 *
 * 真正要守住的是这三条不变量，它们**恰好也是旧实现会违反的**：
 *   1. 建号数 ≤ max_uses  —— 旧实现下 max_uses=1 会建出 5 个账号；
 *   2. 计数用量 ≤ max_uses；
 *   3. **建号数 == 计数用量** —— 旧实现是「5 个账号、used_count 只有 1」，
 *      这一条正是「额度被绕过」的直接证据。
 * 再加上「至少成功 1 个」证明接口本身可用。
 */
async function expectRaceInvariant(opts: {
  prefix: string
  code: string
  maxUses: number
  results: Response[]
}) {
  const created = await countUsersLike(opts.prefix)
  const used = await usedCount(opts.code)
  const ok = opts.results.filter((r) => r.status === 201).length

  // 1 + 2：任何情况下都不能超额
  expect(created).toBeLessThanOrEqual(opts.maxUses)
  expect(used).toBeLessThanOrEqual(opts.maxUses)
  // 3：每一个建出来的账号都必须恰好消耗一个邀请码额度
  expect(created).toBe(used)
  // 至少成功一个，说明接口与额度链路本身是通的
  expect(ok).toBeGreaterThanOrEqual(1)
  expect(ok).toBeLessThanOrEqual(opts.maxUses)

  // 被 400 拒绝的必须是「邀请码已被使用」，而不是别的偶然错误。
  // （2026-09-28：码是一次性的，失败原因已细分为
  //   INVALID_INVITE / INVITE_USED / INVITE_EXPIRED，并发抢码落在 INVITE_USED。）
  for (const res of opts.results) {
    if (res.status === 400) {
      const body = (await res.json()) as { code?: string }
      expect(["INVITE_USED", "INVALID_INVITE"]).toContain(body.code)
    }
  }
}

describe("邀请码并发消费", () => {
  it("max_uses=1 时，5 个并发注册不能建出多于 1 个账号", async () => {
    const code = await makeInvite(1, `RACE1-${uuid().slice(0, 8)}`)
    const prefix = `race1u${uuid().slice(0, 6)}`

    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        fetchSelf(
          registerRequest(
            `${prefix}${i}`,
            `${prefix}${i}@example.com`,
            code,
            `10.0.1.${i + 1}`
          )
        )
      )
    )

    await expectRaceInvariant({ prefix, code, maxUses: 1, results })
  })

  it("max_uses=3 时，6 个并发注册不能建出多于 3 个账号", async () => {
    const code = await makeInvite(3, `RACE3-${uuid().slice(0, 8)}`)
    const prefix = `race3u${uuid().slice(0, 6)}`

    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        fetchSelf(
          registerRequest(
            `${prefix}${i}`,
            `${prefix}${i}@example.com`,
            code,
            `10.0.2.${i + 1}`
          )
        )
      )
    )

    await expectRaceInvariant({ prefix, code, maxUses: 3, results })
  })

  it("并发失败者不会留下半成品账号（用户/子域名必须一致）", async () => {
    const code = await makeInvite(1, `RACEH-${uuid().slice(0, 8)}`)
    const prefix = `racehu${uuid().slice(0, 6)}`

    await Promise.all(
      [0, 1, 2].map((i) =>
        fetchSelf(
          registerRequest(
            `${prefix}${i}`,
            `${prefix}${i}@example.com`,
            code,
            `10.0.3.${i + 1}`
          )
        )
      )
    )

    // 建号数与子域名数必须一一对应：插入是事务性的，不该出现「有用户行没子域名」
    const users = await countUsersLike(prefix)
    const subs = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subdomains WHERE user_id IN (SELECT id FROM users WHERE username LIKE ?)"
    )
      .bind(`${prefix}%`)
      .first<{ c: number }>()
    expect(users).toBe(1)
    expect(subs?.c ?? 0).toBe(1)
  })
})
