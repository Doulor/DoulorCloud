/**
 * 出站邮件（Cloudflare Email Service 的 send_email 绑定）。
 *
 * 为什么不用 SMTP：Workers 运行时**没有 TCP socket**，无法连接
 * smtp.qq.com / SES SMTP 之类的外部 SMTP 服务。Cloudflare 提供的
 * send_email 绑定就是官方替代方案，无需自建邮件服务。
 *
 * ⚠️ 重要限制（决定「验证真实邮箱」能否工作）：
 *   在把 doulor.cn 到面板 **Compute > Email Service > Email Sending** 完成
 *   Onboard 之前，绑定**只能发往账户内「已验证的 destination address」**。
 *   未验证的收件人会报错，此时：
 *     - 给真实邮箱发验证码：需要先 Onboard 发送域名
 *     - 找回账号、群发公告：同上
 *   未 Onboard 时，这类发送会抛出 E_SENDER_NOT_VERIFIED / 收件人未验证之类错误，
 *   本模块会把它转成明确的业务错误返回给前端，而不是静默失败。
 */
import { ApiError } from "./http"
import type { Env } from "./env"

/** 发件人：必须是 wrangler.toml 里 allowed_sender_addresses 列出的地址 */
export const MAIL_FROM = "no-reply@doulor.cn"
export const MAIL_FROM_NAME = "Doulor Cloud"

export interface SendMailInput {
  to: string
  subject: string
  text: string
  html?: string
}

/**
 * 把 Cloudflare 的发送错误转成可操作的中文业务错误。
 *
 * 单独抽出来是因为「回信」与「通知」要走完全一样的错误分类 ——
 * 否则用户看到的提示会不一致（一个说"请先 Onboard"，另一个只说"发送失败"）。
 */
function mapSendError(err: unknown): ApiError {
  const e = err as { code?: string; message?: string }
  const code = e?.code ?? ""
  const message = e?.message ?? String(err)
  console.error("发送邮件失败:", code, message)

  // 收件人不在账户已验证列表里 —— Onboard 之前最常见的失败，必须给出可操作提示
  if (/E_RECIPIENT_NOT_VERIFIED|destination address is not a verified|not a verified address|not verified/i.test(`${code} ${message}`)) {
    return new ApiError(
      400,
      "该收件邮箱尚未验证：请先在 Cloudflare 完成 Email Sending 域名 Onboard（Compute → Email Service → Email Sending），完成后即可发往任意邮箱",
      "RECIPIENT_NOT_VERIFIED"
    )
  }
  if (/E_SENDER_NOT_VERIFIED|sender address is not/i.test(`${code} ${message}`)) {
    return new ApiError(
      400,
      "发件地址未通过验证：请先在 Cloudflare 完成 Email Sending 域名 Onboard",
      "SENDER_NOT_VERIFIED"
    )
  }
  return new ApiError(502, `邮件发送失败：${message}`, "MAIL_SEND_FAILED")
}

export function isMailerConfigured(env: Env): boolean {
  return Boolean(env.EMAIL)
}

/**
 * 发送一封邮件。
 * 失败时抛出可读的业务错误（区分「未配置」「发送域名未 Onboard」「收件人未验证」）。
 */
export async function sendMail(env: Env, input: SendMailInput): Promise<void> {
  if (!env.EMAIL) {
    throw new ApiError(
      503,
      "邮件发送未配置（缺少 send_email 绑定）",
      "MAIL_NOT_CONFIGURED"
    )
  }

  try {
    await env.EMAIL.send({
      to: input.to,
      from: { email: MAIL_FROM, name: MAIL_FROM_NAME },
      subject: input.subject,
      text: input.text,
      html: input.html,
    })
  } catch (err) {
    throw mapSendError(err)
  }
}

export interface SendReplyInput {
  /** 发件地址：用户本人的域名邮箱（如 alice@doulor.cn） */
  from: string
  to: string
  subject: string
  text: string
  /** 原邮件的 Message-ID，用于给邮件客户端串成同一会话 */
  inReplyTo?: string | null
}

/**
 * 以用户自己的域名邮箱身份回复一封邮件（网页端「回信」）。
 *
 * 与 sendMail 的区别：
 *   1. 发件人是**用户自己的邮箱地址**，不是 no-reply@；
 *   2. 带上 `In-Reply-To` / `References`，让对方邮件客户端把两封信归到同一会话；
 *   3. 不设 HTML 正文 —— 纯文本足够，且避免用户输入被当 HTML 渲染的 XSS 风险。
 *
 * ⚠️ 前置条件（部署侧，不是代码能解决的）：
 *   `worker/wrangler.toml` 的 `[[send_email]].allowed_sender_addresses` 若只列了
 *   no-reply@/support@，则**从这里发出的信会被 Cloudflare 拒绝**（发件地址不在白名单）。
 *   要支持"用户以自己的地址回信"，必须删掉该键（或确认 CF 是否支持通配）。
 *   该键的取舍见 HANDOFF §4 与 docs/审计报告 §七。
 *
 * ⚠️ 另外：在 Email Sending 域名 Onboard 之前，CF 只允许发往账户内已验证的
 *   destination address。所以本功能在 Onboard 完成后才能真正对任意外部地址生效。
 */
export async function sendReply(
  env: Env,
  input: SendReplyInput
): Promise<{ messageId: string | null }> {
  if (!env.EMAIL) {
    throw new ApiError(
      503,
      "邮件发送未配置（缺少 send_email 绑定）",
      "MAIL_NOT_CONFIGURED"
    )
  }

  const headers: Record<string, string> = {}
  if (input.inReplyTo) {
    headers["In-Reply-To"] = input.inReplyTo
    headers["References"] = input.inReplyTo
  }

  try {
    const result = await env.EMAIL.send({
      from: { email: input.from, name: input.from.split("@")[0] },
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    })
    return { messageId: result?.messageId ?? null }
  } catch (err) {
    throw mapSendError(err)
  }
}

/** 统一的邮件外观（纯文本 + 简单 HTML） */
export function renderMail(
  title: string,
  paragraphs: string[],
  code?: string
): { text: string; html: string } {
  const text = [title, "", ...paragraphs].join("\n")
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e7eb">
    <h1 style="margin:0 0 16px;font-size:18px;color:#111827">${title}</h1>
    ${paragraphs
      .map(
        (p) =>
          `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">${p}</p>`
      )
      .join("")}
    ${
      code
        ? `<div style="margin:20px 0;padding:14px;background:#f3f4f6;border-radius:8px;text-align:center">
             <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26px;letter-spacing:6px;font-weight:600;color:#111827">${code}</span>
           </div>`
        : ""
    }
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
    <p style="margin:0;font-size:12px;color:#9ca3af">Doulor Cloud · 请勿回复本邮件</p>
  </div>
</body></html>`
  return { text, html }
}