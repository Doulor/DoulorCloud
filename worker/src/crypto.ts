/**
 * 密码与 token 哈希工具。
 * 使用 WebCrypto（Worker 环境原生支持），不依赖外部库。
 */

const encoder = new TextEncoder()

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltHex = toHex(salt)
  const hash = await sha256Hex(`${saltHex}:${password}`)
  return `sha256$${saltHex}$${hash}`
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 3 || parts[0] !== "sha256") return false
  const [, saltHex, expected] = parts
  const actual = await sha256Hex(`${saltHex}:${password}`)
  return timingSafeEqual(actual, expected)
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
