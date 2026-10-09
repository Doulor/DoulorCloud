// 「AI实验室」站内额度「没有可用模型」的回归测试（2026-10-09 线上实测发现）。
//
// 现象：实验室切到「站内额度」时，模型下拉里只有一句「没有可用模型」，
//       发送按钮因为选不到模型而永久禁用 —— 功能整条不可用。
//
// 根因：实验室自动创建的专用 Key **没有带分组**（group=""）。上游 NewAPI 是按
//       token 的分组决定它能用哪些渠道的 ⇒ `/v1/models` 直接返回空、
//       chat 报 `No available channel for model ... under group ...`。
//       同一账号对照实测：普通 Key（group=default）上游给 24 个模型，
//       实验室 Key（group="") 给 0 个。
//
// 本文件锁死两件事：
//   A. 新建的实验室 Key 必须带上「站点可自选分组」（默认 default，跟随设置项）；
//   B. 历史遗留的空分组 Key 要**删掉重建**，而不是继续复用（否则用户一直卡住）。
import { describe, it, expect, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting } from "./helpers"
import { encryptSecret } from "../src/crypto"
import { resetAdminCredentialCache } from "../src/newapi-client"

const BASE = "https://api.doulor.cn"
const LAB_KEY_NAME = "网页实验室"

let restore: (() => void) | null = null

afterEach(() => {
  restore?.()
  restore = null
  resetAdminCredentialCache()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 打桩所有发往 NewAPI 的出站请求；记录路径 + 建 Key 的请求体 */
function stubNewApi(
  handler: (path: string, init?: RequestInit) => Response | Promise<Response>
): { calls: string[]; createBodies: Array<Record<string, unknown>> } {
  const calls: string[] = []
  const createBodies: Array<Record<string, unknown>> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)
    const path = url.slice(BASE.length)
    calls.push(path)
    if (init?.method === "POST" && path === "/api/token/" && init.body) {
      createBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    }
    return handler(path, init)
  }) as unknown as typeof fetch
  restore = () => {
    globalThis.fetch = original
  }
  return { calls, createBodies }
}

interface StubToken {
  id: number
  name: string
  key: string
  group: string
}

/**
 * 一个「上游 Key 列表 + 建 Key / 读 Key / 删 Key」都打通的桩。
 * 返回的 `deleted` / `tokens` 让用例能断言「旧的空分组 Key 确实被删了」。
 */
function labTokenStub(initial: StubToken[]) {
  const tokens = [...initial]
  let nextId = 9000
  const deleted: number[] = []
  const stub = stubNewApi((path, init) => {
    if (init?.method === "POST" && path === "/api/token/") {
      const body = JSON.parse(String(init.body)) as { name: string; group?: string }
      tokens.push({
        id: nextId++,
        name: body.name,
        key: "abcd**********wxyz",
        group: body.group ?? "",
      })
      return jsonResponse({ success: true })
    }
    if (path.startsWith("/api/token/?")) {
      return jsonResponse({ success: true, data: { items: tokens } })
    }
    if (/^\/api\/token\/\d+\/key$/.test(path)) {
      return jsonResponse({ success: true, data: { key: "sk-lab" } })
    }
    const del = /^\/api\/token\/(\d+)$/.exec(path)
    if (del && init?.method === "DELETE") {
      deleted.push(Number(del[1]))
      const i = tokens.findIndex((t) => t.id === Number(del[1]))
      if (i >= 0) tokens.splice(i, 1)
      return jsonResponse({ success: true })
    }
    if (path.includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "model-from-upstream" }] })
    }
    return jsonResponse({ success: true, data: {} })
  })
  return { stub, deleted, tokens }
}

// newapi_user_id 上有唯一索引，每个用例给不同的值
let nextNewApiId = 7000

async function seedBoundAccount(opts: {
  userId: string
  username: string
  cachedToken: string
}): Promise<void> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error("测试环境缺 SESSION_SECRET")
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, enc_password, group_name,
        quota, used_quota, request_count, synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 0, ?, ?)`
  )
    .bind(
      opts.userId,
      nextNewApiId++,
      opts.username,
      `${opts.username}@doulor.cn`,
      await encryptSecret(opts.cachedToken, secret),
      "default",
      now,
      now
    )
    .run()
}

describe("网页实验室：站内额度的 Key 分组（「没有可用模型」回归）", () => {
  it("A. 新建实验室 Key 时带上站点默认分组，上游模型列表能透传出来", async () => {
    const u = await makeUser()
    await seedBoundAccount({ userId: u.id, username: u.username, cachedToken: "tk-cached" })
    const { stub } = labTokenStub([])

    const res = await fetchSelf(authRequest(u, "/api/lab/models"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ models: ["model-from-upstream"] })

    expect(stub.createBodies).toHaveLength(1)
    expect(stub.createBodies[0]).toMatchObject({ name: LAB_KEY_NAME, group: "default" })
  })

  it("B. 历史遗留的空分组 Key → 删掉重建，而不是继续复用", async () => {
    const u = await makeUser()
    await seedBoundAccount({ userId: u.id, username: u.username, cachedToken: "tk-cached" })
    const { stub, deleted, tokens } = labTokenStub([
      { id: 1234, name: LAB_KEY_NAME, key: "oldk**********olds", group: "" },
    ])

    const res = await fetchSelf(authRequest(u, "/api/lab/models"))
    expect(res.status).toBe(200)

    expect(deleted).toEqual([1234])
    expect(stub.createBodies).toHaveLength(1)
    expect(stub.createBodies[0]).toMatchObject({ group: "default" })
    expect(tokens).toHaveLength(1)
    expect(tokens[0].group).toBe("default")
  })

  it("C. 分组正常的旧 Key → 直接复用，不重建、不重删", async () => {
    const u = await makeUser()
    await seedBoundAccount({ userId: u.id, username: u.username, cachedToken: "tk-cached" })
    const { stub, deleted } = labTokenStub([
      { id: 1234, name: LAB_KEY_NAME, key: "ok**********ok", group: "default" },
    ])

    const res = await fetchSelf(authRequest(u, "/api/lab/models"))
    expect(res.status).toBe(200)

    expect(deleted).toHaveLength(0)
    expect(stub.createBodies).toHaveLength(0)
  })

  // 放在最后：这条会改全局设置项，避免影响上面的用例
  it("D. 分组跟随站点设置（newapi_group=vip）而不是写死 default", async () => {
    await setSetting("newapi_group", "vip")
    try {
      const u = await makeUser()
      await seedBoundAccount({ userId: u.id, username: u.username, cachedToken: "tk-cached" })
      const { stub } = labTokenStub([])

      const res = await fetchSelf(authRequest(u, "/api/lab/models"))
      expect(res.status).toBe(200)
      expect(stub.createBodies[0]).toMatchObject({ group: "vip" })
    } finally {
      await setSetting("newapi_group", "default")
    }
  })
})
