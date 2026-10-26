/**
 * 小浣熊（Raccoon）账号捐献 —— 一键入池。
 *
 * 背景（2026-10-26）：
 *   小浣熊官方授权页只接受 loopback 回调（http://localhost:端口），
 *   所以「在网页端点一下授权 → 服务器收到 token」这条路走不通；
 *   而 token 存在非 httpOnly 的 cookie `xhx_token` 里，浏览器脚本可读。
 *   于是采用「一次性捐献码 + 书签小工具」：
 *
 *     ① 用户在本站拿到 10 分钟有效的一次性码（绑定 user_id）
 *     ② 书签脚本在小浣熊页面读出 xhx_token，连同码 POST 回本站
 *     ③ 本站校验码 → 转给 kr 上的入池网关 → 网关校验 token 可用后写进 Agent2API
 *     ④ 记录进 D1，捐献归属到用户
 *
 * 为什么码而不是 cookie：书签运行在 xiaohuanxiong.com 的上下文，
 * 跨站请求带不上本站 SameSite=Lax 的会话 cookie。
 *
 * 安全：claim 是公开接口（不带本站会话），靠「码 + 一次性 + 短效 + 限流」兜底；
 * 真正的凭据是 token 本身，码泄漏最多让攻击者把自己的号捐给该用户。
 */
import { json, assertContentLengthWithin } from "../http"
import type { Env } from "../env"
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { uuid } from "../crypto"
import { adminSetUserGroup, findUserByEmail, findUserByUsername } from "../newapi-client"

/** 入池网关（hk2 上与 Agent2API 同机，只暴露 /_donate/* 几个动作，需 X-Donate-Key）。 */
const GATEWAY_URL = "https://agent2api.doulor.cn/_donate/register"
/**
 * 捐献成功后给用户加中转站分组 —— 与 wb2api 捐献同款语义：**捐了才能用对应渠道**。
 * 走 NewAPI 管理接口（`adminSetUserGroup`），因为直写数据库会被它的 Redis 缓存回写覆盖。
 */
const GRANT_GROUP_NAME = "raccoon"
const CODE_TTL_SECONDS = 600
const CORS_ORIGIN = "https://xiaohuanxiong.com"

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "cache-control": "no-store",
  }
}

function jsonCors(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  })
}

/** 预检（书签如果用 application/json 就会走这里；用 text/plain 时不会触发）。 */
export async function raccoonDonatePreflight(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

/** POST /donations/raccoon/code —— 生成一次性捐献码（需登录）。 */
export async function issueRaccoonCode(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(env, `raccoon:code:user:${user.id}`, 10, 600, "生成捐献码过于频繁")

  const code = uuid().replace(/-/g, "")
  const now = Math.floor(Date.now() / 1000)

  // 顺手清掉该用户过期的旧码，别让表无限长
  await env.DB.prepare(
    `DELETE FROM raccoon_donate_codes WHERE user_id = ? AND expires_at < ?`
  )
    .bind(user.id, now)
    .run()

  await env.DB.prepare(
    `INSERT INTO raccoon_donate_codes (code, user_id, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, NULL)`
  )
    .bind(code, user.id, now, now + CODE_TTL_SECONDS)
    .run()

  return json({ code, expiresIn: CODE_TTL_SECONDS })
}

/**
 * POST /donations/raccoon/claim —— 书签/捐献页兑换（公开，靠码鉴权）。
 *
 * body: { code, accessToken, name? }
 * 返回：{ ok, accountId?, duplicate?, reason?, detail? }
 */
export async function claimRaccoonDonation(env: Env, request: Request): Promise<Response> {
  // 先看长度再解析：书签只该发几百字节
  assertContentLengthWithin(request, 16 * 1024, "请求内容过大")

  let body: { code?: string; accessToken?: string; name?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonCors({ ok: false, reason: "bad_json" }, 400)
  }

  const code = (body.code ?? "").trim()
  const token = (body.accessToken ?? "").trim()
  const name = (body.name ?? "").trim().slice(0, 60)
  if (!code || !token) return jsonCors({ ok: false, reason: "bad_params" }, 400)

  const now = Math.floor(Date.now() / 1000)
  const row = await env.DB.prepare(
    `SELECT code, user_id, expires_at, used_at FROM raccoon_donate_codes WHERE code = ?`
  )
    .bind(code)
    .first<{ code: string; user_id: string; expires_at: number; used_at: number | null }>()

  if (!row) return jsonCors({ ok: false, reason: "code_invalid", detail: "捐献码不存在，请回捐献页重新生成" }, 400)
  if (row.used_at) return jsonCors({ ok: false, reason: "code_used", detail: "这个捐献码已经用过了，请重新生成" }, 400)
  if (now > row.expires_at) return jsonCors({ ok: false, reason: "code_expired", detail: "捐献码已过期（10 分钟有效），请重新生成" }, 400)

  // 同一个码被反复尝试时也要限流（按码计，防止拿一个码硬刷网关）
  await guardRateLimit(env, `raccoon:claim:code:${code}`, 5, 600, "尝试过于频繁，请重新生成捐献码")

  const key = env.RACCOON_DONATE_KEY
  if (!key) {
    return jsonCors({ ok: false, reason: "not_configured", detail: "服务端未配置捐献网关密钥" }, 500)
  }

  // 账号名叫「捐献者用户名」，不再用日期默认名（2026-10-26 站长要求）。
  // 找不到 username 才退回邮箱前缀，实在没有才用日期兜底。
  const donorName = await donorAccountName(env, row.user_id)
  const accountName = (name || "").trim() || donorName
  let gateway: Response
  let rawBody = ""
  try {
    gateway = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Donate-Key": key },
      body: JSON.stringify({ provider: "raccoon", name: accountName, accessToken: token }),
    })
    rawBody = await gateway.text()
  } catch (e) {
    return jsonCors({ ok: false, reason: "gateway_unreachable", detail: `入池服务暂时不可用：${String(e)}` }, 502)
  }

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    // 不是 JSON：多半是网关前面的代理返回了错误页，把状态码与片段带回去便于排查
    return jsonCors({
      ok: false,
      reason: "gateway_bad_response",
      detail: `网关返回 ${gateway.status}：${rawBody.slice(0, 160) || "(空响应)"}`,
    })
  }

  const result = parsed as {
    ok?: boolean
    accountId?: string
    name?: string
    duplicate?: boolean
    available?: boolean
    expiresAt?: number
    reason?: string
    detail?: string
  }

  if (!result.ok) {
    return jsonCors({
      ok: false,
      reason: result.reason ?? "failed",
      detail: result.detail ?? "入池失败",
    })
  }

  // 成功才算「码已用」，失败可以重试
  const usedAt = Math.floor(Date.now() / 1000)
  // 同一个号（同一 account_id）只保留一条记录：重复捐献只刷新时间，不再堆行。
  const existing = await env.DB.prepare(
    `SELECT id FROM raccoon_donations WHERE account_id = ? LIMIT 1`
  )
    .bind(result.accountId ?? null)
    .first<{ id: string }>()
  const statements = [
    env.DB.prepare(`UPDATE raccoon_donate_codes SET used_at = ? WHERE code = ? AND used_at IS NULL`).bind(
      usedAt,
      code
    ),
    existing
      ? env.DB.prepare(
          `UPDATE raccoon_donations
              SET account_name = ?, token_expires_at = ?, created_at = ?, user_id = ?
            WHERE id = ?`
        ).bind(accountName, result.expiresAt ?? null, usedAt, row.user_id, existing.id)
      : env.DB.prepare(
          `INSERT INTO raccoon_donations (id, user_id, account_id, account_name, token_expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          uuid(),
          row.user_id,
          result.accountId ?? null,
          accountName,
          result.expiresAt ?? null,
          usedAt
        ),
  ]
  await env.DB.batch(statements)

  // 捐献成功 → 给该用户在中转站里追加「raccoon」分组（和 wb2api 捐献同款：捐了才能用对应模型）。
  // 失败不阻塞捐献结果（号已经进池，分组可以在后台补发），但会回传 granted 让前端能提示。
  const granted = await grantRaccoonGroup(env, row.user_id)

  return jsonCors({
    ok: true,
    accountId: result.accountId,
    duplicate: result.duplicate ?? false,
    name: accountName,
    granted,
  })
}

/**
 * 生成捐献账号名：默认用捐献者的用户名（2026-10-26 站长要求，不再用日期）。
 *
 * 同一个人捐第二个号时会重名 → 自动加 `-2`、`-3` 后缀区分；
 * 用户名取不到时退回邮箱前缀，再不行才用日期兜底（绝不返回空串，面板会拒空名）。
 */
async function donorAccountName(env: Env, dolordUserId: string): Promise<string> {
  let base = ""
  try {
    const u = await env.DB.prepare(`SELECT username, email FROM users WHERE id = ?`)
      .bind(dolordUserId)
      .first<{ username?: string; email?: string }>()
    base = (u?.username || (u?.email || "").split("@")[0] || "").trim()
  } catch {
    base = ""
  }
  if (!base) base = `raccoon-${new Date().toISOString().slice(0, 10)}`
  base = base.slice(0, 48)

  // 同名已存在就加序号（按已有条数推）
  try {
    const dup = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raccoon_donations WHERE account_name = ? OR account_name LIKE ?`
    )
      .bind(base, `${base}-%`)
      .first<{ n: number }>()
    const n = Number(dup?.n ?? 0)
    if (n > 0) return `${base}-${n + 1}`
  } catch {
    /* 计数失败就用原名 */
  }
  return base
}

/**
 * 给捐献者追加中转站分组（`raccoon`）。
 *
 * 走 NewAPI 官方接口而不是直写库，原因见 `adminSetUserGroup` 的注释：
 * NewAPI 把用户对象缓存在 Redis，任何额度变动都会把旧对象整条写回库，
 * 直写的分组合被静默覆盖（实测过，授组成功一次调用后就被打回原值）。
 *
 * 失败不阻塞捐献结果 —— 号已经进池，分组可以事后补发。
 */
async function grantRaccoonGroup(env: Env, dolordUserId: string): Promise<string | undefined> {
  try {
    const donor = await env.DB.prepare(`SELECT username, email FROM users WHERE id = ?`)
      .bind(dolordUserId)
      .first<{ username?: string; email?: string }>()
    if (!donor) return undefined
    let relay = donor.email ? await findUserByEmail(env, donor.email) : null
    if (!relay && donor.username) relay = await findUserByUsername(env, donor.username)
    if (!relay?.id) return undefined
    return await adminSetUserGroup(env, relay.id, GRANT_GROUP_NAME, "append")
  } catch {
    return undefined
  }
}

/** GET /donations/raccoon/mine —— 我的捐献记录。 */
export async function listMyRaccoonDonations(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, account_id, account_name, token_expires_at, created_at
       FROM raccoon_donations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all()
  return json({ donations: rows.results ?? [] })
}

// ---------------------------------------------------------------------------
// JSON 批量导入（2026-10-26）
//
// 为什么需要它：书签只能一个号一个号地捐，号多的用户（或从别处导出的 token 列表）
// 只能反复点。这里开放「上传 JSON」——服务端不区分格式细节，只要每条能取到
// accessToken（也接受 token / xhx_token / access_token 等常见写法）。
//
// 安全边界：
//   · 必须登录（requireUser），不是公开接口；
//   · 每条限流 6 次/小时，单次最多 300 条 —— 入池网关内部还会逐个校验 token；
//   · token 只在 Worker → 网关这一跳出现，不落 D1（D1 只记 account_id 与用户名）。
// ---------------------------------------------------------------------------

/** 网关批量导入端点（provider 在 body 里指定） */
const GATEWAY_IMPORT_URL = "https://agent2api.doulor.cn/_donate/import"
const IMPORT_MAX_ACCOUNTS = 300

/** 从一条 JSON 里抽出 accessToken —— 兼容几种常见的导出写法 */
function pickToken(o: Record<string, unknown>): string {
  const v =
    o.accessToken ?? o.access_token ?? o.token ?? o.xhx_token ?? o.xhxToken ?? o.cookie ?? o.value
  return typeof v === "string" ? v.trim() : ""
}

/** 从一条 JSON 里抽出名字（可选，缺失就按捐献者用户名 + 序号） */
function pickName(o: Record<string, unknown>): string {
  const v = o.name ?? o.nickname ?? o.username ?? o.email
  return typeof v === "string" ? v.trim().slice(0, 48) : ""
}

/**
 * POST /api/donations/raccoon/import —— 批量捐献小浣熊账号。
 *
 * body: `{ accounts: [{ name?, accessToken, refreshToken? }, ...] }`
 *       也接受裸数组 `[{...}, {...}]`（直接把导出的 JSON 丢进来就能用）。
 */
export async function importRaccoonDonations(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  assertContentLengthWithin(request, 512 * 1024, "请求内容过大")

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, reason: "bad_json", detail: "JSON 解析失败" }, 400)
  }

  const raw: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { accounts?: unknown[] })?.accounts)
      ? ((body as { accounts: unknown[] }).accounts)
      : []
  if (!raw.length) {
    return json({ ok: false, reason: "bad_params", detail: "JSON 里没有账号（需要数组或 {accounts:[...]}）" }, 400)
  }
  if (raw.length > IMPORT_MAX_ACCOUNTS) {
    return json({ ok: false, reason: "too_many", detail: `一次最多导入 ${IMPORT_MAX_ACCOUNTS} 个账号` }, 400)
  }

  await guardRateLimit(env, `raccoon:import:${user.id}`, 6, 3600, "导入太频繁了，请过一会儿再试")

  const key = env.RACCOON_DONATE_KEY
  if (!key) {
    return json({ ok: false, reason: "not_configured", detail: "服务端未配置捐献网关密钥" }, 500)
  }

  // 归一化成网关认的形状；没名字的按「捐献者用户名」「用户名-2」「用户名-3」… 自动编号
  const base = await donorAccountName(env, user.id)
  const accounts: { name: string; accessToken: string; refreshToken?: string }[] = []
  let skipped = 0
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>
    const token = pickToken(o)
    if (!token) {
      skipped += 1
      continue
    }
    const name = pickName(o) || (accounts.length === 0 ? base : `${base}-${accounts.length + 1}`)
    const rt = o.refreshToken ?? o.refresh_token
    const refreshToken = typeof rt === "string" ? rt.trim() : ""
    accounts.push({ name, accessToken: token, ...(refreshToken ? { refreshToken } : {}) })
  }
  if (!accounts.length) {
    return json({ ok: false, reason: "no_token", detail: "每个条目都缺 accessToken" }, 400)
  }

  let res: Response
  let text = ""
  try {
    res = await fetch(GATEWAY_IMPORT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Donate-Key": key },
      body: JSON.stringify({ provider: "raccoon", accounts }),
    })
    text = await res.text()
  } catch (e) {
    return json({ ok: false, reason: "gateway_unreachable", detail: `入池服务暂时不可用：${String(e)}` }, 502)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return json({ ok: false, reason: "gateway_bad_response", detail: `网关返回 ${res.status}：${text.slice(0, 160)}` }, 502)
  }
  if (!parsed?.ok) {
    return json({ ok: false, reason: "gateway_error", detail: JSON.stringify(parsed).slice(0, 200) }, 502)
  }

  // 落库：每个「新增」账号一条（account_id 去重，重复捐同一个号只刷新时间）
  const added = (Array.isArray(parsed.accounts) ? parsed.accounts : []) as { name?: string; id?: string }[]
  const now = Math.floor(Date.now() / 1000)
  for (const a of added) {
    const accountId = (a.id ?? "").trim()
    if (!accountId) continue
    const name = (a.name ?? "").trim() || base
    try {
      const existing = await env.DB.prepare(
        `SELECT id FROM raccoon_donations WHERE account_id = ? LIMIT 1`
      )
        .bind(accountId)
        .first<{ id: string }>()
      if (existing) {
        await env.DB.prepare(
          `UPDATE raccoon_donations SET account_name = ?, user_id = ?, created_at = ? WHERE id = ?`
        )
          .bind(name, user.id, now, existing.id)
          .run()
      } else {
        await env.DB.prepare(
          `INSERT INTO raccoon_donations (id, user_id, account_id, account_name, token_expires_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`
        )
          .bind(uuid(), user.id, accountId, name, now)
          .run()
      }
    } catch {
      // 落库失败不影响入池（号已经在池里了，记录可以之后补）
    }
  }

  const granted = added.length ? await grantRaccoonGroup(env, user.id) : undefined
  return json({
    ok: true,
    added: typeof parsed.added === "number" ? parsed.added : added.length,
    duplicate: typeof parsed.duplicate === "number" ? parsed.duplicate : 0,
    failed: typeof parsed.failed === "number" ? parsed.failed : 0,
    skipped,
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    granted,
  })
}