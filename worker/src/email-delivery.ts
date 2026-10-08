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
import { sendMail, renderMail } from "./mailer"
import { isOwnDomain } from "./root-domains"
import type { Env } from "./env"

const MAX_RAW_BYTES = 2 * 1024 * 1024
/** 单封信正文入库上限（字符），避免超出 D1 单值限制导致插入失败并触发重投 */
const MAX_BODY_CHARS = 256 * 1024
/** HTML 转纯文本的输入上限：线性扫描已经很快，这里只是兜底防止无谓开销 */
const MAX_HTML_CHARS = 512 * 1024

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

/**
 * HTML → 纯文本（保留基本段落结构）。
 *
 * ⚠️ 2026-09-25 审计（P0-4）：原实现第一行是
 *   `.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")`
 * —— 惰性量词 + 反向引用 + 交替。当正文里出现大量**没有闭合标签**的
 * `<script`/`<style` 起始位置时，正则引擎在每个起始位置都要一路扫到串尾，
 * 退化成 O(n²)。实测（Node，同一函数）：
 *   200KB → 1.8s，400KB → 7.8s，800KB → 32.6s（约 4.2×/倍）
 * 而入站邮件的读入上限是 2MB（MAX_RAW_BYTES），且这条路径**无需登录、
 * 无需邀请码**：任何人往任意 *@doulor.cn 发一封约 1MB、全是 `<style>` 的
 * HTML 邮件，就能让该次投递超 CPU 上限失败 → Email Routing 重投 → 反复烧 CPU。
 *
 * 现在改成**单遍线性扫描**（逐字符判断是否在标签内），复杂度 O(n)，
 * 且不再依赖任何惰性量词/反向引用。同时把输入截到 512KB 兜底。
 */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "tr",
  "li",
  "ul",
  "ol",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "section",
  "article",
  "header",
  "footer",
  "br",
])

/** 标签名允许的字符（A-Z a-z 0-9） */
function isTagNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  )
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_m, code: string) => {
      const n = Number(code)
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""
    })
    .replace(/&amp;/gi, "&")
}

function htmlToText(html: string): string {
  // 上限兜底：即使调用方传进来 2MB，也不会让单次投递做无谓的大量工作
  const src = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html
  const n = src.length
  const out: string[] = []
  let i = 0
  // 正在跳过的原始文本元素名（script/style）；非 null 时丢弃其间所有内容
  let skipping: string | null = null

  while (i < n) {
    const lt = src.indexOf("<", i)
    if (lt < 0) {
      if (!skipping) out.push(src.slice(i))
      break
    }
    if (!skipping) out.push(src.slice(i, lt))

    let j = lt + 1
    const closing = src.charCodeAt(j) === 47 // '/'
    if (closing) j++
    const nameStart = j
    while (j < n && isTagNameChar(src.charCodeAt(j))) j++
    const name = src.slice(nameStart, j).toLowerCase()
    const gt = src.indexOf(">", j)
    const tagEnd = gt < 0 ? n : gt + 1

    if (skipping) {
      if (closing && name === skipping) skipping = null
      i = tagEnd
      continue
    }
    if (!closing && (name === "script" || name === "style")) {
      skipping = name
      i = tagEnd
      continue
    }
    if (BLOCK_TAGS.has(name)) out.push("\n")
    i = tagEnd
  }

  return decodeEntities(out.join(""))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

export async function incomingEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const recipient = (message.to ?? "").toLowerCase()
  const envelopeFrom = message.from ?? "unknown"

  // 收件域必须是**本站任一已登记的根域**（root_domains 表），不能只认 env.ROOT_DOMAIN ——
  // 用户的邮箱默认建在 tyu.me 上，只判 doulor.cn 会把新用户的所有来信全部拒收。
  // 未登记的域名本来也不会被 CF 的 catch-all 送到这里，这一层是纵深防御。
  if (!(await isOwnDomain(env, recipient))) {
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
    // 这个地址没有建过邮箱。
    //
    // 2026-09-25 起 Cloudflare 的 catch-all 改由本 Worker 接管（在此之前它是自己
    // 转发到某个真实邮箱的，这类信根本到不了这里），所以这条分支现在会真的被走到 ——
    // 拼错的地址、别人随手发的地址都会经过这里。
    //
    // 处理方式：**拒收**（发信人会收到「收件人不存在」的退信）。
    // 这是刻意的选择，别改成静默丢弃：静默丢信会让群发者以为地址有效、继续发，
    // 而退信能立刻告诉写错地址的人「这个地址不存在」。
    message.setReject("收件人不存在")
    return
  }

  // 用 postal-mime 完整解析（主题解码 / 正文提取 / HTML 回退）
  let subject = ""
  let fromAddress = envelopeFrom
  let text = ""
  let rfcMessageId: string | null = null
  try {
    const rawBuffer = await readRaw(message.raw, MAX_RAW_BYTES)
    const parsed = await PostalMime.parse(rawBuffer)
    subject = parsed.subject ?? ""
    if (parsed.from?.address) {
      // ⚠️ 2026-09-25 审计（H3）：显示名里**不能保留尖括号**。
      // 这里拼出来的是 `from_address` 这一列，而前端「回信」按钮会用
      // 同样的规则从中取 `<...>` 里的地址当收件人（填进 mailto）。
      // 发件人只要把 From 头写成 `"Foo <attacker@evil.com>" <real@good.com>`，
      // 解析后就会拼成 `Foo <attacker@evil.com> <real@good.com>` ——
      // 用户点「回信」，收件人被静默换成攻击者的地址。
      // 去掉 <> 后，这一列里有且只有一对尖括号 = 真实地址。
      // （注：后端那条直接发信路径 2026-10-08 已移除，但前端 mailto 仍做同样解析，
      //   所以这层清洗照旧必要。）
      const safeName = (parsed.from.name ?? "").replace(/[<>]/g, "").trim()
      fromAddress = safeName
        ? `${safeName} <${parsed.from.address}>`
        : parsed.from.address
    }
    text = (parsed.text ?? "").trim()
    if (!text && parsed.html) {
      text = htmlToText(parsed.html)
    }
    // 保存 Message-ID：用于同一封邮件的去重（同 rfc_message_id 不重复落库）。
    // 取不到就留 null。
    rfcMessageId = parsed.messageId?.trim() || null
  } catch (err) {
    console.error("邮件解析失败（仍入库）:", err)
    subject = message.headers.get("subject") ?? ""
  }

  const now = new Date().toISOString()
  const messageId = crypto.randomUUID()

  // ⚠️ 2026-09-25 审计（L11）：入库前先按 Message-ID 去重。
  //
  // 为什么会走到这里：`incomingEmail` 一旦抛错，Email Routing 会**重投**同一封邮件，
  // 而 `messages` 表没有唯一约束，于是收件箱出现重复邮件。
  // 下面的 bookkeeping UPDATE 已经补了 try/catch（消除最主要的重投触发点），
  // 但仍有一个兜不住的窗口：Worker 在 INSERT 成功之后、函数返回之前被 CPU/墙钟杀掉
  // （本文件顶部就记着"投递不能失败"这条约束）。此时重投会再插一行。
  //
  // 用 `rfc_message_id` 判重是安全的：RFC 5322 要求它全局唯一，
  // 重投的正是**同一封**邮件（值完全相同）。取不到 Message-ID 时为 null，
  // 此时不做判重 —— 宁可偶尔重复，也不能误吞真实邮件。
  if (rfcMessageId) {
    const dup = await env.DB.prepare(
      "SELECT id FROM messages WHERE mailbox_id = ? AND rfc_message_id = ? LIMIT 1"
    )
      .bind(mailbox.id, rfcMessageId.slice(0, 500))
      .first<{ id: string }>()
    if (dup) {
      // 已处理过：插入与转发都跳过，避免收件箱和转发各重复一次
      console.warn("重复投递，已忽略:", rfcMessageId, recipient)
      return
    }
  }

  // 1. 存入收件箱
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at, rfc_message_id)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  )
    .bind(
      messageId,
      mailbox.id,
      fromAddress.slice(0, 320),
      subject.slice(0, 500),
      // 必须截断：原文最大 2MB，直接入库会超出 D1 单值上限导致插入失败，
      // 而插入失败会让 Email Routing 重投，形成重复投递
      text.slice(0, MAX_BODY_CHARS),
      now,
      rfcMessageId ? rfcMessageId.slice(0, 500) : null
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
        // 用多通道发信转发（Posta/Brevo/CF），能发任意邮箱，
        // 不再受 Cloudflare「只能转发到已验证 destination」的限制。
        // subject 加 Fwd 前缀、正文附原始发件人，让对方能看出原邮件出处。
        const { text: fwdText, html: fwdHtml } = renderMail(
          `Fwd: ${subject || "(无主题)"}`,
          [`转发自 ${fromAddress}`, "", text || "(无正文)"],
        )
        await sendMail(env, {
          to: target,
          subject: `Fwd: ${subject || "(无主题)"}`,
          text: fwdText,
          html: fwdHtml,
        })
        anyForwarded = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${target}: ${msg}`)
        console.error(`转发失败 ${recipient} -> ${target}:`, err)
      }
    }
    // ⚠️ 2026-09-25 审计（L11）：下面三条 bookkeeping UPDATE 原先**没有 try/catch**，
    // 而更下方写审计日志的那条**有** —— 注释还明确写着「此处抛错会让整个 email() 失败，
    // Email Routing 会重投该邮件 → 收件箱出现重复邮件」。
    // 同一个函数里，一条被保护、三条没有，是明显的遗漏：
    // D1 抖动一下就会重投，而重投会再插一行邮件（收件箱重复）。
    // 「记录转发状态」是**辅助信息**，绝不能因为它失败就丢掉一封邮件。
    try {
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
    } catch (err) {
      console.error("转发状态记录失败（不影响投递）:", mailbox.id, err)
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