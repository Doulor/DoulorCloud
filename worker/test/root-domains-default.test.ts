/**
 * 默认根域绝不能是「带权限」的域（2026-10-04 越权注册修复）。
 *
 * 复现场景：管理员把 doulor.cn 设成默认域（is_default=1），或 root_domains 表为空
 * 回落 env.ROOT_DOMAIN（doulor.cn）。注册、临时邮箱、未指定域的邮箱别名都会走
 * `getDefaultRootDomain()`，而它原先**不看 requires_feature** —— 于是任何没解锁
 * `doulor` 权限的人都能白拿一个 @doulor.cn 地址（还能收信，被拿去当注册机邮箱）。
 *
 * 修复：getDefaultRootDomain 跳过带 `requires_feature` 的域，回落到真正「人人可用」
 * 的域（tyu.me）。本文件守住两条线：
 *   1. 即使 doulor.cn 是 is_default，默认域也落到免权限的 tyu.me；
 *   2. 端到端注册出的主邮箱落在 @tyu.me，而不是 @doulor.cn。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { fetchSelf } from "./helpers"
import { getDefaultRootDomain, resetRootDomainCache } from "../src/root-domains"

async function seedRootDomains() {
  const now = new Date().toISOString()
  await env.DB.batch([
    // doulor.cn：故意设成默认 + 挂 doulor 权限（修复后不应再被当默认发出去）
    env.DB.prepare(
      `INSERT INTO root_domains (name, zone_id, label, requires_feature, is_default, enabled, created_at)
       VALUES ('doulor.cn', NULL, NULL, 'doulor', 1, 1, ?)`
    ).bind(now),
    // tyu.me：免权限、非默认
    env.DB.prepare(
      `INSERT INTO root_domains (name, zone_id, label, requires_feature, is_default, enabled, created_at)
       VALUES ('tyu.me', NULL, NULL, NULL, 0, 1, ?)`
    ).bind(now),
  ])
  resetRootDomainCache()
}

async function makeInvite(code: string) {
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, max_uses, used_count, permissions, created_at) VALUES (?, ?, 1, 0, ?, ?)"
  )
    .bind(
      uuid(),
      code,
      // 显式不带 doulor：普通邀请码
      JSON.stringify({ r2: true, ai: true, frp: true, proxy: true }),
      new Date().toISOString()
    )
    .run()
}

describe("默认根域不得带权限", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM root_domains").run()
    resetRootDomainCache()
  })

  it("doulor.cn 是 is_default 时，getDefaultRootDomain 仍回落 tyu.me", async () => {
    await seedRootDomains()
    const def = await getDefaultRootDomain(env)
    expect(def.name).toBe("tyu.me")
  })

  it("端到端注册：主邮箱落在 @tyu.me，而不是 @doulor.cn", async () => {
    await seedRootDomains()
    const code = `inv_${uuid().slice(0, 8)}`
    await makeInvite(code)

    const username = `zeph-${uuid().slice(0, 8)}`
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": `1.2.3.${Math.floor(Math.random() * 200) + 1}` },
        body: JSON.stringify({
          username,
          email: `real_${username}@example.com`,
          password: "pass12345",
          inviteCode: code,
        }),
      })
    )
    expect(res.status).toBe(201)

    const mailbox = await env.DB.prepare(
      "SELECT address FROM mailboxes WHERE address LIKE ? ORDER BY created_at ASC LIMIT 1"
    )
      .bind(`${username}@%`)
      .first<{ address: string }>()
    expect(mailbox?.address).toBe(`${username}@tyu.me`)
  })

  it("表为空时回落主域 doulor.cn（历史行为，非本次修复目标，但记录以防回归误判）", async () => {
    // 不 seed，表空 → fallbackRow = doulor.cn。这里只是固化现状，避免有人
    // 把「空表回落」误当成「doulor.cn 白送」的回归。
    const def = await getDefaultRootDomain(env)
    expect(def.name).toBe("doulor.cn")
  })
})
