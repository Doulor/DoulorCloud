// 邮件图片代理：签名改写 + 代理侧安全边界。
//
// 代理是「公开可访问、会替调用方去 fetch 任意 http(s) 地址」的接口 ——
// 这是 SSRF 的教科书形态。这里的每条用例对应一个必须挡住的攻击面，
// 删掉任何一条都等于把那扇门重新打开。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { fetchSelf } from "./helpers"
import { mailImageUrl, signMailImages, verifyMailImage } from "../src/mail-images"

/** 打桩上游：imageFetch 决定「图片服务器」返回什么 */
let upstream: (url: string) => Response = () => pngResponse()
let seen: string[] = []
let restore: (() => void) | null = null

function pngResponse(bytes = 64): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": "image/png", "Content-Length": String(bytes) },
  })
}

beforeEach(() => {
  seen = []
  upstream = () => pngResponse()
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    // 只拦「代理去取图片」这一种调用，其它（本仓内部）原样放行
    if (/^https?:\/\/(cdn|img)\.example\//.test(url) || /^http:\/\/127\.0\.0\.1/.test(url)) {
      seen.push(url)
      return upstream(url)
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restore = () => {
    globalThis.fetch = original
  }
})

afterEach(() => {
  restore?.()
  restore = null
})

/** 拿一个带合法签名的代理地址 */
async function proxyUrl(src: string): Promise<string> {
  const url = await mailImageUrl(env, src)
  if (!url) throw new Error("测试环境缺 SESSION_SECRET")
  return url
}

describe("图片签名与读取侧改写", () => {
  it("data-mail-src 被换成带签名的代理地址，签名可校验", async () => {
    const html =
      '<p>a</p><img alt="t" data-mail-src="https://cdn.example/a.png?x=1&amp;y=2">'
    const out = await signMailImages(env, html)

    expect(out).toContain('src="https://cloud.doulor.cn/api/mail/img?')
    expect(out).not.toContain("data-mail-src")
    // 原地址里的 & 已转义，取出来要还原
    const m = /src="([^"]+)"/.exec(out)
    expect(m).not.toBeNull()
    const u = new URL(m![1].replace(/&amp;/g, "&"))
    expect(u.pathname).toBe("/api/mail/img")
    const src = u.searchParams.get("src")!
    expect(src).toBe("https://cdn.example/a.png?x=1&y=2")
    expect(await verifyMailImage(env, src, u.searchParams.get("s")!)).toBe(true)
  })

  it("没配 SESSION_SECRET 时原样返回（宁可裂图，也不退化成直连原地址）", async () => {
    const noSecret = { ...(env as unknown as Record<string, unknown>), SESSION_SECRET: "" }
    const html = '<img data-mail-src="https://cdn.example/a.png">'
    expect(await signMailImages(noSecret as never, html)).toBe(html)
  })

  it("非 http(s) 的 data-mail-src 不会被换成 src", async () => {
    const out = await signMailImages(env, '<img data-mail-src="javascript:alert(1)">')
    expect(out).not.toMatch(/<img[^>]*\ssrc=/)
  })

  it("同一张图只签一次（邮件里 logo 重复出现不会重复算 HMAC）", async () => {
    const html =
      '<img data-mail-src="https://cdn.example/same.png"><img data-mail-src="https://cdn.example/same.png">'
    const out = await signMailImages(env, html)
    const urls = [...out.matchAll(/src="([^"]+)"/g)].map((m) => m[1])
    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe(urls[1])
  })

  it("校验：签名被改动 / 地址被改动都失败", async () => {
    const url = new URL((await proxyUrl("https://cdn.example/a.png")).replace(/&amp;/g, "&"))
    const src = url.searchParams.get("src")!
    const sig = url.searchParams.get("s")!
    expect(await verifyMailImage(env, src, sig)).toBe(true)
    expect(await verifyMailImage(env, "https://cdn.example/b.png", sig)).toBe(false)
    expect(await verifyMailImage(env, src, sig.slice(0, -1) + "x")).toBe(false)
  })
})

describe("GET /api/mail/img：安全边界", () => {
  it("没有签名 / 签名不对 → 404（不是开放代理）", async () => {
    const bare = await fetchSelf(new Request("https://cloud.doulor.cn/api/mail/img?src=https://cdn.example/a.png"))
    expect(bare.status).toBe(404)

    const bad = await fetchSelf(
      new Request(
        "https://cloud.doulor.cn/api/mail/img?src=https://cdn.example/a.png&s=AAAAAAAAAAAAAAAAAAAAAA"
      )
    )
    expect(bad.status).toBe(404)
    // 两次都没真的去取图
    expect(seen).toHaveLength(0)
  })

  it("签名合法但目标是内网地址 → 404（SSRF 挡住，且不发请求）", async () => {
    for (const src of [
      "http://127.0.0.1/a.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/x.png",
      "http://192.168.1.1/x.png",
      "http://localhost/x.png",
    ]) {
      const res = await fetchSelf(new Request(await proxyUrl(src)))
      expect(res.status, src).toBe(404)
    }
    expect(seen).toHaveLength(0)
  })

  it("上游返回 HTML / SVG → 404（SVG 是可执行文档，不能进我们的域）", async () => {
    upstream = () => new Response("<html>x</html>", { status: 200, headers: { "Content-Type": "text/html" } })
    expect((await fetchSelf(new Request(await proxyUrl("https://cdn.example/a")))).status).toBe(404)

    upstream = () =>
      new Response('<svg onload="alert(1)"/>', { status: 200, headers: { "Content-Type": "image/svg+xml" } })
    expect((await fetchSelf(new Request(await proxyUrl("https://cdn.example/b")))).status).toBe(404)
  })

  it("上游 302 重定向 → 404（不跟随，避免被跳去内网）", async () => {
    upstream = () =>
      new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/a.png" } })
    expect((await fetchSelf(new Request(await proxyUrl("https://cdn.example/a")))).status).toBe(404)
  })

  it("上游声明超过体积上限 → 404", async () => {
    upstream = () =>
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(9 * 1024 * 1024) },
      })
    expect((await fetchSelf(new Request(await proxyUrl("https://cdn.example/a")))).status).toBe(404)
  })

  it("正常位图：200 + 正确的类型与防护头", async () => {
    const res = await fetchSelf(new Request(await proxyUrl("https://cdn.example/ok.png")))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox")
    // 沙箱 iframe 是不透明源，CORP 若写 same-origin 会把图全拦掉
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin")
    expect(res.headers.get("Cache-Control")).toContain("max-age")
    expect((await res.arrayBuffer()).byteLength).toBe(64)
  })

  it("本站自己的域名不代理（避免被当成绕过自家鉴权的跳板）", async () => {
    const res = await fetchSelf(
      new Request(await proxyUrl("https://cloud.doulor.cn/api/me"))
    )
    expect(res.status).toBe(404)
    expect(seen).toHaveLength(0)
  })
})
