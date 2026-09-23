/**
 * 密码与 token 哈希工具。
 * 使用 WebCrypto（Worker 环境原生支持），不依赖外部库。
 */

const encoder = new TextEncoder()

/**
 * 口令哈希（PBKDF2-HMAC-SHA256）。
 *
 * ⚠️ 历史背景（2026-09-23 安全审计）：旧实现是 **单次 SHA-256 + salt**
 * （`sha256$<salt>$<hash>`）。SHA-256 是为速度设计的哈希，GPU 每秒可算数十亿次，
 * 密码库一旦泄漏（D1 导出、备份、日志）弱口令几乎瞬间被还原。
 * 现改为 PBKDF2-HMAC-SHA256 + 随机 salt，并把迭代次数写进哈希串（便于将来上调）。
 *
 * 格式：`pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>`
 * 旧格式仍然可验证（`verifyPassword` 兼容），并在**登录成功时透明升级**
 * （见 verifyPassword 注释与 handlers/auth.ts 的 login）。
 *
 * ⚠️ 迭代次数与 Workers CPU 限额的取舍：
 *   Workers Free 计划的 CPU 限额是每次请求 10ms，PBKDF2 迭代过高会被直接杀掉
 *   （登录接口整体失败）。100_000 是 Cloudflare 官方示例的常用量级，在付费计划上
 *   约 100~200ms CPU、可接受；若确认运行在 Free 计划，请下调到 10_000 以下，
 *   或（更推荐）升级付费计划以保住这个强度。
 */
export const PBKDF2_ITERATIONS = 100_000

/** PBKDF2 派生的十六进制哈希 */
async function pbkdf2Hex(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<string> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    256
  )
  return toHex(new Uint8Array(bits))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${hash}`
}

/**
 * 校验口令。同时支持新（PBKDF2）与旧（单次 SHA-256）两种格式，
 * 保证升级过程对存量用户无感 —— 不需要强制所有人重置密码。
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$")

  // 新格式：pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>
  if (parts.length === 5 && parts[0] === "pbkdf2" && parts[1] === "sha256") {
    const iterations = Number(parts[2])
    if (!Number.isFinite(iterations) || iterations <= 0) return false
    const expected = parts[4]
    const actual = await pbkdf2Hex(password, fromHex(parts[3]), iterations)
    return timingSafeEqual(actual, expected)
  }

  // 旧格式：sha256$<saltHex>$<hashHex>（仅用于让存量用户能登录，随后升级）
  if (parts.length === 3 && parts[0] === "sha256") {
    const [, saltHex, expected] = parts
    const actual = await sha256Hex(`${saltHex}:${password}`)
    return timingSafeEqual(actual, expected)
  }

  return false
}

/**
 * 该哈希是否需要升级到当前算法/迭代次数。
 * 登录成功后调用，命中则用新算法重写一次（透明升级）。
 * 不认识的格式一律返回 false —— 避免把损坏的哈希反复重写。
 */
export function needsPasswordRehash(stored: string): boolean {
  const parts = stored.split("$")
  if (parts[0] === "sha256") return true // 旧格式，必然升级
  if (parts[0] !== "pbkdf2" || parts.length !== 5) return false
  const iterations = Number(parts[2])
  return !Number.isFinite(iterations) || iterations < PBKDF2_ITERATIONS
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toHex(bytes)
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token)
}

export function uuid(): string {
  return crypto.randomUUID()
}

async function sha256Hex(input: string): Promise<string> {
  const data = encoder.encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return toHex(new Uint8Array(digest))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ---- 对称加密（用于存放第三方服务的长期凭据，如 NewAPI access token）----

/**
 * 从 SESSION_SECRET 派生 AES-GCM 密钥。
 * 同一密钥即可，不需要额外的 Secret，避免配置项膨胀。
 */
async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("doulor-mail-secret-v1"),
      info: encoder.encode("aes-gcm-256"),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 加密为 `v1:<iv>:<ciphertext>`（均为 base64） */
export async function encryptSecret(
  plaintext: string,
  secret: string
): Promise<string> {
  const key = await deriveEncryptionKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  )
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`
}

export async function decryptSecret(
  payload: string,
  secret: string
): Promise<string> {
  const parts = payload.split(":")
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("无法识别的密文格式")
  }
  const key = await deriveEncryptionKey(secret)
  const iv = fromBase64(parts[1])
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    fromBase64(parts[2])
  )
  return new TextDecoder().decode(plain)
}
