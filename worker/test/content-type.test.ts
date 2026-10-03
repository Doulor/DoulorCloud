/**
 * 回归测试：用户上传内容的「可内联展示」判定（2026-09-25 审计 P0-1）。
 *
 * 为什么必须有这个测试：
 *   本仓库原先在 5 个 handler 里各写了一份类型白名单，其中三份都把
 *   `image/svg+xml` 当成了安全类型。SVG 是可执行文档 —— 它作为顶层文档
 *   加载时，内嵌 `<script>` 会以该 URL 所属源执行，而直链 `/dl/*` 与
 *   分享箱 `/api/tempbox/*` 都挂在应用主源上（会话 Cookie 是 host-only，
 *   不会发到子域），所以这是一个**同源存储型 XSS = 完整账户接管**。
 *
 *   这个漏洞能活到审计，是因为**没有任何测试覆盖 tempbox 与直链**：
 *   上传时的 Content-Type 完全由上传者控制（预签名 PUT 只签 host、
 *   proxyUpload 直接取请求头），所以唯一兜底就是这里的判定。
 *   一旦有人「顺手放宽」白名单，本测试必须立刻红。
 */
import { describe, it, expect } from "vitest"
import {
  normalizeContentType,
  isInlineSafe,
  contentDispositionFor,
  hardenUserContentResponse,
} from "../src/content-type"

describe("normalizeContentType", () => {
  it("去掉 charset 参数并转小写", () => {
    expect(normalizeContentType("IMAGE/PNG; charset=utf-8")).toBe("image/png")
    expect(normalizeContentType("  image/jpeg  ")).toBe("image/jpeg")
    expect(normalizeContentType(null)).toBe("")
    expect(normalizeContentType(undefined)).toBe("")
  })
})

describe("isInlineSafe —— 必须拒绝的可执行/可脚本化类型", () => {
  // 这一组是本测试的核心：任何一个变成 true 都意味着账户接管风险回归
  const dangerous = [
    "image/svg+xml",
    "image/svg", // 非标准写法，历史上同样被浏览器当 SVG 处理
    "IMAGE/SVG+XML", // 大小写变体
    "image/svg+xml; charset=utf-8", // 带参数变体
    "text/html",
    "text/html;charset=UTF-8",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
    "application/mathml+xml",
    "application/rss+xml",
    "application/atom+xml",
    // 未来的 XML 家族类型应被 `+xml` 后缀规则自动拦下
    "application/whatever+xml",
  ]

  for (const t of dangerous) {
    it(`拒绝 ${t}`, () => {
      expect(isInlineSafe(t)).toBe(false)
    })
  }

  it("空值一律不安全（默认拒绝）", () => {
    expect(isInlineSafe("")).toBe(false)
    expect(isInlineSafe(null)).toBe(false)
    expect(isInlineSafe(undefined)).toBe(false)
  })
})

describe("isInlineSafe —— 允许正常展示的类型", () => {
  const safe = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "audio/mpeg",
    "text/plain",
    "application/pdf",
  ]
  for (const t of safe) {
    it(`允许 ${t}`, () => {
      expect(isInlineSafe(t)).toBe(true)
    })
  }

  it("未知类型默认不内联", () => {
    expect(isInlineSafe("application/zip")).toBe(false)
    expect(isInlineSafe("application/octet-stream")).toBe(false)
    expect(isInlineSafe("text/csv")).toBe(false)
  })
})

describe("contentDispositionFor", () => {
  it("危险类型必须降级为 attachment + octet-stream", () => {
    const r = contentDispositionFor("image/svg+xml", "evil.svg")
    // 只改 Disposition 不够：部分浏览器仍会按声明的类型嗅探渲染
    expect(r.contentType).toBe("application/octet-stream")
    expect(r.contentDisposition.startsWith("attachment;")).toBe(true)
  })

  it("安全类型保持 inline 且保留原类型", () => {
    const r = contentDispositionFor("image/png", "a.png")
    expect(r.contentType).toBe("image/png")
    expect(r.contentDisposition.startsWith("inline;")).toBe(true)
  })

  it("文件名做百分号编码，注入不进 header", () => {
    const r = contentDispositionFor("image/png", 'a";\r\nX-Evil: 1.png')
    expect(r.contentDisposition.includes("\r")).toBe(false)
    expect(r.contentDisposition.includes("\n")).toBe(false)
    expect(r.contentDisposition.includes('"')).toBe(false)
  })

  it("空文件名有兜底", () => {
    expect(contentDispositionFor("image/png", "").contentDisposition).toContain("file")
  })
})

describe("hardenUserContentResponse", () => {
  it("把 R2 透传响应重新收口并加 nosniff", async () => {
    const upstream = new Response("x", {
      headers: { "Content-Type": "image/svg+xml" },
    })
    const hardened = hardenUserContentResponse(upstream, "evil.svg")
    expect(hardened.headers.get("Content-Type")).toBe("application/octet-stream")
    expect(hardened.headers.get("Content-Disposition")).toContain("attachment")
    expect(hardened.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("不给用户内容留下可共享缓存（默认 no-store）", () => {
    const hardened = hardenUserContentResponse(
      new Response("x", { headers: { "Content-Type": "image/png" } }),
      "a.png"
    )
    expect(hardened.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("上游已显式声明 Cache-Control 时不覆盖", () => {
    const hardened = hardenUserContentResponse(
      new Response("x", {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60" },
      }),
      "a.png"
    )
    expect(hardened.headers.get("Cache-Control")).toBe("public, max-age=60")
  })
})
