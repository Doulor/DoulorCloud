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
 *
 * 🔴 2026-10-16 改为**审核制**（站长要求，迁移 0162，改之前先看）：
 *   · 登记成功不再等于生效 —— 新登记的 `review_status = 'pending'`，要等站长**批准**；
 *   · 三态：`pending`（不可用）→ `approved`（可用）/ `rejected`（不可用，带拒绝理由）；
 *   · 「能不能用」= **approved 且 enabled**（见 isUsable）：审核态与「临时停用」是两把锁，
 *     任一把没开就不许调上游；
 *   · **所有者能看见、但不能用**自己那台待审/被拒的站：列表里连同状态一起返回，
 *     但 /me、/keys、/models 一律拒绝 —— 否则「提交完立刻读余额」就是绕过审核的路径；
 *   · 存量数据在迁移里一次性回填成 approved（线上现有 3 条行为不变）。
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
import { isPrivateOrLocalHost } from "../url-guard"

/** 每人最多登记几台（含站长自己的那台之外的其它站） */
const MAX_PER_USER = 5

/**
 * 审核三态（与迁移 0162 的口径一致）。
 *
 * 为什么把字面量集中在这里：状态值要同时出现在 SQL 条件、响应字段、前端的徽章上，
 * 散着写迟早出现「这里写 approved、那里写 enabled」的错位。
 */
const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const
type ReviewStatus = (typeof REVIEW_STATUSES)[number]

interface ProviderRow {
  id: string
  name: string
  kind: string
  base_url: string
  token_enc: string
  owner_user_id: string
  enabled: number
  sort: number
  review_status: string | null
  review_note: string | null
  reviewed_at: string | null
  reviewed_by: string | null
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
  // 内网 / 环回 / 链路本地 IP 一律拒绝。
  //
  // 🔴 统一到 url-guard.ts 那一份（2026-10-14 安全审计）。
  //   这里原先自己拼了一份 IPv4 黑名单，与 url-guard 的不一致：
  //     · 漏了 100.64.0.0/16（运营商级 NAT，CGNAT）
  //     · 漏了 192.0.0.0/24、198.18.0.0/15 等保留段
  //   同一件事维护两份实现，迟早只修一边 —— 现在只有 url-guard 一处。
  //
  // ⚠️ 仍然挡不住的：域名**解析到**内网 IP 的情况（sslip.io 之流）。
  //   Worker 的 fetch 在边缘解析 DNS，我们拿不到解析结果，无法在调用前判断。
  //   实际影响有限：Cloudflare 边缘**不会**把请求发到私网地址（会直接返回 1003），
  //   所以这条路径的终点是"请求失败"，不是"读到内网服务"。
  if (blockedHost || isPrivateOrLocalHost(host)) {
    throw new ApiError(400, "这个地址不允许登记（内网 / 本机地址）", "INVALID_URL")
  }
  url.search = ""
  url.hash = ""
  // 统一去掉路径尾部斜杠：适配器自己拼 /api/... ，留着会拼出双斜杠
  return url.toString().replace(/\/+$/, "")
}

async function loadProvider(env: Env, id: string): Promise<ProviderRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, base_url, token_enc, owner_user_id, enabled, sort,
            review_status, review_note, reviewed_at, reviewed_by, created_at, updated_at
       FROM relay_providers WHERE id = ?`
  )
    .bind(id)
    .first<ProviderRow>()
  return row ?? null
}

/**
 * 库里的审核态 → 三态之一。
 *
 * 认不出来的值（NULL / 拼错 / 手工改库）一律当 `pending`：
 * 这是**刻意的 fail-closed** —— 判据的用途只有一个「能不能放行调上游」，
 * 认不出来时必须选「不放行」。迁移 0162 里那一列是 NOT NULL DEFAULT 'pending'，
 * 所以正常路径上不会有 NULL，这里是防手工改库与将来加状态时漏改的兜底。
 */
function reviewStatusOf(row: ProviderRow): ReviewStatus {
  const s = String(row.review_status ?? "").trim().toLowerCase()
  return (REVIEW_STATUSES as readonly string[]).includes(s) ? (s as ReviewStatus) : "pending"
}

/**
 * 这台站现在能不能被**用**？（读上游的余额 / 订阅 / Key / 模型）
 *
 * 两把锁都要开，缺一不可：
 *   · `review_status = 'approved'` —— 站长审过这一台（审核制的主闸）；
 *   · `enabled = 1` —— 站长没临时把它停掉（紧急刹车，批准后仍然有效）。
 *
 * ⚠️ 这里**不**给所有者开例外。所有者对自己那台待审/被拒的站「能看见」（列表里带状态），
 * 但「不能用」—— 一旦给所有者开了读上游的口子，「先登记、趁审核没下来赶紧读」就成了
 * 绕过审核的路径；而且待审的站本来就不该在用户侧产生上游流量。
 */
function isUsable(row: ProviderRow): boolean {
  return reviewStatusOf(row) === "approved" && Number(row.enabled) === 1
}

/**
 * 不可用时抛错 —— 三种原因给三种话，用户才知道下一步该干什么
 * （「还在排队」和「被拒了」在界面上必须是两句不同的话，这正是要单独加一列的原因）。
 */
function assertUsable(row: ProviderRow): void {
  const status = reviewStatusOf(row)
  if (status === "pending") {
    throw new ApiError(
      403,
      "这台中转站还在等站长审核，审核通过后才能使用",
      "PENDING_REVIEW"
    )
  }
  if (status === "rejected") {
    const note = String(row.review_note ?? "").trim()
    throw new ApiError(
      403,
      note ? `这台中转站的入驻申请被拒绝：${note}` : "这台中转站的入驻申请被拒绝",
      "REVIEW_REJECTED"
    )
  }
  // approved 但还是不可用 ⇒ 只能是 enabled = 0
  throw new ApiError(403, "这台中转站已被停用", "DISABLED")
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
 *
 * 审核态（2026-10-16）：`reviewStatus` + `usable` 必须带出去 ——
 *   · `reviewStatus` 让登记人看到「待审核 / 已通过 / 已拒绝」；
 *   · `usable` 是**服务端算的**「现在到底能不能用」，前端只负责照着灰掉按钮。
 *     让前端自己去拼 `reviewStatus === 'approved' && enabled` 迟早会跟后端漂移
 *     （少了 enabled 那一半就会出现「已批准但我刚停用过，按钮却还能点」）。
 * 拒绝理由只在**被拒绝**时返回：同一列将来若被拿去做内部备注，也不会顺着这里漏出去。
 */
function toPublic(
  row: ProviderRow,
  opts: { mine: boolean; admin: boolean }
): Record<string, unknown> {
  const status = reviewStatusOf(row)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled === 1,
    reviewStatus: status,
    reviewNote: status === "rejected" ? (row.review_note ?? null) : null,
    reviewedAt: row.reviewed_at ?? null,
    usable: isUsable(row),
    mine: opts.mine,
    sort: row.sort,
    baseUrl: row.base_url,
    createdAt: row.created_at,
  }
}

function isOwnerOrAdmin(row: ProviderRow, user: { id: string; role: string }): boolean {
  return row.owner_user_id === user.id || user.role === "root" || user.role === "superadmin"
}

/**
 * GET /api/relay/providers —— 我能看到的中转站。
 *
 * 可见性口径（2026-10-16 审核制）：
 *   · 别人登记的站：**只有「已批准 + 未停用」才出现**（与「能不能用」同一把锁，
 *     免得列表里出现一台点进去必定 403 的站）；
 *   · 我自己登记的站：**任何审核态都返回**（待审核 / 已拒绝也要能看见自己的提交，
 *     否则用户提交完就再也找不到它了 —— 只能靠「删掉重来」，那等于让审核制把
 *     用户的入口也一起关掉）。状态在响应里如实带出，能不能用由 `usable` 说。
 */
export async function listRelayProviders(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, name, kind, base_url, token_enc, owner_user_id, enabled, sort,
            review_status, review_note, reviewed_at, reviewed_by, created_at, updated_at
       FROM relay_providers
      WHERE (review_status = 'approved' AND enabled = 1) OR owner_user_id = ?
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
  /**
   * 落库即「待审核」（2026-10-16 审核制）。
   *
   *   · `review_status` 显式写 'pending'，不依赖列默认值 —— 默认值只是兜底，
   *     这道闸的主语是这里的业务决策，写出来才看得见（将来谁改默认值也改不掉它）；
   *   · `enabled` 仍然写 1：它与审核态是两把**独立**的锁，新站「审核过了就该能用」，
   *     不该要求站长批完再审一次「启用」。停用是事后的紧急刹车（管理端一个按钮）。
   */
  await env.DB.prepare(
    `INSERT INTO relay_providers
       (id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, review_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 100, 'pending', ?, ?)`
  )
    .bind(id, name, kind, baseUrl, await encryptSecret(adminToken, env.SESSION_SECRET!), user.id, now, now)
    .run()

  await recordAudit(
    env,
    user.id,
    "relay.provider.create",
    `登记中转站「${name}」（${kind}，${baseUrl}），等待站长审核`,
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
  /**
   * 被拒之后「改一改再试一次」要能走通（2026-10-16 审核制）。
   *
   * 为什么必须重置成 pending：拒绝是一次性的判定，而拒绝理由通常是**可修的**
   * （令牌权限不够、OIDC 没配好、地址写错）。若不重置，用户改完仍是 rejected
   * —— 界面上永远挂着那句「被拒绝」，站长那边也不会有新条目可审，
   * 用户唯一的出路变成「删掉重新登记」（还要再撞一次每人 5 台的额度）。
   * 改完重新排队，才是审核制该有的闭环。
   *
   * 为什么**只**对 rejected 重置，pending/approved 原样保留：
   *   · pending 本来就是排队中，再置一次没有区别；
   *   · approved 是站长对**这台站与这个登记人**的信任，连显示名改个字都要重审一次
   *     只会增加站长的机械劳动（真要收回，管理端有停用与拒绝两个按钮）。
   * 顺带清掉旧的拒绝理由与审核痕迹：留着会让用户困惑「这次拒绝的是哪个版本」。
   */
  const resubmit = reviewStatusOf(row) === "rejected"
  await env.DB.prepare(
    resubmit
      ? `UPDATE relay_providers
            SET name = ?, kind = ?, base_url = ?, token_enc = ?, review_status = 'pending',
                review_note = NULL, reviewed_at = NULL, reviewed_by = NULL, updated_at = ?
          WHERE id = ?`
      : "UPDATE relay_providers SET name = ?, kind = ?, base_url = ?, token_enc = ?, updated_at = ? WHERE id = ?"
  )
    .bind(name, kind, baseUrl, tokenEnc, new Date().toISOString(), id)
    .run()

  await recordAudit(
    env,
    user.id,
    "relay.provider.update",
    `修改中转站「${name}」（${kind}，${baseUrl}）` + (resubmit ? "，重新提交审核" : ""),
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
 *
 * 🔒 门禁（2026-10-16）：这是**使用**这台站（带着登记人的管理员令牌去请求上游），
 * 所以必须 `isUsable`。原先是「owner 例外」—— 停用后登记人仍能读上游；
 * 审核制下这个例外必须拿掉：否则「刚提交、趁站长还没审」就能读余额，
 * 那道审核闸等于不存在。所有者想确认令牌/地址是否还通，走「编辑」（保存时会重新探测）。
 */
export async function getRelayProviderView(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  if (!isUsable(row)) assertUsable(row)
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
 *
 * 🔒 门禁：同 /me（这就是「使用」，必须 isUsable）。
 */
export async function getRelayProviderKeys(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  if (!isUsable(row)) assertUsable(row)
  const token = await decryptSecret(row.token_enc, env.SESSION_SECRET!)
  const res = await fetchRelayKeys(row.kind as RelayKind, row.base_url, token, user.email)
  return json(res)
}

/**
 * GET /api/relay/providers/:id/models —— 那台站的可用模型清单（只读）。
 *
 * 🔴 这里原先**根本没有 enabled 检查**（2026-10-16 审核制改造时补上）：
 * 它是唯一一条「读了 row 却不判状态就直接打上游」的路径，于是任何登录用户
 * 都能拿一台**已被站长停用**的站的 id 去读它的模型清单 —— 停用在那条路上是假的。
 * 现在与 /me、/keys 同一把锁（`isUsable`）。
 */
export async function getRelayProviderModels(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireUser(env, request)
  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")
  if (!isUsable(row)) assertUsable(row)
  const res = await fetchRelayModels(row.kind as RelayKind, row.base_url)
  return json(res)
}

/**
 * GET /api/admin/relay-providers —— 站长视角：全部登记（含待审核 / 已拒绝 / 已停用）。
 *
 * 返回 `sort` 与 `reviewNote` 是管理端界面要求的：列表要能按 sort 排序展示，
 * 拒绝理由要能复核「上次为什么拒的」。
 * 令牌（token_enc）**永远不出现在这里**，管理端也不解密展示 —— 它是唯一真正的秘密，
 * 管理端只需要知道「这台站是否已登记令牌」（登记必然有，所以连这个布尔都不必给）。
 */
export async function adminListRelayProviders(env: Env, request: Request): Promise<Response> {
  await assertAdminScope(env, await requireUser(env, request), "newapi.subscriptions")
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.kind, p.base_url, p.owner_user_id, p.enabled, p.sort, p.created_at,
            p.review_status, p.review_note, p.reviewed_at,
            u.username AS owner_username
       FROM relay_providers p
       LEFT JOIN users u ON u.id = p.owner_user_id
      ORDER BY p.sort ASC, p.created_at ASC`
  ).all<Record<string, unknown>>()
  const providers = (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    baseUrl: r.base_url,
    ownerUsername: r.owner_username,
    enabled: Number(r.enabled) === 1,
    reviewStatus: reviewStatusOf(r as unknown as ProviderRow),
    reviewNote: (r.review_note as string | null) ?? null,
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    sort: Number(r.sort ?? 0),
    createdAt: r.created_at,
  }))
  return json({ providers })
}

/**
 * POST /api/admin/relay-providers/:id/review —— 批准 / 拒绝（拒绝必须写理由）。
 *
 * 与「启用 / 停用」（adminSetRelayProviderEnabled）是**两件独立的事**：
 *   · 审核 = 这台站能不能进这个体系（一次性判定，带上理由）；
 *   · 启用/停用 = 已进体系的站现在放不放行（随时可拨的紧急刹车）。
 * 批准之后仍然可以停用，两者互不覆盖。
 *
 * 审计沿用同文件既有口径：`recordAudit(..., row.owner_user_id, ...)` —— 事件挂在
 * **登记人**名下（这样他能在自己最近活动里看到「我的申请被拒了」），
 * 而「谁批的」写在 detail 里（管理员用户名）。
 */
export async function adminReviewRelayProvider(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireUser(env, request)
  await assertAdminScope(env, admin, "newapi.subscriptions")
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; note?: unknown }
  const action = String(body.action ?? "").trim().toLowerCase()
  if (action !== "approve" && action !== "reject") {
    throw new ApiError(400, "审核动作只能是批准（approve）或拒绝（reject）", "INVALID_ACTION")
  }
  // 理由要展示给登记人：截断到 200 字，既够说清问题，也不会被拿来当留言板
  const note = String(body.note ?? "").trim().slice(0, 200)
  /**
   * 拒绝**必须**填理由（2026-10-16）。
   *
   * 为什么强制：拒绝是用户侧唯一「他努力了但被否掉」的结局，没有理由的话
   * 他不知道该改什么，只能反复提交同一份配置 —— 站长的每一次拒绝就白拒了。
   * 批准则不要求（没什么要解释的），且此时把 review_note 清空，
   * 免得上一轮的拒绝理由留在库里被后来人误读成「批准还带条件」。
   */
  if (action === "reject" && !note) {
    throw new ApiError(400, "请填写拒绝理由（会展示给登记人）", "REASON_REQUIRED")
  }

  const row = await loadProvider(env, id)
  if (!row) throw new ApiError(404, "中转站不存在", "NOT_FOUND")

  const next: ReviewStatus = action === "approve" ? "approved" : "rejected"
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE relay_providers
        SET review_status = ?, review_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(next, next === "rejected" ? note : null, now, admin.id, now, id)
    .run()

  await recordAudit(
    env,
    row.owner_user_id,
    next === "approved" ? "relay.provider.approve" : "relay.provider.reject",
    `管理员 ${admin.username} ${next === "approved" ? "批准" : "拒绝"}中转站「${row.name}」` +
      (next === "rejected" ? `，理由：${note}` : ""),
    request.headers.get("CF-Connecting-IP")
  )
  // 审核态变了 ⇒ 列表与「能不能用」都变了，清掉 60 秒的只读视图缓存
  invalidateRelayViewCache()
  return json({ ok: true, reviewStatus: next, reviewNote: next === "rejected" ? note : null })
}

/**
 * POST /api/admin/relay-providers/:id/enabled —— 一键停用 / 恢复。
 *
 * 2026-10-16 审核制之后，这一列**不再是**「能不能用」的唯一判据：
 * 能不能用 = `review_status = 'approved'` **且** `enabled = 1`。
 * 所以对一台尚未批准（或已拒绝）的站「恢复」，它在用户侧依然不可用 ——
 * 响应里连 `usable` 一起给回去，管理端界面就不会显示成「已生效」。
 */
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
  return json({
    ok: true,
    enabled: enabled === 1,
    // 两把锁同时开才是「真的能用」，管理端据此显示，避免误导
    usable: enabled === 1 && reviewStatusOf(row) === "approved",
  })
}
