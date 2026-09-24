// NewAPI 权限同步：孤儿清理 + 权限对齐（封禁/解封）。
//
// 背景：cloud 收回用户的 ai 权限（或关闭免权限开关）后，用户在 NewAPI 的
// 账号与已创建的 API Key 仍然有效（Key 直连 NewAPI，绕过 cloud）。本同步
// 每小时跑一次，把 cloud 的权限状态对齐到 NewAPI 侧：
//   - 账号已不存在 → 删 cloud 记录（用户回到「未开通」）
//   - 无权限 → disable（其 Key 立即失效）
//   - 有权限 → enable
//   - 管理员 → 永远豁免
import { describe, it, expect, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser } from "./helpers"
import { syncPermissionState } from "../src/handlers/newapi"
import { resetAdminCredentialCache } from "../src/newapi-client"

const BASE = "https://api.doulor.cn"

function stubNewApi(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): () => void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url.startsWith(BASE)) return handler(url, init)
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  return () => {
    globalThis.fetch = original
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** NewAPI /api/user/search 的信封：{ success:true, data:{ items:[...] } } */
function searchEnvelope(users: Array<{ id: number; username: string; status?: number }>) {
  return jsonResponse({ success: true, message: "", data: { items: users } })
}

let restore: (() => void) | null = null

afterEach(() => {
  restore?.()
  restore = null
  resetAdminCredentialCache()
  vi.restoreAllMocks()
})

/** 直接在 DB 里塞一条 newapi_accounts 记录，模拟「已开通」状态 */
async function seedAccount(
  userId: string,
  newapiUserId: number,
  username: string
) {
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, group_name, quota, used_quota, request_count, synced_at, created_at)
     VALUES (?, ?, ?, ?, 'enc', 'default', 0, 0, 0, NULL, ?)`
  )
    .bind(userId, newapiUserId, username, `${username}@doulor.cn`, new Date().toISOString())
    .run()
}

describe("syncPermissionState", () => {
  it("孤儿账号：NewAPI 侧已删除 → 清掉 cloud 记录", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 999, u.username)

    // NewAPI 搜索不到这个用户名
    restore = stubNewApi((url) => {
      if (url.includes("/api/user/search")) return searchEnvelope([])
      return jsonResponse({ success: true })
    })

    const r = await syncPermissionState(env)
    expect(r.removedOrphans).toBe(1)

    const row = await env.DB.prepare(
      "SELECT * FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(u.id)
      .first()
    expect(row).toBeNull()
  })

  it("无 ai 权限且非管理员 → disable", async () => {
    const u = await makeUser()
    // 显式关掉 ai 权限：permissions = NULL 在本项目里是「全开」，必须显式 false
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ ai: false }), u.id)
      .run()
    await seedAccount(u.id, 100, u.username)

    restore = stubNewApi((url) => {
      if (url.includes("/api/user/search")) {
        return searchEnvelope([{ id: 100, username: u.username, status: 1 }]) // 当前启用
      }
      if (url.includes("/api/user/manage")) {
        return jsonResponse({ success: true })
      }
      return jsonResponse({ success: true })
    })

    const r = await syncPermissionState(env)
    expect(r.disabled).toBe(1)
    expect(r.enabled).toBe(0)
  })

  it("管理员永远豁免，即使没有显式 ai 权限", async () => {
    const admin = await makeUser({ role: "admin" })
    await seedAccount(admin.id, 101, admin.username)

    restore = stubNewApi((url) => {
      if (url.includes("/api/user/search")) {
        return searchEnvelope([{ id: 101, username: admin.username, status: 1 }])
      }
      if (url.includes("/api/user/manage")) {
        throw new Error("管理员不应触发任何 manage 调用")
      }
      return jsonResponse({ success: true })
    })

    const r = await syncPermissionState(env)
    expect(r.disabled).toBe(0)
    expect(r.enabled).toBe(0)
  })

  it("已被禁用的账号在权限恢复后 → enable", async () => {
    // 造一个「有 ai 权限」的用户：直接写 users.permissions
    const u = await makeUser()
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ ai: true }), u.id)
      .run()
    await seedAccount(u.id, 102, u.username)

    restore = stubNewApi((url) => {
      if (url.includes("/api/user/search")) {
        return searchEnvelope([{ id: 102, username: u.username, status: 2 }]) // 当前禁用
      }
      if (url.includes("/api/user/manage")) {
        return jsonResponse({ success: true })
      }
      return jsonResponse({ success: true })
    })

    const r = await syncPermissionState(env)
    expect(r.enabled).toBe(1)
    expect(r.disabled).toBe(0)
  })

  it("免权限开放（open_features 含 ai）→ 视为有权限，不封禁", async () => {
    const u = await makeUser() // 无 ai 权限
    await seedAccount(u.id, 103, u.username)

    // 打开免权限开关
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('open_features', 'ai', ?)
       ON CONFLICT(key) DO UPDATE SET value = 'ai', updated_at = excluded.updated_at`
    )
      .bind(new Date().toISOString())
      .run()

    restore = stubNewApi((url) => {
      if (url.includes("/api/user/search")) {
        return searchEnvelope([{ id: 103, username: u.username, status: 1 }])
      }
      if (url.includes("/api/user/manage")) {
        throw new Error("免权限开放时不应触发 manage 调用")
      }
      return jsonResponse({ success: true })
    })

    const r = await syncPermissionState(env)
    expect(r.disabled).toBe(0)
    expect(r.enabled).toBe(0)
  })
})
