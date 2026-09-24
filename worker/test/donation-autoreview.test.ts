// 捐献自动审核开关 + frp 的静态校验。
//
// 覆盖两件事：
//   1. `auto_review_features` 开关：关掉某模块后，该模块提交不再自动审核（转人工）。
//   2. frp 的 config.yml 静态校验（仅语法 + serverAddr，不验证连通性）。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"
import { parseAutoReviewFeatures } from "../src/handlers/donations"
import { parsePermissions } from "../src/permissions"

const SUB_HOST = "https://sub.example.com"
const VALID_SUB = [
  "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?type=ws&security=tls#香港",
].join("\n")

let calls: string[] = []
let restores: Array<() => void> = []

function stubFetch(handler: (url: string) => Response | undefined): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return handler(url) ?? original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
}

beforeEach(() => {
  calls = []
  return env.DB.prepare("DELETE FROM proxy_subscriptions").run()
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

async function setAutoReview(features: string[]): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('auto_review_features', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(features.join(","), new Date().toISOString())
    .run()
}

async function makeDonor(): Promise<TestUser> {
  const user = await makeUser()
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
    .bind(`${user.username}@example.net`, user.id)
    .run()
  await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
  return user
}

async function submit(user: TestUser, type: string, payload: Record<string, unknown>) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    })
  )
  return { res, body: (await res.json()) as Record<string, unknown> }
}

async function permsOf(userId: string) {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  return parsePermissions(row?.permissions)
}

describe("parseAutoReviewFeatures", () => {
  it("解析逗号分隔，忽略未知与重复", () => {
    expect(parseAutoReviewFeatures("ai,proxy")).toEqual(["ai", "proxy"])
    expect(parseAutoReviewFeatures("ai,bogus,frp,ai")).toEqual(["ai", "frp"])
    expect(parseAutoReviewFeatures("")).toEqual([])
    expect(parseAutoReviewFeatures(null)).toEqual([])
    expect(parseAutoReviewFeatures(" AI , PROXY ")).toEqual(["ai", "proxy"])
  })
})

describe("自动审核开关", () => {
  it("关闭 proxy 自动审核后，代理捐献转为待人工（不自动通过/拒绝）", async () => {
    await setAutoReview(["ai"]) // 只留 ai 自动，proxy 关闭
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SUB_HOST) ? new Response(VALID_SUB) : undefined))

    const { res, body } = await submit(user, "proxy", { subUrls: [`${SUB_HOST}/sub`] })
    expect(res.status).toBe(201) // 转人工 = 待审核，201（非 200 自动判定）
    expect(body.status).toBe("pending")
    expect(body.autoReviewed).toBe(false)
    // 没有解锁，也没有导入
    expect((await permsOf(user.id)).proxy).toBe(false)
    const subs = await env.DB.prepare("SELECT COUNT(*) c FROM proxy_subscriptions").first<{ c: number }>()
    expect(subs?.c).toBe(0)
  })

  it("全部关闭（空串）时 AI 捐献也转人工", async () => {
    await setAutoReview([])
    const user = await makeDonor()
    const { body } = await submit(user, "ai", {
      baseUrl: "https://up.example.com",
      apiKey: "sk-x",
      models: ["m1"],
    })
    expect(body.status).toBe("pending")
    expect(body.autoReviewed).toBe(false)
  })
})

describe("frp 自动审核（静态校验）", () => {
  it("合法 config.yml（含 serverAddr）→ 自动通过并解锁 frp", async () => {
    await setAutoReview(["frp"])
    const user = await makeDonor()
    const { body } = await submit(user, "frp", {
      configYml: "serverAddr: frp.example.com\nserverPort: 7000\ntoken: abc123\n\n[[proxies]]\nname = \"web\"\ntype = \"tcp\"\nlocalPort = 8080\nremotePort = 8080\n",
    })
    expect(body.status).toBe("approved")
    expect(body.autoReviewed).toBe(true)
    expect(String(body.reviewNote)).toContain("serverAddr")
    expect((await permsOf(user.id)).frp).toBe(true)
  })

  it("缺少 serverAddr → 自动拒绝", async () => {
    await setAutoReview(["frp"])
    const user = await makeDonor()
    const { body } = await submit(user, "frp", {
      configYml: "serverPort: 7000\n[[proxies]]\nname = \"x\"\ntype = \"tcp\"\n",
    })
    expect(body.status).toBe("rejected")
    expect(String(body.reviewNote)).toContain("serverAddr")
    expect((await permsOf(user.id)).frp).toBe(false)
  })

  it("首行不是「键: 值」→ 拒绝（乱贴文字）", async () => {
    await setAutoReview(["frp"])
    const user = await makeDonor()
    const { body } = await submit(user, "frp", {
      configYml: "这是一段不是 yaml 的文字，随便贴的",
    })
    expect(body.status).toBe("rejected")
  })

  it("frp 不在开关里（默认）→ 转人工", async () => {
    await setAutoReview(["ai", "proxy"])
    const user = await makeDonor()
    const { body } = await submit(user, "frp", {
      configYml: "serverAddr: frp.example.com\nserverPort: 7000\n",
    })
    expect(body.status).toBe("pending")
  })

  it("没填 config.yml → 转人工（不做无谓的自动拒绝）", async () => {
    await setAutoReview(["frp"])
    const user = await makeDonor()
    const { body } = await submit(user, "frp", { configYml: "" })
    expect(body.status).toBe("pending")
  })
})
