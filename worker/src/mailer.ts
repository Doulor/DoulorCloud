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
import { getSetting } from "./settings"
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

/** 通过 Cloudflare Email Routing（send_email 绑定）发信 —— 只能发已验证 destination */
async function sendViaCf(env: Env, input: SendMailInput): Promise<void> {
  if (!env.EMAIL) {
    throw new ApiError(
      503,
      "CF 邮件发送未配置（缺少 send_email 绑定）",
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

/**
 * 判断一个通道的失败响应是不是「额度/限流」类错误。
 *
 * 为什么单独识别：额度用尽是**全局**的，跟具体收件人无关。若按普通失败处理，
 * 群发会把「还没轮到的人」全部标成 failed —— 失败名单被污染，而且这些人其实
 * 只是要等到额度恢复。识别出来之后（错误码 MAIL_QUOTA_EXCEEDED）调用方可以
 * 「暂停本轮、把剩余收件人留在 pending」。
 *
 * 依据：Brevo 免费版每天 300 封，用完后 POST /v3/smtp/email 返回 400
 * （code 形如 `max_emails_per_day_exceeded`）；超速率则返回 429。posta 网关同理。
 */
function isQuotaResponse(status: number, body: string): boolean {
  if (status === 429 || status === 402) return true
  return /max_emails|quota|daily[ _-]?limit|credits?[ _-]?(exceed|limit)|(exceed|reach)\w*\s+(the\s+)?(daily\s+)?(limit|quota)/i.test(
    body
  )
}

/**
 * 通过自建 Posta 网关发信（HTTP API + Bearer，背后是用户自己配的 SMTP）—— 可发任意邮箱。
 *
 * 接口契约（Posta v1，`/openapi.json`）：`POST /api/v1/emails/send`，
 * `Authorization: Bearer <api-key>`（需 send 权限），请求体：
 *   { from, to: string[], subject, text?, html? }
 * `html` 是一等字段 —— renderMail 的卡片样式在 Posta 通道直接生效
 * （这正是从 Posthorn 换到 Posta 的原因：Posthorn 1.x 只能发纯文本）。
 *
 * ⚠️ `from` 取自设置项 `posta_from`（可配置），**默认不是站点的 no-reply 地址**。
 *   原因：Posta 背后若是 QQ SMTP，信封 `MAIL FROM` 必须等于授权登录账号，否则报
 *   `501 Mail from address must be same as authorization user`（2026-09-27 实测）。
 *   所以默认值是与登录账号一致的 `Doulor Cloud <DoulorCloud@foxmail.com>`。
 *   若之后 Posta 换用支持自有域名的 SMTP，只改设置项即可，无需改代码。
 */
async function sendViaPosta(env: Env, input: SendMailInput): Promise<void> {
  const url = (await getSetting(env, "posta_url")).trim()
  const key = (await getSetting(env, "posta_key")).trim()
  if (!url || !key) {
    throw new ApiError(503, "Posta 网关未配置", "MAIL_NOT_CONFIGURED")
  }
  // 存的是基础地址（如 https://xxx.doulor.cn）；兼容直接粘完整端点的情况
  const base = url.replace(/\/+$/, "")
  const endpoint = base.endsWith("/send") ? base : `${base}/api/v1/emails/send`
  // 发件人可配置：QQ SMTP 要求 MAIL FROM = 登录账号（见 posta_from 的注释）
  const from =
    (await getSetting(env, "posta_from")).trim() || `${MAIL_FROM_NAME} <${MAIL_FROM}>`
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    }),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    const quota = isQuotaResponse(res.status, body)
    throw new ApiError(
      quota ? 429 : 502,
      `Posta 发信失败: ${res.status} ${body}`,
      quota ? "MAIL_QUOTA_EXCEEDED" : "MAIL_SEND_FAILED"
    )
  }
}

/**
 * 拆出 Brevo 的多把 API Key。
 *
 * 为什么要支持多把：Brevo 免费版**按账号**限 300 封/天。多注册几个小号、
 * 每个小号配一把 Key，就能把日额度叠加起来（3 个号 ≈ 900 封/天）。
 * 分隔符宽容处理：逗号、分号、换行、空白都认 —— 管理员怎么粘都能用。
 */
export function parseBrevoKeys(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 单把 Brevo Key 的「当日剩余封数」缓存（模块级，isolate 内共享）。
 *
 * 为什么要缓存：发信前要跳过「当日额度已用尽」的 Key（见 sendViaBrevo 的
 * 长注释），而判断依据只能问 Brevo 的 `/v3/account`。群发时每封都问一次太浪费，
 * 因此 isolate 内缓存 5 分钟，并在每次真正发出去后就地减 1。
 */
const BREVO_HEALTH_TTL_MS = 5 * 60 * 1000
const brevoKeyHealth = new Map<string, { credits: number | null; checkedAt: number }>()

/**
 * Brevo 多 Key 的轮转游标（模块级）。
 *
 * ⚠️ **初值随机**。旧实现从 0 开始自增，而模块级状态在**冷启动的 isolate 里会重置** ——
 * 低流量时段几乎每个请求都落在新建的 isolate 上，于是「轮询」退化成了
 * 「永远先试第一把 Key」。第一把一旦额度见底（Brevo 用尽额度后仍回 201 + 静默丢弃，
 * 见 sendViaBrevo），「总是先试它」就等于「总是丢邮件」。
 * 随机初值抹掉这条偏差；之后仍是自增轮询，保证同一 isolate 内连续发信
 * （公告群发每批 20 封）能均匀摊到各把 Key 上。
 */
let brevoKeyCursor = Math.floor(Math.random() * 1000)

/**
 * 问一把 Brevo Key 的账号今天还剩多少封。
 *
 * 免费版（`plan[0].creditsType === "sendLimit"`）的 `credits` 就是**当日剩余**
 * 封数（实测：发出一封后 151 → 147，见 2026-09-30 排查）。
 * 读不到时返回 null —— 网络失败、账号开了 IP 白名单拦截、或是套餐语义不同，
 * 调用方一律按「未知」处理（不拦截，保持与旧版完全一致的行为）。
 */
async function fetchBrevoCredits(key: string): Promise<number | null> {
  try {
    const res = await fetch("https://api.brevo.com/v3/account", {
      headers: { "api-key": key, accept: "application/json" },
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      plan?: { credits?: number; creditsType?: string }[]
    }
    const plan = body?.plan?.[0]
    if (plan?.creditsType !== "sendLimit" || typeof plan.credits !== "number") return null
    return plan.credits
  } catch {
    return null
  }
}

/** 带缓存的额度查询 */
async function brevoCredits(key: string): Promise<number | null> {
  const now = Date.now()
  const cached = brevoKeyHealth.get(key)
  if (cached && now - cached.checkedAt < BREVO_HEALTH_TTL_MS) return cached.credits
  const credits = await fetchBrevoCredits(key)
  brevoKeyHealth.set(key, { credits, checkedAt: now })
  return credits
}

/** 成功发出去一封 → 把缓存里的剩余额度减 1（不同步也没关系，只是更早触发复查） */
function noteBrevoUsed(key: string): void {
  const cached = brevoKeyHealth.get(key)
  if (cached && typeof cached.credits === "number" && cached.credits > 0) cached.credits -= 1
}

/** Brevo 明确回了额度错误 → 立刻把该 Key 标记为「今天已用尽」，后续不再尝试 */
function markBrevoExhausted(key: string): void {
  brevoKeyHealth.set(key, { credits: 0, checkedAt: Date.now() })
}

/** 通过 Brevo（Sendinblue）发信（HTTP API）—— 可发任意邮箱，支持多把 Key 叠加额度 */
async function sendViaBrevo(env: Env, input: SendMailInput): Promise<void> {
  const keys = parseBrevoKeys(await getSetting(env, "brevo_api_key"))
  const senderEmail = (await getSetting(env, "brevo_sender_email")).trim()
  const senderName =
    (await getSetting(env, "brevo_sender_name")).trim() || MAIL_FROM_NAME
  if (keys.length === 0 || !senderEmail) {
    throw new ApiError(503, "Brevo 未配置（缺少 API key 或发件人）", "MAIL_NOT_CONFIGURED")
  }

  // ⚠️ 2026-09-30 实测（这是「有人说收不到验证码」的根因）：
  //    Brevo 免费版的**当日额度用尽后，POST /v3/smtp/email 依旧返回 201 Created
  //    并给一个 messageId**，然后把这封信**静默丢弃** —— `GET /v3/smtp/statistics/events`
  //    里连最初的 `requests` 事件都不会有，收件人自然也收不到。
  //    （代码注释里原先假设的「400 max_emails_per_day_exceeded」并不成立。）
  //
  //    于是「res.ok 就当成功」的写法会让一把用完额度的**死 Key 把整封邮件吃掉**：
  //    既不轮转到下一把，也不回退 Posta/CF，而调用方还拿到「已发送」。
  //    实测那天第 1 把 Key（bdoulor@gmail.com）在 16:23 之后彻底停止受理，
  //    而它又因为「模块级游标在冷启动 isolate 里恒为 0」被优先命中，
  //    导致相当比例的验证码邮件凭空消失。
  //
  // 对策：发信前按缓存的额度把「已知当日已用尽」的 Key 剔掉；全剔光就如实
  // 抛 MAIL_QUOTA_EXCEEDED（调用方据此暂停/重试），绝不假装成功。
  const usable: string[] = []
  for (const key of keys) {
    const credits = await brevoCredits(key)
    // credits === null 表示读不到（网络/IP/套餐语义未知）→ 不拦，保持旧行为
    if (credits === null || credits > 0) usable.push(key)
  }
  if (usable.length === 0) {
    throw new ApiError(
      429,
      `Brevo 全部 ${keys.length} 把 Key 的当日额度都已用尽，请稍后重试或补充新 Key`,
      "MAIL_QUOTA_EXCEEDED"
    )
  }

  // 轮转起点取游标（初值随机，见 brevoKeyCursor 注释），避免冷启动时永远先打第一把 Key
  const start = brevoKeyCursor++ % usable.length
  const ordered = [...usable.slice(start), ...usable.slice(0, start)]
  const tag = ordered.length > 1 ? (i: number) => `（第 ${i + 1}/${ordered.length} 把 Key）` : () => ""

  let lastErr: ApiError | null = null
  for (let i = 0; i < ordered.length; i++) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": ordered[i],
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: input.to }],
        subject: input.subject,
        textContent: input.text,
        ...(input.html ? { htmlContent: input.html } : {}),
      }),
    })
    if (res.ok) {
      noteBrevoUsed(ordered[i])
      return
    }

    const body = (await res.text()).slice(0, 200)
    // 免费版 300 封/天用完后（在仍会回 400 的情况下）返回 max_emails_per_day_exceeded ——
    // 属额度类，让调用方「暂停」而不是把这批人记成失败（见 isQuotaResponse 说明）。
    const quota = isQuotaResponse(res.status, body)
    if (quota) markBrevoExhausted(ordered[i])
    lastErr = new ApiError(
      quota ? 429 : 502,
      `Brevo 发信失败: ${res.status} ${body}${tag(i)}`,
      quota ? "MAIL_QUOTA_EXCEEDED" : "MAIL_SEND_FAILED"
    )
    // 只有「这把 Key 用完了（额度）」或「这把 Key 无效/被停用（401/403）」
    // 才值得换下一把重试；其余失败（如收件人被拒、参数错误）换 Key 也没用。
    const retryable = quota || res.status === 401 || res.status === 403
    if (!retryable) throw lastErr
  }
  throw lastErr ?? new ApiError(502, "Brevo 发信失败", "MAIL_SEND_FAILED")
}

/** 可用的出站通道标识 */
export type MailTransport = "posta" | "brevo" | "cf"

/**
 * 发送一封邮件（多通道路由）。
 *
 * 路由规则：
 *   1. 收件人命中 `mail_cf_targets` 白名单 → 直接走 CF（管理员等固定目标，送达率高且免费）。
 *   2. 否则按 `mail_transport_order` 顺序逐个尝试（默认 posta → brevo → cf），
 *      前一个失败自动回退到下一个，全部失败抛出最后一个错误。
 *
 * `opts.prefer` 用于「公告群发」这类需要管理员指定主通道的场景：把该通道提到
 * 顺序最前，**其余通道仍然保留为回退**。只改优先级、不改回退语义 —— 首选通道
 * 临时故障时邮件照样发得出去，不会因为一个下拉框而全军覆没。
 *
 * `opts.chain` 用于**显式指定**整条通道链（以值为准，不再读 mail_transport_order）。
 * 公告群发靠它把 posta 摘掉：posta 是异步队列，HTTP 200 只代表"已排队"，上游
 * 真实失败对调用方不可见，混进回退链会把「没发出去」记成「已发送」（见
 * handlers/announcements.ts 的 ANNOUNCE_CHAIN）。
 *
 * 失败时抛出可读的业务错误。
 */
export async function sendMail(
  env: Env,
  input: SendMailInput,
  opts: { prefer?: MailTransport; chain?: MailTransport[] } = {}
): Promise<void> {
  // 1. CF 白名单命中 → 直接 CF（白名单支持换行/逗号/空格分隔，一行一个）
  const cfTargets = (await getSetting(env, "mail_cf_targets"))
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (cfTargets.includes(input.to.toLowerCase())) {
    await sendViaCf(env, input)
    return
  }

  // 2. 按顺序回退。显式 chain 优先，否则用设置项 mail_transport_order。
  const order: string[] = opts.chain?.length
    ? [...opts.chain]
    : (await getSetting(env, "mail_transport_order"))
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)

  // 首选通道提到最前（去重后追加其余）
  const effective =
    opts.prefer && order.includes(opts.prefer)
      ? [opts.prefer, ...order.filter((t) => t !== opts.prefer)]
      : order

  let lastErr: unknown = null
  // 记录每个通道的失败原因：只留最后一个会让排查被误导 —— 回退通道多半是"兜底也失败"
  // （例如 CF 未 Onboard 时的「收件人未验证」），而真正的原因是首选通道给的
  // （2026-09-28 实测：Brevo 直接拒收的地址，全被记成了 CF 的"未验证"）。
  const failures: { transport: string; err: unknown }[] = []
  for (const t of effective) {
    try {
      if (t === "posta") await sendViaPosta(env, input)
      else if (t === "brevo") await sendViaBrevo(env, input)
      else if (t === "cf") await sendViaCf(env, input)
      else continue
      return // 成功即返回
    } catch (err) {
      lastErr = err
      // 额度/限流是**全局**错误：换通道重试没有意义（下一个通道多半也没额度），
      // 而且会把真实原因（额度用尽）掩盖成最后那个通道的报错。直接抛给调用方，
      // 由它决定「暂停、稍后重试」。
      if (err instanceof ApiError && err.code === "MAIL_QUOTA_EXCEEDED") throw err
      failures.push({ transport: t, err })
      console.error(`邮件通道「${t}」发信失败，回退下一个:`, err)
    }
  }

  // 3. 全部失败。
  // 错误码/HTTP 状态沿用最后一个通道的（保持既有调用方语义不变），
  // 但消息里带上完整链路，管理员一眼能看出是哪一环真正拒收。
  if (failures.length > 0) {
    const detail = failures
      .map(({ transport, err }) => `${transport}: ${err instanceof Error ? err.message : String(err)}`)
      .join(" ｜ ")
    if (lastErr instanceof ApiError) {
      throw new ApiError(lastErr.status, detail.slice(0, 400), lastErr.code)
    }
    throw new ApiError(502, detail.slice(0, 400), "MAIL_SEND_FAILED")
  }
  throw new ApiError(503, "没有可用的邮件发送通道", "MAIL_NOT_CONFIGURED")
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

/** HTML 转义（与 profile-page.ts 的 esc 同口径，覆盖 &<>"'） */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * 统一的邮件外观（纯文本 + 简单 HTML）。
 *
 * ⚠️ 2026-09-25 审计（H10）：原实现把 title / paragraphs / code **原样插进
 * HTML**，没有任何转义。而这三个参数里有用户可控的自由文本：
 *   - `frp.ts` 的 `info.remark`（500 字符自由文本）
 *   - `donations.ts` 的 `body.remark`（200 字符自由文本）
 *   - `wb2api.ts` 的接口返回文本
 * 而这类通知邮件是**发给管理员**的 —— 也就是说普通用户可以在管理员的
 * 邮箱里注入任意 HTML（钓鱼链接、追踪像素、伪装按钮）。
 * 现在统一在这里转义：所有调用方自动安全，不需要各自记得转义。
 * 若将来确实需要发富文本，应新增一个显式的 `renderMailRaw` 而不是放开这里。
 */
export function renderMail(
  title: string,
  paragraphs: string[],
  code?: string
): { text: string; html: string } {
  const text = [title, "", ...paragraphs].join("\n")
  // 品牌头：站点图标 + 站名，整块可点击进控制台。
  // 用 <img> 外链而不是内联 SVG —— Gmail/Outlook 等主流客户端会剥掉 <svg>，
  // 图片是邮件里唯一可靠的品牌位；加 ?v= 绕开站点对 /favicon.png 的一年 immutable 缓存。
  const brand = `<a href="https://cloud.doulor.cn/dashboard" target="_blank" style="display:inline-block;margin:0 0 20px;text-decoration:none">
      <img src="https://cloud.doulor.cn/favicon.png?v=2" width="40" height="40" alt="Doulor Cloud" style="border-radius:10px;display:inline-block;vertical-align:middle;border:0">
      <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:21px;font-weight:700;letter-spacing:-0.02em;color:#111827">Doulor Cloud</span>
    </a>`
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e7eb">
    ${brand}
    <h1 style="margin:0 0 16px;font-size:18px;color:#111827">${escapeHtml(title)}</h1>
    ${paragraphs
      .map(
        (p) =>
          `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">${escapeHtml(p)}</p>`
      )
      .join("")}
    ${
      code
        ? `<div style="margin:20px 0;padding:14px;background:#f3f4f6;border-radius:8px;text-align:center">
             <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26px;letter-spacing:6px;font-weight:600;color:#111827">${escapeHtml(code)}</span>
           </div>`
        : ""
    }
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
    <p style="margin:0;font-size:12px;color:#9ca3af">Doulor Cloud · 请勿回复本邮件</p>
  </div>
</body></html>`
  return { text, html }
}