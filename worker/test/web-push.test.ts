/**
 * Web Push 载荷加密的往返测试（RFC 8291 / aes128gcm）。
 *
 * 这段代码没法靠"看日志"验证 —— 推失败在服务端只是一行 404/410，在用户那边
 * 就是"没弹"。所以这里用**客户端视角**把密文解回来：生成一对"浏览器订阅密钥"，
 * 用正式实现加密，再按规范（同 salt/info 推导 CEK/NONCE）解密，逐字节比对。
 *
 * 只要这个用例绿，加密那一半就是对的；剩下的一半（VAPID 头、POST 端点）
 * 由 handlers 的用例与真机验证。
 */
import { describe, it, expect } from "vitest"
import { encryptPushPayload, b64uEncode, b64uDecode, buildVapidHeader } from "../src/web-push"

const enc = (s: string) => new TextEncoder().encode(s)

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

/** 模拟浏览器侧：用自己的私钥 + 密文里的 as_public 解回明文 */
async function decryptAsClient(
  body: Uint8Array,
  uaPrivate: CryptoKey,
  uaPublicRaw: Uint8Array,
  authSecret: Uint8Array
): Promise<string> {
  const salt = body.slice(0, 16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)

  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  )
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256)
  )
  const keyInfo = concat(enc("WebPush: info\0"), uaPublicRaw, asPublic)
  const ikm = await hkdf(authSecret, shared, keyInfo, 32)
  const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12)

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext)
  )
  // 最后一个是 0x02 记录分隔符
  return new TextDecoder().decode(plain.slice(0, -1))
}

describe("Web Push 载荷加密", () => {
  it("客户端私钥能解回原文，且结尾分隔符是 0x02", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair
    const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const payload = { title: "新邮件：GitHub", body: "安全提醒", url: "/dashboard/email" }

    const body = await encryptPushPayload(payload, b64uEncode(uaPublicRaw), b64uEncode(auth))

    // 头部：salt(16) + rs(4) + idlen(1) + as_public(65)
    // 注意用**字节数**（中文一个字符 3 字节），不是字符数
    const plainBytes = new TextEncoder().encode(JSON.stringify(payload)).length
    expect(body[20]).toBe(65)
    expect(body.length).toBe(16 + 4 + 1 + 65 + plainBytes + 1 + 16)

    const text = await decryptAsClient(body, ua.privateKey, uaPublicRaw, auth)
    expect(JSON.parse(text)).toEqual(payload)
  })

  it("两次加密的 salt/临时公钥都不同（前向安全，不可重放比对）", async () => {
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])
    const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const p = b64uEncode(uaPublicRaw)
    const a = b64uEncode(auth)

    const b1 = await encryptPushPayload({ title: "x" }, p, a)
    const b2 = await encryptPushPayload({ title: "x" }, p, a)
    expect(b64uEncode(b1.slice(0, 16))).not.toBe(b64uEncode(b2.slice(0, 16)))
    expect(b64uEncode(b1.slice(21, 86))).not.toBe(b64uEncode(b2.slice(21, 86)))
  })

  it("base64url 编解码可逆（含 -_ 字符）", () => {
    const raw = new Uint8Array([0xfb, 0xff, 0x00, 0x3e, 0x3f, 0x01])
    const s = b64uEncode(raw)
    expect(s).not.toMatch(/[+/=]/)
    expect(Array.from(b64uDecode(s))).toEqual(Array.from(raw))
  })
})

describe("VAPID 头（RFC 8292）", () => {
  it("JWT 用公钥能验过，且 aud 取的是端点 origin", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))

    const endpoint = "https://fcm.googleapis.com/wp/abc123"
    const header = await buildVapidHeader(privateJwk, publicRaw, endpoint)
    expect(header.startsWith("vapid t=")).toBe(true)
    expect(header).toContain(", k=")

    const t = header.slice("vapid t=".length, header.indexOf(", k="))
    const [h64, p64, s64] = t.split(".")
    // JWT 头/体
    const head = JSON.parse(new TextDecoder().decode(b64uDecode(h64))) as {
      alg: string
      typ: string
    }
    const body = JSON.parse(new TextDecoder().decode(b64uDecode(p64))) as {
      aud: string
      exp: number
      sub: string
    }
    expect(head).toEqual({ typ: "JWT", alg: "ES256" })
    expect(body.aud).toBe("https://fcm.googleapis.com")
    expect(body.sub.startsWith("mailto:")).toBe(true)
    expect(body.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // 签名必须能被公钥验过（r||s，64 字节）
    const sig = b64uDecode(s64)
    expect(sig.length).toBe(64)
    const pubKey = await crypto.subtle.importKey(
      "raw",
      publicRaw,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    )
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pubKey,
      sig,
      enc(`${h64}.${p64}`)
    )
    expect(ok).toBe(true)
  })
})
