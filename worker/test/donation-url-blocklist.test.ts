// 自定义 AI 渠道捐献的 **baseUrl 黑名单**（2026-10-10 站长要求）。
//
// 语义：**前缀匹配** —— 命中就不允许捐献。站长给的三个例子：
//   https://token.sensenova.cn          （原样）
//   https://token.sensenova.cn/v1       （用户常把 /v1 整段粘进来）
//   https://token.sensenova.cn/         （带尾部斜杠）
// 三条都必须拦。
//
// 这里既钉纯函数（匹配 / 归一化口径），也走**真实 HTTP 路由**确认「提交时就被拒」
// —— 只测纯函数证明不了链路真的接上了，也证明不了「没误伤别的上游」。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting, type TestUser } from "./helpers"
import {
  DEFAULT_DONATION_URL_BLOCKLIST,
  isUpstreamUrlBlocked,
  normalizeUrlBlocklist,
} from "../src/donation-url-blocklist"

const BLOCKED = "https://token.sensenova.cn"
const ALLOWED = "https://token.sensenova.com" // 只差一个字母，必须放行（防误伤）

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let restores: Array<() => void> = []

/** 打桩 fetch（只在本文件需要，避免探测真的出网） */
function stubFetch(
  handler: (url: string) => Response | undefined
): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const res = handler(url)
    if (res) return res
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

beforeEach(async () => {
  // 每个用例都从「库里没有这一行 ⇒ 用代码默认名单」起步，避免互相污染
  await env.DB.prepare("DELETE FROM app_settings WHERE key = 'donation_url_blocklist'").run()
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

// ---- 纯函数 ----

describe("捐献 baseUrl 黑名单：匹配语义", () => {
  it("站长举的三个例子：原样 / 带 /v1 / 带尾部斜杠，都拦", () => {
    expect(isUpstreamUrlBlocked(BLOCKED, DEFAULT_DONATION_URL_BLOCKLIST)).toBe(true)
    expect(isUpstreamUrlBlocked(`${BLOCKED}/v1`, DEFAULT_DONATION_URL_BLOCKLIST)).toBe(true)
    expect(isUpstreamUrlBlocked(`${BLOCKED}/`, DEFAULT_DONATION_URL_BLOCKLIST)).toBe(true)
  })

  it("大小写 / 协议 / 端口 / 更深路径都不放过", () => {
    const bl = DEFAULT_DONATION_URL_BLOCKLIST
    expect(isUpstreamUrlBlocked("https://TOKEN.SenseNova.CN/v1", bl)).toBe(true)
    expect(isUpstreamUrlBlocked("http://token.sensenova.cn/v1", bl)).toBe(true)
    expect(isUpstreamUrlBlocked("https://token.sensenova.cn:8443/v1", bl)).toBe(true)
    expect(isUpstreamUrlBlocked("https://token.sensenova.cn/v1/chat/completions", bl)).toBe(true)
  })

  it("不误伤别的上游", () => {
    const bl = DEFAULT_DONATION_URL_BLOCKLIST
    expect(isUpstreamUrlBlocked("https://api.openai.com/v1", bl)).toBe(false)
    expect(isUpstreamUrlBlocked(ALLOWED, bl)).toBe(false)
    expect(isUpstreamUrlBlocked("https://token.sensenova.cn.evil.com/v1", bl)).toBe(false)
  })

  it("边界语义：后面接路径算命中；接别的字符 = 另一个域名，不算", () => {
    // ②「在我填的后面接路径」—— 同一台服务器上的别的位置
    for (const ok of [
      `${BLOCKED}/`,
      `${BLOCKED}/v1`,
      `${BLOCKED}/v1/chat/completions`,
      `${BLOCKED}?x=1`,
      `${BLOCKED}:8443/v1`,
    ]) {
      expect(isUpstreamUrlBlocked(ok, DEFAULT_DONATION_URL_BLOCKLIST), ok).toBe(true)
    }
    // ✗ 只是字母碰巧连着（`.com` 后面接着 `pany.com`）—— 另一个域名，站长明确否掉了
    for (const no of [
      "https://token.sensenova.cnx.com/v1",
      "https://token.sensenova.cn-other.com/v1",
      "https://token.sensenova.cn.evil.com/v1",
    ]) {
      expect(isUpstreamUrlBlocked(no, DEFAULT_DONATION_URL_BLOCKLIST), no).toBe(false)
    }
  })

  it("名单条目本身也走同一套归一化（管理员怎么填都认）", () => {
    for (const raw of [
      "https://token.sensenova.cn",
      "  https://token.sensenova.cn/  ",
      "http://TOKEN.SENSENOVA.CN",
    ]) {
      expect(isUpstreamUrlBlocked(`${BLOCKED}/v1`, raw), raw).toBe(true)
    }
  })

  it("空名单 / 全空白 = 一条都不拦（「不启用」的语义）", () => {
    expect(isUpstreamUrlBlocked(`${BLOCKED}/v1`, "")).toBe(false)
    expect(isUpstreamUrlBlocked(`${BLOCKED}/v1`, "   \n \t ")).toBe(false)
  })

  it("多条目：换行 / 逗号 / 空白都能拆，去重后按换行拼接，且**保留原样拼写**", () => {
    const norm = normalizeUrlBlocklist(
      "https://a.example.com, https://b.example.com\nhttps://a.example.com/"
    )
    // 去重按比较口径（大小写 / 末尾斜杠不同 = 同一条），但存的是站长当初写的原样
    expect(norm).toBe("https://a.example.com\nhttps://b.example.com")
    expect(isUpstreamUrlBlocked("https://b.example.com/v1", norm)).toBe(true)
    expect(isUpstreamUrlBlocked("https://c.example.com/v1", norm)).toBe(false)
  })

  it("长名单不被截断（管理端保存分支存在的原因）", () => {
    const entries = Array.from({ length: 12 }, (_, i) => `https://up${i}.example.com`)
    const norm = normalizeUrlBlocklist(entries.join("\n"))
    // 12 条 × ~26 字符 ≈ 300 > 通用兜底的 100 字符上限
    expect(norm.length).toBeGreaterThan(100)
    expect(norm.split("\n")).toHaveLength(12)
    expect(isUpstreamUrlBlocked("https://up11.example.com/v1", norm)).toBe(true)
  })

  it("文档化行为：命中必须落在「边界」上，不做前缀糊匹配", () => {
    // 站长 2026-10-10 明确否掉了 `api.x.com` 连 `api.x.company.com` 一起拦的那种匹配
    expect(isUpstreamUrlBlocked("https://api.x.company.com/v1", "https://api.x.com")).toBe(false)
    expect(isUpstreamUrlBlocked("https://api.x.com/v1", "https://api.x.com")).toBe(true)
  })

  it("不剥 /v1：填 .../v1 只拦那一个路径，不会变成拦整个域名", () => {
    const bl = "https://x.example.com/v1"
    expect(isUpstreamUrlBlocked("https://x.example.com/v1", bl)).toBe(true)
    expect(isUpstreamUrlBlocked("https://x.example.com/v1/chat", bl)).toBe(true)
    expect(isUpstreamUrlBlocked("https://x.example.com", bl)).toBe(false)
    expect(isUpstreamUrlBlocked("https://x.example.com/v2", bl)).toBe(false)
  })

  it("真机常见写法都要拦：末尾带斜杠、带 /v1/、整段粘贴", () => {
    for (const c of [
      BLOCKED,
      `${BLOCKED}/`,
      `${BLOCKED}/v1`,
      `${BLOCKED}/v1/`,
      `  ${BLOCKED}/v1  `,
    ]) {
      expect(isUpstreamUrlBlocked(c, DEFAULT_DONATION_URL_BLOCKLIST), c).toBe(true)
    }
  })
})

// ---- HTTP 链路 ----

async function submitAiDonation(user: TestUser, baseUrl: string) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ai", payload: { baseUrl, apiKey: "sk-test", models: ["m1"] } }),
    })
  )
  return { res, body: (await res.json()) as { error?: string; code?: string; id?: string } }
}

async function probeAi(user: TestUser, baseUrl: string) {
  const res = await fetchSelf(
    authRequest(user, "/donations/ai/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: "sk-test" }),
    })
  )
  return { res, body: (await res.json()) as { ok: boolean; models: string[]; message: string } }
}

describe("捐献 baseUrl 黑名单：提交时就被拒（真实路由）", () => {
  it("命中默认名单 → 400 URL_BLOCKED，且**一条单据都不会产生**", async () => {
    const user = await makeUser()
    // 三个等价写法都必须被拦（归一化在服务端做，不靠前端）
    for (const raw of [BLOCKED, `${BLOCKED}/v1`, `${BLOCKED}/`]) {
      const { res, body } = await submitAiDonation(user, raw)
      expect(res.status, raw).toBe(400)
      expect(body.code, raw).toBe("URL_BLOCKED")
    }
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM donations WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(0)
  })

  it("探测接口先拦：命中名单时 ok=false，不去连上游", async () => {
    const user = await makeUser()
    const { res, body } = await probeAi(user, `${BLOCKED}/v1`)
    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.message).toContain("无法捐献")
  })

  it("名单只认配置里那一条，相近域名照常放行", async () => {
    const user = await makeUser()
    await setSetting("donation_url_blocklist", BLOCKED)
    stubFetch((url) =>
      url.startsWith(ALLOWED) ? jsonResponse({ object: "list", data: [{ id: "m1" }] }) : undefined
    )
    const blocked = await probeAi(user, `${BLOCKED}/v1`)
    expect(blocked.body.ok).toBe(false)

    const allowed = await probeAi(user, `${ALLOWED}/v1`)
    expect(allowed.body.ok).toBe(true)
    expect(allowed.body.models).toEqual(["m1"])
  })

  it("配置成空串 = 不启用（管理端清空后必须真的不拦）", async () => {
    const user = await makeUser()
    await setSetting("donation_url_blocklist", "")
    stubFetch((url) =>
      url.startsWith(BLOCKED) ? jsonResponse({ object: "list", data: [{ id: "m1" }] }) : undefined
    )
    const { body } = await probeAi(user, `${BLOCKED}/v1`)
    expect(body.ok).toBe(true)
  })

  it("自定义名单立即生效（保存侧归一化过的形态）", async () => {
    const user = await makeUser()
    await setSetting("donation_url_blocklist", normalizeUrlBlocklist("https://bad.example.com/"))
    const hit = await submitAiDonation(user, "https://bad.example.com/v1")
    expect(hit.res.status).toBe(400)
    expect(hit.body.code).toBe("URL_BLOCKED")
  })
})
