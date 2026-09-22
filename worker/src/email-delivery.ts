/**
 * 邮箱入站处理器（Email Workers 模式）。
 *
 * 入站邮件（发往 @doulor.cn、且 Email Routing 规则指向本 Worker）：
 *   1. 存入 D1 收件箱（网页内可读）
 *   2. 若该邮箱配置了转发目标，尝试 message.forward() 转发
 *      —— Cloudflare 只允许转发到「已验证的 destination address」，
 *         因此转发目标在设置时就会注册为 destination（触发验证邮件）。
 *
 * MIME 解析使用 postal-mime（Cloudflare 官方推荐，Workers 原生兼容），
 * 正确处理 RFC 2047 编码主题、quoted-printable/base64、HTML-only 邮件。
 */
import PostalMime from "postal-mime"
import type { Env } from "./env"

const MAX_RAW_BYTES = 2 * 1024 * 1024
/** 单封信正文入库上限（字符），避免超出 D1 单值限制导致插入失败并触发重投 */
const MAX_BODY_CHARS = 256 * 1024

async function readRaw(
  raw: ReadableStream<Uint8Array>,
  limit: number
): Promise<ArrayBuffer> {
  const reader = raw.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    total += value.byteLength
    if (total >= limit) break
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    const n = Math.min(chunk.byteLength, total - offset)
    if (n <= 0) break
    all.set(chunk.subarray(0, n), offset)
    offset += n
  }
  return all.buffer
}

/** HTML → 纯文本（保留基本段落结构） */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

export async function incomingEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const rootDomain = env.ROOT_DOMAIN.toLowerCase()
  const recipient = (message.to ?? "").toLowerCase()
  const envelopeFrom = message.from ?? "unknown"

  if (!recipient.endsWith(`@${rootDomain}`)) {
    message.setReject("收件人不是本站域名的邮箱")
    return
  }

  const mailbox = await env.DB.prepare(
    "SELECT * FROM mailboxes WHERE address = ? COLLATE NOCASE"
  )
    .bind(recipient)
    .first<{
      id: string
      user_id: string
      address: string
      forwarding_to: string | null
    }>()

  if (!mailbox) {
    message.setReject("收件人不存在")
    return
  }

  // 用 postal-mime 完整解析（主题解码 / 正文提取 / HTML 回退）
  let subject = ""
  let fromAddress = envelopeFrom
  let text = ""
  try {
    const rawBuffer = await readRaw(message.raw, MAX_RAW_BYTES)
    const parsed = await PostalMime.parse(rawBuffer)
    subject = parsed.subject ?? ""
    if (parsed.from?.address) {
      fromAddress = parsed.from.name
        ? `${parsed.from.name} <${parsed.from.address}>`
        : parsed.from.address
    }
    text = (parsed.text ?? "").trim()
    if (!text && parsed.html) {
      text = htmlToText(parsed.html)
    }
  } catch (err) {
    console.error("邮件解析失败（仍入库）:", err)
    subject = message.headers.get("subject") ?? ""
  }

  const now = new Date().toISOString()
  const messageId = crypto.randomUUID()

  // 1. 存入收件箱
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      messageId,
      mailbox.id,
      fromAddress.slice(0, 320),
      subject.slice(0, 500),
      // 必须截断：原文最大 2MB，直接入库会超出 D1 单值上限导致插入失败，
      // 而插入失败会让 Email Routing 重投，形成重复投递
      text.slice(0, MAX_BODY_CHARS),
      now
    )
    .run()

  // 2. 转发（仅已验证的 destination 可用；失败不影响入库）
  let forwardTargets: string[] = []
  if (mailbox.forwarding_to) {
    try {
      const parsed = JSON.parse(mailbox.forwarding_to) as unknown
      if (Array.isArray(parsed)) {
        forwardTargets = parsed
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 3)
      }
    } catch {
      forwardTargets = []
    }
  }

  if (forwardTargets.length > 0) {
    let anyForwarded = false
    const failures: string[] = []
    for (const target of forwardTargets) {
      try {
        await message.forward(target)
        anyForwarded = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${target}: ${msg}`)
        console.error(`转发失败 ${recipient} -> ${target}:`, err)
      }
    }
    // 只在真正转发成功时才记时间戳（避免界面上「已转发」的假象）
    if (anyForwarded) {
      await env.DB.prepare("UPDATE mailboxes SET last_forwarded_at = ? WHERE id = ?")
        .bind(now, mailbox.id)
        .run()
    }
    if (failures.length > 0) {
      await env.DB.prepare(
        "UPDATE mailboxes SET last_forward_error = ? WHERE id = ?"
      )
        .bind(failures.join("; ").slice(0, 500), mailbox.id)
        .run()
    } else {
      await env.DB.prepare(
        "UPDATE mailboxes SET last_forward_error = NULL WHERE id = ?"
      )
        .bind(mailbox.id)
        .run()
    }
  }

  // 审计日志：失败不能抛出。此处抛错会让整个 email() 失败，
  // Email Routing 会重投该邮件 → 收件箱出现重复邮件。
  try {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'email.receive', ?, ?)"
    )
      .bind(crypto.randomUUID(), mailbox.user_id, `${envelopeFrom} -> ${recipient}`, now)
      .run()
  } catch (err) {
    console.error("审计日志写入失败（不影响投递）:", err)
  }
}