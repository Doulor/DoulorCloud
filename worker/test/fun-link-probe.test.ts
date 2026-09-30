// 「网页分享 → 自动识别」的测试。
//
// 两件事必须锁住：
//   1. 解析要准：标题要解 HTML 实体、图标相对路径要补全、脏图标要能兜底；
//   2. 不能变成「拿 Worker 探内网 / 当免费代理」的工具 ⇒ 内网地址一律拒、图标只认库里存过的。
//
// 出站请求统一用替换 `globalThis.fetch` 的方式打桩（与本仓库其它测试一致），
// 否则会真的去打外网，又慢又不稳。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import { extractIconUrl, extractMetaDescription, extractTitle } from "../src/html-meta"
import { isPrivateOrLocalHost } from "../src/url-guard"

const PAGE = `<!doctype html><html><head>
<title>
  这个网站 &amp; 很有意思
</title>
<meta name="description" content="  带你逛一圈  ">
<link rel="icon" href="/static/icon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/static/touch.png" sizes="180x180">
</head><body>hi</body></html>`

const htmlResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })

let restoreFetch: (() => void) | null = null
/** example.com / example.org 上的请求都会走它 */
let responder: (url: string) => Response = () => htmlResponse(PAGE)

beforeEach(() => {
  responder = () => htmlResponse(PAGE)
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("example.com") || url.includes("example.org")) return responder(url)
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

const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

function probe(user: { cookie: string }, body: Record<string, unknown>) {
  return fetchSelf(authRequest(user, "/api/admin/fun-links/probe", jsonBody(body)))
}

interface ProbeDTO {
  title: string
  description: string
  iconUrl: string
  finalUrl: string
}

async function createLink(
  admin: { cookie: string },
  body: Record<string, unknown>
): Promise<{ id: string; iconUrl: string }> {
  const res = await fetchSelf(
    authRequest(
      admin,
      "/api/admin/fun-links",
      jsonBody({ title: "图标测试", url: "https://icon-host.example.com/p", ...body })
    )
  )
  expect(res.status).toBe(200)
  const { link } = await res.json<{ link: { id: string; iconUrl: string } }>()
  return { id: link.id, iconUrl: link.iconUrl }
}

// ---------------------------------------------------------------------------

describe("HTML 解析", () => {
  it("标题：解实体、折叠空白、最长 60 字", () => {
    expect(extractTitle("<title>\n  A &amp; B  \n</title>")).toBe("A & B")
    expect(extractTitle("<title>&#39;引号&#39; &lt;测试&gt;</title>")).toBe("'引号' <测试>")
    expect(extractTitle("<html>没有标题</html>")).toBe("")
    expect(extractTitle(`<title>${"字".repeat(80)}</title>`)).toHaveLength(60)
  })

  it("描述：优先 name=description，其次 og:description", () => {
    expect(extractMetaDescription(`<meta name="description" content=" 一句话 ">`)).toBe("一句话")
    expect(extractMetaDescription(`<meta property="og:description" content="og 的">`)).toBe("og 的")
    expect(
      extractMetaDescription(
        `<meta property="og:description" content="og 的"><meta name="description" content="正经的">`
      )
    ).toBe("正经的")
    expect(extractMetaDescription("<html></html>")).toBe("")
  })

  it("图标：相对路径补成绝对地址", () => {
    const html = `<link rel="icon" href="/static/i.png">`
    expect(extractIconUrl(html, "https://example.com/a/b")).toBe("https://example.com/static/i.png")
  })

  it("图标：多个候选挑尺寸最大的", () => {
    const html =
      `<link rel="icon" href="/small.png" sizes="16x16">` +
      `<link rel="icon" href="/big.png" sizes="96x96">`
    expect(extractIconUrl(html, "https://example.com/")).toBe("https://example.com/big.png")
  })

  it("图标：协议相对地址（//cdn…）也能补全", () => {
    const html = `<link rel="shortcut icon" href="//cdn.example.org/i.ico">`
    expect(extractIconUrl(html, "https://example.com/")).toBe("https://cdn.example.org/i.ico")
  })

  it("图标：只有 apple-touch-icon 时也用它", () => {
    const html = `<link rel="apple-touch-icon" href="/touch.png">`
    expect(extractIconUrl(html, "https://example.com/")).toBe("https://example.com/touch.png")
  })

  it("图标：没有 <link> 时兜底 /favicon.ico", () => {
    expect(extractIconUrl("<html></html>", "https://example.com/a/b")).toBe(
      "https://example.com/favicon.ico"
    )
  })

  it("图标：内联 data: 图标不算数，仍然兜底 favicon.ico", () => {
    const html = `<link rel="icon" href="data:image/png;base64,AAAA">`
    expect(extractIconUrl(html, "https://example.com/")).toBe("https://example.com/favicon.ico")
  })

  it("图标：rel 大小写与属性顺序不影响", () => {
    const html = `<link href="/x.png" REL="ICON">`
    expect(extractIconUrl(html, "https://example.com/")).toBe("https://example.com/x.png")
  })
})

describe("内网地址拦截（共用 url-guard）", () => {
  it("本地 / 私有网段 / IPv6 字面量一律拒绝", () => {
    for (const bad of [
      "http://localhost/",
      "http://api.localhost/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://172.16.5.4/",
      "http://169.254.1.1/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://nas.local/",
      "http://router.internal/",
    ]) {
      const host = new URL(bad).hostname.replace(/^\[|\]$/g, "")
      expect(isPrivateOrLocalHost(host), bad).toBe(true)
    }
  })

  it("公网地址放行", () => {
    for (const ok of ["https://example.com/", "http://www.qq.com/", "https://1.1.1.1/", "https://8.8.8.8/"]) {
      const host = new URL(ok).hostname
      expect(isPrivateOrLocalHost(host), ok).toBe(false)
    }
  })
})

describe("POST /api/admin/fun-links/probe", () => {
  it("非管理员 → 403", async () => {
    const user = await makeUser()
    const res = await probe(user, { url: "https://example.com/" })
    expect(res.status).toBe(403)
  })

  it("没填链接 / 非法协议 / 内网地址 → 400", async () => {
    const admin = await makeUser({ role: "admin" })
    expect((await probe(admin, {})).status).toBe(400)
    expect((await probe(admin, { url: "ftp://example.com/" })).status).toBe(400)
    expect((await probe(admin, { url: "不是网址" })).status).toBe(400)
    expect((await probe(admin, { url: "http://127.0.0.1/" })).status).toBe(400)
  })

  it("识别出标题 / 说明 / 图标（相对路径补成绝对）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await probe(admin, { url: "https://example.com/post" })
    expect(res.status).toBe(200)
    const body = await res.json<ProbeDTO>()
    expect(body.title).toBe("这个网站 & 很有意思")
    expect(body.description).toBe("带你逛一圈")
    expect(body.iconUrl).toBe("https://example.com/static/icon-32.png")
    expect(body.finalUrl).toContain("example.com")
  })

  it("对方报错 → 400 并带上状态码", async () => {
    responder = () => new Response("boom", { status: 502 })
    const admin = await makeUser({ role: "admin" })
    const res = await probe(admin, { url: "https://example.com/" })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toContain("502")
  })

  it("目标不是网页（图片）→ 400", async () => {
    responder = () => new Response("x", { status: 200, headers: { "content-type": "image/png" } })
    const admin = await makeUser({ role: "admin" })
    expect((await probe(admin, { url: "https://example.com/i.png" })).status).toBe(400)
  })
})

describe("GET /api/fun-links/icon/:id", () => {
  const pngResponse = () =>
    new Response("PNGDATA", { status: 200, headers: { "content-type": "image/png" } })

  it("未登录 → 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/fun-links/icon/whatever"))
    expect(res.status).toBe(401)
  })

  it("条目没填图标 → 404", async () => {
    const admin = await makeUser({ role: "admin" })
    const { id } = await createLink(admin, { iconUrl: "" })
    expect((await fetchSelf(authRequest(admin, `/api/fun-links/icon/${id}`))).status).toBe(404)
  })

  it("不存在的 id → 404", async () => {
    const admin = await makeUser({ role: "admin" })
    expect((await fetchSelf(authRequest(admin, "/api/fun-links/icon/nope"))).status).toBe(404)
  })

  it("正常返回图片，并带上一天缓存", async () => {
    responder = pngResponse
    const admin = await makeUser({ role: "admin" })
    const { id } = await createLink(admin, { iconUrl: "https://example.com/i.png" })
    const res = await fetchSelf(authRequest(admin, `/api/fun-links/icon/${id}`))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toContain("max-age=86400")
    // 用 arrayBuffer 读：对 image/png 调 .text() 会触发一条无害但吵人的运行时警告
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("PNGDATA")
  })

  it("对方返回的不是图片 → 404（别把 HTML 当图标吐给前端）", async () => {
    responder = () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } })
    const admin = await makeUser({ role: "admin" })
    const { id } = await createLink(admin, { iconUrl: "https://example.com/page" })
    expect((await fetchSelf(authRequest(admin, `/api/fun-links/icon/${id}`))).status).toBe(404)
  })

  it("对方 404 → 也回 404", async () => {
    responder = () => new Response("", { status: 404 })
    const admin = await makeUser({ role: "admin" })
    const { id } = await createLink(admin, { iconUrl: "https://example.com/missing.png" })
    expect((await fetchSelf(authRequest(admin, `/api/fun-links/icon/${id}`))).status).toBe(404)
  })

  it("下架的条目：普通用户取不到，管理员还能取", async () => {
    responder = pngResponse
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const { id } = await createLink(admin, { iconUrl: "https://example.com/i.png", enabled: false })
    expect((await fetchSelf(authRequest(user, `/api/fun-links/icon/${id}`))).status).toBe(404)
    expect((await fetchSelf(authRequest(admin, `/api/fun-links/icon/${id}`))).status).toBe(200)
  })
})

describe("图标地址的保存校验", () => {
  it("非法图标地址 → 400；留空允许", async () => {
    const admin = await makeUser({ role: "admin" })
    const bad = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/fun-links",
        jsonBody({ title: "x", url: "https://ok.example.com", iconUrl: "javascript:alert(1)" })
      )
    )
    expect(bad.status).toBe(400)

    const empty = await createLink(admin, { iconUrl: "" })
    expect(empty.iconUrl).toBe("")
  })

  it("只改图标不会动其它字段", async () => {
    const admin = await makeUser({ role: "admin" })
    const { id } = await createLink(admin, { description: "原说明", iconUrl: "" })

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/fun-links/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iconUrl: "https://cdn.example.org/new.png" }),
      })
    )
    expect(res.status).toBe(200)
    const { link } = await res.json<{ link: { iconUrl: string; description: string; title: string } }>()
    expect(link.iconUrl).toBe("https://cdn.example.org/new.png")
    expect(link.description).toBe("原说明")
    expect(link.title).toBe("图标测试")
  })
})
