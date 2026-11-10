// 2026-11-10 渗透测试 finding#2 的回归测试：登录「账号层」频控的别名绕过。
//
// 漏洞：`POST /api/login` 的账号维度限流按请求里 identifier 的**原始字符串**分桶，
// 而同一个账户有用户名 + 注册邮箱两个可登录标识（handler 里那条 SELECT 两者都认）。
// 于是攻击者可以先用用户名把账号桶打到 429，再改用该账户的注册邮箱接着试口令 ——
// 同一账户的口令尝试次数被放大（还能两个标识交替放大），per-account 限流被绕过。
// IP 层限流（30 次/15 分钟）本来就是按 IP 计数的，不受这个洞影响，本次也不动它。
//
// 修复后账号桶按**解析出的账户**计数（`login:uid:<id>`；查不到用户时退回原串桶），
// 本文件钉住的就是这条语义：
//   A. 用用户名连错 12 次，账号桶在阈值 10 处锁住（前 10 次 401，第 11 次起 429）；
//   B. 紧接着改用该账户的注册邮箱 + **正确口令**，仍然 429 RATE_LIMITED
//      —— 修复前这里是 200（邮箱是另一个新桶，而 IP 桶才用掉 12/30）；
//   C. 被锁的是这个账户，不是全局：另一个无关账户照常登录成功并拿到 session；
//   D. 兜底分支仍在：不存在的标识照样按原串限流（匿名者不能无限刷）。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, fetchSelf } from "./helpers"

/**
 * 本文件所有登录请求共用的测试 IP。
 *
 * 显式给一个而不是让 `clientIp()` 退化成 "unknown"：本仓测试文件是并行跑的、
 * 共享同一个本地 D1，用 "unknown" 就会和别的文件里走登录的用例共用
 * `login:ip:unknown` 这个桶（阈值 30），互相吃额度、随机变红。
 * 203.0.113.0/24 是 TEST-NET-3，不会指向任何真实主机。
 */
const TEST_IP = "203.0.113.42"

function loginRequest(identifier: string, password: string): Request {
  return new Request("https://cloud.doulor.cn/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": TEST_IP },
    body: JSON.stringify({ identifier, password }),
  })
}

/** 打一次 POST /api/login。走真实入口，超限才是「429 响应」而不是抛异常 */
async function postLogin(identifier: string, password: string): Promise<Response> {
  return fetchSelf(loginRequest(identifier, password))
}

async function codeOf(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return body.code
}

/**
 * 用**用户名**连发 12 次错误口令，返回每次的状态码。
 *
 * 12 次是有意的：账号阈值 10，所以前 10 次只是「口令错」，第 11、12 次才被账号桶拦下。
 * 这样一次循环同时证明了「口令错 → 401」与「账号桶锁 → 429」两件事。
 */
async function lockByUsername(username: string): Promise<number[]> {
  const statuses: number[] = []
  for (let i = 0; i < 12; i++) {
    statuses.push((await postLogin(username, `wrong-pass-${i}`)).status)
  }
  return statuses
}

/** 取该账户的注册邮箱（从库里读，不在这里复制一份 makeUser 的命名约定） */
async function emailOf(userId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>()
  expect(row?.email).toBeTruthy()
  return row!.email
}

/** 某个限流桶有没有计数行（判键名用：只看行是否存在，不看 count，窗口滚动也不影响结论） */
async function bucketRows(bucket: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate_limits WHERE bucket = ?")
    .bind(bucket)
    .first<{ c: number }>()
  return row?.c ?? 0
}

beforeEach(async () => {
  // 限流计数是全局表（IP 桶 + 账号桶都在这张表里），必须清干净：
  // 否则用例 A 打出来的锁会飘到用例 C —— 而 C 恰恰要求「另一个账户能正常登录」。
  // 清表也顺带把 IP 桶清零，所以每个用例的 30 次额度都是满的。
  await env.DB.prepare("DELETE FROM rate_limits").run()
})

describe("登录频控按账户计数（finding#2）", () => {
  it("用例 A：用户名连错 12 次 → 账号桶在阈值 10 处锁住", async () => {
    const u = await makeUser()
    const statuses = await lockByUsername(u.username)

    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(401))
    expect(statuses.slice(10)).toEqual([429, 429])
  })

  it("用例 B：账号被用户名锁住后，改用注册邮箱 + 正确口令仍然 429 RATE_LIMITED", async () => {
    const u = await makeUser()
    const email = await emailOf(u.id)
    expect(await lockByUsername(u.username)).toContain(429)

    // 换了标识，但仍是同一个账户 → 账号桶（login:uid:<id>）已满，照样被拒。
    // 修复前这里能拿到 200：邮箱在 identifier 桶里是个全新的桶，IP 桶也才 12/30。
    const res = await postLogin(email, "pass1234")
    expect(res.status).toBe(429)
    expect(await codeOf(res)).toBe("RATE_LIMITED")

    // 顺带钉住键名（旧键 → 新键）：12 次尝试全记在账户桶 `login:uid:<id>` 上，
    // 按原串分桶的 `login:id:<用户名>` 根本不该出现。
    expect(await bucketRows(`login:uid:${u.id}`)).toBe(1)
    expect(await bucketRows(`login:id:${u.username}`)).toBe(0)
    // 而且没有把邮箱这次尝试拆成第二个桶（同一个账户不该既算 uid 桶又算 identifier 桶）
    expect(await bucketRows(`login:id:${email}`)).toBe(0)
  })

  it("用例 C：锁的是这个账户，不是全局 —— 无关账户照常登录（200 + session）", async () => {
    const locked = await makeUser()
    const other = await makeUser()
    expect(await lockByUsername(locked.username)).toContain(429)

    const res = await postLogin(other.username, "pass1234")
    expect(res.status).toBe(200)
    expect(res.headers.get("Set-Cookie")).toContain("doulor_session=")
  })

  it("用例 D（兜底）：不存在的标识仍按原串限流，匿名者不能无限刷", async () => {
    const ghost = "no_such_account_20261110"
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      statuses.push((await postLogin(ghost, "whatever")).status)
    }
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(401))
    expect(statuses[10]).toBe(429)

    // 用户查不到 ⇒ 没有 uid 可用，退回 identifier 形式的桶（这次修复保留的兜底）
    expect(await bucketRows(`login:id:${ghost}`)).toBe(1)
  })
})
