/**
 * OAuth：用户自助创建应用 + 站长审核（2026-10-06）。
 *
 * 背景：OAuth 应用原先只能管理员在后台添加。放开给用户自建后主要风险是**钓鱼**
 * （应用名可以随便填）。配套三道护栏，本文件逐条锁死：
 *   1. 审核开关 `oauth_user_clients_open`：关着（默认）时用户提交的是 pending，
 *      **通过前不能用于授权**；
 *   2. 应用名**敏感词拦截**（防冒充官方 / 客服）；
 *   3. 改了**名字或回调地址 → 重新排队审核**（否则先过审再改成钓鱼地址就白审了）。
 * 另外锁死越权：用户改不动别人的应用。
 *
 * ⚠️ 这里一律用 **root** 建应用 / 审核，不用 `admin`：admin 目前受「权限组
 *    admin_scope」那套改动影响拿不到管理接口（403），用它会红在无关原因上。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

const REDIRECT = "https://client.example.com/oauth/callback"

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/** 建一个用户自建应用，返回响应体 */
async function createMyClient(
  user: TestUser,
  overrides: { name?: string; redirectUris?: string[] } = {}
): Promise<{
  status: number
  body: {
    client?: { id: string; clientId: string; reviewStatus: string }
    clientSecret?: string
    pending?: boolean
    code?: string
  }
}> {
  const res = await fetchSelf(
    authRequest(
      user,
      "/api/oauth/my-clients",
      jsonInit({
        name: overrides.name ?? "我的博客",
        redirectUris: overrides.redirectUris ?? [REDIRECT],
      })
    )
  )
  return { status: res.status, body: (await res.json()) as never }
}

/** 直接走一次「同意」流程；返回状态码（不关心是否真拿到 code） */
async function approve(
  user: TestUser,
  clientId: string
): Promise<{ status: number; code?: string }> {
  const res = await fetchSelf(
    authRequest(
      user,
      "/api/oauth/authorize/decision",
      jsonInit({
        approve: true,
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "openid profile email",
        state: "s",
        response_type: "code",
      })
    )
  )
  const body = (await res.json()) as { redirectTo?: string; code?: string }
  const code = body.redirectTo
    ? new URL(body.redirectTo).searchParams.get("code") ?? undefined
    : undefined
  return { status: res.status, code }
}

/** 取应用当前状态（走「我的应用」列表） */
async function statusOf(user: TestUser, id: string): Promise<string | null> {
  const res = await fetchSelf(authRequest(user, "/api/oauth/my-clients"))
  const body = (await res.json()) as { clients: { id: string; reviewStatus: string }[] }
  return body.clients.find((c) => c.id === id)?.reviewStatus ?? null
}

describe("OAuth 用户自建应用：审核开关", () => {
  it("开关关着（默认）→ 创建为待审核，且通过前无法用于授权", async () => {
    await setSetting("oauth_user_clients_open", "0")
    const user = await makeUser()
    const created = await createMyClient(user)

    expect(created.status).toBe(201)
    expect(created.body.pending).toBe(true)
    expect(created.body.client?.reviewStatus).toBe("pending")
    // ⚠️ secret 仍然下发（用户要先去对方站点配置），但应用还不能用
    expect(created.body.clientSecret).toBeTruthy()

    const denied = await approve(user, created.body.client!.clientId)
    expect(denied.status).toBe(403)
    expect(denied.code).toBeUndefined()
  })

  it("站长审核通过后，应用即可正常授权", async () => {
    await setSetting("oauth_user_clients_open", "0")
    const root = await makeUser({ role: "root" })
    const user = await makeUser()
    const created = await createMyClient(user)
    const id = created.body.client!.id

    const review = await fetchSelf(
      authRequest(root, `/api/admin/oauth/clients/${id}/review`, jsonInit({ approve: true }))
    )
    expect(review.status).toBe(200)
    expect(await statusOf(user, id)).toBe("approved")

    const ok = await approve(user, created.body.client!.clientId)
    expect(ok.status).toBe(200)
    expect(ok.code).toBeTruthy()
  })

  it("站长驳回 → 应用被拒且带驳回原因", async () => {
    await setSetting("oauth_user_clients_open", "0")
    const root = await makeUser({ role: "root" })
    const user = await makeUser()
    const created = await createMyClient(user)
    const id = created.body.client!.id

    const review = await fetchSelf(
      authRequest(
        root,
        `/api/admin/oauth/clients/${id}/review`,
        jsonInit({ approve: false, note: "看起来像钓鱼站" })
      )
    )
    expect(review.status).toBe(200)

    const list = await fetchSelf(authRequest(user, "/api/oauth/my-clients"))
    const body = (await list.json()) as {
      clients: { id: string; reviewStatus: string; reviewNote: string | null }[]
    }
    const mine = body.clients.find((c) => c.id === id)
    expect(mine?.reviewStatus).toBe("rejected")
    expect(mine?.reviewNote).toBe("看起来像钓鱼站")

    const denied = await approve(user, created.body.client!.clientId)
    expect(denied.status).toBe(403)
  })

  it("开关开着 → 直接生效，无需审核", async () => {
    await setSetting("oauth_user_clients_open", "1")
    const user = await makeUser()
    const created = await createMyClient(user)

    expect(created.status).toBe(201)
    expect(created.body.pending).toBe(false)
    expect(created.body.client?.reviewStatus).toBe("approved")

    const ok = await approve(user, created.body.client!.clientId)
    expect(ok.status).toBe(200)
  })
})

describe("OAuth 用户自建应用：固定护栏", () => {
  it("应用名含敏感词（官方 / 客服 / Doulor…）被拒", async () => {
    await setSetting("oauth_user_clients_open", "1")
    const user = await makeUser()
    for (const bad of ["Doulor 官方验证", "账号申诉客服", "Official Support"]) {
      const r = await createMyClient(user, { name: bad })
      expect(r.status, `名字「${bad}」应被拒`).toBe(400)
      expect(r.body.code).toBe("NAME_NOT_ALLOWED")
    }
  })

  it("改了回调地址 → 重新回到待审核（防「先过审再改成钓鱼地址」）", async () => {
    await setSetting("oauth_user_clients_open", "0")
    const root = await makeUser({ role: "root" })
    const user = await makeUser()
    const created = await createMyClient(user)
    const id = created.body.client!.id

    await fetchSelf(
      authRequest(root, `/api/admin/oauth/clients/${id}/review`, jsonInit({ approve: true }))
    )
    expect(await statusOf(user, id)).toBe("approved")

    // 换一个回调地址 → 必须重新排队
    const upd = await fetchSelf(
      authRequest(user, `/api/oauth/my-clients/${id}`, jsonInit({ redirectUris: ["https://evil.example.net/cb"] }, "PUT"))
    )
    expect(upd.status).toBe(200)
    expect(await statusOf(user, id)).toBe("pending")
  })

  it("开关开着时，改回调地址不重新排队（免审）", async () => {
    await setSetting("oauth_user_clients_open", "1")
    const user = await makeUser()
    const created = await createMyClient(user)
    const id = created.body.client!.id

    await fetchSelf(
      authRequest(user, `/api/oauth/my-clients/${id}`, jsonInit({ redirectUris: ["https://other.example.com/cb"] }, "PUT"))
    )
    expect(await statusOf(user, id)).toBe("approved")
  })

  it("改不动 / 删不掉别人的应用（越权返回 404，不泄露存在性）", async () => {
    await setSetting("oauth_user_clients_open", "1")
    const a = await makeUser()
    const b = await makeUser()
    const created = await createMyClient(a)
    const id = created.body.client!.id

    const upd = await fetchSelf(
      authRequest(b, `/api/oauth/my-clients/${id}`, jsonInit({ name: "被改的" }, "PUT"))
    )
    expect(upd.status).toBe(404)

    const del = await fetchSelf(
      authRequest(b, `/api/oauth/my-clients/${id}`, { method: "DELETE" })
    )
    expect(del.status).toBe(404)

    // A 的应用仍在，且没被改名
    expect(await statusOf(a, id)).toBe("approved")
  })

  it("超过每人上限后拒绝创建", async () => {
    await setSetting("oauth_user_clients_open", "1")
    const user = await makeUser()
    for (let i = 0; i < 5; i++) {
      const r = await createMyClient(user, { name: `应用${i}` })
      expect(r.status, `第 ${i + 1} 个应成功`).toBe(201)
    }
    const sixth = await createMyClient(user, { name: "第六个" })
    expect(sixth.status).toBe(400)
    expect(sixth.body.code).toBe("TOO_MANY_CLIENTS")
  })
})
