/**
 * 内网穿透「租用化」的管理端接口（2026-10-13）。
 *
 * 这一层的目的：**让管理员完全不必再打开 frps-panel 的网页**。
 * 那个网页现在其实是坏的（HTML/i18n 链路 panic，见 docs/内网穿透租用化改造方案.md §1.2），
 * 而且即便不坏，手工建号 + 手写到期日也不可能规模化。
 *
 * 分工（重要，别搞混）：
 *   · 本文件只写 D1 —— 它是**唯一真值**
 *   · 真正的落地由服务器上的 frp-agent 轮询后完成（最多 20 秒延迟）
 *   · 管理端展示的「同步状态」就是这两者是否一致的观测点
 *
 * 因此这里**不调用面板**，一次网络请求都不发。好处是：
 *   · 管理端不依赖那台服务器的可达性（Worker 本来也到不了它）
 *   · 管理员的操作永远不会因为对端抖动而失败
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { audit, getSettingNumber, getSettings } from "../settings"
import { requireUser } from "../auth"
import { applyPoints, getPointsBalance } from "../points"
import { renderFrpcConfig } from "../frp-config"
import type { Env } from "../env"

/**
 * 租用账号的统一前缀。
 *
 * 🔴 **必须与服务器上 agent 的 `user_prefix`、以及 handlers/frp-agent.ts 的
 * `FRP_USER_PREFIXES` 一致。** agent 靠它区分「本站创建的账号」与面板里
 * 46 个管理员人工建的历史账号，从而保证清理时绝不误删他人账号。
 * 实测这 46 个历史账号里没有任何一个以 `DC_` 开头。
 *
 * 2026-10-14：`dcfrp_` 旧前缀**已彻底移除**（站长确认从未投入使用，
 * D1 里唯一的 `dcfrp_06ed1dbb` 是一笔测试订阅，已改名为 DC_ 前缀）。
 * 所以这里只剩 `DC_` 一个前缀。
 */
const FRP_USER_PREFIX = "DC_"

/** 边界：哪些前缀算「本站创建的账号」。 */
const FRP_USER_PREFIXES = ["DC_"]

/**
 * 默认租用端口区间（2026-10-13 站长确认）。
 * 选这一段是因为现有 46 个历史账号里没人占用它。
 */
const DEFAULT_PORT_RANGE: [number, number] = [31000, 31999]

/** 面板的 token 只接受字母与数字（实测带连字符会被拒：token format error） */
const TOKEN_PATTERN = /^[A-Za-z0-9]{8,64}$/
const USER_PATTERN = new RegExp(`^(?:${FRP_USER_PREFIXES.join("|")})[A-Za-z0-9]{4,32}$`)

const DAY_MS = 86_400_000

interface PlanRow {
  id: string
  node_id: string
  name: string
  days: number
  price_points: number
  max_ports: number
  allow_ranges: string
  sort_order: number
  enabled: number
  note: string | null
  created_at: string
  updated_at: string
}

interface SubscriptionRow {
  id: string
  user_id: string
  node_id: string
  plan_id: string | null
  frp_user: string
  frp_token: string
  ports: string
  status: string
  started_at: string
  expires_at: string
  auto_renew: number
  price_points: number
  synced_at: string | null
  sync_state: string
  last_error: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 生成一个 8 位十六进制片段，用于拼账号名 */
function shortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * 生成面板用的 token。
 *
 * ⚠️ 只能用 A-Za-z0-9：面板对 token 有格式校验，实测 `dsh-probe-token`
 * 会被拒（`operate failed, token [...] format error`）。
 */
function generateFrpToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let out = ""
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

function parsePorts(raw: string): number[] {
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((n): n is number => Number.isInteger(n))
  } catch {
    return []
  }
}

/** 解析套餐的可选端口区间；空/非法则回落默认区间 */
function parseRanges(raw: string | null | undefined): [number, number][] {
  if (!raw) return [DEFAULT_PORT_RANGE]
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v) || v.length === 0) return [DEFAULT_PORT_RANGE]
    const out: [number, number][] = []
    for (const item of v) {
      if (!Array.isArray(item) || item.length !== 2) continue
      const [a, b] = item as unknown[]
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue
      const start = Math.min(a as number, b as number)
      const end = Math.max(a as number, b as number)
      if (start < 1 || end > 65535) continue
      out.push([start, end])
    }
    return out.length > 0 ? out : [DEFAULT_PORT_RANGE]
  } catch {
    return [DEFAULT_PORT_RANGE]
  }
}

/** 该节点上所有已经被占用的端口（租约 + 历史占用表） */
async function takenPorts(env: Env, nodeId: string): Promise<Set<number>> {
  const taken = new Set<number>()
  const leases = await env.DB.prepare(
    `SELECT port FROM frp_port_leases WHERE node_id = ?`
  )
    .bind(nodeId)
    .all<{ port: number }>()
  for (const row of leases.results ?? []) taken.add(row.port)

  // 历史占用表（人工登记的那些）也要避开，否则会和存量用户撞端口
  const legacy = await env.DB.prepare(
    `SELECT remote_port FROM frp_ports WHERE node_id = ?`
  )
    .bind(nodeId)
    .all<{ remote_port: number }>()
  for (const row of legacy.results ?? []) taken.add(row.remote_port)

  return taken
}

/** 从区间里挑出 count 个空闲端口（纯计算，不写库） */
async function pickPorts(
  env: Env,
  nodeId: string,
  count: number,
  ranges: [number, number][]
): Promise<number[]> {
  const taken = await takenPorts(env, nodeId)
  const out: number[] = []
  for (const [start, end] of ranges) {
    for (let port = start; port <= end && out.length < count; port++) {
      if (taken.has(port)) continue
      taken.add(port)
      out.push(port)
    }
    if (out.length >= count) break
  }
  return out
}

/** 为一个订阅登记端口租约（端口唯一性交给主键约束，而不是「先查再插」） */
async function leasePorts(
  env: Env,
  nodeId: string,
  subId: string,
  ports: number[],
  note: string
): Promise<void> {
  if (ports.length === 0) return
  const at = nowIso()
  await env.DB.batch(
    ports.map((port) =>
      env.DB.prepare(
        `INSERT INTO frp_port_leases (node_id, port, sub_id, kind, note, created_at)
         VALUES (?, ?, ?, 'rental', ?, ?)
         ON CONFLICT(node_id, port) DO UPDATE SET sub_id = excluded.sub_id, note = excluded.note`
      ).bind(nodeId, port, subId, note, at)
    )
  )
}

async function requireNode(env: Env, nodeId: string): Promise<{ id: string; name: string }> {
  const row = await env.DB.prepare(`SELECT id, name FROM frp_nodes WHERE id = ?`)
    .bind(nodeId)
    .first<{ id: string; name: string }>()
  if (!row) throw new ApiError(404, `节点不存在：${nodeId}`, "FRP_NODE_NOT_FOUND")
  return row
}

// ---------------------------------------------------------------- 套餐

/** GET /api/admin/frp/plans */
/**
 * 把租用收入按比例分成给**节点捐献者**。
 *
 * 站长口径：租用者支付的积分按 `frp_rental_owner_share_percent`（默认 10%）
 * 转给捐献者，其余销毁。比例在管理面板可改。
 *
 * 几个刻意的取舍：
 *   · **自营节点不分成**：owner_user_id 为空 = 平台自己的机器，收入全额销毁。
 *   · **自己租自己的不分成**：钱从「扣 100」变成「扣 100 再退 10」，多一次无意义
 *     往返，还会在积分流水里刷噪声。
 *   · **算出来是 0 就完全不动**：比例 0、或单价低到分成不足 1 分时，
 *     不写一条 delta=0 的流水。
 *   · **失败不影响租约**：分成是附带动作，抛错不该把用户已经付过钱的租约搞坏，
 *     所以整段包在 try 里，出问题只记日志。
 *
 * 向下取整是刻意的：宁可少给一分，也不要出现「分出去比收进来多」。
 */
async function shareRentalToOwner(
  env: Env,
  nodeId: string,
  paidPoints: number,
  payerUserId: string,
  detail: string,
  dedupKey: string
): Promise<void> {
  try {
    if (paidPoints <= 0) return

    // 没有回退值参数：解析不出来时它自己会回落到 SETTING_DEFAULTS（也就是 10）
    const pct = await getSettingNumber(env, "frp_rental_owner_share_percent")
    if (pct <= 0) return
    const effective = Math.min(pct, 100)

    const node = await env.DB.prepare(
      `SELECT owner_user_id FROM frp_nodes WHERE id = ? LIMIT 1`
    )
      .bind(nodeId)
      .first<{ owner_user_id: string | null }>()
    const ownerId = node?.owner_user_id
    if (!ownerId) return // 自营节点
    if (ownerId === payerUserId) return // 自己租自己的

    const share = Math.floor((paidPoints * effective) / 100)
    if (share <= 0) return

    await applyPoints(env, {
      userId: ownerId,
      delta: share,
      reason: "frp_rental_share",
      detail: `节点租用分成 ${effective}% · ${detail}`,
      dedupKey,
    })
  } catch (err) {
    // 分成失败不能连累已经成立的租约
    console.error("frp rental owner share failed", err)
  }
}

export async function listFrpPlans(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "frp.plans")
  const { results } = await env.DB.prepare(
    `SELECT p.*, n.name AS node_name
       FROM frp_plans p LEFT JOIN frp_nodes n ON n.id = p.node_id
      ORDER BY p.sort_order ASC, p.days ASC`
  ).all<PlanRow & { node_name: string | null }>()
  return json({
    plans: (results ?? []).map((p) => ({
      id: p.id,
      nodeId: p.node_id,
      nodeName: p.node_name,
      name: p.name,
      days: p.days,
      pricePoints: p.price_points,
      maxPorts: p.max_ports,
      allowRanges: parseRanges(p.allow_ranges),
      sortOrder: p.sort_order,
      enabled: p.enabled === 1,
      note: p.note,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
    defaultPortRange: DEFAULT_PORT_RANGE,
  })
}

/** POST /api/admin/frp/plans —— 新建或更新（带 id 即更新） */
export async function upsertFrpPlan(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "frp.plans")
  const body = (await request.json()) as {
    id?: string
    nodeId?: string
    name?: string
    days?: number
    pricePoints?: number
    maxPorts?: number
    allowRanges?: [number, number][]
    sortOrder?: number
    enabled?: boolean
    note?: string
  }

  const nodeId = String(body.nodeId ?? "").trim()
  const name = String(body.name ?? "").trim()
  const days = Number(body.days)
  const pricePoints = Number(body.pricePoints)
  const maxPorts = Number(body.maxPorts ?? 1)

  if (!nodeId) throw new ApiError(400, "缺少节点", "BAD_PLAN")
  if (!name) throw new ApiError(400, "缺少套餐名", "BAD_PLAN")
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new ApiError(400, "天数必须是 1~3650 的整数", "BAD_PLAN")
  }
  if (!Number.isInteger(pricePoints) || pricePoints < 0) {
    throw new ApiError(400, "价格必须是非负整数（积分）", "BAD_PLAN")
  }
  if (!Number.isInteger(maxPorts) || maxPorts < 1 || maxPorts > 20) {
    throw new ApiError(400, "端口数必须是 1~20 的整数", "BAD_PLAN")
  }
  await requireNode(env, nodeId)

  const at = nowIso()
  const id = body.id?.trim() || `plan_${shortId()}${shortId()}`

  if (body.id?.trim()) {
    const exists = await env.DB.prepare(`SELECT id FROM frp_plans WHERE id = ?`).bind(id).first()
    if (!exists) throw new ApiError(404, `套餐不存在：${id}`, "PLAN_NOT_FOUND")
    await env.DB.prepare(
      `UPDATE frp_plans
          SET node_id = ?, name = ?, days = ?, price_points = ?, max_ports = ?,
              allow_ranges = ?, sort_order = ?, enabled = ?, note = ?, updated_at = ?
        WHERE id = ?`
    )
      .bind(
        nodeId,
        name,
        days,
        pricePoints,
        maxPorts,
        JSON.stringify(body.allowRanges ?? [DEFAULT_PORT_RANGE]),
        Number(body.sortOrder ?? 0),
        body.enabled === false ? 0 : 1,
        body.note ?? null,
        at,
        id
      )
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO frp_plans
         (id, node_id, name, days, price_points, max_ports, allow_ranges, sort_order, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        nodeId,
        name,
        days,
        pricePoints,
        maxPorts,
        JSON.stringify(body.allowRanges ?? [DEFAULT_PORT_RANGE]),
        Number(body.sortOrder ?? 0),
        body.enabled === false ? 0 : 1,
        body.note ?? null,
        at,
        at
      )
      .run()
  }

  await audit(env, admin.id, body.id?.trim() ? "frp.plan.update" : "frp.plan.create", `${name} (${days}天 / ${pricePoints}积分 / ${maxPorts}端口)`)
  return json({ ok: true, id })
}

/** DELETE /api/admin/frp/plans/:id */
export async function deleteFrpPlan(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdminScope(env, request, "frp.plans")
  // 已经有人买过的套餐不允许直接删（订阅行还引用着它），停用即可
  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM frp_subscriptions WHERE plan_id = ?`
  )
    .bind(id)
    .first<{ n: number }>()
  if ((used?.n ?? 0) > 0) {
    throw new ApiError(
      409,
      `该套餐已被 ${used?.n} 个订阅引用，不能删除；请改为「停用」`,
      "PLAN_IN_USE"
    )
  }
  await env.DB.prepare(`DELETE FROM frp_plans WHERE id = ?`).bind(id).run()
  await audit(env, admin.id, "frp.plan.delete", id)
  return json({ ok: true })
}

// ---------------------------------------------------------------- 订阅

interface SubListItem {
  id: string
  userId: string
  username: string | null
  nodeId: string
  nodeName: string | null
  planId: string | null
  frpUser: string
  ports: number[]
  status: string
  startedAt: string
  expiresAt: string
  daysLeft: number
  autoRenew: boolean
  pricePoints: number
  syncState: string
  syncedAt: string | null
  lastError: string | null
}

/** GET /api/admin/frp/subscriptions */
export async function listFrpSubscriptions(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "frp.rentals")
  const { results } = await env.DB.prepare(
    `SELECT s.*, u.username AS username, n.name AS node_name
       FROM frp_subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN frp_nodes n ON n.id = s.node_id
      ORDER BY s.expires_at ASC`
  ).all<SubscriptionRow & { username: string | null; node_name: string | null }>()

  const now = Date.now()
  const subs: SubListItem[] = (results ?? []).map((row) => {
    const expires = Date.parse(row.expires_at)
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      nodeId: row.node_id,
      nodeName: row.node_name,
      planId: row.plan_id,
      frpUser: row.frp_user,
      ports: parsePorts(row.ports),
      status: row.status,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      daysLeft: Number.isFinite(expires)
        ? Math.ceil((expires - now) / DAY_MS)
        : 0,
      autoRenew: row.auto_renew === 1,
      pricePoints: row.price_points,
      syncState: row.sync_state,
      syncedAt: row.synced_at,
      lastError: row.last_error,
    }
  })

  // agent 心跳 —— 管理端「在线实况」用。拿不到就说明 agent 没在跑。
  const heartbeat = await env.DB.prepare(
    `SELECT node_id, last_seen_at, revision, server_info, last_error, report_count
       FROM frp_agent_state ORDER BY last_seen_at DESC`
  ).all<{
    node_id: string
    last_seen_at: string
    revision: string | null
    server_info: string | null
    last_error: string | null
    report_count: number
  }>()

  const agents = (heartbeat.results ?? []).map((h) => {
    const seen = Date.parse(h.last_seen_at)
    let serverInfo: unknown = null
    try {
      serverInfo = h.server_info ? JSON.parse(h.server_info) : null
    } catch {
      serverInfo = null
    }
    return {
      nodeId: h.node_id,
      lastSeenAt: h.last_seen_at,
      /** 超过 2 分钟没心跳就认为 agent 掉线了（它每 20 秒一轮） */
      online: Number.isFinite(seen) ? now - seen < 120_000 : false,
      revision: h.revision,
      serverInfo,
      lastError: h.last_error,
      reportCount: h.report_count,
    }
  })

  return json({
    subscriptions: subs,
    agents,
    userPrefix: FRP_USER_PREFIX,
    defaultPortRange: DEFAULT_PORT_RANGE,
  })
}

/** POST /api/admin/frp/subscriptions —— 手工开一份订阅（或替用户开） */
export async function createFrpSubscription(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "frp.rentals")
  const body = (await request.json()) as {
    userId?: string
    /** 管理端界面填的是用户名（比让人去查 uuid 友好得多），两个都收 */
    username?: string
    nodeId?: string
    planId?: string
    days?: number
    portCount?: number
    ports?: number[]
    note?: string
  }

  const userIdInput = String(body.userId ?? "").trim()
  const usernameInput = String(body.username ?? "").trim()
  if (!userIdInput && !usernameInput) {
    throw new ApiError(400, "缺少用户（userId 或 username）", "BAD_SUBSCRIPTION")
  }
  const user = userIdInput
    ? await env.DB.prepare(`SELECT id, username FROM users WHERE id = ?`)
        .bind(userIdInput)
        .first<{ id: string; username: string }>()
    : await env.DB.prepare(`SELECT id, username FROM users WHERE username = ? COLLATE NOCASE`)
        .bind(usernameInput)
        .first<{ id: string; username: string }>()
  if (!user) {
    throw new ApiError(404, `用户不存在：${userIdInput || usernameInput}`, "USER_NOT_FOUND")
  }

  let nodeId = String(body.nodeId ?? "").trim()
  let days = Number(body.days ?? 0)
  let portCount = Number(body.portCount ?? 1)
  let ranges: [number, number][] = [DEFAULT_PORT_RANGE]
  let planId: string | null = null

  if (body.planId) {
    const plan = await env.DB.prepare(`SELECT * FROM frp_plans WHERE id = ?`)
      .bind(body.planId)
      .first<PlanRow>()
    if (!plan) throw new ApiError(404, "套餐不存在", "PLAN_NOT_FOUND")
    planId = plan.id
    nodeId = nodeId || plan.node_id
    days = days || plan.days
    portCount = body.portCount ?? plan.max_ports
    ranges = parseRanges(plan.allow_ranges)
  }

  if (!nodeId) throw new ApiError(400, "缺少节点", "BAD_SUBSCRIPTION")
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new ApiError(400, "天数必须是 1~3650 的整数", "BAD_SUBSCRIPTION")
  }
  if (!Number.isInteger(portCount) || portCount < 1 || portCount > 20) {
    throw new ApiError(400, "端口数必须是 1~20 的整数", "BAD_SUBSCRIPTION")
  }
  await requireNode(env, nodeId)

  // 端口：管理员显式指定就用它，否则从区间里自动挑
  let ports: number[]
  if (Array.isArray(body.ports) && body.ports.length > 0) {
    ports = body.ports.filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535)
    if (ports.length !== body.ports.length) {
      throw new ApiError(400, "端口列表含非法值", "BAD_SUBSCRIPTION")
    }
    const taken = await takenPorts(env, nodeId)
    const clash = ports.filter((p) => taken.has(p))
    if (clash.length > 0) {
      throw new ApiError(409, `端口已被占用：${clash.join(", ")}`, "PORT_TAKEN")
    }
  } else {
    ports = await pickPorts(env, nodeId, portCount, ranges)
    if (ports.length < portCount) {
      throw new ApiError(
        409,
        `可用端口不足（区间 ${ranges.map(([a, b]) => `${a}-${b}`).join("、")} 里只剩 ${ports.length} 个）`,
        "PORT_EXHAUSTED"
      )
    }
  }

  const id = `sub_${shortId()}${shortId()}`


  const frpUser = `${FRP_USER_PREFIX}${shortId()}`
  if (!USER_PATTERN.test(frpUser)) {
    throw new ApiError(500, `生成的账号名不合规：${frpUser}`, "BAD_SUBSCRIPTION")
  }
  const frpToken = generateFrpToken()
  if (!TOKEN_PATTERN.test(frpToken)) {
    throw new ApiError(500, "生成的 token 不合规", "BAD_SUBSCRIPTION")
  }

  const at = new Date()
  const expires = new Date(at.getTime() + days * DAY_MS).toISOString()

  await env.DB.prepare(
    `INSERT INTO frp_subscriptions
       (id, user_id, node_id, plan_id, frp_user, frp_token, ports, status,
        started_at, expires_at, auto_renew, price_points, sync_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, 0, 'pending', ?, ?)`
  )
    .bind(
      id,
      user.id,
      nodeId,
      planId,
      frpUser,
      frpToken,
      JSON.stringify(ports),
      at.toISOString(),
      expires,
      at.toISOString(),
      at.toISOString()
    )
    .run()

  await leasePorts(env, nodeId, id, ports, `管理员开给 ${user.username}`)
  await audit(
    env,
    admin.id,
    "frp.subscription.create",
    `${user.username} / ${frpUser} / ${ports.join(",")} / ${days}天`
  )

  return json({ ok: true, id, frpUser, frpToken, ports, expiresAt: expires })
}

/**
 * POST /api/admin/frp/subscriptions/:id —— 对一份订阅做动作。
 *
 * 支持的动作：
 *   extend   续期（from = max(now, expires_at)，不会因为过期而吞掉天数）
 *   suspend  停用（status=cancelled，agent 下一轮会把面板账号 disable）
 *   resume   恢复（status=active）
 *   revoke   回收（删行；agent 下一轮会把面板账号 remove）
 *   setPorts 改端口（会同步更新租约）
 */
export async function updateFrpSubscription(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "frp.rentals")
  const sub = await env.DB.prepare(`SELECT * FROM frp_subscriptions WHERE id = ?`)
    .bind(id)
    .first<SubscriptionRow>()
  if (!sub) throw new ApiError(404, "订阅不存在", "SUBSCRIPTION_NOT_FOUND")

  const body = (await request.json()) as {
    action?: string
    days?: number
    ports?: number[]
    /** 直接设定到期时间（管理员手工兜底用）；优先级高于 days */
    expiresAt?: string
    /** setToken 用：新的连接密码（只允许字母数字，见 TOKEN_PATTERN） */
    token?: string
  }
  const action = String(body.action ?? "").trim()
  const at = nowIso()

  if (action === "revoke") {
    // 先删租约再删订阅：反过来会留下无人认领的端口占用
    await env.DB.prepare(`DELETE FROM frp_port_leases WHERE sub_id = ?`).bind(id).run()
    await env.DB.prepare(`DELETE FROM frp_subscriptions WHERE id = ?`).bind(id).run()
    await audit(env, admin.id, "frp.subscription.revoke", `${sub.frp_user} / ${sub.ports}`)
    return json({ ok: true, revoked: true })
  }

  if (action === "suspend" || action === "resume") {
    await env.DB.prepare(
      `UPDATE frp_subscriptions SET status = ?, updated_at = ? WHERE id = ?`
    )
      .bind(action === "suspend" ? "cancelled" : "active", at, id)
      .run()
    await audit(env, admin.id, `frp.subscription.${action}`, sub.frp_user)
    return json({ ok: true, status: action === "suspend" ? "cancelled" : "active" })
  }

  if (action === "extend") {
    let nextExpiry: string
    if (body.expiresAt) {
      const ts = Date.parse(body.expiresAt)
      if (!Number.isFinite(ts)) throw new ApiError(400, "到期时间格式不正确", "BAD_SUBSCRIPTION")
      nextExpiry = new Date(ts).toISOString()
    } else {
      const days = Number(body.days)
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new ApiError(400, "续期天数必须是 1~3650 的整数", "BAD_SUBSCRIPTION")
      }
      // 已过期就从「现在」起算，未过期就往后顺延 —— 不吞掉剩余天数，也不让过期用户倒扣
      const base = Math.max(Date.now(), Date.parse(sub.expires_at) || 0)
      nextExpiry = new Date(base + days * DAY_MS).toISOString()
    }
    await env.DB.prepare(
      `UPDATE frp_subscriptions
          SET expires_at = ?, updated_at = ?,
              status = CASE WHEN status = 'expired' THEN 'active' ELSE status END
        WHERE id = ?`
    )
      .bind(nextExpiry, at, id)
      .run()
    await audit(env, admin.id, "frp.subscription.extend", `${sub.frp_user} → ${nextExpiry}`)
    return json({ ok: true, expiresAt: nextExpiry })
  }

  if (action === "setToken") {
    // 改密码。站长要求：用户名不可改（生成后固定），但密码用户自己可以改。
    //
    // ⚠️ 必须在这里就用 TOKEN_PATTERN 挡住 —— 面板对 token 有格式校验
    //    （只收 A-Za-z0-9），放进去的话用户会拿到一个「面板连不上、
    //    但看不出原因」的账号，排查成本极高。宁可在这里报错。
    const raw = typeof body.token === "string" ? body.token.trim() : ""
    if (!TOKEN_PATTERN.test(raw)) {
      throw new ApiError(
        400,
        "密码只能用 8–64 位字母或数字（面板不收其它字符）",
        "BAD_TOKEN"
      )
    }
    await env.DB.prepare(`UPDATE frp_subscriptions SET frp_token = ?, updated_at = ? WHERE id = ?`)
      .bind(raw, at, id)
      .run()
    await audit(env, admin.id, "frp.subscription.setToken", sub.frp_user)
    return json({ ok: true, frpToken: raw })
  }

  if (action === "setPorts") {
    const wanted = Array.isArray(body.ports) ? body.ports : []
    if (wanted.length === 0) throw new ApiError(400, "端口列表不能为空", "BAD_SUBSCRIPTION")
    const ports = wanted.filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535)
    if (ports.length !== wanted.length) {
      throw new ApiError(400, "端口列表含非法值", "BAD_SUBSCRIPTION")
    }
    // 排除「本订阅自己已经占的」再判断冲突，否则改端口必然自撞
    const own = new Set(parsePorts(sub.ports))
    const taken = await takenPorts(env, sub.node_id)
    const clash = ports.filter((p) => taken.has(p) && !own.has(p))
    if (clash.length > 0) {
      throw new ApiError(409, `端口已被占用：${clash.join(", ")}`, "PORT_TAKEN")
    }
    // 先放掉旧租约里不再需要的，再登记新的
    const keep = ports.filter((p) => own.has(p))
    await env.DB.prepare(`DELETE FROM frp_port_leases WHERE sub_id = ?`).bind(id).run()
    await leasePorts(env, sub.node_id, id, keep, "保留")
    await leasePorts(env, sub.node_id, id, ports.filter((p) => !own.has(p)), "新增")
    await env.DB.prepare(
      `UPDATE frp_subscriptions SET ports = ?, updated_at = ? WHERE id = ?`
    )
      .bind(JSON.stringify(ports), at, id)
      .run()
    await audit(env, admin.id, "frp.subscription.setPorts", `${sub.frp_user} → ${ports.join(",")}`)
    return json({ ok: true, ports })
  }

  throw new ApiError(400, `未知动作：${action || "(空)"}`, "BAD_SUBSCRIPTION")
}

// ---------------------------------------------------------------- 用户端
//
// 用户能看到什么、能做什么：
//   · 有哪些套餐可买（以及自己有多少积分）
//   · 自己的租约：账号、端口、到期时间、剩余天数、可直接用的 frpc 配置
//   · 用积分购买 / 续期
//
// ⚠️ 与管理员不同，这里的每一次积分变动都必须走 applyPoints —— 它是原子的，
// 余额不足会直接拒绝而不是扣成负数，并且有 dedup_key 防重复提交。

interface RentalRow extends SubscriptionRow {
  node_name: string | null
  server_addr: string | null
  server_port: number | null
  auth_token: string | null
  config_template: string | null
}

/**
 * 生成给用户直接用的 frpc 配置。
 *
 * 复用 `renderFrpcConfig`（后端与前端各有一份等价实现，这里用后端那份），
 * 保证**租用生成的配置与人工申请生成的配置完全同形** —— 否则用户照着旧教程改就会踩坑。
 *
 * `localPort` 默认与 `remotePort` 相同并附注释：内网穿透的本质是「公网端口 → 你本机某端口」，
 * 服务端无从知道你本机端口，只能给一个需要用户改的默认值。
 */
function rentalConfigToml(row: RentalRow): string {
  const ports = parsePorts(row.ports)
  const proxies =
    ports.length === 0
      ? "# 你的租约还没有分配端口，请联系管理员"
      : ports
          .map((port) =>
            [
              "[[proxies]]",
              `name = "${row.frp_user}-${port}"`,
              `type = "tcp"`,
              `localIP = "127.0.0.1"`,
              `# ⚠️ 把下面的 localPort 改成你自己本机服务的端口`,
              `localPort = ${port}`,
              `remotePort = ${port}`,
            ].join("\n")
          )
          .join("\n\n")

  return renderFrpcConfig(row.config_template, {
    serverAddr: row.server_addr ?? "",
    serverPort: row.server_port ?? 0,
    authToken: row.auth_token,
    user: row.frp_user,
    password: row.frp_token,
    proxies,
  })
}

/** GET /api/frp/rental/plans —— 可购买的套餐 + 我的积分余额 */
export async function listRentalPlans(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const balance = await getPointsBalance(env, user.id)

  // `frp_enabled` 原本只服务于已退役的人工申请流程。现在让它当**租用销售总开关** ——
  // 否则它就成了一个「面板能改、服务端从不读」的假开关（护栏会直接报出来）。
  // 关掉只影响「还能不能买」，已购租约照常运行到到期，不会掐断用户。
  const settings = await getSettings(env)
  const suspended = settings.frp_enabled !== "1"

  if (suspended) {
    return json({
      balance,
      plans: [],
      suspended: true,
      /** frpc 下载地址：租用用户也需要它，否则拿到配置也没客户端可用 */
      coreUrl: settings.frp_core_url || null,
      userPrefix: FRP_USER_PREFIX,
    })
  }

  const { results } = await env.DB.prepare(
    `SELECT p.*, n.name AS node_name
       FROM frp_plans p
       JOIN frp_nodes n ON n.id = p.node_id
      WHERE p.enabled = 1 AND n.enabled = 1
      ORDER BY p.sort_order ASC, p.price_points ASC`
  ).all<PlanRow & { node_name: string | null }>()

  // 我在该节点上已有的租约 —— 前端据此把「购买」换成「续期」
  const mine = await env.DB.prepare(
    `SELECT id, node_id, frp_user, expires_at, status
       FROM frp_subscriptions WHERE user_id = ? AND status != 'cancelled'`
  )
    .bind(user.id)
    .all<{ id: string; node_id: string; frp_user: string; expires_at: string; status: string }>()

  const mineByNode: Record<string, { id: string; frpUser: string; expiresAt: string }> = {}
  for (const row of mine.results ?? []) {
    mineByNode[row.node_id] = { id: row.id, frpUser: row.frp_user, expiresAt: row.expires_at }
  }

  return json({
    balance,
    plans: (results ?? []).map((p) => ({
      id: p.id,
      nodeId: p.node_id,
      nodeName: p.node_name,
      name: p.name,
      days: p.days,
      pricePoints: p.price_points,
      maxPorts: p.max_ports,
      allowRanges: parseRanges(p.allow_ranges),
      /** 买得起吗 —— 前端据此置灰按钮，省得点下去才报错 */
      affordable: balance >= p.price_points,
      /** 我在这个节点上已有的租约（有则只能续期，不能重复购买） */
      existing: mineByNode[p.node_id] ?? null,
    })),
    suspended: false,
    coreUrl: settings.frp_core_url || null,
    userPrefix: FRP_USER_PREFIX,
  })
}

/** GET /api/frp/rental/mine —— 我的租约（含可直接用的配置） */
export async function listMyRentals(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const balance = await getPointsBalance(env, user.id)

  const { results } = await env.DB.prepare(
    `SELECT s.*, n.name AS node_name, n.server_addr, n.server_port, n.auth_token, n.config_template
       FROM frp_subscriptions s
       LEFT JOIN frp_nodes n ON n.id = s.node_id
      WHERE s.user_id = ?
      ORDER BY s.expires_at DESC`
  )
    .bind(user.id)
    .all<RentalRow>()

  const now = Date.now()
  return json({
    balance,
    subscriptions: (results ?? []).map((row) => {
      const expires = Date.parse(row.expires_at)
      const daysLeft = Number.isFinite(expires) ? Math.ceil((expires - now) / DAY_MS) : 0
      const expired = Number.isFinite(expires) && expires <= now
      return {
        id: row.id,
        nodeId: row.node_id,
        nodeName: row.node_name,
        frpUser: row.frp_user,
        ports: parsePorts(row.ports),
        /** 到期即视为不可用，即便 status 还没来得及翻成 expired（阶段 4 的 cron 会翻） */
        status: expired && row.status === "active" ? "expired" : row.status,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        daysLeft,
        planId: row.plan_id,
        pricePoints: row.price_points,
        syncState: row.sync_state,
        lastError: row.last_error,
        serverAddr: row.server_addr,
        serverPort: row.server_port,
        /** 只有还在有效期内才给配置，避免用户拿着连不上的配置来回试 */
        configToml: !expired && row.status === "active" ? rentalConfigToml(row) : null,
      }
    }),
  })
}

/** POST /api/frp/rental/purchase —— 用积分购买一份租约 */
export async function purchaseRental(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { planId?: string; requestId?: string }
  const planId = String(body.planId ?? "").trim()
  if (!planId) throw new ApiError(400, "缺少套餐", "BAD_PURCHASE")

  // 销售总开关（见 listRentalPlans 的说明）：只挡新购买，不影响已购租约续期与运行
  const settings = await getSettings(env)
  if (settings.frp_enabled !== "1") {
    throw new ApiError(409, "内网穿透租用当前已暂停销售，请稍后再试", "RENTAL_SUSPENDED")
  }

  const plan = await env.DB.prepare(`SELECT * FROM frp_plans WHERE id = ?`)
    .bind(planId)
    .first<PlanRow>()
  if (!plan) throw new ApiError(404, "套餐不存在", "PLAN_NOT_FOUND")
  if (plan.enabled !== 1) throw new ApiError(409, "该套餐已下架", "PLAN_DISABLED")

  const node = await env.DB.prepare(`SELECT id, name, enabled FROM frp_nodes WHERE id = ?`)
    .bind(plan.node_id)
    .first<{ id: string; name: string; enabled: number }>()
  if (!node) throw new ApiError(404, "节点不存在", "FRP_NODE_NOT_FOUND")
  if (node.enabled !== 1) throw new ApiError(409, "该节点已停用", "NODE_DISABLED")

  // 一个节点上只保留一份有效租约：多份会让「续期哪一份」变得含糊，也容易被用来囤端口
  const existing = await env.DB.prepare(
    `SELECT id, frp_user FROM frp_subscriptions
      WHERE user_id = ? AND node_id = ? AND status != 'cancelled' LIMIT 1`
  )
    .bind(user.id, plan.node_id)
    .first<{ id: string; frp_user: string }>()
  if (existing) {
    throw new ApiError(
      409,
      `你在该节点上已有一份租约（${existing.frp_user}），请直接续期`,
      "ALREADY_SUBSCRIBED"
    )
  }

  // 先把端口挑出来：这一步失败就绝不该扣分
  const ports = await pickPorts(env, plan.node_id, plan.max_ports, parseRanges(plan.allow_ranges))
  if (ports.length < plan.max_ports) {
    throw new ApiError(
      409,
      `可用端口不足（需要 ${plan.max_ports} 个，只剩 ${ports.length} 个），请联系管理员扩容`,
      "PORT_EXHAUSTED"
    )
  }

  const deducted = await applyPoints(env, {
    userId: user.id,
    delta: -plan.price_points,
    reason: "frp_rental",
    detail: `内网穿透 · ${plan.name}（${plan.days} 天 / 端口 ${ports.join(",")}）`,
    dedupKey: body.requestId ? `frp_rental:buy:${body.requestId}` : null,
  })
  if (!deducted.applied) {
    if (deducted.reason === "duplicated") {
      throw new ApiError(409, "这次购买已经处理过了，请刷新页面查看", "DUPLICATE_REQUEST")
    }
    throw new ApiError(
      402,
      `积分不足：需要 ${plan.price_points}，你当前有 ${deducted.balance}`,
      "INSUFFICIENT_POINTS"
    )
  }

  const id = `sub_${shortId()}${shortId()}`
  // 扣款已成功、租约 id 也定下来了 —— 这时候再分成。
  // 幂等键用订阅 id：一笔租约对应一次分成，重复调用不会重复给。
  await shareRentalToOwner(
    env,
    plan.node_id,
    plan.price_points,
    user.id,
    `${plan.name}（${plan.days} 天）`,
    `frp_rental:share:${id}`
  )
  const frpUser = `${FRP_USER_PREFIX}${shortId()}`
  const frpToken = generateFrpToken()
  const at = new Date()
  const expires = new Date(at.getTime() + plan.days * DAY_MS).toISOString()

  try {
    await env.DB.prepare(
      `INSERT INTO frp_subscriptions
         (id, user_id, node_id, plan_id, frp_user, frp_token, ports, status,
          started_at, expires_at, auto_renew, price_points, sync_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, 'pending', ?, ?)`
    )
      .bind(
        id,
        user.id,
        plan.node_id,
        plan.id,
        frpUser,
        frpToken,
        JSON.stringify(ports),
        at.toISOString(),
        expires,
        plan.price_points,
        at.toISOString(),
        at.toISOString()
      )
      .run()
    await leasePorts(env, plan.node_id, id, ports, `用户购买 ${plan.name}`)
  } catch (err) {
    // 🚨 落库失败必须把钱退回去 —— 绝不能让用户付了积分却没有租约
    await applyPoints(env, {
      userId: user.id,
      delta: plan.price_points,
      reason: "frp_rental",
      detail: `内网穿透 · ${plan.name} 开通失败，积分已退回`,
      dedupKey: `frp_rental:refund:${id}`,
    })
    throw err
  }

  await audit(
    env,
    user.id,
    "frp.rental.purchase",
    `${plan.name} / ${frpUser} / ${ports.join(",")} / -${plan.price_points}`
  )

  return json({
    ok: true,
    id,
    frpUser,
    ports,
    expiresAt: expires,
    balance: deducted.balance,
    pricePoints: plan.price_points,
  })
}

/** POST /api/frp/rental/renew —— 用积分续期 */
/**
 * POST /frp/rental/token —— 租约所有者改自己的 frp 密码。
 *
 * 站长要求：账号名生成后**不可改**，但密码用户可以自己在 DoulorCloud 里改。
 *
 * 🔴 查询必须限定 user_id —— token 是 frp 唯一的连接凭据，越权改掉别人的密码
 *    等于把人家的隧道顶掉。越权时返回 **404 而不是 403**：403 等于告诉攻击者
 *    「这个租约 id 确实存在」。
 *
 * 格式校验和面板 v1 的 setToken 共用 TOKEN_PATTERN，理由见那里。
 */
export async function setMyRentalToken(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { id?: string; token?: string }
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少租约", "BAD_TOKEN")

  const sub = await env.DB.prepare(
    `SELECT * FROM frp_subscriptions WHERE id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<SubscriptionRow>()
  if (!sub) throw new ApiError(404, "租约不存在", "SUBSCRIPTION_NOT_FOUND")
  if (sub.status === "cancelled") {
    throw new ApiError(409, "该租约已被停用，请联系管理员", "SUBSCRIPTION_CANCELLED")
  }

  // 面板只收 A-Za-z0-9（实测带连字符会被拒：operate failed, token format error）。
  // 不在这里挡住，用户会拿到一个「面板连不上、但看不出原因」的账号，排查成本极高。
  const raw = typeof body.token === "string" ? body.token.trim() : ""
  if (!TOKEN_PATTERN.test(raw)) {
    throw new ApiError(
      400,
      "密码只能用 8–64 位字母或数字（面板不收其它字符）",
      "BAD_TOKEN"
    )
  }

  await env.DB.prepare(`UPDATE frp_subscriptions SET frp_token = ?, updated_at = ? WHERE id = ?`)
    .bind(raw, nowIso(), id)
    .run()
  await audit(env, user.id, "frp.rental.setToken", sub.frp_user)
  return json({ ok: true, frpToken: raw })
}

/**
 * 开关「自动续费」（用户只能改自己的租约）。
 *
 * 语义：到期前 24 小时内，如果开着自动续费且积分够，就自动按当前套餐续一期。
 *
 * ⚠️ 为什么用 `WHERE id = ? AND user_id = ?` 而不是先查后判断：
 *    先查再更新中间有窗口，而且"查到了但不属于你"和"不存在"必须返回**同样的 404**
 *    —— 否则拿着别人的 id 试探就能区分出"这个 id 存在但不是你的"，
 *    等于泄露了别人租约的 id。这和改令牌那条是同一个道理。
 */
export async function setMyRentalAutoRenew(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; autoRenew?: unknown }
  const id = String(body.id || "").trim()
  if (!id) throw new ApiError(400, "缺少租约 id", "BAD_REQUEST")
  if (typeof body.autoRenew !== "boolean") {
    throw new ApiError(400, "autoRenew 必须是布尔值", "BAD_REQUEST")
  }

  const res = await env.DB.prepare(
    `UPDATE frp_subscriptions SET auto_renew = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  )
    .bind(body.autoRenew ? 1 : 0, new Date().toISOString(), id, user.id)
    .run()

  if (!res.meta.changes) {
    throw new ApiError(404, "租约不存在", "NOT_FOUND")
  }
  return json({ ok: true, id, autoRenew: body.autoRenew })
}

/**
 * 自动续费引擎（由 cron 调用）。
 *
 * 规则：`auto_renew = 1` 且**到期时间已进入 24 小时窗口**的活跃租约，
 * 自动再买一期；积分不够就把开关**关掉**并记下原因。
 *
 * 几个刻意的决定：
 *
 *   · **提前 24 小时续，而不是到期后再续**
 *     到期后才续的话，用户会有一段服务中断的空窗（下一次 cron、面板同步、
 *     用户重连都要时间）。提前续是"无缝"的。
 *
 *   · **只处理一次，不会连买多期**
 *     续完 `expires_at` 就推到 24 小时窗口之外了，所以同一条租约在下一轮
 *     不会再被选中 —— 天然幂等，不需要额外的"已处理"标记。
 *
 *   · **积分不够就关掉开关，而不是反复重试**
 *     反复重试会在每轮 cron 里刷失败日志，用户也永远不知道发生了什么。
 *     关掉开关 + 留下原因，用户下次打开页面就能看见。
 *
 *   · **没有套餐的租约直接跳过**
 *     `plan_id` 可空（早期数据/手工建的租约）。没有套餐就没有价格，
 *     续不了，也不该把开关关掉 —— 那是数据本身不完整，不是用户的问题。
 */
export async function autoRenewDueRentals(
  env: Env
): Promise<{ renewed: number; insufficient: number; skipped: number }> {
  const out = { renewed: 0, insufficient: 0, skipped: 0 }
  const nowMs = Date.now()
  const horizon = new Date(nowMs + 24 * 3600 * 1000).toISOString()
  const nowIso = new Date(nowMs).toISOString()

  const rows = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.plan_id, s.expires_at,
            p.price_points, p.days, p.name
       FROM frp_subscriptions s
       JOIN frp_plans p ON p.id = s.plan_id
      WHERE s.auto_renew = 1
        AND s.status = 'active'
        AND s.plan_id IS NOT NULL
        AND s.expires_at <= ?
      LIMIT 200`
  )
    .bind(horizon)
    .all<{
      id: string
      user_id: string
      plan_id: string
      expires_at: string
      price_points: number
      days: number
      name: string
    }>()

  const due = rows.results ?? []
  if (due.length === 0) return out

  for (const r of due) {
    const price = Number(r.price_points) || 0
    const days = Number(r.days) || 0

    // 0 积分的套餐：直接续，不需要扣款（免费套餐不该因为"没分"而断掉）
    let applied = true
    let balance = 0
    if (price > 0) {
      const deducted = await applyPoints(env, {
        userId: r.user_id,
        delta: -price,
        reason: "frp_rental",
        detail: `内网穿透 · 自动续费 ${r.name}（+${days} 天）`,
        // 幂等键带上原到期时间：同一期只续一次，即使 cron 重复触发
        dedupKey: `frp_rental:autorenew:${r.id}:${r.expires_at}`,
      })
      applied = deducted.applied
      balance = deducted.balance
    }

    if (!applied) {
      // 积分不够（或已处理过）→ 关掉开关，留下原因让用户看得见
      await env.DB.prepare(
        `UPDATE frp_subscriptions
            SET auto_renew = 0, last_error = ?, updated_at = ?
          WHERE id = ?`
      )
        .bind(`自动续费失败：积分不足（需要 ${price}，当前 ${balance}）`, nowIso, r.id)
        .run()
      out.insufficient++
      continue
    }

    // 从**原到期时间**往后推，而不是从现在推 ——
    // 否则 cron 延迟执行会把用户的时间"吃掉"几个小时。
    const base = Date.parse(r.expires_at)
    const from = Number.isFinite(base) ? base : nowMs
    const next = new Date(from + days * 86400000).toISOString()
    await env.DB.prepare(
      `UPDATE frp_subscriptions
          SET expires_at = ?, sync_state = 'pending', last_error = NULL, updated_at = ?
        WHERE id = ?`
    )
      .bind(next, nowIso, r.id)
      .run()

    // 面板账号的到期注释要跟着改，否则用户看到的是旧日期。
    // 同步由 agent 在 20 秒内完成（它读 sync_state='pending'）。
    out.renewed++
  }

  return out
}

export async function renewRental(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { id?: string; requestId?: string }
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少租约", "BAD_RENEW")

  // 必须限定 user_id：否则拿着别人的订阅 id 就能替别人续期（花自己的分，改别人的到期日）
  const sub = await env.DB.prepare(
    `SELECT * FROM frp_subscriptions WHERE id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<SubscriptionRow>()
  if (!sub) throw new ApiError(404, "租约不存在", "SUBSCRIPTION_NOT_FOUND")
  if (sub.status === "cancelled") {
    throw new ApiError(409, "该租约已被停用，请联系管理员", "SUBSCRIPTION_CANCELLED")
  }
  if (!sub.plan_id) {
    throw new ApiError(409, "该租约不是按套餐开通的，请联系管理员续期", "NO_PLAN")
  }

  const plan = await env.DB.prepare(`SELECT * FROM frp_plans WHERE id = ?`)
    .bind(sub.plan_id)
    .first<PlanRow>()
  if (!plan) throw new ApiError(409, "原套餐已删除，请联系管理员续期", "PLAN_GONE")

  const deducted = await applyPoints(env, {
    userId: user.id,
    delta: -plan.price_points,
    reason: "frp_rental",
    detail: `内网穿透续期 · ${plan.name}（+${plan.days} 天）`,
    dedupKey: body.requestId ? `frp_rental:renew:${body.requestId}` : null,
  })
  if (!deducted.applied) {
    if (deducted.reason === "duplicated") {
      throw new ApiError(409, "这次续期已经处理过了，请刷新页面查看", "DUPLICATE_REQUEST")
    }
    throw new ApiError(
      402,
      `积分不足：需要 ${plan.price_points}，你当前有 ${deducted.balance}`,
      "INSUFFICIENT_POINTS"
    )
  }

  // 与管理员续期**同一口径**：未过期从原到期日顺延，已过期从现在起算
  const base = Math.max(Date.now(), Date.parse(sub.expires_at) || 0)
  const nextExpiry = new Date(base + plan.days * DAY_MS).toISOString()

  await env.DB.prepare(
    `UPDATE frp_subscriptions
        SET expires_at = ?, status = 'active', sync_state = 'pending', updated_at = ?
      WHERE id = ?`
  )
    .bind(nextExpiry, nowIso(), id)
    .run()

  await audit(env, user.id, "frp.rental.renew", `${sub.frp_user} → ${nextExpiry} / -${plan.price_points}`)

  return json({
    ok: true,
    expiresAt: nextExpiry,
    balance: deducted.balance,
    pricePoints: plan.price_points,
  })
}
