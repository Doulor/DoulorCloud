/**
 * 邮件图片代理：签名、地址校验、读取侧改写。
 *
 * 为什么要有这一层（而不是直接渲染邮件里的 `<img src>`）：
 *   直接渲染 = 发件人往图片地址里塞一个唯一 ID，就能知道**谁、在什么时间、
 *   从哪个 IP** 打开了邮件（追踪像素）。这也是主流邮箱默认拦图片的原因。
 *   走我们自己的代理之后，发件人只看得到 Cloudflare 的出口 IP。
 *
 * 残留风险（如实写在这里，别当成已解决）：
 *   · 「这封信被打开了」这件事，仍可能被**唯一的图片 URL** 暴露 —— 我们能隐藏
 *     用户的 IP / 地区，但隐藏不了「这个 URL 被请求过」。要彻底消除只能默认
 *     不加载图片（Gmail 对陌生发件人就是这么做的）。本站选择可用性优先。
 *   · 代理本身要能拒绝：非图片类型（尤其 SVG，可内嵌脚本）、内网地址、
 *     无限重定向、超大响应。这些检查都在 handlers/mail-image.ts。
 *
 * 签名为什么放在**读取时**而不是入库时：
 *   入库时签的链接会跟着 SESSION_SECRET 一起失效（换密钥后旧邮件里的图片全裂）。
 *   读取时签，签名永远用当下这把密钥，历史邮件也不会因换密钥而坏掉。
 */
import type { Env } from "./env"
import { timingSafeEqual } from "./crypto"

const encoder = new TextEncoder()

/** 代理接口路径（挂在 API Worker 的 /api 命名空间下） */
export const MAIL_IMAGE_PATH = "/api/mail/img"

function siteOrigin(env: Env): string {
  return `https://cloud.${env.ROOT_DOMAIN || "doulor.cn"}`
}

function base64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function sign(secret: string, src: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`mail-img:v1:${src}`))
  )
  return base64url(sig.slice(0, 16))
}

/** 原始图片地址 → 我们自己的代理地址（无密钥时返回 null） */
export async function mailImageUrl(env: Env, src: string): Promise<string | null> {
  if (!env.SESSION_SECRET) return null
  const q = new URLSearchParams({ src, s: await sign(env.SESSION_SECRET, src) })
  return `${siteOrigin(env)}${MAIL_IMAGE_PATH}?${q.toString()}`
}

/** 校验代理请求上的签名 */
export async function verifyMailImage(env: Env, src: string, sig: string): Promise<boolean> {
  if (!env.SESSION_SECRET || !src || !sig) return false
  return timingSafeEqual(sig, await sign(env.SESSION_SECRET, src))
}

/** 把消毒器写下的 data-mail-src 换成真正的代理地址 */
function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/**
 * 读取邮件 HTML 时调用：给每张图片签一个代理地址。
 *
 * 没配 SESSION_SECRET 时**原样返回**（图片不显示）—— 失败方向必须是"不加载"，
 * 绝不能退化成"直接连原地址"，那等于把追踪像素又放回来。
 */
export async function signMailImages(env: Env, html: string | null | undefined): Promise<string> {
  if (!html || !html.includes("data-mail-src")) return html ?? ""
  if (!env.SESSION_SECRET) return html

  // 同一地址在邮件里常重复出现（logo、社交图标），先算出唯一集合再一次签完
  const found = new Set<string>()
  for (const m of html.matchAll(/data-mail-src="([^"]*)"/g)) {
    found.add(unescapeAttr(m[1]))
  }
  const signed = new Map<string, string>()
  for (const src of found) {
    if (!/^https?:\/\//i.test(src)) continue
    const url = await mailImageUrl(env, src)
    if (url) signed.set(src, url)
  }

  return html.replace(/data-mail-src="([^"]*)"/g, (whole, raw: string) => {
    const url = signed.get(unescapeAttr(raw))
    // 签不出来的（非法协议 / 没密钥）保持 data-mail-src：浏览器不会加载它
    return url ? `src="${escapeAttr(url)}"` : whole
  })
}
