/**
 * 邮件退订链接的签名与校验（无状态，不建表）。
 *
 * 为什么用 HMAC 签名而不是「登录后去设置页关」：
 *   · Gmail / Yahoo 对批量发件人要求 RFC 8058 一键退订 —— 邮件客户端会**不带任何 cookie**
 *     直接 POST 到 `List-Unsubscribe` 里的地址，只能靠 URL 自身证明身份；
 *   · 让用户为了退订先登录，是最常见的「被点举报垃圾邮件」原因，伤的是整个发信域名的信誉。
 *
 * 签名内容 = `用户 ID + 类别`，不含过期时间：退订链接在旧邮件里也必须一直能用
 * （RFC 8058 的明确要求）。链接泄露的最坏后果只是「替他关掉一类通知」，
 * 而且用户随时能在设置页重新打开 —— 这个风险面与「永不过期」是匹配的。
 *
 * 密钥复用 SESSION_SECRET，消息里带 `mail-unsub:v1:` 前缀做域隔离，
 * 不会与其它用 SESSION_SECRET 的场景（AES-GCM 派生、frp 签名）产生可互换的签名。
 */
import type { Env } from "./env"
import { timingSafeEqual } from "./crypto"

/**
 * 可退订的邮件类别 → 对应 users 表上的开关列。
 *   · `announcements` —— 站点公告群发（notify_announcements）
 *   · `personal`      —— 与本人相关的通知：社区互动、反馈回复（notify_enabled）
 * 验证码 / 重置密码 / 2FA 这类事务邮件**不可退订**，所以不在这里。
 */
export type UnsubscribeCategory = "announcements" | "personal"

export const UNSUBSCRIBE_COLUMNS: Record<UnsubscribeCategory, "notify_announcements" | "notify_enabled"> = {
  announcements: "notify_announcements",
  personal: "notify_enabled",
}

export function isUnsubscribeCategory(v: string): v is UnsubscribeCategory {
  return v === "announcements" || v === "personal"
}

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function sign(secret: string, uid: string, cat: UnsubscribeCategory): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`mail-unsub:v1:${uid}:${cat}`))
  )
  // 截到 128 bit：URL 短一些，强度对「关一个通知开关」绰绰有余
  return base64url(sig.slice(0, 16))
}

/** 站点根地址（退订接口挂在 API Worker 的 /api/* 路由下） */
function siteOrigin(env: Env): string {
  return `https://cloud.${env.ROOT_DOMAIN || "doulor.cn"}`
}

/**
 * 生成某用户某类别的退订地址。
 *
 * 没配 SESSION_SECRET 时返回 null —— 调用方据此退回「去设置页关闭」的普通链接，
 * 也不发 List-Unsubscribe 头（宁可没有，也不能发一个点了没用的链接）。
 */
export async function unsubscribeUrl(
  env: Env,
  uid: string,
  cat: UnsubscribeCategory
): Promise<string | null> {
  if (!env.SESSION_SECRET || !uid) return null
  const sig = await sign(env.SESSION_SECRET, uid, cat)
  const q = new URLSearchParams({ u: uid, c: cat, s: sig })
  return `${siteOrigin(env)}/api/mail/unsubscribe?${q.toString()}`
}

/** 校验退订参数；通过返回 { uid, cat }，否则 null */
export async function verifyUnsubscribe(
  env: Env,
  params: URLSearchParams
): Promise<{ uid: string; cat: UnsubscribeCategory } | null> {
  const uid = (params.get("u") ?? "").trim()
  const cat = (params.get("c") ?? "").trim()
  const sig = (params.get("s") ?? "").trim()
  if (!env.SESSION_SECRET || !uid || !sig || uid.length > 64 || !isUnsubscribeCategory(cat)) {
    return null
  }
  const expected = await sign(env.SESSION_SECRET, uid, cat)
  return timingSafeEqual(sig, expected) ? { uid, cat } : null
}
