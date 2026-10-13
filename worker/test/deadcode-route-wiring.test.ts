/**
 * 回归测试：两条「handler 存在但没人调得动」的路由，现在有**真实 HTTP 证据**（任务 B）。
 *
 * 背景（`check-unused-exports.mjs` 的 ALLOW 里挂着的那两条）：
 *
 *   1. `handlers/community.ts::linkPreview`
 *      —— 审计 F4：handler 带限流、写得挺完整，但 index.ts 里**没有路由**，
 *         前端的请求会落到静态 Worker 被 SPA 兜底成 index.html（200 + HTML），
 *         前端 `res.json()` 解析失败后**静默**回退成普通链接。
 *         路由现已补上（`GET /api/community/link-preview`），
 *         `check-api-paths.mjs` 的 KNOWN_GAPS 也随之清空。
 *
 *   2. `handlers/admin.ts::deleteInvite`
 *      —— ALLOW 里的说法是「管理员实际上无法撤销已发出的邀请码」。**复核后不成立**：
 *         `DELETE /api/admin/invites/:id` 早就挂着 `adminDeleteInviteWithRefund`
 *         （严格超集：多额度退还 + 多审计日志），deleteInvite 只是它的旧版本
 *         （连审计都没有），已整个删掉。所以本文件测的是**那条真路由**能不能用，
 *         以及为什么不该再往同一路径上挂第二个实现。
 *
 * ⚠️ 关键点：这里一律走 `fetchSelf`（真打 Worker 的路由表），**不是**直接调 handler ——
 *    「路由接没接上」这个缺陷只有在路由层才暴露得出来（这正是当初漏掉的原因）。
 *    顺便断言 `content-type` 是 JSON：html 兜底会让它变成 text/html。
 *
 * ⚠️ 只读 `worker/test/helpers.ts` 里已有的导出；本文件是新建文件，
 *    不改任何既有测试（`worker/test/` 属另一任务的范围）。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

/* ------------------------------------------------------------------ */
/* 1. 链接预览：GET /api/community/link-preview                        */
/* ------------------------------------------------------------------ */

/**
 * 用**站内帖子**链接做样例：这条路直接查 D1，不产生任何出站请求，
 * 所以不需要打桩 fetch，测试也不会因为网络环境而闪断。
 */
async function seedPost(userId: string, body: string): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    "INSERT INTO posts (id, user_id, channel, body, created_at) VALUES (?, ?, 'general', ?, ?)"
  )
    .bind(id, userId, body, new Date().toISOString())
    .run()
  return id
}

describe("GET /api/community/link-preview（原先没有路由）", () => {
  it("真实路由可达：返回 JSON 预览而不是 SPA 的 HTML 兜底", async () => {
    await setSetting("community_enabled", "1")
    const author = await makeUser()
    const postId = await seedPost(author.id, "链接预览路由的回归样例正文")
    const viewer = await makeUser()

    const target = `https://cloud.doulor.cn/community/${postId}`
    const res = await fetchSelf(
      authRequest(viewer, `/api/community/link-preview?url=${encodeURIComponent(target)}`)
    )

    expect(res.status).toBe(200)
    // 路由没接上时这里是 text/html（index.html 兜底）—— 当初的故障形态
    expect(res.headers.get("content-type") ?? "").toContain("application/json")

    const body = await res.json<{
      preview: { internal: boolean; postId: string; description: string; siteName: string } | null
    }>()
    expect(body.preview).not.toBeNull()
    expect(body.preview!.internal).toBe(true)
    expect(body.preview!.postId).toBe(postId)
    expect(body.preview!.description).toContain("回归样例正文")
  })

  it("不登录时是 401（证明跑到的是真 handler，而不是静态兜底）", async () => {
    await setSetting("community_enabled", "1")
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/community/link-preview?url=https://example.com/")
    )
    expect(res.status).toBe(401)
    const body = await res.json<{ code: string }>()
    // requireUser 在未带会话时抛的就是这个码（不是静态兜底的 HTML）
    expect(body.code).toBe("UNAUTHORIZED")
  })
})

/* ------------------------------------------------------------------ */
/* 2. 撤销邀请码：DELETE /api/admin/invites/:id                        */
/* ------------------------------------------------------------------ */

async function seedInvite(): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, expires_at, created_at, permissions)
     VALUES (?, ?, NULL, 1, 0, NULL, ?, ?)`
  )
    .bind(id, `DCW-${id.slice(0, 8).toUpperCase()}`, new Date().toISOString(), JSON.stringify({}))
    .run()
  return id
}

async function inviteExists(id: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM invite_codes WHERE id = ?").bind(id).first()
  return Boolean(r)
}

async function auditCount(): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'admin.invite.delete'"
  ).first<{ c: number }>()
  return r?.c ?? 0
}

describe("DELETE /api/admin/invites/:id（撤销已发出的邀请码）", () => {
  it("superadmin 能撤销：204 + 行被删 + 留下审计日志", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const id = await seedInvite()
    expect(await inviteExists(id)).toBe(true)

    const before = await auditCount()
    const res = await fetchSelf(
      authRequest(admin, `/api/admin/invites/${id}`, { method: "DELETE" })
    )

    expect(res.status).toBe(204)
    expect(await inviteExists(id)).toBe(false)
    // 这条正是「旧版本 deleteInvite」缺的东西：删了码却查不到是谁删的
    expect(await auditCount()).toBe(before + 1)
  })

  it("普通用户撤销不了（403），且邀请码还在", async () => {
    const user = await makeUser()
    const id = await seedInvite()

    const res = await fetchSelf(
      authRequest(user, `/api/admin/invites/${id}`, { method: "DELETE" })
    )

    expect(res.status).toBe(403)
    expect(await inviteExists(id)).toBe(true)
  })

  it("删不存在的邀请码回 404（而不是 500 / 204）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const res = await fetchSelf(
      authRequest(admin, `/api/admin/invites/${uuid()}`, { method: "DELETE" })
    )
    expect(res.status).toBe(404)
    const body = await res.json<{ code: string }>()
    expect(body.code).toBe("NOT_FOUND")
  })
})
