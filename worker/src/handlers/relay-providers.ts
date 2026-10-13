/**
 * 「中转站」自助登记 + 只读查询（2026-10-12 站长需求）。
 *
 * 口径（站长 2026-10-12 定，改之前先看）：
 *   1. **朋友自己填令牌** —— 登记、改、删都由登记人自助完成，不走站长；
 *   2. **额度只读** —— 我们只读上游余额与订阅，**不代发额度、不建 Key、不改余额**；
 *      朋友怎么给自己的用户发额度，是他在自己站里的事；
 *   3. **一个用户可以登记/绑定多台**。
 *
 * 安全（这是「把别人站的管理权委托给我们」的接口，必须收敛）：
 *   · 令牌**加密存**（encryptSecret，与其它凭据同一套），**任何响应都不回显**；
 *   · 地址只允许 **https + 公网主机**，挡掉 SSRF（内网/环回/我们自己域名）；
 *   · 登记前**先探测**：用这把令牌去读一次登记人自己的资料，读不通就不许登记
 *     （这样「令牌错」「地址错」「站不可达」在登记那一刻就告诉用户）；
 *   · 每人最多 5 台、创建限流；站长可在管理端一键停用（enabled=0）。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { assertAdminScope } from "./admin"
import { encryptSecret, decryptSecret, uuid } from "../crypto"
import { audit as recordAudit } from "../settings"
import { assertClientNameAllowed } from "../oauth-provider"
import {
  RELAY_KINDS,
  checkRelayOidc,
  fetchRelayKeys,
  fetchRelayModels,
  fetchRelayUserView,
  invalidateRelayViewCache,
  type RelayKind,
} from "../relay-adapters"
import type { Env } from "../env"

/** 每人最多登记几台（含站长自己的那台之外的其它站） */
const MAX_PER_USER = 5

interface ProviderRow {
  id: string
  name: string
  kind: string
  base_url: string
  token_enc: string
  owner_user_id: string
  enabled: number
  sort: number
  created_at: string
  updated_at: string
}

/**
 * 校验并归一化站点地址 —— 同时是一道 **SSRF 闸门**。
 *
 * 这个地址是**用户随手填的**，而我们服务端会带着管理员令牌去请求它。
 * 不挡的话，填 `https://169.254.169.254`、`http://localhost:8787` 这类地址
 * 就能拿我们当跳板探测内网（或反过来让我们去打自己的后端）。
 */
function normalizeBaseUrl(raw: unknown): string {
  const s = String(raw ?? "").trim()
  if (!s) throw new ApiError(400, "请填写站点地址（如 https://api.example.com）", "INVALID_URL")
  let url: URL
  try {
    url = new URL(s)
  } catch {
    throw new ApiError(400, "站点地址格式不对，要带 https:// 的完整地址", "INVALID_URL")
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "站点地址必须是 https://（明文 http 会泄露管理员令牌）", "INVALID_URL")
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "")
  const blockedHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith("doulor.cn") // 不给自己开环：防止把本站当地址绕圈
  // 内网 / 环回 / 链路本地 IP 一律拒绝（IPv4 与常见 IPv6 写法都盖到）
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  let privateIp = false
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    privateIp =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
  }
  const ipv6Private =
    host === "[::1]" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")
  if (blockedHost || privateIp || ipv6Private) {
    throw new ApiError(400, "这个地址不允许登记（内网 / 本机地址）", "INVALID_URL")
  }
  url.search = ""
  url.hash = ""
  // 统一去掉路径尾部斜杠：适配器自己拼 /api/... ，留着会拼出双斜杠
  return url.toString().replace(/\/+$/, "")
}

async function loadProvider(env: Env, id: string): Promise<ProviderRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, created_at, updated_at
       FROM relay_providers WHERE id = ?`
  )
    .bind(id)
    .first<ProviderRow>()
  return row ?? null
}

function parseKind(raw: unknown): RelayKind {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!(RELAY_KINDS as readonly string[]).includes(s)) {
    throw new ApiError(400, "请选择站点类型（NewAPI / Sub2API）", "INVALID_KIND")
  }
  return s as RelayKind
}

/**
 * 响应里**永远不含令牌**（这是唯一真正的秘密）。
 *
 * 站点地址**对所有登录用户可见**（2026-10-12 站长要求「点进去要能看到接入信息」）：
 * 用户要拿它当 Base URL 调 API，而且它本身就是个公开的 API 域名，藏起来只会让功能不可用。
 */
function toPublic(
  row: ProviderRow,
  opts: { mine: boolean; admin: boolean }
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled === 1,
    mine: opts.mine,
    sort: row.sort,
    baseUrl: row.base_url,
    createdAt: row.created_at,
  }
}

function isOwnerOrAdmin(row: ProviderRow, user: { id: string; role: string }): boolean {
  return row.owner_user_id === user.id || user.role === "root" || user.role === "superadmin"
}

/** GET /api/relay/providers —— 我能看到的中转站（含我自己登记的、即使已停用） */
export async function listRelayProviders(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, created_at, updated_at
       FROM relay_providers
      WHERE enabled = 1 OR owner_user_id = ?
      ORDER BY sort ASC, created_at ASC`
  )
    .bind(user.id)
    .all<ProviderRow>()
  const list = rows.results ?? []
  return json({
    providers: list.map((r) => toPublic(r, { mine: r.owner_user_id === user.id, admin: false })),
    maxPerUser: MAX_PER_USER,
    mineCount: list.filter((r) => r.owner_user_id === user.id).length,
  })
}

/** POST /api/relay/providers —— 自助登记一台（先探测，通了才落库） */
export async function createRelayProvider(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(env, `relay-provider:${user.id}`, 10, 3600, "登记太频繁")

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const name = assertClientNameAllowed(String(body.name ?? "").trim().slice(0, 40))
  const kind = parseKind(body.kind)
  const baseUrl = normalizeBaseUrl(body.baseUrl)
  const adminToken = String(body.adminToken ?? "").trim()
  if (adminToken.length < 8) {
    throw new ApiError(400, "管理员令牌看起来不对（太短）", "INVALID_TOKEN")
  }

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM relay_providers WHERE owner_user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()
  if (Number(count?.c ?? 0) >= MAX_PER_USER) {
    throw new ApiError(
      400,
      `最多登记 ${MAX_PER_USER} 台中转站，请先删掉不用的`,
      "TOO_MANY_PROVIDERS"
    )
  }

  // 探测：拿这把令牌读一次「登记人自己」在那台站的资料。
  // 读不通 ⇒ 直接拒绝（令牌错 / 地址错 / 站不可达），不把坏配置落库。
  const probe = await fetchRelayUserView(kind, baseUrl, adminToken, user.email)
  if (!probe.reachable) {
    throw new ApiError(400, `连不上这台站或令牌无效：${probe.error ?? "未知原因"}`, "PROBE_FAILED")
  }

  /**
   * 🔴 入驻前提：对方站必须已经配好「用 Doulor Cloud 登录」的 OIDC（2026-10-12 站长要求）。
   *
   * 理由是功能闭环：入驻的全部价值就是「用户拿本站身份在他那台站里有账号、能看余额」。
   * 没配 OIDC 时，用户在那边根本没有账号，卡片永远显示「查无此人」——
   * 与其让用户和站长互相猜，不如在登记这一刻就把缺什么说清楚。
   * 检测是**读对方站自己声明的配置**（NewAPI 读 `oidc.*` 选项；Sub2API 打它的 OIDC 登录入口）。
   */
  const oidc = await checkRelayOidc(env, kind, baseUrl, adminToken)
  if (!oidc.ok) {
    throw new ApiError(
      400,
      `这台站还不能入驻：${oidc.detail}。配好 OIDC 后重新登记即可。`,
      "OIDC_NOT_CONFIGURED"
    )
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO relay_providers
       (id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 100, ?, ?)`
  )
    .bind(id, name, kind, baseUrl, await encryptSecret(adminToken, env.SESSION_SECRET!), user.id, now, now)
    .run()

  await recordAudit(
    env,
    user.id,
    "relay.provider.create",
    `登记中转站「${name}」（${kind}，${baseUrl}）`,
    request.headers.get("CF-Connecting-IP")
  )
  invalidateRelayViewCache()

  const row = await loadProvider(env, id)
  return json({
    provider: row ? toPublic(row, { mine: true, admin: false }) : null,
    // 检测不到（对方开了验证码等）时**放行但带警告**，前端要如实转告登记人
    ...(oidc.verified ? {} : { oidcWarning: oidc.detail }),
  })
}

/** PUT /api/relay/providers/:id —— 改（只有登记人 / 站长） */
export async function updateRelayProvider(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  if (!isOwnerOrAdmin(row, user)) {
    throw new ApiError(403, "只有登记人自己可以修改", "FORBIDDEN")
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const name =
    body.name === undefined
      ? row.name
      : assertClientNameAllowed(String(body.name ?? "").trim().slice(0, 40))
  const kind = body.kind === undefined ? (row.kind as RelayKind) : parseKind(body.kind)
  const baseUrl = body.baseUrl === undefined ? row.base_url : normalizeBaseUrl(body.baseUrl)
  const newToken =
    body.adminToken === undefined || String(body.adminToken).trim() === ""
      ? null
      : String(body.adminToken).trim()
  if (newToken !== null && newToken.length < 8) {
    throw new ApiError(400, "管理员令牌看起来不对（太短）", "INVALID_TOKEN")
  }

  // 地址/类型/令牌有变化 ⇒ 重新探测（新的组合必须真的能用）
  let oidcWarning: string | null = null
  const changed = kind !== row.kind || baseUrl !== row.base_url || newToken !== null
  if (changed) {
    const token = newToken ?? (await decryptSecret(row.token_enc, env.SESSION_SECRET!))
    const probe = await fetchRelayUserView(kind, baseUrl, token, user.email)
    if (!probe.reachable) {
      throw new ApiError(400, `连不上这台站或令牌无效：${probe.error ?? "未知原因"}`, "PROBE_FAILED")
    }
    // 与登记同一条前提：改配置后 OIDC 依然要指向本站
    const oidc = await checkRelayOidc(env, kind, baseUrl, token)
    if (oidc.ok && !oidc.verified) oidcWarning = oidc.detail
    if (!oidc.ok) {
      throw new ApiError(
        400,
        `这台站还不能入驻：${oidc.detail}。配好 OIDC 后重试。`,
        "OIDC_NOT_CONFIGURED"
      )
    }
  }

  const tokenEnc = newToken === null ? row.token_enc : await encryptSecret(newToken, env.SESSION_SECRET!)
  await env.DB.prepare(
    "UPDATE relay_providers SET name = ?, kind = ?, base_url = ?, token_enc = ?, updated_at = ? WHERE id = ?"
  )
    .bind(name, kind, baseUrl, tokenEnc, new Date().toISOString(), id)
    .run()

  await recordAudit(
    env,
    user.id,
    "relay.provider.update",
    `修改中转站「${name}」（${kind}，${baseUrl}）`,
    request.headers.get("CF-Connecting-IP")
  )
  invalidateRelayViewCache()

  const fresh = await loadProvider(env, id)
  return json({
    provider: fresh ? toPublic(fresh, { mine: row.owner_user_id === user.id, admin: false }) : null,
    ...(oidcWarning ? { oidcWarning } : {}),
  })
}

/** DELETE /api/relay/providers/:id —— 删（登记人 / 站长），令牌随之作废 */
export async function deleteRelayProvider(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  if (!isOwnerOrAdmin(row, user)) {
    throw new ApiError(403, "只有登记人自己可以删除", "FORBIDDEN")
  }
  await env.DB.prepare("DELETE FROM relay_providers WHERE id = ?").bind(id).run()
  await recordAudit(
    env,
    user.id,
    "relay.provider.delete",
    `删除中转站「${row.name}」（${row.kind}，${row.base_url}）`,
    request.headers.get("CF-Connecting-IP")
  )
  invalidateRelayViewCache()
  return json({ ok: true })
}

/**
 * GET /api/relay/providers/:id/me —— 我在那台站的只读视图（余额 + 订阅）。
 * 用**登记人的管理员令牌**按我的邮箱去查；查不到就是「那边没有账号」，如实展示。
 */
export async function getRelayProviderView(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  if (row.enabled !== 1 && row.owner_user_id !== user.id) {
    throw new ApiError(403, "这台中转站已被停用", "DISABLED")
  }
  const token = await decryptSecret(row.token_enc, env.SESSION_SECRET!)
  const view = await fetchRelayUserView(row.kind as RelayKind, row.base_url, token, user.email)
  return json({ view })
}

/**
 * GET /api/relay/providers/:id/keys —— 我在那台站的 Key 列表（只读）。
 *
 * ⚠️ 不同站支持度不同（见适配器注释）：Sub2API 管理员接口能读，
 * NewAPI 的 Key 是用户维度的、管理员令牌读不到 ⇒ 如实返回 supported:false，
 * 界面要说明「去对方站看」，不能给个空表让人误以为「没有 Key」。
 */
export async function getRelayProviderKeys(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  if (row.enabled !== 1 && row.owner_user_id !== user.id) {
    throw new ApiError(403, "这台中转站已被停用", "DISABLED")
  }
  const token = await decryptSecret(row.token_enc, env.SESSION_SECRET!)
  const res = await fetchRelayKeys(row.kind as RelayKind, row.base_url, token, user.email)
  return json(res)
}

/** GET /api/relay/providers/:id/models —— 那台站的可用模型清单（只读） */
export async function getRelayProviderModels(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  const res = await fetchRelayModels(row.kind as RelayKind, row.base_url)
  return json(res)
}

/** GET /api/admin/relay-providers —— 站长视角：全部登记（含停用的） */
export async function adminListRelayProviders(env: Env, request: Request): Promise<Response> {
  await await assertAdminScope(env, await requireUser(env, request), "newapi.subscriptions")
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.kind, p.base_url, p.owner_user_id, p.enabled, p.sort, p.created_at,
            u.username AS owner_username
       FROM relay_providers p
       LEFT JOIN users u ON u.id = p.owner_user_id
      ORDER BY p.sort ASC, p.created_at ASC`
  ).all<Record<string, unknown>>()
  return json({
    providers: (rows.results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.base_url,
      ownerUsername: r.owner_username,
      enabled: Number(r.enabled) === 1,
      createdAt: r.created_at,
    })),
  })
}

/** POST /api/admin/relay-providers/:id/enabled —— 一键停用 / 恢复 */
export async function adminSetRelayProviderEnabled(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireUser(env, request)
  await assertAdminScope(env, admin, "newapi.subscriptions")
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown }
  const enabled = body.enabled === true || body.enabled === 1 ? 1 : 0
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  await env.DB.prepare(
    "UPDATE relay_providers SET enabled = ?, updated_at = ? WHERE id = ?"
  )
    .bind(enabled, new Date().toISOString(), id)
    .run()
  await recordAudit(
    env,
    row.owner_user_id,
    "relay.provider.toggle",
    `管理员 ${admin.username} ${enabled ? "恢复" : "停用"}中转站「${row.name}」`,
    request.headers.get("CF-Connecting-IP")
  )
  invalidateRelayViewCache()
  return json({ ok: true, enabled: enabled === 1 })
}
