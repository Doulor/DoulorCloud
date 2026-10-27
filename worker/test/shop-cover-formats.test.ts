// 商品封面格式放开（2026-10-26）回归测试
//
// 背景：封面此前只认 http(s) 直链与 /api/shop-img/ 本地上传路径，粘贴
// data:image/... 一律 400「封面图地址必须是 http(s) 链接」；且商品保存接口
// 的 JSON 请求体上限 16 KB，Data URL 就算放行也会先撞「请求内容过大」。
//
// 修复后封面允许三种形态：http(s) / /api/shop-img/ / data:image/（白名单
// 类型 + 100 KB 长度上限），保存接口体上限放宽到 160 KB；本地上传放开 SVG
// （1 MB 上限 + 轻量嗅探），读取端 SVG 直链带 CSP: sandbox。
//
// 本文件覆盖：
//   1. sanitizeProductInput 纯函数：三种合法形态、坏值拒绝、长度上限、
//      http 链接 500 字符截断的老行为不回退
//   2. isPlausibleSvg：SVG 嗅探（有 <svg、无 <script）
//   3. 上传接口的类型门（无 R2 环境：非法类型 400 在存储检查之前）
//   4. SELF 集成：90 KB Data URL 能真实走通 POST /api/points/products；
//      120 KB Data URL 被字段上限拦下（而非请求体上限的模糊报错）

import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import {
  isDataImageUrl,
  sanitizeProductInput,
  MAX_COVER_DATA_URL_CHARS,
} from "../src/points-shop"
import { isPlausibleSvg, hardenShopCoverResponse } from "../src/handlers/points"

const PNG_B64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const SVG_RAW = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'></svg>"
const SVG_ENCODED = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E"
const SVG_B64 = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'></svg>")}`

/** 构造一个 base64 体长 n 字符的 png Data URL */
function b64Cover(n: number): string {
  return `data:image/png;base64,${"A".repeat(n)}`
}

function expectCoverError(fn: () => unknown, needle: string): void {
  try {
    fn()
    expect.unreachable("应当抛出 ApiError")
  } catch (err) {
    expect((err as Error).message).toContain(needle)
  }
}

describe("isDataImageUrl（Data URL 白名单判定）", () => {
  it("放行白名单类型：png base64 / svg 原文 / svg URL 编码 / svg base64", () => {
    expect(isDataImageUrl(PNG_B64)).toBe(true)
    expect(isDataImageUrl(SVG_RAW)).toBe(true)
    expect(isDataImageUrl(SVG_ENCODED)).toBe(true)
    expect(isDataImageUrl(SVG_B64)).toBe(true)
  })

  it("拒绝非 image/* 与不在白名单的 mediatype", () => {
    expect(isDataImageUrl("data:text/html;base64,PGI+aGk8L2I+")).toBe(false)
    expect(isDataImageUrl("data:application/octet-stream;base64,AAA")).toBe(false)
    expect(isDataImageUrl("data:image/svg+xml-compressed;base64,AAA")).toBe(false)
    expect(isDataImageUrl("data:,hello")).toBe(false)
  })

  it("base64 标签下的体必须是 base64 字符集", () => {
    expect(isDataImageUrl("data:image/png;base64,<script>")).toBe(false)
    expect(isDataImageUrl("data:image/png;base64,")).toBe(false)
    expect(isDataImageUrl("data:image/png;base64,abc def")).toBe(false) // 中间空格不行
    expect(isDataImageUrl("data:image/png;base64,abc=\n")).toBe(true) // 首尾空白容忍
  })

  it("javascript: 等伪协议与空体不通过", () => {
    expect(isDataImageUrl("javascript:alert(1)")).toBe(false)
    expect(isDataImageUrl("data:image/png,")).toBe(false)
  })
})

describe("sanitizeProductInput —— 封面三种合法形态", () => {
  const base = { name: "测试商品", price: 10, delivery: "manual" }

  it("data:image Data URL 原样保留（不截断、不改写）", () => {
    const out = sanitizeProductInput({ ...base, imageUrl: SVG_RAW })
    expect(out.imageUrl).toBe(SVG_RAW)
    const out2 = sanitizeProductInput({ ...base, imageUrl: PNG_B64 })
    expect(out2.imageUrl).toBe(PNG_B64)
  })

  it("超长 Data URL 报「Data URL 过长」且上限为 100 KB", () => {
    expect(MAX_COVER_DATA_URL_CHARS).toBe(100_000)
    expectCoverError(
      () => sanitizeProductInput({ ...base, imageUrl: b64Cover(MAX_COVER_DATA_URL_CHARS) }),
      "Data URL 过长"
    )
    // 恰好在上限内的能过
    const ok = sanitizeProductInput({
      ...base,
      imageUrl: b64Cover(MAX_COVER_DATA_URL_CHARS - "data:image/png;base64,".length),
    })
    expect(ok.imageUrl).not.toBeNull()
  })

  it("http(s) 与 /api/shop-img/ 老行为不回退（含 500 字符截断）", () => {
    expect(sanitizeProductInput({ ...base, imageUrl: "https://example.com/a.png" }).imageUrl).toBe(
      "https://example.com/a.png"
    )
    expect(
      sanitizeProductInput({ ...base, imageUrl: "/api/shop-img/u-1/abc.png" }).imageUrl
    ).toBe("/api/shop-img/u-1/abc.png")
    const long = `https://example.com/${"x".repeat(600)}`
    const out = sanitizeProductInput({ ...base, imageUrl: long })
    expect(out.imageUrl).toBe(long.slice(0, 500))
  })

  it("坏值依旧拒绝：伪协议 / 任意相对路径 / 空 data 体", () => {
    expectCoverError(
      () => sanitizeProductInput({ ...base, imageUrl: "javascript:alert(1)" }),
      "封面图地址必须是"
    )
    expectCoverError(
      () => sanitizeProductInput({ ...base, imageUrl: "ftp://example.com/a.png" }),
      "封面图地址必须是"
    )
    expectCoverError(
      () => sanitizeProductInput({ ...base, imageUrl: "data:text/html;base64,PGI+" }),
      "封面图地址必须是"
    )
  })
})

describe("isPlausibleSvg（上传侧嗅探）", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

  it("认得正常 SVG（含 xml 声明）", () => {
    expect(isPlausibleSvg(bytes("<?xml version='1.0'?><svg xmlns='x'></svg>"))).toBe(true)
    expect(isPlausibleSvg(bytes("<SVG viewBox='0 0 1 1'></SVG>"))).toBe(true)
  })

  it("拒收非 SVG 与带 <script> 的 SVG", () => {
    expect(isPlausibleSvg(bytes("<html><body>hi</body></html>"))).toBe(false)
    expect(isPlausibleSvg(bytes("plain text"))).toBe(false)
    expect(
      isPlausibleSvg(bytes("<svg xmlns='x'><script>alert(1)</script></svg>"))
    ).toBe(false)
  })
})

describe("hardenShopCoverResponse（读取端响应头）", () => {
  const hardened = (ct: string) =>
    new Response("bytes", {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Content-Disposition": "attachment; filename*=UTF-8''x",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    })

  it("位图：换成一年 immutable 强缓存，类型不动", () => {
    const res = hardenShopCoverResponse(hardened("image/png"), "abc12345.png", hardened("image/png"))
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable")
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Content-Security-Policy")).toBeNull()
  })

  it("SVG：放开内联 + CSP sandbox（顶层文档打开也执行不了脚本）", () => {
    const res = hardenShopCoverResponse(
      hardened("application/octet-stream"),
      "abc12345.svg",
      hardened("application/octet-stream") // 模拟 harden 的降级结果
    )
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(res.headers.get("Content-Disposition")).toContain("inline")
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable")
  })

  it("CSP sandbox 不得夹带 allow-scripts / allow-same-origin", () => {
    const res = hardenShopCoverResponse(hardened("x"), "a.svg", hardened("x"))
    const csp = res.headers.get("Content-Security-Policy") ?? ""
    expect(csp).not.toContain("allow-scripts")
    expect(csp).not.toContain("allow-same-origin")
  })
})

describe("POST /api/points/product/image —— 类型门（无 R2 环境）", () => {
  it("非法类型在存储检查之前就被 400 拒掉", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/points/product/image", {
        method: "POST",
        body: "<html></html>",
        headers: { "Content-Type": "text/html" },
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ code?: string }>()
    expect(body.code).toBe("INVALID_TYPE")
  })

  it("SVG 类型通过类型门（无 R2 → 503 而不是 400）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/points/product/image", {
        method: "POST",
        body: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        headers: { "Content-Type": "image/svg+xml" },
      })
    )
    expect(res.status).toBe(503)
    const body = await res.json<{ code?: string }>()
    expect(body.code).toBe("R2_NOT_CONFIGURED")
  })
})

describe("POST /api/points/products —— Data URL 端到端", () => {
  it("90 KB 的 base64 Data URL 能真实保存成功（请求体上限已放宽）", async () => {
    const u = await makeUser()
    const cover = b64Cover(90_000)
    const res = await fetchSelf(
      authRequest(u, "/api/points/products", {
        method: "POST",
        body: JSON.stringify({
          name: "Data URL 封面回归",
          price: 20,
          delivery: "manual",
          imageUrl: cover,
        }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ product: { imageUrl: string | null } }>()
    expect(body.product.imageUrl).toBe(cover)
  })

  it("120 KB 的 Data URL 被字段上限拦下，报「Data URL 过长」", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/points/products", {
        method: "POST",
        body: JSON.stringify({
          name: "超长封面",
          price: 20,
          delivery: "manual",
          imageUrl: b64Cover(120_000),
        }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ error?: string }>()
    expect(body.error ?? "").toContain("Data URL 过长")
  })
})
