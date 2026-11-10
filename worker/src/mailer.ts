/**
 * 出站邮件：三条通道 + 失败自动回退（顺序见设置项 `mail_transport_order`）。
 *
 *   `brevo`      —— Brevo（Sendinblue）HTTP API，第三方，支持多把 Key 叠加额度；
 *   `cf-send`    —— Cloudflare **Email Sending** REST API：可发任意邮箱，
 *                   前提是把发送域名 Onboard（Workers Paid）；
 *   `cf-routing` —— Cloudflare **Email Routing** 的 `send_email` 绑定：免费，
 *                   但只能发账户内「已验证的 destination address」。
 *
 * 默认顺序 `brevo → cf-send → cf-routing`，前一条失败（含额度用尽）自动换下一条，
 * 全部失败才把整条链路的报错回给调用方（见文件末尾的 sendMail）。
 *
 * 为什么不用 SMTP：Workers 运行时**没有 TCP socket**，无法连接
 * smtp.qq.com / SES SMTP 之类的外部 SMTP 服务。Cloudflare 提供的
 * send_email 绑定 / Email Sending REST API 就是官方替代方案。
 */
import { ApiError } from "./http"
import { getSetting } from "./settings"
import { fetchWithTimeout } from "./async-utils"
import type { Env } from "./env"

/**
 * 默认发件人（也是 CF 两条路径的兜底）。
 *
 * 域名必须等于**在 Cloudflare Email Sending 里 Onboard 过的那个**。当前是根域
 * `doulor.cn`（2026-11-08 站长确认；DNS 上也确实是它：`include:_spf.mx.cloudflare.net`
 * 的 SPF + `cf2024-1._domainkey` 的 DKIM）。
 * 换发送域名时改设置项 `cf_send_from`（面板即时生效），并同步检查
 * worker/wrangler.toml 里 send_email 绑定的 `allowed_sender_addresses`。
 */
export const MAIL_FROM = "no-reply@doulor.cn"
export const MAIL_FROM_NAME = "Doulor Cloud"

/** 调 Cloudflare 管理 API 的超时（与 cloudflare.ts 同口径） */
const CF_API_TIMEOUT_MS = 15_000

export interface SendMailInput {
  to: string
  subject: string
  text: string
  html?: string
  /**
   * 自定义发件人 —— 目前只有「站内邮箱对外发信」会传（用用户自己的邮箱地址当 From，
   * 收件人才看得出是谁发的）。不传 = 各通道的默认发件人
   * （`brevo_sender_email` / `cf_send_from` / `MAIL_FROM`）。
   *
   * ⚠️ `cf-routing`（send_email 绑定）受 `allowed_sender_addresses` 限制，
   *    永远用 `MAIL_FROM`，**忽略**本字段 —— 绑定的白名单里没有用户地址，
   *    传了只会被 CF 拒掉。
   */
  from?: { email: string; name?: string }
  /** 回信地址（用户自己的邮箱），让收件人直接回复到用户而不是 no-reply */
  replyTo?: string
  /**
   * 额外邮件头（三条通道都原样透传）。目前由 renderMail 生成：
   * `Auto-Submitted`，以及通知类邮件的 `List-Unsubscribe` / `List-Unsubscribe-Post`。
   *
   * ⚠️ CF 两条通道按白名单校验头名，不在白名单里的会**整封拒发**
   *    （developers.cloudflare.com/email-service/reference/headers/）。
   *    新增头之前先查那张表；自定义头一律用 `X-` 前缀。
   */
  headers?: Record<string, string>
}

/**
 * 把 Cloudflare 的发送错误转成可操作的中文业务错误。
 *
 * 集中一处，让各条发送路径（验证码 / 通知 / 群发）走完全一样的错误分类，
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
  // 发送域名没在 Email Sending 里 Onboard（站长 2026-11-08 只开了 mail.doulor.cn）
  if (/E_SENDER_DOMAIN_NOT_AVAILABLE|sender domain/i.test(`${code} ${message}`)) {
    return new ApiError(
      400,
      "发件域名不可用：这个地址的域名没有在 Cloudflare Email Sending 里 Onboard —— 把「发件人邮箱」改成已开通的那个域名下的地址（当前开通的是 mail.doulor.cn）",
      "SENDER_DOMAIN_NOT_AVAILABLE"
    )
  }
  return new ApiError(502, `邮件发送失败：${message}`, "MAIL_SEND_FAILED")
}

// 这里原本有一个 `isMailerConfigured(env)`（= `Boolean(env.EMAIL)`），已删除：
// 无调用点，而且它想表达的那件事在真正发信的地方**已经做了** ——
// `sendViaCfRouting` 在 `!env.EMAIL` 时直接抛一个带修复指引的 ApiError。
// 多留一个「能不能发信」的并行判断，只会让人误以为发信路径会先去问它。

/**
 * 解析 `cf-send` 用的 API Token。
 *
 * 顺序：设置项 `cf_send_token`（管理面板可填，只写不读）→ Worker Secret
 * `CLOUDFLARE_API_TOKEN_SECRET` → 普通变量 `CLOUDFLARE_API_TOKEN`。
 *
 * 为什么允许单独填：全站那把 CF Token 权限很大（DNS / Workers / Email Routing），
 * 而发信只需要「Email Sending: Edit」。能给发信单独发一把最小权限 Token，
 * 就没必要让邮件通道依赖那把大 Token 的死活。返回空串 = 未配置（不抛错，
 * 由调用方决定是 503 还是静默跳过）。
 */
async function resolveCfSendToken(env: Env): Promise<string> {
  const own = (await getSetting(env, "cf_send_token")).trim()
  if (own) return own
  return (env.CLOUDFLARE_API_TOKEN_SECRET || env.CLOUDFLARE_API_TOKEN || "").trim()
}

/**
 * `cf-routing` 通道：通过 Cloudflare Email Routing 的 `send_email` 绑定发信。
 *
 * ⚠️ 能力边界（这正是要单独有一条 `cf-send` 的原因）：
 *   在没有把发送域名 Onboard 之前，这个绑定**只能发往账户内「已验证的 destination address」**。
 *   免费、送达率高，适合发给固定的管理员邮箱；但要发给任意用户就必须走 `cf-send`
 *   （REST API + 已 onboard 域名）。
 *
 * 发件人与 `cf-send` 共用设置项 `cf_send_from`：两条 CF 路径必须从**同一个已 onboard
 * 的域名**发出，否则其中一条会报 `E_SENDER_DOMAIN_NOT_AVAILABLE`。绑定的
 * `allowed_sender_addresses`（wrangler.toml）也必须包含这个地址。
 */
async function sendViaCfRouting(env: Env, input: SendMailInput): Promise<void> {
  if (!env.EMAIL) {
    throw new ApiError(
      503,
      "CF Routing 发信未配置（缺少 send_email 绑定）",
      "MAIL_NOT_CONFIGURED"
    )
  }
  const fromParts = splitAddress((await getSetting(env, "cf_send_from")).trim() || MAIL_FROM)
  const fromAddress = fromParts.address || MAIL_FROM
  const fromName =
    (await getSetting(env, "cf_send_from_name")).trim() || fromParts.name || MAIL_FROM_NAME
  try {
    await env.EMAIL.send({
      to: input.to,
      from: { email: fromAddress, name: fromName },
      subject: input.subject,
      text: input.text,
      html: input.html,
      ...(input.headers ? { headers: input.headers } : {}),
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
 * （code 形如 `max_emails_per_day_exceeded`）；超速率则返回 429。
 */
function isQuotaResponse(status: number, body: string): boolean {
  if (status === 429 || status === 402) return true
  return /max_emails|quota|daily[ _-]?limit|credits?[ _-]?(exceed|limit)|(exceed|reach)\w*\s+(the\s+)?(daily\s+)?(limit|quota)/i.test(
    body
  )
}

/**
 * Cloudflare Email Sending REST API 的错误码 → 可操作的中文说明。
 *
 * 为什么不直接把原始英文丢给管理员：这些报错几乎全是「后台少做了一步」，
 * 而英文原文（`email.sending.error.authentication.forbidden`）看不出该去点哪里。
 * 码表来源：developers.cloudflare.com/email-service/api/send-emails/rest-api/。
 */
const CF_SEND_ERROR_HINTS: Record<number, string> = {
  10000: "账户 ID 不对，或该账户没有 Email Sending 权限",
  10001: "请求格式不合法（收件人 / 发件人 / 主题缺失或格式错）",
  10100: "Cloudflare 认证服务暂时不可用，稍后重试",
  10101: "API Token 无效或已过期",
  10102: "API Token 缺少「Email Sending」权限（Edit）",
  10103: "Token 类型不对：这里要的是 API Token，不是 Origin CA / 全局 Key",
  10105: "账户未开通 Email Sending（需要 Workers Paid 套餐）",
  10200: "邮件体积超过 25 MiB 上限",
  10202: "邮件内容不合法（被 Cloudflare 判为无效邮件）",
  10203: "该 zone / 账户的发信功能被关闭了",
  10207: "账户的发信被暂停（收件人投诉率过高）",
}

/** 从 Cloudflare 的错误响应里挑一句人话 */
function cfSendErrorMessage(status: number, raw: string): { message: string; code: string } {
  let code = 0
  let msg = raw.slice(0, 200)
  try {
    const body = JSON.parse(raw) as {
      errors?: { code?: number; message?: string }[]
    }
    const first = body?.errors?.[0]
    if (first) {
      code = Number(first.code ?? 0)
      msg = String(first.message ?? msg)
    }
  } catch {
    // 非 JSON（网关 5xx 之类）—— 用原始文本
  }
  const hint = CF_SEND_ERROR_HINTS[code]
  const quota = status === 429 || code === 10004 || /throttled|rate[ _-]?limit|daily/i.test(msg)
  return {
    message: `CF Send 发信失败: ${status} ${hint ? `${hint}（` : ""}${msg}${hint ? "）" : ""}`,
    code: quota ? "MAIL_QUOTA_EXCEEDED" : "MAIL_SEND_FAILED",
  }
}

/**
 * 把 `Name <addr@host>` 或裸地址拆成 { address, name }。
 *
 * 为什么需要：发件人设置项是个普通输入框，管理员很自然会照 RFC 5322 的习惯写
 * `Doulor Cloud <no-reply@doulor.cn>`（Posta 时代那一栏就是这种格式）。
 * 而 REST API 要的是 `{ address, name }` 两个字段 —— 把整串塞进 address 会被
 * Cloudflare 判成 10001 invalid_request_schema，报错信息完全看不出是这个原因。
 */
function splitAddress(raw: string): { address: string; name: string } {
  const s = raw.trim()
  const m = /^(.*?)<([^>]+)>\s*$/.exec(s)
  if (m) return { address: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, "").trim() }
  return { address: s, name: "" }
}

/**
 * `cf-send` 通道：通过 **Cloudflare Email Sending** 的 REST API 发信 —— 可发任意邮箱。
 *
 * 为什么和 `cf-routing` 是两条通道（不是同一个东西的两个名字）：
 *   · `cf-routing` 用 Workers 的 `send_email` 绑定，**只能发账户内已验证的收件地址**，
 *     免费、不需要 onboard 域名 —— 适合发给固定的管理员邮箱；
 *   · `cf-send` 走 `POST /accounts/{id}/email/sending/send`，需要把发送域名在
 *     Compute → Email Service → Email Sending 里 Onboard（Workers Paid），
 *     之后可以发给**任意**收件人。用户收验证码 / 找回密码靠的是这条。
 * 两条互不影响：绑定没配额、API 有配额；API 挂了绑定还能兜住白名单里的人。
 *
 * 认证：设置项 `cf_send_token`（面板可填，只写不读）→ 回落 Worker Secret
 * `CLOUDFLARE_API_TOKEN_SECRET` → 普通变量 `CLOUDFLARE_API_TOKEN`。
 * 独立设置项的意义：可以给发信单独开一把只含「Email Sending: Edit」的最小权限 Token，
 * 不必把全站那把大权限 Token 交出去。
 *
 * 响应语义（与绑定不同）：HTTP 200 只代表「已受理」，真正的每个收件人结果在
 * `result.delivered / queued / permanent_bounces` 里。**必须看这三个字段**：
 * 收件人被硬退（permanent_bounces）时 HTTP 仍是 200 —— 只判 `res.ok` 会把退信
 * 当成发送成功（这与 Brevo「201 + 静默丢弃」是同一类坑）。
 */
async function sendViaCfSend(
  env: Env,
  input: SendMailInput,
  /**
   * 「Cloudflare 已受理」的回调（HTTP 2xx 且已解析出结果时立刻调一次）。
   *
   * 为什么要这个钩子而不是在函数外用 `await send()` 之后计数：**收件人被硬退时
   * 本函数会抛错**，但那封信在 Cloudflare 那边**已经算进配额**了（官方口径：
   * hard-bounce 计入，只有 API 边界被拒的才不计）。放在外面数就会漏掉退信，
   * 月度用量越数越少，最后超额扣费还以为没超。
   */
  onAccepted?: () => Promise<void>
): Promise<void> {
  const accountId = (env.ACCOUNT_ID ?? "").trim()
  const token = await resolveCfSendToken(env)
  if (!accountId || !token) {
    throw new ApiError(
      503,
      "CF Send 未配置（缺少 API Token 或账户 ID）：请在管理面板填写 Token，或在 Cloudflare 后台创建含「Email Sending: Edit」权限的 Token",
      "MAIL_NOT_CONFIGURED"
    )
  }
  const fromRaw = (await getSetting(env, "cf_send_from")).trim() || MAIL_FROM
  const fromName = (await getSetting(env, "cf_send_from_name")).trim() || MAIL_FROM_NAME
  const fromParts = splitAddress(fromRaw)
  const fromAddress = (input.from?.email ?? fromParts.address) || MAIL_FROM
  const fromDisplay = input.from?.name || fromName

  let res: Response
  try {
    res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // REST 口径的具名地址是 { address, name }（与 Workers 绑定的 { email, name } 不同）
          from: { address: fromAddress, name: fromDisplay },
          to: [{ address: input.to }],
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
          subject: input.subject,
          text: input.text,
          ...(input.html ? { html: input.html } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
        }),
      },
      CF_API_TIMEOUT_MS
    )
  } catch (err) {
    throw new ApiError(
      502,
      `CF Send 请求失败：${err instanceof Error ? err.message : String(err)}`,
      "MAIL_SEND_FAILED"
    )
  }

  const raw = (await res.text()).slice(0, 500)
  if (!res.ok) {
    const { message, code } = cfSendErrorMessage(res.status, raw)
    throw new ApiError(code === "MAIL_QUOTA_EXCEEDED" ? 429 : 502, message, code)
  }

  // 走通了 API 边界 = 计入本月用量（退信也算，见 onAccepted 的注释）
  if (onAccepted) await onAccepted()

  // 200 也要逐个看收件人结果（见本函数上方的说明）
  const to = input.to.toLowerCase()
  let bounced = false
  try {
    const body = JSON.parse(raw) as {
      success?: boolean
      result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] }
    }
    const delivered = (body.result?.delivered ?? []).map((e) => e.toLowerCase())
    const queued = (body.result?.queued ?? []).map((e) => e.toLowerCase())
    const bounces = (body.result?.permanent_bounces ?? []).map((e) => e.toLowerCase())
    bounced = bounces.includes(to) && !delivered.includes(to) && !queued.includes(to)
  } catch {
    // 解析不了就按成功处理：HTTP 200 已经说明 Cloudflare 受理了这封信
    return
  }
  if (bounced) {
    throw new ApiError(
      502,
      `CF Send 收件人被硬退（permanent bounce）：${input.to} 不存在或拒收`,
      "MAIL_SEND_FAILED"
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

/**
 * 把 Brevo 的错误响应翻成管理员能照着修的一句话。
 *
 * 为什么不能只贴原始 body：站长 2026-11-08 反馈「Brevo 总是发送失败」，
 * 而这三种失败在 Brevo 侧长得完全不一样，原始 JSON 里也看不出该去点哪里：
 *   · 401 / `Key not found`            → Key 过期或被删
 *   · 401 / `unrecognised IP address`  → 该子账号开了 IP 白名单，Worker 出口 IP 不在名单里
 *   · 400 / `sender` 相关              → 发件人邮箱没在 Brevo 后台验证过
 * 这三条都跟"额度"无关 —— 把它们混成一句话，排查时自然会先怀疑额度。
 */
function brevoErrorMessage(status: number, body: string, tag: string): string {
  const raw = body.replace(/\s+/g, " ").trim()
  if (status === 401 || status === 403) {
    const ipBlocked = /ip|unrecognised|unrecognized|whitelist/i.test(raw)
    return `Brevo 发信失败: ${status} ${
      ipBlocked
        ? "Key 所在子账号开启了 IP 校验，Worker 出口 IP 不在白名单 —— 去 Brevo 后台关掉 IP 校验"
        : "Key 无效 / 已删除 / 无发信权限 —— 换一把 Key"
    }（${raw}）${tag}`
  }
  if (/sender|from/i.test(raw) && status === 400) {
    return `Brevo 发信失败: 400 发件人未通过验证 —— 请在 Brevo 后台验证发件邮箱或域名（${raw}）${tag}`
  }
  if (/blocked|suspended|account/i.test(raw) && status === 400) {
    return `Brevo 发信失败: 400 账号被停用或受限 —— 去 Brevo 后台查看账号状态（${raw}）${tag}`
  }
  return `Brevo 发信失败: ${status} ${raw}${tag}`
}

/** 通过 Brevo（Sendinblue）发信（HTTP API）—— 可发任意邮箱，支持多把 Key 叠加额度 */
async function sendViaBrevo(env: Env, input: SendMailInput): Promise<void> {
  const keys = parseBrevoKeys(await getSetting(env, "brevo_api_key"))
  const senderEmail = (await getSetting(env, "brevo_sender_email")).trim()
  const senderName =
    (await getSetting(env, "brevo_sender_name")).trim() || MAIL_FROM_NAME
  // 站内邮箱对外发信会带自己的地址当发件人（见 SendMailInput.from）：
  // Brevo 只要**域名**验证过，同域下任意 local part 都能发，所以用户地址可以直接用。
  const fromEmail = input.from?.email?.trim() || senderEmail
  if (keys.length === 0 || !fromEmail) {
    throw new ApiError(503, "Brevo 未配置（缺少 API key 或发件人）", "MAIL_NOT_CONFIGURED")
  }

  // ⚠️ 2026-09-30 实测（这是「有人说收不到验证码」的根因）：
  //    Brevo 免费版的**当日额度用尽后，POST /v3/smtp/email 依旧返回 201 Created
  //    并给一个 messageId**，然后把这封信**静默丢弃** —— `GET /v3/smtp/statistics/events`
  //    里连最初的 `requests` 事件都不会有，收件人自然也收不到。
  //    （代码注释里原先假设的「400 max_emails_per_day_exceeded」并不成立。）
  //
  //    于是「res.ok 就当成功」的写法会让一把用完额度的**死 Key 把整封邮件吃掉**：
  //    既不轮转到下一把，也不回退到后面的通道，而调用方还拿到「已发送」。
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
        sender: { name: input.from?.name || senderName, email: fromEmail },
        to: [{ email: input.to }],
        ...(input.replyTo ? { replyTo: { email: input.replyTo } } : {}),
        subject: input.subject,
        textContent: input.text,
        ...(input.html ? { htmlContent: input.html } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
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
      brevoErrorMessage(res.status, body, tag(i)),
      quota ? "MAIL_QUOTA_EXCEEDED" : "MAIL_SEND_FAILED"
    )
    // 只有「这把 Key 用完了（额度）」或「这把 Key 无效/被停用（401/403）」
    // 才值得换下一把重试；其余失败（如收件人被拒、参数错误）换 Key 也没用。
    const retryable = quota || res.status === 401 || res.status === 403
    if (!retryable) throw lastErr
  }
  throw lastErr ?? new ApiError(502, "Brevo 发信失败", "MAIL_SEND_FAILED")
}

/**
 * 可用的出站通道标识。
 *
 * ⚠️ 这三个值会**原样存进 `app_settings.mail_transport_order`**（逗号分隔），
 *    所以改名等于改数据格式：旧值 `cf` / `posta` 的兼容处理见 `normalizeTransportOrder`。
 */
export type MailTransport = "brevo" | "cf-send" | "cf-routing"

/** 全部通道（含只有白名单才会用到的 cf-routing；顺序即"合法值"清单） */
export const MAIL_TRANSPORTS: readonly MailTransport[] = ["brevo", "cf-send", "cf-routing"]

/**
 * 默认发送顺序：Brevo → CF Send。
 *
 * 为什么不是三条都列上（2026-11-08 站长定调）：
 *   · Brevo 超额度**不扣费**（只是发不出去），CF Email Sending 超额度**要扣费** ——
 *     所以"会失败的免费通道"排在"可能产生账单的通道"前面，CF 只当备用；
 *   · `cf-routing` 不放进来：它不能发任意收件人，唯一的独立价值（已验证地址免费不限量）
 *     已经由 `mail_cf_targets` 白名单直接接管，放进链里只会让每封普通邮件先白失败一次。
 *     管理员仍可手工把它写进设置项，但默认不给。
 */
export const DEFAULT_TRANSPORT_ORDER: readonly MailTransport[] = ["brevo", "cf-send"]

/** 判断字符串是不是合法通道标识（设置项校验、公告首选通道归一化都走它） */
export function isMailTransport(v: string): v is MailTransport {
  return (MAIL_TRANSPORTS as readonly string[]).includes(v)
}

/**
 * 把设置项里的字符串解析成通道链。
 *
 * 兼容两种**历史值**（2026-11-08 重构：posta 下线 / `cf` 拆成 `cf-send` + `cf-routing`）：
 *   · `posta`  —— 自建网关已整体删除。整个值只要还提到 posta，就说明它是
 *                重构前写进库里的 —— 此时**整体回落到新默认链**，而不是
 *                把 posta 静默摘掉。否则老库里的 `brevo,posta,cf` 会变成
 *                `brevo,cf-routing`：既少了新加的 cf-send，又把"发不了任意收件人"
 *                的那条留在了链里。
 *   · `cf`     —— 旧名，等义于 `cf-routing`（当时只有绑定这一条 CF 路径）。
 *
 * 空串 / 全是垃圾值 → 回落到默认链（保证「配错了」不会变成「没有通道」）。
 */
export function normalizeTransportOrder(raw: string): MailTransport[] {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  if (parts.some((p) => p === "posta")) return [...DEFAULT_TRANSPORT_ORDER]

  const out: MailTransport[] = []
  for (const p of parts) {
    const t = p === "cf" ? "cf-routing" : p
    if (!isMailTransport(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  return out.length > 0 ? out : [...DEFAULT_TRANSPORT_ORDER]
}

/* ---- CF 发信的月度预算闸（不超额扣费）-------------------------------- */

/**
 * 计数窗口的键：`YYYY-MM`（= 该计费窗口**起始日所在的月份**）。
 *
 * 窗口起点与额度面板同源：设置项 `cf_cycle_day`（1~28，默认 1 = 自然月）。
 * 因为起始日固定是每月同一天，一个月里不可能出现两个不同的窗口起点 ——
 * 所以用"起点所在月份"当键是唯一且稳定的，不需要额外存日期。
 *
 * ⚠️ 这里没有直接 import cf-quota.ts 的 `quotaCycleStart`：那个模块是 handler，
 *    牵进来会把一堆 CF 额度/计费逻辑拖进发信路径。两边口径要一起改时记得对齐。
 */
function cfUsagePeriod(cycleDay: number, now = new Date()): string {
  const day = Math.min(Math.max(Math.trunc(cycleDay) || 1, 1), 28)
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (d.getUTCDate() < day) d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

export interface CfMailBudget {
  /** 本窗口已计费发送量 */
  used: number
  /** 上限（0 = 不限） */
  cap: number
  period: string
  /** 是否已到上限（到量就不再用 CF 发，避免扣费） */
  blocked: boolean
}

/**
 * 读本月 CF 发信用量与上限。
 *
 * ⚠️ 这是**本地计数**，不是去问 Cloudflare 账单（没有对应的轻量只读接口）。
 * 所以它只能保证"**本站**发的信不超额"；若同账号还有别的系统在发信，这里的数字会偏低。
 * 默认上限 2900（而不是 3000）就是为这类误差留的余量。
 */
export async function cfMailBudget(env: Env): Promise<CfMailBudget> {
  const capRaw = Number((await getSetting(env, "cf_send_monthly_cap")).trim())
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.trunc(capRaw) : 0
  const cycleDay = Number((await getSetting(env, "cf_cycle_day")).trim()) || 1
  const period = cfUsagePeriod(cycleDay)

  let used = 0
  try {
    const row = await env.DB.prepare(
      "SELECT count FROM mail_send_usage WHERE channel = 'cf' AND period = ?"
    )
      .bind(period)
      .first<{ count: number }>()
    used = row?.count ?? 0
  } catch (err) {
    // 表还没建（迁移 0193 没跑）→ 不拦（保持旧行为），但必须留下痕迹：
    // 闸门悄悄失效比扣钱更可怕，因为它连"为什么扣了"都查不出来。
    console.error("读取 CF 发信月度用量失败（迁移 0193_mail_send_usage.sql 没跑？）:", err)
  }

  return { used, cap, period, blocked: cap > 0 && used >= cap }
}

/** 成功（被 CF 受理）一封 → 本窗口 +1 */
async function noteCfSendUsage(env: Env, period: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO mail_send_usage (channel, period, count, updated_at)
       VALUES ('cf', ?, 1, ?)
       ON CONFLICT(channel, period) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`
    )
      .bind(period, new Date().toISOString())
      .run()
  } catch (err) {
    console.error("累加 CF 发信月度用量失败:", err)
  }
}

/**
 * 走 CF 发信（cf-send / cf-routing）—— **先过月度预算闸，再发**。
 *
 * 到量时抛 `MAIL_BUDGET_REACHED`（不是 MAIL_QUOTA_EXCEEDED）：让它按"这条通道暂时不可用"
 * 回退给下一条通道，而不是触发公告群的"暂停等额度恢复"（预算要到下个账期才恢复，
 * 让队列挂在那儿等一个月没有意义）。
 */
async function sendViaCfMetered(
  env: Env,
  transport: "cf-send" | "cf-routing",
  input: SendMailInput
): Promise<void> {
  const budget = await cfMailBudget(env)
  if (budget.blocked) {
    throw new ApiError(
      429,
      `CF 发信本账期已用 ${budget.used}/${budget.cap} 封（免费额度 3000），已达自设上限 —— 为避免超额扣费，本次不使用 CF 通道`,
      "MAIL_BUDGET_REACHED"
    )
  }
  const meter = () => noteCfSendUsage(env, budget.period)
  if (transport === "cf-send") {
    await sendViaCfSend(env, input, meter)
    return
  }
  await sendViaCfRouting(env, input)
  await meter()
}

/** 按单个通道发一封（`testMail` 的逐通道自检、以及 sendMail 的回退循环共用） */
export async function sendMailVia(
  env: Env,
  transport: MailTransport,
  input: SendMailInput
): Promise<void> {
  if (transport === "brevo") return sendViaBrevo(env, input)
  return sendViaCfMetered(env, transport, input)
}

/**
 * 发送一封邮件（多通道路由 + 失败自动回退）。
 *
 * 路由规则：
 *   1. 收件人命中 `mail_cf_targets` 白名单 → 直接走 `cf-routing`
 *      （已验证 destination 的发送**永远免费、不占额度**，所以这条路径不过预算闸）。
 *   2. 否则按 `mail_transport_order` 顺序逐个尝试（默认 brevo → cf-send），
 *      前一个失败自动回退到下一个；全部失败才抛错，消息里带上**每一环**的失败原因。
 *      CF 那两条进链时都要过 `cf_send_monthly_cap` 的月度预算闸（见 sendViaCfMetered），
 *      到量就跳过 —— 宁可不发，也不产生超额账单。
 *
 * ⚠️ 回退不再区分错误类型（2026-11-08 站长要求）：额度用尽、Key 失效、发件人未验证
 *    一律继续往后试。旧实现在额度类错误上直接 `throw` 中断整条链 —— 结果是一条通道
 *    额度用尽就等于「所有邮件都发不出去」，哪怕后面还有两条能用的通道。
 *    唯一的例外在最后一步：只要链路上出现过额度类失败，最终仍以 MAIL_QUOTA_EXCEEDED
 *    收尾，让公告群发保持「暂停本轮、剩余留 pending、等额度恢复再续跑」的既有语义。
 *
 * `opts.prefer` 用于「公告群发」这类需要管理员指定主通道的场景：把该通道提到
 * 顺序最前，**其余通道仍然保留为回退**。只改优先级、不改回退语义 —— 首选通道
 * 临时故障时邮件照样发得出去，不会因为一个下拉框而全军覆没。
 *
 * `opts.chain` 用于**显式指定**整条通道链（以值为准，不再读 mail_transport_order）。
 *
 * 失败时抛出可读的业务错误。
 */
export async function sendMail(
  env: Env,
  input: SendMailInput,
  opts: { prefer?: MailTransport; chain?: MailTransport[] } = {}
): Promise<void> {
  // 1. CF 白名单命中 → 直接 CF Routing（白名单支持换行/逗号/空格分隔，一行一个）
  //
  // ⚠️ 带自定义发件人（`input.from`，站内邮箱对外发信）时**不走这条捷径**：
  //    send_email 绑定的 allowed_sender_addresses 只认站点自己的那几个地址，
  //    走它会把发件人悄悄换成站点地址 —— 用户写的信变成"官方发的"，正是要避免的。
  const cfTargets = (await getSetting(env, "mail_cf_targets"))
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!input.from && cfTargets.includes(input.to.toLowerCase())) {
    await sendViaCfRouting(env, input)
    return
  }

  // 2. 按顺序回退。显式 chain 优先，否则用设置项 mail_transport_order。
  const order: MailTransport[] = opts.chain?.length
    ? [...opts.chain]
    : normalizeTransportOrder(await getSetting(env, "mail_transport_order"))

  // 首选通道提到最前（去重后追加其余）
  const preferred: MailTransport[] =
    opts.prefer && order.includes(opts.prefer)
      ? [opts.prefer, ...order.filter((t) => t !== opts.prefer)]
      : order

  // 带自定义发件人（站内邮箱对外发信）时，cf-routing **必然**发不出去：
  // 绑定的 allowed_sender_addresses 只认站点自己的那几个地址。直接摘掉它，
  // 免得每封信都白撞一次、还在日志里留一条注定失败的记录。
  const effective = input.from ? preferred.filter((t) => t !== "cf-routing") : preferred

  // 记录每个通道的失败原因：只留最后一个会让排查被误导 —— 回退通道多半是"兜底也失败"
  // （例如 CF 未 Onboard 时的「收件人未验证」），而真正的原因是首选通道给的
  // （2026-09-28 实测：Brevo 直接拒收的地址，全被记成了 CF 的"未验证"）。
  const failures: { transport: MailTransport; err: unknown }[] = []
  for (const t of effective) {
    try {
      await sendMailVia(env, t, input)
      return // 成功即返回
    } catch (err) {
      failures.push({ transport: t, err })
      console.error(`邮件通道「${t}」发信失败，回退下一个:`, err)
    }
  }

  // 3. 全部失败。
  if (failures.length > 0) {
    const detail = failures
      .map(({ transport, err }) => `${transport}: ${err instanceof Error ? err.message : String(err)}`)
      .join(" ｜ ")
    // 只要链路上出现过额度类失败，就以额度错误收尾（公告群发据此「暂停而非记失败」）。
    //
    // 为什么是 `some` 而不是 `every`：混着 quota 的失败最可能是「主通道没额度了，
    // 兜底通道本来就没配好」。此时如果按普通失败处理，群发会把**整批还没轮到的人**
    // 记成 failed —— 而他们只是要等额度恢复，重发按钮也救不回「已扣掉的重试次数」。
    // 暂停的代价小得多：留 pending、cron 每小时续跑一次，配置修好或额度恢复就自动发完。
    // 真实原因不会因此丢失 —— detail 里逐条列了每个通道的错误原文。
    const anyQuota = failures.some(
      (f) => f.err instanceof ApiError && f.err.code === "MAIL_QUOTA_EXCEEDED"
    )
    const lastErr = failures[failures.length - 1].err
    if (lastErr instanceof ApiError) {
      throw new ApiError(
        anyQuota ? 429 : lastErr.status,
        detail.slice(0, 400),
        anyQuota ? "MAIL_QUOTA_EXCEEDED" : lastErr.code
      )
    }
    throw new ApiError(502, detail.slice(0, 400), "MAIL_SEND_FAILED")
  }
  throw new ApiError(503, "没有可用的邮件发送通道", "MAIL_NOT_CONFIGURED")
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

/** 站点根地址（邮件里所有站内链接都从这里拼，保证同一个域名） */
const SITE_ORIGIN = "https://cloud.doulor.cn"

/** 站内页面的绝对地址：`siteUrl("/dashboard/feedback")` */
export function siteUrl(path: string): string {
  return `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`
}

/**
 * 邮件类别 —— 决定页脚写什么、能不能退订。
 *   · `transactional` 账号安全 / 用户自己操作的结果（验证码、重置密码、捐献审核结果…）：不可退订
 *   · `notification`  与本人相关的通知（社区互动、反馈回复），受 notify_enabled 控制：可退订
 *   · `announcement`  站点公告群发，受 notify_announcements 控制：可退订
 *   · `admin`         发给管理员的运营通知，收件地址在管理面板配置：不走用户退订
 */
export type MailKind = "transactional" | "notification" | "announcement" | "admin"

export interface RenderMailOptions {
  /** 默认 `transactional` */
  kind?: MailKind
  /** 验证码：单独放大显示 */
  code?: string
  /** 主操作按钮（下方会附一行可复制的备用链接）；只接受 http(s) 地址 */
  action?: { label: string; url: string }
  /** 收件箱列表里的预览摘要；不传取第一段正文 */
  preheader?: string
  /**
   * 一键退订地址（见 mail-unsubscribe.ts 的 unsubscribeUrl）。
   * 传了就会在页脚放「退订」链接，并生成 List-Unsubscribe / List-Unsubscribe-Post 头。
   */
  unsubscribeUrl?: string | null
}

export interface RenderedMail {
  text: string
  html: string
  /** 直接展开进 sendMail 的入参即可（`{ to, subject, ...rendered }`） */
  headers: Record<string, string>
}

const FOOTER_REASON: Record<MailKind, string> = {
  transactional: "这是一封与你的账号安全或你发起的操作相关的服务邮件，无法退订。",
  notification: "你收到这封邮件，是因为在 Doulor Cloud 开启了「个人通知」邮件。",
  announcement: "你收到这封邮件，是因为在 Doulor Cloud 开启了「站点公告」邮件。",
  admin: "你收到这封邮件，是因为该地址被配置为 Doulor Cloud 的管理员通知邮箱。",
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * 统一的邮件外观（纯文本 + HTML + 邮件头）。
 *
 * 结构（table 布局，Outlook / Gmail / 国内客户端都按预期渲染）：
 *   预览摘要（隐藏）→ 品牌头 → 标题 → 正文 → 验证码 / 主按钮 → 页脚
 *   页脚 = 收到原因 + 常用入口（控制台 / 通知设置 / 隐私政策 / 退订）
 *
 * ⚠️ 2026-09-25 审计（H10）：原实现把 title / paragraphs / code **原样插进
 * HTML**，没有任何转义。而这三个参数里有用户可控的自由文本：
 *   - `frp.ts` 的 `info.remark`（500 字符自由文本）
 *   - `donations.ts` 的 `body.remark`（200 字符自由文本）
 *   - `wb2api.ts` 的接口返回文本
 * 而这类通知邮件是**发给管理员**的 —— 也就是说普通用户可以在管理员的
 * 邮箱里注入任意 HTML（钓鱼链接、追踪像素、伪装按钮）。
 * 现在统一在这里转义：所有调用方自动安全，不需要各自记得转义。
 * 链接只能通过 `action` 由**调用方代码**给出，正文里的文字永远不会变成可点链接。
 * 若将来确实需要发富文本，应新增一个显式的 `renderMailRaw` 而不是放开这里。
 *
 * 第三个参数传字符串 = 旧用法（只有验证码），保持兼容。
 */
export function renderMail(
  title: string,
  paragraphs: string[],
  opts: string | RenderMailOptions = {}
): RenderedMail {
  const o: RenderMailOptions = typeof opts === "string" ? { code: opts } : opts
  const kind: MailKind = o.kind ?? "transactional"
  const action = o.action && isHttpUrl(o.action.url) ? o.action : undefined
  const unsub = o.unsubscribeUrl && isHttpUrl(o.unsubscribeUrl) ? o.unsubscribeUrl : undefined
  const body = paragraphs.filter((p) => p.trim().length > 0)

  // 页脚入口：管理员通知指向管理面板，其余指向用户自己的设置
  const links: { label: string; url: string }[] =
    kind === "admin"
      ? [
          { label: "管理面板", url: siteUrl("/dashboard/admin") },
          { label: "控制台", url: siteUrl("/dashboard") },
        ]
      : kind === "transactional"
        ? [
            { label: "控制台", url: siteUrl("/dashboard") },
            { label: "账号安全", url: siteUrl("/dashboard/settings?tab=security") },
            { label: "隐私政策", url: siteUrl("/privacy") },
          ]
        : [
            { label: "控制台", url: siteUrl("/dashboard") },
            { label: "通知设置", url: siteUrl("/dashboard/settings?tab=notify") },
            { label: "隐私政策", url: siteUrl("/privacy") },
            ...(unsub ? [{ label: "退订", url: unsub }] : []),
          ]

  // ---- 纯文本版：链接写全，任何客户端都能复制 ----
  const text = [
    title,
    "",
    ...paragraphs,
    ...(o.code ? ["", `验证码：${o.code}`] : []),
    ...(action ? ["", `${action.label}：${action.url}`] : []),
    "",
    "——",
    FOOTER_REASON[kind],
    ...links.map((l) => `${l.label}：${l.url}`),
    "Doulor Cloud · 本邮件由系统自动发送，请勿直接回复",
  ].join("\n")

  // ---- HTML 版 ----
  const preheaderText = (o.preheader ?? body[0] ?? title).replace(/\s+/g, " ").trim().slice(0, 90)
  // 预览摘要后面补一串零宽占位，免得客户端把正文后续内容（页脚链接）拼进预览里
  const preheader = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(
    preheaderText
  )}${"&#8199;&#65279;&#847;".repeat(30)}</div>`

  // 品牌头：站点图标 + 站名，整块可点击进控制台。
  // 用 <img> 外链而不是内联 SVG —— Gmail/Outlook 等主流客户端会剥掉 <svg>，
  // 图片是邮件里唯一可靠的品牌位；加 ?v= 绕开站点对 /favicon.png 的一年 immutable 缓存。
  const brand = `<a href="${siteUrl("/dashboard")}" target="_blank" style="display:inline-block;text-decoration:none">
          <img src="${siteUrl("/favicon.png?v=2")}" width="40" height="40" alt="Doulor Cloud" style="border-radius:10px;display:inline-block;vertical-align:middle;border:0">
          <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:21px;font-weight:700;letter-spacing:-0.02em;color:#111827">Doulor Cloud</span>
        </a>`

  const paragraphHtml = body
    .map(
      (p) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#374151">${escapeHtml(p).replace(
          /\r?\n/g,
          "<br>"
        )}</p>`
    )
    .join("")

  const codeHtml = o.code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0">
          <tr><td align="center" style="padding:14px;background:#f3f4f6;border-radius:8px">
            <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;letter-spacing:6px;font-weight:600;color:#111827">${escapeHtml(o.code)}</span>
          </td></tr>
        </table>`
    : ""

  const actionHtml = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 10px">
          <tr><td align="center" bgcolor="#111827" style="border-radius:8px">
            <a href="${escapeHtml(action.url)}" target="_blank" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(action.label)}</a>
          </td></tr>
        </table>
        <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:#6b7280">按钮无法点击？复制下面的链接到浏览器打开：</p>
        <p style="margin:0 0 4px;font-size:12px;line-height:1.6;word-break:break-all"><a href="${escapeHtml(action.url)}" target="_blank" style="color:#2563eb;text-decoration:underline">${escapeHtml(action.url)}</a></p>`
    : ""

  const footerLinks = links
    .map(
      (l) =>
        `<a href="${escapeHtml(l.url)}" target="_blank" style="color:#6b7280;text-decoration:underline">${escapeHtml(l.label)}</a>`
    )
    .join(`<span style="color:#d1d5db">&nbsp;·&nbsp;</span>`)

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9">
  <tr><td align="center" style="padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px">
      <tr><td style="padding:28px 28px 0">
        ${brand}
      </td></tr>
      <tr><td style="padding:20px 28px 8px">
        <h1 style="margin:0 0 16px;font-size:18px;line-height:1.4;color:#111827">${escapeHtml(title)}</h1>
        ${paragraphHtml}
        ${codeHtml}
        ${actionHtml}
      </td></tr>
      <tr><td style="padding:12px 28px 24px">
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:8px 0 16px">
        <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#9ca3af">${escapeHtml(FOOTER_REASON[kind])}</p>
        <p style="margin:0 0 8px;font-size:12px;line-height:1.6">${footerLinks}</p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af">Doulor Cloud · 本邮件由系统自动发送，请勿直接回复</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`

  // 邮件头：Auto-Submitted 让对方的自动回复 / 休假回信不回到 no-reply（RFC 3834）；
  // 有退订地址时补 RFC 2369 + RFC 8058 一键退订（Gmail / Yahoo 对批量发件人的硬性要求）
  const headers: Record<string, string> = { "Auto-Submitted": "auto-generated" }
  if (unsub && /^https:\/\//i.test(unsub)) {
    headers["List-Unsubscribe"] = `<${unsub}>`
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
  }

  return { text, html, headers }
}
