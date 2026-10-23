/**
 * 从邮件正文里识别验证码（2026-10-24）。
 *
 * 为什么放在前端做：`messages` 表只存纯文本正文，识别是一次纯函数计算，
 * 没必要为它加字段/迁移；改了规则也不用重跑历史邮件。
 *
 * 策略（按可靠性排序）：
 *   1. 关键词 + 数字：「验证码 / verification code / code / OTP / PIN」后面 20 字符内的 4–8 位数字
 *   2. 关键词 + 字母数字混合码（部分服务用 6 位大写字母数字）
 *   3. 兜底：正文中出现**恰好一次**的独立 6 位数字
 *
 * 宁可返回 null 也不要瞎猜 —— 复制错码比没有按钮更糟。
 */
export function extractVerificationCode(text: string | null | undefined): string | null {
  if (!text) return null
  const body = text.replace(/\r\n/g, "\n")

  // 1) 关键词后面跟数字（最常见：验证码 123456 / your code is 123456）
  const kwNum =
    /(?:验证码|校验码|动态码|verification\s*code|login\s*code|security\s*code|one[\s-]*time\s*(?:code|password)|\bOTP\b|\bPIN\b|\bcode\b)[^\dA-Za-z]{0,24}(\d{4,8})(?!\d)/i.exec(
      body
    )
  if (kwNum) return kwNum[1]

  // 2) 关键词后面跟字母数字混合码（如 A1B2C3、XK7-9P2）
  const kwAlnum =
    /(?:验证码|校验码|verification\s*code|\bcode\b)[^\dA-Za-z]{0,24}([A-Z0-9]{4,8}(?:-[A-Z0-9]{2,6})?)(?!\w)/i.exec(
      body
    )
  if (kwAlnum && /\d/.test(kwAlnum[1])) return kwAlnum[1]

  // 3) 兜底：独立出现的 6 位数字，且全文只出现一次（避免把订单号/金额当验证码）
  const sixes = body.match(/(?<!\d)\d{6}(?!\d)/g) ?? []
  const uniq = Array.from(new Set(sixes))
  if (uniq.length === 1) return uniq[0]

  return null
}
