/**
 * 登录 IP 记录 + 「IP 监管」同 IP 反查。
 *
 * 需求（2026-10-08 站长）：登录时记录来源 IP，管理端能一键查出
 * 「被多个不同账号共用的 IP」，用来发现小号 / 团伙。
 *
 * 本测试钉住的边界：
 *   1. `recordLoginIp` 对同一 (用户, IP) 是**去过重**的：一行 + times 累加，
 *      不是流水账（否则经常换节点的人会把表撑爆）；
 *   2. 反查只把**被 ≥2 个未封禁账号**共用的 IP 算作可疑；
 *   3. 已封禁的账号**不参与**（否则封一个号就永久制造噪音）；
 *   4. 同一人在同一 IP 上登 100 次也只算 1 个人；
 *   5. 空 IP 直接忽略，不落库。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, type TestUser } from "./helpers"
import { recordLoginIp, listSharedLoginIps } from "../src/login-ip"

/** 给用户塞一条 IP 记录（走真实入口，顺便验证 upsert） */
async function seen(user: TestUser, ip: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await recordLoginIp(env, user.id, ip)
}

async function setStatus(user: TestUser, status: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, user.id).run()
}

describe("登录 IP 记录", () => {
  it("同一 (用户, IP) 去重：一行 + times 累加", async () => {
    const u = await makeUser()
    await seen(u, "203.0.113.10", 3)

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c, MAX(times) AS t FROM user_login_ips WHERE user_id = ? AND ip = ?"
    )
      .bind(u.id, "203.0.113.10")
      .first<{ c: number; t: number }>()
    expect(row?.c).toBe(1)
    expect(row?.t).toBe(3)
  })

  it("空 IP 不落库", async () => {
    const u = await makeUser()
    await recordLoginIp(env, u.id, "")
    await recordLoginIp(env, u.id, null)
    await recordLoginIp(env, u.id, "   ")
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM user_login_ips WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(0)
  })

  it("换 IP 会新增行（一个人多 IP 是正常的）", async () => {
    const u = await makeUser()
    await seen(u, "203.0.113.20")
    await seen(u, "203.0.113.21")
    await seen(u, "203.0.113.22", 2)
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM user_login_ips WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(3)
  })
})

describe("IP 监管 · 同 IP 反查", () => {
  it("两个未封禁账号共用 IP → 命中，且列出双方", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await seen(a, "198.51.100.7")
    await seen(b, "198.51.100.7")

    const groups = await listSharedLoginIps(env)
    const g = groups.find((x) => x.ip === "198.51.100.7")
    expect(g).toBeDefined()
    expect(g!.userCount).toBe(2)
    const names = g!.users.map((u) => u.username).sort()
    expect(names).toEqual([a.username, b.username].sort())
  })

  it("同一人同一 IP 登多次只算 1 个账号 → 不算可疑", async () => {
    const a = await makeUser()
    await seen(a, "198.51.100.8", 5)
    const groups = await listSharedLoginIps(env)
    expect(groups.find((x) => x.ip === "198.51.100.8")).toBeUndefined()
  })

  it("另一个账号已封禁 → 不计入，该 IP 不再可疑", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await seen(a, "198.51.100.9")
    await seen(b, "198.51.100.9")
    expect((await listSharedLoginIps(env)).find((x) => x.ip === "198.51.100.9")).toBeDefined()

    await setStatus(b, "suspended")
    const after = await listSharedLoginIps(env)
    expect(after.find((x) => x.ip === "198.51.100.9")).toBeUndefined()
  })

  it("三个账号共用同一 IP → userCount = 3", async () => {
    const us = [await makeUser(), await makeUser(), await makeUser()]
    for (const u of us) await seen(u, "198.51.100.11")
    const g = (await listSharedLoginIps(env)).find((x) => x.ip === "198.51.100.11")
    expect(g?.userCount).toBe(3)
    expect(g?.users.length).toBe(3)
  })

  it("只被一个账号用过的 IP 不出现在结果里", async () => {
    const u = await makeUser()
    await seen(u, "198.51.100.12")
    const groups = await listSharedLoginIps(env)
    expect(groups.find((x) => x.ip === "198.51.100.12")).toBeUndefined()
  })
})
