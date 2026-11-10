/**
 * 邮件退订：GET /api/mail/unsubscribe（确认页）+ POST /api/mail/unsubscribe（执行）。
 *
 * 为什么 GET 不直接退订：企业邮箱 / 安全网关会**预取**邮件里的每个链接做扫描，
 * GET 有副作用就会出现「用户什么都没点，通知却被关了」。所以：
 *   · GET  只渲染一个确认页（一个按钮，POST 回同一地址）；
 *   · POST 才真正改开关 —— 这也正是 RFC 8058 一键退订的约定
 *     （邮件客户端 POST `List-Unsubscribe=One-Click` 到 List-Unsubscribe 的地址）。
 *
 * 身份完全来自 URL 上的 HMAC 签名（见 ../mail-unsubscribe.ts），不读会话 cookie，
 * 因此 index.ts 的跨站校验对这条路径豁免：没有可被借用的会话身份。
 */
import type { Env } from "../env"
import { audit } from "../settings"
import {
  UNSUBSCRIBE_COLUMNS,
  verifyUnsubscribe,
  type UnsubscribeCategory,
} from "../mail-unsubscribe"

const CATEGORY_LABELS: Record<UnsubscribeCategory, string> = {
  announcements: "站点公告邮件",
  personal: "个人通知邮件（社区互动、反馈回复等）",
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function page(env: Env, title: string, bodyHtml: string, status = 200): Response {
  const settingsUrl = `https://cloud.${env.ROOT_DOMAIN || "doulor.cn"}/dashboard/settings?tab=notify`
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Doulor Cloud</title>
<style>
  body{margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#111827}
  main{max-width:440px;margin:12vh auto 0;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px}
  h1{margin:0 0 12px;font-size:18px}
  p{margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151}
  button{appearance:none;border:0;border-radius:8px;background:#111827;color:#fff;font-size:14px;font-weight:600;padding:10px 18px;cursor:pointer}
  button:focus-visible,a:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
  a{color:#2563eb}
  .muted{font-size:12px;color:#6b7280;margin-top:16px}
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  ${bodyHtml}
  <p class="muted">也可以在 <a href="${esc(settingsUrl)}">通知设置</a> 里随时调整各类邮件。</p>
</main>
</body>
</html>`
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      // 页面没有任何脚本；表单只允许提交回本站
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  })
}

function invalidLink(env: Env): Response {
  return page(
    env,
    "链接无效",
    "<p>这个退订链接不完整或已失效。请从最新一封邮件底部的「退订」重新打开，或登录后在设置页关闭。</p>",
    400
  )
}

/** GET：确认页（不产生任何副作用） */
export async function unsubscribePage(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const v = await verifyUnsubscribe(env, url.searchParams)
  if (!v) return invalidLink(env)
  // 表单 POST 回同一地址（签名参数留在 query 里），与 One-Click 走同一段处理逻辑
  const action = `${url.pathname}?${url.searchParams.toString()}`
  return page(
    env,
    "退订邮件",
    `<p>确认后将不再向你发送<strong>${esc(CATEGORY_LABELS[v.cat])}</strong>。验证码、找回密码等账号安全邮件不受影响。</p>
     <form method="post" action="${esc(action)}">
       <input type="hidden" name="List-Unsubscribe" value="One-Click">
       <button type="submit">确认退订</button>
     </form>`
  )
}

/** POST：执行退订（确认页按钮 + RFC 8058 One-Click 共用） */
export async function unsubscribe(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const v = await verifyUnsubscribe(env, url.searchParams)
  if (!v) return invalidLink(env)

  const column = UNSUBSCRIBE_COLUMNS[v.cat]
  // 列名来自固定映射表，不是用户输入
  const res = await env.DB.prepare(`UPDATE users SET ${column} = 0, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), v.uid)
    .run()
  if ((res.meta?.changes ?? 0) > 0) {
    await audit(env, v.uid, "mail.unsubscribe", `通过邮件退订：${CATEGORY_LABELS[v.cat]}`)
  }

  // 用户已注销等情况也回成功页：对邮件客户端来说「此后不再收到」这个结果是成立的
  return page(
    env,
    "已退订",
    `<p>已为你关闭<strong>${esc(CATEGORY_LABELS[v.cat])}</strong>。之后想重新接收，可以在通知设置里打开。</p>`
  )
}
