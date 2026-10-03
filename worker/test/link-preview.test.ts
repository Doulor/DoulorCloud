// 链接卡片预览的解析与缓存。
//
// 重点锁两件事：
//   1. og:image 缺失时也要给出站点图标（icon）—— 否则卡片左侧是空的，
//      文字紧贴边缘，看着像坏了（QQ 群邀请页 `qm.qq.com/q/xxx` 就是这种）；
//   2. 相对路径（og:image / favicon）要补成绝对地址，不然前端加载不了。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { getLinkPreview } from "../src/link-preview"

/** 类似 QQ 群邀请页：有标题和描述，但没有任何 og:image */
const PAGE_NO_OG = `<!doctype html><html><head>
<title>QQ群</title>
<meta name="description" content="QQ">
</head><body>x</body></html>`

const PAGE_FULL = `<!doctype html><html><head>
<meta property="og:title" content="卡片标题">
<meta property="og:description" content="卡片描述">
<meta property="og:image" content="/img/cover.png">
<meta property="og:site_name" content="示例站">
<link rel="icon" href="https://cdn.example.org/i.png" sizes="64x64">
</head></html>`

const PAGE_NO_TITLE = `<!doctype html><html><head>
<meta name="description" content="只有描述">
</head></html>`

let restoreFetch: (() => void) | null = null
let html = PAGE_FULL
/** 打桩里真实发生的抓取次数（用来验证缓存确实生效） */
let hits = 0

beforeEach(() => {
  html = PAGE_FULL
  hits = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes(".example.com")) {
      hits++
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

describe("getLinkPreview", () => {
  it("完整 og 标签：标题 / 描述 / 站点名 / 图标都在，相对图片补成绝对", async () => {
    const p = await getLinkPreview(env, "https://preview-full.example.com/page")
    expect(p).not.toBeNull()
    expect(p!.title).toBe("卡片标题")
    expect(p!.description).toBe("卡片描述")
    expect(p!.siteName).toBe("示例站")
    expect(p!.image).toBe("https://preview-full.example.com/img/cover.png")
    expect(p!.icon).toBe("https://cdn.example.org/i.png")
  })

  it("没有 og:image 时（QQ 群那种页面）仍给出站点图标兜底", async () => {
    html = PAGE_NO_OG
    const p = await getLinkPreview(env, "https://preview-qq.example.com/q/abc")
    expect(p).not.toBeNull()
    expect(p!.title).toBe("QQ群")
    expect(p!.image).toBeNull()
    // 页面没声明 <link rel="icon"> ⇒ 兜底到站点根下的 /favicon.ico
    expect(p!.icon).toBe("https://preview-qq.example.com/favicon.ico")
  })

  it("连标题都没有 → 返回 null（调用方回退普通链接）", async () => {
    html = PAGE_NO_TITLE
    const p = await getLinkPreview(env, "https://preview-notitle.example.com/x")
    expect(p).toBeNull()
  })

  it("同一个 URL 第二次走缓存，不再抓取", async () => {
    const url = "https://preview-cache.example.com/p"
    const first = await getLinkPreview(env, url)
    expect(first).not.toBeNull()
    expect(hits).toBe(1)

    const second = await getLinkPreview(env, url)
    expect(second).not.toBeNull()
    expect(second!.icon).toBe(first!.icon)
    expect(hits).toBe(1) // 没有第二次抓取
  })
})
