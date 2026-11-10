/**
 * AutoClaw（国内版）捐献 —— 手机验证码两段式（2026-10-27）。
 *
 * 为什么不用书签：AutoClaw 国内版**没有网页授权登录**，上游明确返回
 *   「AutoClaw 国内版没有网页授权登录，请改用「手机验证码登录」或「填写凭证」」
 * 所以这里走短信：用户填手机号 → 收码 → 提交 → 账号直接进 Agent2API 池。
 *
 * 链路：本站 → 入池网关 /_donate/sms/{send,verify} → 面板 /api/session/login/sms/*
 */
import type { Env } from "../env"
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { uuid } from "../crypto"
import { pushMessage } from "../user-messages"

const GATEWAY = "https://agent2api.doulor.cn/_donate"
const PROVIDER = "autoclaw"

async function gateway<T>(env: Env, path: string, body: unknown): Promise<T> {
  const key = env.RACCOON_DONATE_KEY
  if (!key) throw new ApiError(503, "入池网关密钥未配置（RACCOON_DONATE_KEY）", "DONATE_KEY_MISSING")
  const res = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { "X-Donate-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new ApiError(502, `入池网关返回非 JSON: ${text.slice(0, 160)}`, "GATEWAY_BAD_RESPONSE")
  }
  if (!res.ok) {
    throw new ApiError(502, `入池网关 ${res.status}: ${text.slice(0, 160)}`, "GATEWAY_ERROR")
  }
  return data as T
}

function normPhone(raw: unknown): string {
  const p = String(raw ?? "").replace(/\D/g, "")
  if (!/^1\d{10}$/.test(p)) {
    throw new ApiError(400, "请填写 11 位中国大陆手机号", "BAD_PHONE")
  }
  return p
}

/** POST /donations/autoclaw/sms/send —— 发送验证码（需登录 + 双重限流防刷短信） */
export async function autoclawSmsSend(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { phone?: string }
  const phone = normPhone(body.phone)

  await guardRateLimit(env, `autoclaw:sms:user:${user.id}`, 5, 600, "发送验证码过于频繁，请稍后再试")
  await guardRateLimit(env, `autoclaw:sms:phone:${phone}`, 5, 600, "该手机号发送验证码过于频繁")

  const r = await gateway<{ ok?: boolean; detail?: string }>(env, "/sms/send", {
    provider: PROVIDER,
    phone,
  })
  if (!r.ok) {
    throw new ApiError(400, r.detail || "验证码发送失败", "SMS_SEND_FAILED")
  }
  return json({ ok: true, sent: true })
}

type PoolAccount = {
  id?: string
  userId?: string
  name?: string
  displayName?: string
  provider?: string
  edition?: string
}

/** POST /donations/autoclaw/sms/verify —— 提交验证码，成功后账号已入池并落库 */
export async function autoclawSmsVerify(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { phone?: string; code?: string }
  const phone = normPhone(body.phone)
  const code = String(body.code ?? "").replace(/\D/g, "")
  if (!/^\d{4,8}$/.test(code)) {
    throw new ApiError(400, "请填写收到的验证码", "BAD_CODE")
  }
  await guardRateLimit(env, `autoclaw:smsv:user:${user.id}`, 10, 600, "尝试验证码过于频繁")

  const r = await gateway<{ ok?: boolean; detail?: string; account?: PoolAccount | null }>(
    env,
    "/sms/verify",
    { provider: PROVIDER, phone, code }
  )
  if (!r.ok) {
    throw new ApiError(400, r.detail || "验证码不正确或已失效", "SMS_VERIFY_FAILED")
  }
  const acc = r.account ?? null
  const accountId = String(acc?.id ?? "")
  const accountName = String(acc?.displayName ?? acc?.name ?? phone.slice(-4)).slice(0, 60)

  // 2026-10-29：解析不到账号时**绝不能假装成功**。
  // 原实现是 `if (accountId) { ...写库... }` 然后无条件 return ok:true —— 一旦网关
  // 反查失败，用户会看到"捐献成功"，但库里没有记录、额度也不加，连事后补救的线索都没有。
  if (!accountId) {
    throw new ApiError(
      502,
      "验证码已通过，但暂时无法确认该账号已进入号池。请稍等一两分钟后重新发起捐献；如果反复出现请联系管理员。",
      "AUTOCLAW_ACCOUNT_UNRESOLVED"
    )
  }

  const now = Math.floor(Date.now() / 1000)
  if (accountId) {
    const existing = await env.DB.prepare(
      `SELECT id FROM autoclaw_donations WHERE account_id = ? LIMIT 1`
    )
      .bind(accountId)
      .first<{ id: string }>()
    if (existing) {
      await env.DB.prepare(
        `UPDATE autoclaw_donations SET user_id = ?, account_name = ?, status = 'active',
             invalid_at = NULL, invalid_reason = NULL, created_at = ? WHERE id = ?`
      )
        .bind(user.id, accountName, now, existing.id)
        .run()
    } else {
      await env.DB.prepare(
        `INSERT INTO autoclaw_donations (id, user_id, account_id, account_name, token_expires_at, created_at, status)
         VALUES (?, ?, ?, ?, NULL, ?, 'active')`
      )
        .bind(uuid(), user.id, accountId, accountName, now)
        .run()
    }
  }

  try {
    await pushMessage(env, user.id, {
      category: "system",
      type: "autoclaw_donation_ok",
      title: "AutoClaw 账号捐献成功",
      body: `手机号尾号 ${phone.slice(-4)} 的 AutoClaw 账号已加入 Doulor 号池，每日免费额度将在 1 分钟内生效。`,
      link: "/dashboard/donations",
      dedupKey: `autoclaw_ok:${user.id}:${accountId || phone}:${now}`,
    } as never)
  } catch {
    /* 通知失败不影响捐献结果 */
  }

  return json({ ok: true, accountId, accountName })
}

/** GET /donations/autoclaw/mine —— 我的捐献记录 */
export async function listMyAutoclawDonations(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, account_id, account_name, status, created_at
       FROM autoclaw_donations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all()
  return json({ donations: rows.results ?? [] })
}
