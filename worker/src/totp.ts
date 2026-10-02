/**
 * TOTP（RFC 6238）—— 认证器 App 里那串 30 秒一换的 6 位动态码。
 *
 * 纯 Web Crypto 实现，不引第三方库：算法本身很短，而依赖越少越好维护
 * （Workers 环境支持 `crypto.subtle` 的 HMAC-SHA1）。
 *
 * ── 几个容易写错的地方 ──
 * · **时间步长 30 秒**、**6 位码**，这两个值是 App 端约定俗成的默认，改了就扫不出来；
 * · HMAC 的 counter 必须是**大端 8 字节**，且高 4 字节通常为 0（2038 年后才会用到）；
 * · 取码用「动态截断」：拿最后一字节的低 4 位当偏移，从那里取 4 字节再抹掉最高位，
 *   最后对 10^6 取模 —— 不是简单地把 HMAC 前几字节转数字。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
/** 时间步长（秒） */
export const TOTP_PERIOD = 30
/** 动态码位数 */
export const TOTP_DIGITS = 6
/** 校验时容忍的时间窗个数（前后各 1 个 ⇒ 允许约 ±30 秒的时钟偏差） */
const DRIFT_STEPS = 1

/** 20 字节随机密钥，Base32 编码 —— 认证器 App 认这个长度与格式 */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)))
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "")
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 算出指定时间窗的动态码 */
async function totpAtCounter(secret: string, counter: number): Promise<string> {
  const keyBytes = base32Decode(secret)
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  )
  // counter 必须是大端 8 字节
  const msg = new Uint8Array(8)
  const view = new DataView(msg.buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter % 2 ** 32)
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg))
  // 动态截断：末字节低 4 位作偏移，取 4 字节并抹掉符号位
  const offset = sig[sig.length - 1] & 0x0f
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3]
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0")
}

/** 算出**当前**时间窗的动态码（测试与自检用；业务代码只做校验） */
export async function currentTotp(
  secret: string,
  now: number = Date.now()
): Promise<string> {
  return totpAtCounter(secret, Math.floor(now / 1000 / TOTP_PERIOD))
}

/**
 * 校验动态码。
 *
 * 允许前后各一个时间窗：手机和服务器的时间很难完全一致，
 * 只认当前窗会让「差 2 秒」的用户永远登不进去。
 * ⚠️ 不能放宽更多 —— 每多一个窗，爆破空间就多一份。
 */
export async function verifyTotp(
  secret: string,
  code: string,
  now: number = Date.now()
): Promise<boolean> {
  const input = code.replace(/\D/g, "")
  if (input.length !== TOTP_DIGITS) return false
  const counter = Math.floor(now / 1000 / TOTP_PERIOD)
  for (let i = -DRIFT_STEPS; i <= DRIFT_STEPS; i++) {
    const expected = await totpAtCounter(secret, counter + i)
    // 定长比较，避免时序侧信道（这里风险极低，但顺手做对）
    if (timingSafeStrEqual(expected, input)) return true
  }
  return false
}

function timingSafeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 生成 `otpauth://` 链接，前端据此画二维码 */
export function totpAuthUrl(params: {
  secret: string
  account: string
  issuer: string
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`)
  const qs = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  })
  return `otpauth://totp/${label}?${qs.toString()}`
}

/** 恢复码：10 位十六进制，可读性尚可、猜中的概率可忽略 */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
