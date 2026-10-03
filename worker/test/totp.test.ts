import { describe, it, expect } from "vitest"
import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  totpAuthUrl,
  verifyTotp,
} from "../src/totp"

/**
 * TOTP 是「写错了自己也能自洽」的典型：生成的码和校验的码都出自同一份实现，
 * 即使算法错了、自己验自己也是通的。所以**必须拿 RFC 的标准向量来对**，
 * 否则用户扫进认证器 App 会发现码永远不对，而单测全绿。
 *
 * RFC 6238 附录 B 的密钥是 ASCII "12345678901234567890"，标准输出 8 位；
 * 本站用 6 位，取其后 6 位即可。
 */
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"))

describe("base32", () => {
  it("编解码往返一致", () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad])
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes))
  })

  it("忽略大小写与空格等噪声", () => {
    const a = base32Decode("GEZDGNBVGY3TQOJQ")
    const b = base32Decode("gezd gnbv gy3t qojq")
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

describe("verifyTotp", () => {
  it("匹配 RFC 6238 标准向量（6 位）", async () => {
    // T=59s → counter=1 → 8 位 94287082 → 后 6 位 287082
    expect(await verifyTotp(RFC_SECRET, "287082", 59_000)).toBe(true)
    // T=1111111109s → counter=37037036 → 8 位 07081804 → 后 6 位 081804
    expect(await verifyTotp(RFC_SECRET, "081804", 1_111_111_109_000)).toBe(true)
    // T=1234567890s → counter=41152263 → 8 位 89005924 → 后 6 位 005924
    expect(await verifyTotp(RFC_SECRET, "005924", 1_234_567_890_000)).toBe(true)
  })

  it("拒绝错误的码", async () => {
    expect(await verifyTotp(RFC_SECRET, "000000", 59_000)).toBe(false)
    expect(await verifyTotp(RFC_SECRET, "287083", 59_000)).toBe(false)
  })

  it("拒绝位数不对的输入", async () => {
    expect(await verifyTotp(RFC_SECRET, "28708", 59_000)).toBe(false)
    expect(await verifyTotp(RFC_SECRET, "2870821", 59_000)).toBe(false)
    expect(await verifyTotp(RFC_SECRET, "", 59_000)).toBe(false)
  })

  it("容忍前后各一个时间窗（时钟偏差），但不更多", async () => {
    // 前一个窗（T=29s，counter=0）的码，在 T=59s 时应被接受
    expect(await verifyTotp(RFC_SECRET, "287082", 59_000 - 30_000)).toBe(true)
    // 相差 3 个窗（90 秒）就必须拒绝
    expect(await verifyTotp(RFC_SECRET, "287082", 59_000 + 90_000)).toBe(false)
    expect(await verifyTotp(RFC_SECRET, "287082", 59_000 - 90_000)).toBe(false)
  })

  it("忽略输入里的空格与连字符（用户从 App 复制常带）", async () => {
    expect(await verifyTotp(RFC_SECRET, " 287 082 ", 59_000)).toBe(true)
  })
})

describe("密钥与恢复码", () => {
  it("生成的密钥是合法 Base32 且足够长", () => {
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]+$/)
    // 20 字节 → 32 个 Base32 字符
    expect(secret.length).toBe(32)
    expect(base32Decode(secret).length).toBe(20)
  })

  it("两次生成不相同", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret())
  })

  it("恢复码是 10 位十六进制且不重复", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateRecoveryCode()))
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{10}$/)
    expect(codes.size).toBe(50)
  })
})

describe("totpAuthUrl", () => {
  it("生成认证器能识别的 otpauth 链接", () => {
    const url = totpAuthUrl({ secret: "ABC234", account: "alice", issuer: "Doulor Cloud" })
    expect(url.startsWith("otpauth://totp/")).toBe(true)
    expect(url).toContain("secret=ABC234")
    expect(url).toContain("digits=6")
    expect(url).toContain("period=30")
    // 账号与签发方要带在 label 里，App 才能显示成「Doulor Cloud: alice」
    expect(decodeURIComponent(url)).toContain("Doulor Cloud:alice")
  })
})
