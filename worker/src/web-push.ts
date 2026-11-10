/**
 * Web Push（服务端）—— VAPID 签名 + RFC 8291 载荷加密。
 *
 * 为什么值得单独一层：轮询在手机上先天不灵（浏览器把后台定时器节流到 ~1 次/分钟，
 * App 的 WebView 进后台直接冻结）。Web Push 是"服务端一推、Service Worker 立刻醒"，
 * 页面关着也能弹 —— 这是站内通知能做到"即时"的唯一正路。
 *
 * 用到的三份标准（都在 WebCrypto 里现成支持，不需要 Node 的 crypto / web-push 包）：
 *   · RFC 8291 —— 载荷加密（ECDH P-256 → HKDF-SHA256 → AES-128-GCM，aes128gcm 格式）
 *   · RFC 8188 —— 分帧头部（salt | rs | idlen | keyid | ciphertext）
 *   · RFC 8292 —— VAPID（ES256 JWT，放在 Authorization 头）
 *
 * ⚠️ 这里的每个字节顺序都按标准来，改之前先跑 test/web-push.test.ts 的往返用例：
 *    它用"客户端私钥"把密文解回来，等价于浏览器侧的解密流程。
 */
import type { Env } from "./env"

/** 订阅行 */
export interface PushSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

/* ---- base64url ---- */

export function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/* ---- HKDF-SHA256（WebCrypto 一次调用即 extract+expand）---- */

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  len: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    len * 8
  )
  return new Uint8Array(bits)
}

/* ---- VAPID 密钥（全局一份，存 D1；只有这里有读写）---- */

interface VapidKeys {
  privateJwk: JsonWebKey
  publicRaw: Uint8Array
}

let vapidCache: VapidKeys | null = null

/**
 * 取（或首次生成）VAPID 密钥。
 *
 * 为什么懒生成 + 落库：密钥必须长期稳定（换了以后所有旧订阅会失效），
 * 而 Worker 没有可靠的全局状态，只能存 D1。缓存只是 isolate 内的加速。
 */
export async function getVapidKeys(env: Env): Promise<VapidKeys> {
  if (vapidCache) return vapidCache

  const row = await env.DB.prepare(
    "SELECT private_jwk, public_raw FROM push_vapid_keys WHERE id = 1"
  ).first<{ private_jwk: string; public_raw: string }>()

  if (row) {
    vapidCache = {
      privateJwk: JSON.parse(row.private_jwk) as JsonWebKey,
      publicRaw: b64uDecode(row.public_raw),
    }
    return vapidCache
  }

  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT OR IGNORE INTO push_vapid_keys (id, private_jwk, public_raw, created_at) VALUES (1, ?, ?, ?)"
  )
    .bind(JSON.stringify(privateJwk), b64uEncode(publicRaw), now)
    .run()

  // 并发下可能别的 isolate 抢先写入 —— 重新读一次以库里的为准
  const fresh = await env.DB.prepare(
    "SELECT private_jwk, public_raw FROM push_vapid_keys WHERE id = 1"
  ).first<{ private_jwk: string; public_raw: string }>()
  vapidCache = fresh
    ? { privateJwk: JSON.parse(fresh.private_jwk) as JsonWebKey, publicRaw: b64uDecode(fresh.public_raw) }
    : { privateJwk, publicRaw }
  return vapidCache
}

/** 给前端订阅用的 applicationServerKey（base64url 的公钥原始点） */
export async function vapidPublicKey(env: Env): Promise<string> {
  const keys = await getVapidKeys(env)
  return b64uEncode(keys.publicRaw)
}

/** VAPID 的 Authorization 头（ES256 JWT） */
async function vapidAuthHeader(env: Env, endpoint: string): Promise<string> {
  const keys = await getVapidKeys(env)
  return buildVapidHeader(keys.privateJwk, keys.publicRaw, endpoint)
}

/**
 * 构造 `Authorization: vapid t=<jwt>, k=<public>`。
 *
 * 抽成纯函数是为了能单测：JWT 要的签名是 **r||s（64 字节）**，不是 DER 编码 ——
 * 这两者混用是最常见的坑，而推送服务只会回一个 401，完全看不出原因。
 * 用例里用公钥把签名验一遍，等价于推送服务侧的校验。
 */
export async function buildVapidHeader(
  privateJwk: JsonWebKey,
  publicRaw: Uint8Array,
  endpoint: string,
  nowMs = Date.now()
): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = { typ: "JWT", alg: "ES256" }
  const payload = {
    aud,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    // 推送服务方在滥用排查时用这个联系站长；用站点域名邮箱即可
    sub: "mailto:no-reply@doulor.cn",
  }
  const signingInput = `${b64uEncode(enc(JSON.stringify(header)))}.${b64uEncode(
    enc(JSON.stringify(payload))
  )}`
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(signingInput))
  return `vapid t=${signingInput}.${b64uEncode(sig)}, k=${b64uEncode(publicRaw)}`
}

/* ---- 载荷加密（RFC 8291 / aes128gcm）---- */

/**
 * 把 JSON 载荷加密成推送服务的请求体。
 *
 * 步骤与标准一一对应：
 *   1. 生成临时 ECDH 密钥对；与订阅的 p256dh 做 ECDH 得到共享密钥；
 *   2. IKM = HKDF(salt=auth_secret, ikm=shared, info="WebPush: info\0"||ua_pub||as_pub, 32)
 *   3. CEK/NONCE = HKDF(salt=random16, ikm=IKM, info="Content-Encoding: aes128gcm\0" / "…nonce\0")
 *   4. 明文尾部补 0x02（最后一条记录的分隔符），AES-128-GCM 加密；
 *   5. 组装 body：salt(16) | rs(4) | idlen(1) | as_pub(65) | ciphertext
 */
export async function encryptPushPayload(
  payload: PushPayload,
  p256dhB64: string,
  authB64: string
): Promise<Uint8Array> {
  const uaPublic = b64uDecode(p256dhB64)
  const authSecret = b64uDecode(authB64)

  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  )
  const sharedBits = await crypto.subtle.deriveBits(
    // workers-types 把 ECDH 的参数收得很窄，这里按标准字段传
    { name: "ECDH", public: uaKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0],
    eph.privateKey,
    256
  )
  const shared = new Uint8Array(sharedBits)
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer)

  // 1) IKM
  const keyInfo = concat(enc("WebPush: info\0"), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, shared, keyInfo, 32)

  // 2) CEK / NONCE
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12)

  // 3) 明文 + 结尾分隔符
  const plaintext = concat(enc(JSON.stringify(payload)), new Uint8Array([0x02]))
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, plaintext)
  )

  // 4) 头
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096, false)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext)
}

/* ---- 发送 ---- */

export type PushSendResult = "ok" | "gone" | "failed"

/** 给一条订阅推一条消息；404/410 表示订阅已失效（调用方据此删除） */
export async function sendPush(
  env: Env,
  sub: Pick<PushSubscriptionRow, "endpoint" | "p256dh" | "auth">,
  payload: PushPayload
): Promise<PushSendResult> {
  try {
    const body = await encryptPushPayload(payload, sub.p256dh, sub.auth)
    const auth = await vapidAuthHeader(env, sub.endpoint)
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body,
    })
    if (res.ok) return "ok"
    if (res.status === 404 || res.status === 410) return "gone"
    console.error("Web Push 失败:", res.status, (await res.text()).slice(0, 200))
    return "failed"
  } catch (err) {
    console.error("Web Push 异常:", err)
    return "failed"
  }
}

/**
 * 给某个用户的**所有**设备推一条。
 *
 * 失败即忽略（通知不能影响主流程）；失效订阅顺手删掉，避免每次都白推一遍。
 */
export async function pushToUser(
  env: Env,
  userId: string,
  payload: PushPayload
): Promise<number> {
  let sent = 0
  try {
    const rows = await env.DB.prepare(
      "SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?"
    )
      .bind(userId)
      .all<PushSubscriptionRow>()
    for (const sub of rows.results ?? []) {
      const r = await sendPush(env, sub, payload)
      if (r === "ok") {
        sent++
        await env.DB.prepare("UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?")
          .bind(new Date().toISOString(), sub.id)
          .run()
          .catch(() => {})
      } else if (r === "gone") {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?")
          .bind(sub.id)
          .run()
          .catch(() => {})
      }
    }
  } catch (err) {
    console.error("pushToUser 失败:", err)
  }
  return sent
}
