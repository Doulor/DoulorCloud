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
    const e = err as { code?: string; message?: string }
    const code = e?.code ?? ""
    const message = e?.message ?? String(err)
    console.error("发送邮件失败:", input.to, code, message)

    // 收件人不在账户已验证列表里 —— 这是最常见的失败，必须给出可操作的提示
    if (/E_RECIPIENT_NOT_VERIFIED|destination address is not a verified|not a verified address|not verified/i.test(`${code} ${message}`)) {
      throw new ApiError(
        400,
        "该收件邮箱尚未验证：请先在 Cloudflare 完成 Email Sending 域名 Onboard（Compute → Email Service → Email Sending），完成后即可发往任意邮箱",
        "RECIPIENT_NOT_VERIFIED"
      )
    }
    if (/E_SENDER_NOT_VERIFIED|sender address is not/i.test(`${code} ${message}`)) {
      throw new ApiError(
        400,
        "发件地址未通过验证：请先在 Cloudflare 完成 Email Sending 域名 Onboard",
        "SENDER_NOT_VERIFIED"
      )
    }

    throw new ApiError(502, `邮件发送失败：${message}`, "MAIL_SEND_FAILED")
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