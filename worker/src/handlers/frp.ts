/**
 * frp 内网穿透。
 *
 * 为什么不直连 frps-panel：实测 Cloudflare Worker **无法访问**该面板 ——
 *   裸 IP（http://1.2.3.4:7200）被 Cloudflare 出网策略拦截（1ms 返回 403 1003，
 *   请求根本没有离开边缘）；改走域名时，北京节点（阿里云大陆机房）返回
 *   "Non-compliance ICP Filing" 未备案拦截，香港节点返回 520。
 * 因此改为**人工审核**流程：用户提交申请 → 邮件通知管理员 →
 * 管理员在面板手工在 frps-panel 建号 → 回到本站批准/拒绝 → 邮件通知申请人。
 *
 * 本站负责：节点信息展示、端口分配与占用检测、申请单流转、config.toml 生成。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser, requireFeatureUser, type UserRow } from "../auth"
import { sendMail, renderMail } from "../mailer"
import { audit, getSetting, getSettings } from "../settings"
import type { Env } from "../env"

const MAX_TUNNELS = 20

interface FrpNodeRow {
  id: string
  name: string
  region: string | null
  server_addr: string
  server_port: number
  auth_token: string
  token_prefix: string
  port_min: number
  port_max: number
  max_ports: number
  enabled: number
  sort_order: number
  note: string | null
}

interface FrpApplicationRow {
  id: string
  user_id: string
  node_id: string
  frp_user: string
  frp_password: string
  ports: string
  tunnels: string
  notify_email: string
  remark: string | null
  status: string
  review_note: string | null
  reviewed_at: string | null
  metadatas_token: string | null
  created_at: string
}

/** 取某节点的 frps auth.token（仅用于给本人已通过的申请生成配置） */
function authTokenOf(nodes: FrpNodeRow[], nodeId: string): string | null {
  return nodes.find((n) => n.id === nodeId)?.auth_token ?? null
}

/** 对外暴露的节点信息：**不含** auth.token（那是 frps 服务端密钥） */
function toPublicNode(row: FrpNodeRow) {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    serverAddr: row.server_addr,
    serverPort: row.server_port,
    portMin: row.port_min,
    portMax: row.port_max,
    maxPorts: row.max_ports,
    enabled: row.enabled === 1,
    note: row.note,
  }
}

function parseJsonArray<T>(raw: string, fallback: T[]): T[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as T[]) : fallback
  } catch {
    return fallback
  }
}

interface Tunnel {
  name: string
  type: "tcp" | "udp"
  localIP: string
  localPort: number
  remotePort: number
}

/** 校验隧道定义 */
function validateTunnels(input: unknown): Tunnel[] {
  if (!Array.isArray(input)) return []
  if (input.length > MAX_TUNNELS) {
    throw new ApiError(400, `最多 ${MAX_TUNNELS} 条隧道`, "TOO_MANY_TUNNELS")
  }
  return input.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>
    const name = String(o.name ?? "").trim()
    if (!name || name.length > 64) {
      throw new ApiError(400, `第 ${i + 1} 条隧道名称无效`, "INVALID_TUNNEL")
    }
    const type = String(o.type ?? "tcp").toLowerCase()
    if (type !== "tcp" && type !== "udp") {
      throw new ApiError(400, `第 ${i + 1} 条隧道类型只能是 tcp 或 udp`, "INVALID_TUNNEL")
    }
    const localIP = String(o.localIP ?? "127.0.0.1").trim() || "127.0.0.1"
    const localPort = Math.trunc(Number(o.localPort))
    if (!Number.isFinite(localPort) || localPort < 1 || localPort > 65535) {
      throw new ApiError(400, `第 ${i + 1} 条隧道本地端口无效`, "INVALID_TUNNEL")
    }
    const remotePort = Math.trunc(Number(o.remotePort))
    if (!Number.isFinite(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new ApiError(400, `第 ${i + 1} 条隧道公网端口无效`, "INVALID_TUNNEL")
    }
    return { name, type: type as "tcp" | "udp", localIP, localPort, remotePort }
  })
}

/** 校验端口列表：数量、范围、重复 */
async function validatePorts(
  env: Env,
  node: FrpNodeRow,
  input: unknown
): Promise<number[]> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiError(400, "请至少选择一个端口", "INVALID_PORTS")
  }
  const ports = [...new Set(input.map((p) => Math.trunc(Number(p))))]
  if (ports.length > node.max_ports) {
    throw new ApiError(
      400,
      `每个账号最多选择 ${node.max_ports} 个端口`,
      "TOO_MANY_PORTS"
    )
  }
  for (const p of ports) {
    if (!Number.isFinite(p) || p < node.port_min || p > node.port_max) {
      throw new ApiError(
        400,
        `端口需在 ${node.port_min}-${node.port_max} 之间`,
        "PORT_OUT_OF_RANGE"
      )
    }
  }

  // 占用检测：已被他人占用的端口不可再选
  const placeholders = ports.map(() => "?").join(",")
  const taken = await env.DB.prepare(
    `SELECT remote_port FROM frp_ports
      WHERE node_id = ? AND remote_port IN (${placeholders})`
  )
    .bind(node.id, ...ports)
    .all<{ remote_port: number }>()

  const takenSet = new Set((taken.results ?? []).map((r) => r.remote_port))
  if (takenSet.size > 0) {
    throw new ApiError(
      409,
      `端口已被占用：${[...takenSet].join("、")}，请换一个`,
      "PORT_TAKEN"
    )
  }
  return ports
}

/**
 * 校验通知邮箱：只接受本站在册邮箱或已验证的真实邮箱。
 * 防止把申请结果发到任意地址（也是防止被当作发信跳板）。
 */
async function validateNotifyEmail(
  env: Env,
  user: UserRow,
  input: string
): Promise<string> {
  const email = input.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "通知邮箱格式不正确", "INVALID_EMAIL")
  }
  const rootDomain = env.ROOT_DOMAIN.toLowerCase()

  // 本站域名邮箱：必须是自己的（在 mailboxes 里且属于本人）
  if (email.endsWith(`@${rootDomain}`)) {
    const own = await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE AND user_id = ? LIMIT 1"
    )
      .bind(email, user.id)
      .first()
    if (!own) {
      throw new ApiError(400, "该邮箱不属于你", "INVALID_EMAIL")
    }
    return email
  }

  // 真实邮箱：必须是本人且已验证（未验证发不出去，Cloudflare 会拒）
  if (email !== user.email.toLowerCase() || user.email_verified !== 1) {
    throw new ApiError(
      400,
      "只能使用你的本站邮箱，或已在「设置」中验证过的真实邮箱",
      "INVALID_EMAIL"
    )
  }
  return email
}

// ---- 节点 ----

/** GET /api/frp —— 节点列表 + 我的申请 + 我的端口 + 配置项 */
export async function getFrpOverview(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "frp")
  const settings = await getSettings(env)

  const nodes = await env.DB.prepare(
    "SELECT * FROM frp_nodes WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC"
  ).all<FrpNodeRow>()

  const apps = await env.DB.prepare(
    `SELECT id, node_id, frp_user, ports, tunnels, notify_email, remark,
            status, review_note, reviewed_at, metadatas_token, created_at
       FROM frp_applications WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all<Record<string, unknown>>()

  const ports = await env.DB.prepare(
    "SELECT node_id, remote_port FROM frp_ports WHERE user_id = ?"
  )
    .bind(user.id)
    .all<{ node_id: string; remote_port: number }>()

  // 该用户在每个节点上已占用的端口（前端用于提示「已占用」）
  const myPorts: Record<string, number[]> = {}
  for (const p of ports.results ?? []) {
    ;(myPorts[p.node_id] ??= []).push(p.remote_port)
  }

  // 全部已占用端口（含他人的），供前端做实时占用提示
  const allPorts = await env.DB.prepare(
    "SELECT node_id, remote_port FROM frp_ports"
  ).all<{ node_id: string; remote_port: number }>()
  const takenPorts: Record<string, number[]> = {}
  for (const p of allPorts.results ?? []) {
    ;(takenPorts[p.node_id] ??= []).push(p.remote_port)
  }

  const activated = await isActivated(env, user.id)

  return json({
    featureEnabled: settings.frp_enabled === "1",
    /** 用户是否已手动启用（与网盘/中转站一致：启用后才显示功能界面） */
    activated,
    coreUrl: settings.frp_core_url,
    nodes: activated ? (nodes.results ?? []).map(toPublicNode) : [],
    applications: !activated ? [] : (apps.results ?? []).map((a) => ({
      id: a.id,
      nodeId: a.node_id,
      frpUser: a.frp_user,
      ports: parseJsonArray<number>(a.ports as string, []),
      tunnels: parseJsonArray<Tunnel>(a.tunnels as string, []),
      notifyEmail: a.notify_email,
      remark: a.remark,
      status: a.status,
      reviewNote: a.review_note,
      reviewedAt: a.reviewed_at,
      createdAt: a.created_at,
      // 生成 config.toml 需要的两项令牌：
      //   metadatas.token —— 该申请的令牌（审批时确定）
      //   auth.token      —— 节点的 frps 共享密钥（仅下发给本人的已通过申请）
      metadatasToken: a.metadatas_token,
      authToken: a.status === "approved" ? authTokenOf(nodes.results ?? [], String(a.node_id)) : null,
    })),
    myPorts,
    takenPorts,
    // 可用于接收结果通知的邮箱
    notifyOptions: activated ? await notifyOptions(env, user) : [],
  })
}

/** 该用户是否已启用内网穿透 */
async function isActivated(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT enabled FROM frp_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ enabled: number }>()
  return row?.enabled === 1
}

/**
 * POST /api/frp/enable —— 手动启用（与网盘开通、中转站开通一致）
 * 启用后才展示节点与申请入口。
 */
export async function enableFrp(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "frp")
  const settings = await getSettings(env)
  if (settings.frp_enabled !== "1") {
    throw new ApiError(403, "内网穿透功能已关闭", "FEATURE_DISABLED")
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_accounts (user_id, enabled, created_at, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`
  )
    .bind(user.id, now, now)
    .run()

  await audit(env, user.id, "frp.enable", "启用内网穿透")
  return json({ activated: true })
}

/** POST /api/frp/disable —— 关闭（保留已通过申请的端口占用） */
export async function disableFrp(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "frp")
  await env.DB.prepare(
    "UPDATE frp_accounts SET enabled = 0, updated_at = ? WHERE user_id = ?"
  )
    .bind(new Date().toISOString(), user.id)
    .run()
  await audit(env, user.id, "frp.disable", "关闭内网穿透")
  return json({ activated: false })
}

/** 该用户可选的「结果通知邮箱」列表 */
async function notifyOptions(
  env: Env,
  user: UserRow
): Promise<{ email: string; kind: "site" | "real" }[]> {
  const rows = await env.DB.prepare(
    "SELECT address FROM mailboxes WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all<{ address: string }>()
  const options: { email: string; kind: "site" | "real" }[] = (
    rows.results ?? []
  ).map((r) => ({
    email: r.address,
    kind: "site" as const,
  }))
  if (user.email_verified === 1) {
    options.push({ email: user.email, kind: "real" as const })
  }
  return options
}

// ---- 申请 ----

/** POST /api/frp/apply —— 提交申请（进入人工审核） */
export async function applyFrp(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "frp")
  const settings = await getSettings(env)
  if (settings.frp_enabled !== "1") {
    throw new ApiError(403, "内网穿透功能已关闭", "FEATURE_DISABLED")
  }

  if (!(await isActivated(env, user.id))) {
    throw new ApiError(400, "请先启用内网穿透功能", "NOT_ACTIVATED")
  }

  const body = (await request.json()) as {
    nodeId?: string
    frpUser?: string
    frpPassword?: string
    ports?: unknown
    tunnels?: unknown
    notifyEmail?: string
    remark?: string
  }

  const node = await env.DB.prepare(
    "SELECT * FROM frp_nodes WHERE id = ? AND enabled = 1"
  )
    .bind(body.nodeId ?? "")
    .first<FrpNodeRow>()
  if (!node) throw new ApiError(404, "节点不存在或已停用", "NOT_FOUND")

  // frp 账号名：默认用本站用户名，允许自定义但需合法
  const frpUser = (body.frpUser ?? user.username).trim()
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(frpUser)) {
    throw new ApiError(
      400,
      "账号名只能包含字母、数字、下划线和连字符（2-32 位）",
      "INVALID_FRP_USER"
    )
  }

  const frpPassword = body.frpPassword ?? ""
  if (frpPassword.length < 6 || frpPassword.length > 64) {
    throw new ApiError(400, "密码长度需在 6-64 位之间", "WEAK_PASSWORD")
  }

  // 同一节点不允许有未处理的重复申请
  const pending = await env.DB.prepare(
    "SELECT id FROM frp_applications WHERE user_id = ? AND node_id = ? AND status = 'pending' LIMIT 1"
  )
    .bind(user.id, node.id)
    .first()
  if (pending) {
    throw new ApiError(409, "你在该节点已有待审核的申请，请等待处理", "ALREADY_PENDING")
  }

  const ports = await validatePorts(env, node, body.ports)
  const tunnels = validateTunnels(body.tunnels)
  const notifyEmail = await validateNotifyEmail(
    env,
    user,
    body.notifyEmail ?? user.email
  )

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_applications
       (id, user_id, node_id, frp_user, frp_password, ports, tunnels,
        notify_email, remark, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      user.id,
      node.id,
      frpUser,
      frpPassword,
      JSON.stringify(ports),
      JSON.stringify(tunnels),
      notifyEmail,
      (body.remark ?? "").trim().slice(0, 500) || null,
      now
    )
    .run()

  await audit(
    env,
    user.id,
    "frp.apply",
    `申请 ${node.name} 节点，账号 ${frpUser}，端口 ${ports.join(",")}`
  )

  // 邮件通知管理员（失败不阻断申请）
  await notifyAdmin(env, {
    username: user.username,
    nodeName: node.name,
    frpUser,
    ports,
    tunnels,
    notifyEmail,
    remark: body.remark ?? "",
  })

  return json({ application: { id, status: "pending", createdAt: now } }, 201)
}

/** 给管理员发「有新申请」通知 */
async function notifyAdmin(
  env: Env,
  info: {
    username: string
    nodeName: string
    frpUser: string
    ports: number[]
    tunnels: Tunnel[]
    notifyEmail: string
    remark: string
  }
): Promise<void> {
  const to = (await getSetting(env, "frp_admin_notify_email")).trim()
  if (!to) {
    console.warn("未配置 frp_admin_notify_email，跳过管理员通知")
    return
  }
  try {
    const { text, html } = renderMail("新的内网穿透申请", [
      `用户：${info.username}`,
      `节点：${info.nodeName}`,
      `账号：${info.frpUser}`,
      `端口：${info.ports.join("、")}`,
      `隧道：${info.tunnels.length} 条`,
      `结果通知邮箱：${info.notifyEmail}`,
      info.remark ? `备注：${info.remark}` : "",
      "请到管理面板 → 内网穿透 处理该申请。",
    ].filter(Boolean))
    await sendMail(env, { to, subject: "【Doulor Cloud】新的内网穿透申请", text, html })
  } catch (err) {
    console.error("管理员通知邮件发送失败:", err)
  }
}

/** POST /api/frp/cancel —— 撤回自己的待审申请 */
export async function cancelFrp(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "frp")
  const body = (await request.json()) as { id?: string }

  const app = await env.DB.prepare(
    "SELECT * FROM frp_applications WHERE id = ? AND user_id = ?"
  )
    .bind(body.id ?? "", user.id)
    .first<FrpApplicationRow>()
  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")
  if (app.status !== "pending") {
    throw new ApiError(400, "只能撤回待审核的申请", "INVALID_STATE")
  }

  await env.DB.prepare("DELETE FROM frp_applications WHERE id = ?").bind(app.id).run()
  await audit(env, user.id, "frp.cancel", `撤回申请 ${app.id}`)
  return new Response(null, { status: 204 })
}

// ---- 管理端：审核 ----

/** GET /api/admin/frp/applications —— 申请列表 */
export async function listFrpApplications(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  const url = new URL(request.url)
  const status = url.searchParams.get("status") ?? "pending"

  const rows = await env.DB.prepare(
    `SELECT a.*, u.username AS site_username, n.name AS node_name
       FROM frp_applications a
       JOIN users u ON a.user_id = u.id
       JOIN frp_nodes n ON a.node_id = n.id
      WHERE (? = 'all' OR a.status = ?)
      ORDER BY a.created_at DESC
      LIMIT 200`
  )
    .bind(status, status)
    .all<Record<string, unknown>>()

  return json({
    applications: (rows.results ?? []).map((a) => ({
      id: a.id,
      siteUsername: a.site_username,
      nodeId: a.node_id,
      nodeName: a.node_name,
      frpUser: a.frp_user,
      frpPassword: a.frp_password,
      ports: parseJsonArray<number>(a.ports as string, []),
      tunnels: parseJsonArray<Tunnel>(a.tunnels as string, []),
      notifyEmail: a.notify_email,
      remark: a.remark,
      status: a.status,
      reviewNote: a.review_note,
      reviewedAt: a.reviewed_at,
      metadatasToken: a.metadatas_token,
      createdAt: a.created_at,
    })),
  })
}

/**
 * POST /api/admin/frp/review —— 批准或拒绝。
 *
 * 批准时记录端口占用（防止后续申请重复选到同一端口）。
 * 无论批准或拒绝，都会给申请人填写的通知邮箱发邮件。
 */
export async function reviewFrpApplication(
  env: Env,
  request: Request
): Promise<Response> {
  const admin = await requireAdminUser(env, request)
  const body = (await request.json()) as {
    id?: string
    action?: "approve" | "reject"
    note?: string
    /** 与该用户在 frps-panel 里创建的 token 保持一致；留空则自动生成 */
    metadatasToken?: string
  }

  const app = await env.DB.prepare(
    `SELECT a.*, u.username AS site_username, u.id AS uid, n.name AS node_name
       FROM frp_applications a
       JOIN users u ON a.user_id = u.id
       JOIN frp_nodes n ON a.node_id = n.id
      WHERE a.id = ?`
  )
    .bind(body.id ?? "")
    .first<FrpApplicationRow & { site_username: string; node_name: string }>()
  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")
  if (app.status !== "pending") {
    throw new ApiError(409, "该申请已被处理", "ALREADY_REVIEWED")
  }

  const approve = body.action === "approve"
  const note = (body.note ?? "").trim().slice(0, 500) || null
  const now = new Date().toISOString()
  const ports = parseJsonArray<number>(app.ports, [])

  if (approve) {
    // 再次校验端口是否已被占用（申请提交后可能被别的申请用掉）
    const placeholders = ports.map(() => "?").join(",")
    const taken = await env.DB.prepare(
      `SELECT remote_port FROM frp_ports
        WHERE node_id = ? AND remote_port IN (${placeholders})`
    )
      .bind(app.node_id, ...ports)
      .all<{ remote_port: number }>()
    const takenSet = (taken.results ?? []).map((r) => r.remote_port)
    if (takenSet.length > 0) {
      throw new ApiError(
        409,
        `端口已被占用，无法批准：${takenSet.join("、")}。请拒绝并让用户重新选择`,
        "PORT_TAKEN"
      )
    }

    // metadatas.token：优先用管理员填写的值（需与 frps-panel 里一致），
    // 留空则按「节点前缀 + 序号」自动生成
    let metadatasToken = (body.metadatasToken ?? "").trim()
    if (!metadatasToken) {
      const node = await env.DB.prepare(
        "SELECT token_prefix FROM frp_nodes WHERE id = ?"
      )
        .bind(app.node_id)
        .first<{ token_prefix: string }>()
      const seq = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM frp_applications WHERE node_id = ? AND status = 'approved'"
      )
        .bind(app.node_id)
        .first<{ c: number }>()
      metadatasToken = `${node?.token_prefix ?? ""}${(seq?.c ?? 0) + 1}`
    }

    await env.DB.batch([
      ...ports.map((p) =>
        env.DB.prepare(
          `INSERT INTO frp_ports (id, node_id, user_id, application_id, remote_port, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(uuid(), app.node_id, app.user_id, app.id, p, now)
      ),
      env.DB.prepare(
        `UPDATE frp_applications
            SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?,
                metadatas_token = ?
          WHERE id = ?`
      ).bind(note, admin.id, now, metadatasToken, app.id),
    ])
  } else {
    await env.DB.prepare(
      `UPDATE frp_applications
          SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?
        WHERE id = ?`
    )
      .bind(note, admin.id, now, app.id)
      .run()
  }

  await audit(
    env,
    admin.id,
    approve ? "frp.approve" : "frp.reject",
    `${app.site_username} 的申请（${app.node_name}）`
  )

  // 结果通知申请人（失败不阻断审核结果落库）
  const fresh = await env.DB.prepare(
    "SELECT metadatas_token FROM frp_applications WHERE id = ?"
  )
    .bind(app.id)
    .first<{ metadatas_token: string | null }>()
  await notifyApplicant(
    env,
    { ...app, metadatas_token: fresh?.metadatas_token ?? null },
    approve,
    note,
    ports
  )

  return json({ ok: true, status: approve ? "approved" : "rejected" })
}

/** 给申请人发结果邮件 */
async function notifyApplicant(
  env: Env,
  app: FrpApplicationRow & { site_username: string; node_name: string },
  approved: boolean,
  note: string | null,
  ports: number[]
): Promise<void> {
  const tunnels = parseJsonArray<Tunnel>(app.tunnels, [])
  const lines = approved
    ? [
        `节点：${app.node_name}`,
        `账号：${app.frp_user}`,
        `密码：${app.frp_password}`,
        `可用端口：${ports.join("、")}`,
        `metadatas.token：${app.metadatas_token ?? "（未设置）"}`,
        `隧道：${tunnels.map((t) => `${t.name}(${t.type} ${t.remotePort}→${t.localPort})`).join("、") || "无"}`,
        note ? `管理员备注：${note}` : "",
        "请到 Doulor Cloud 的内网穿透页面生成 config.toml，并替换到 frp 核心目录后启动。",
      ]
    : [
        `节点：${app.node_name}`,
        `账号：${app.frp_user}`,
        "很抱歉，你的申请未通过审核。",
        note ? `原因：${note}` : "",
        "如有疑问可联系管理员，或修改后重新提交申请。",
      ]

  try {
    const { text, html } = renderMail(
      approved ? "内网穿透申请已通过" : "内网穿透申请未通过",
      lines.filter(Boolean)
    )
    await sendMail(env, {
      to: app.notify_email,
      subject: approved
        ? "【Doulor Cloud】内网穿透申请已通过"
        : "【Doulor Cloud】内网穿透申请未通过",
      text,
      html,
    })
  } catch (err) {
    console.error("申请结果邮件发送失败:", app.notify_email, err)
  }
}

/** 管理员校验（与 handlers/admin.ts 同口径） */
async function requireAdminUser(env: Env, request: Request): Promise<UserRow> {
  const user = await requireUser(env, request)
  if (user.role !== "admin") {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  return user
}

// ---- 节点管理（管理端） ----

/** POST /api/admin/frp/nodes —— 新建/更新节点 */
export async function upsertFrpNode(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request)
  const body = (await request.json()) as {
    id?: string
    name?: string
    region?: string
    serverAddr?: string
    serverPort?: number
    authToken?: string
    tokenPrefix?: string
    portMin?: number
    portMax?: number
    maxPorts?: number
    enabled?: boolean
    sortOrder?: number
    note?: string
  }

  const name = (body.name ?? "").trim()
  const serverAddr = (body.serverAddr ?? "").trim()
  if (!name) throw new ApiError(400, "请填写节点名称", "INVALID_INPUT")
  if (!serverAddr) throw new ApiError(400, "请填写 serverAddr", "INVALID_INPUT")

  const portMin = Math.trunc(Number(body.portMin ?? 20000))
  const portMax = Math.trunc(Number(body.portMax ?? 50000))
  if (portMin < 1 || portMax > 65535 || portMin >= portMax) {
    throw new ApiError(400, "端口范围无效", "INVALID_INPUT")
  }
  const maxPorts = Math.min(Math.max(Math.trunc(Number(body.maxPorts ?? 5)), 1), 50)
  const serverPort = Math.trunc(Number(body.serverPort ?? 7000))
  const now = new Date().toISOString()

  const values = {
    name,
    region: (body.region ?? "").trim() || null,
    serverAddr,
    serverPort,
    authToken: (body.authToken ?? "").trim(),
    tokenPrefix: (body.tokenPrefix ?? "").trim(),
    portMin,
    portMax,
    maxPorts,
    enabled: body.enabled === false ? 0 : 1,
    sortOrder: Math.trunc(Number(body.sortOrder ?? 0)),
    note: (body.note ?? "").trim() || null,
  }

  if (body.id) {
    await env.DB.prepare(
      `UPDATE frp_nodes SET name=?, region=?, server_addr=?, server_port=?,
              auth_token=?, token_prefix=?, port_min=?, port_max=?, max_ports=?,
              enabled=?, sort_order=?, note=?, updated_at=?
        WHERE id=?`
    )
      .bind(
        values.name, values.region, values.serverAddr, values.serverPort,
        values.authToken, values.tokenPrefix, values.portMin, values.portMax,
        values.maxPorts, values.enabled, values.sortOrder, values.note, now,
        body.id
      )
      .run()
    return json({ id: body.id })
  }

  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, region, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, values.name, values.region, values.serverAddr, values.serverPort,
      values.authToken, values.tokenPrefix, values.portMin, values.portMax,
      values.maxPorts, values.enabled, values.sortOrder, values.note, now, now
    )
    .run()

  return json({ id }, 201)
}

/** GET /api/admin/frp/nodes —— 节点列表（含 auth.token，仅管理员可见） */
export async function listFrpNodes(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM frp_nodes ORDER BY sort_order ASC, created_at ASC"
  ).all<FrpNodeRow>()
  const counts = await env.DB.prepare(
    "SELECT node_id, COUNT(*) AS c FROM frp_ports GROUP BY node_id"
  ).all<{ node_id: string; c: number }>()
  const usedMap: Record<string, number> = {}
  for (const r of counts.results ?? []) usedMap[r.node_id] = r.c

  return json({
    nodes: (rows.results ?? []).map((n) => ({
      ...toPublicNode(n),
      authToken: n.auth_token,
      tokenPrefix: n.token_prefix,
      usedPorts: usedMap[n.id] ?? 0,
    })),
  })
}

/** DELETE /api/admin/frp/nodes/:id */
export async function deleteFrpNode(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdminUser(env, request)
  const existing = await env.DB.prepare("SELECT id FROM frp_nodes WHERE id = ?")
    .bind(id)
    .first()
  if (!existing) throw new ApiError(404, "节点不存在", "NOT_FOUND")
  await env.DB.prepare("DELETE FROM frp_nodes WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}

/** POST /api/admin/frp/ports/release —— 释放某用户在某节点的端口 */
export async function releaseFrpPorts(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  const body = (await request.json()) as { username?: string; nodeId?: string }
  const target = await env.DB.prepare(
    "SELECT id FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(body.username ?? "")
    .first<{ id: string }>()
  if (!target) throw new ApiError(404, "用户不存在", "NOT_FOUND")

  const res = await env.DB.prepare(
    "DELETE FROM frp_ports WHERE user_id = ? AND node_id = ?"
  )
    .bind(target.id, body.nodeId ?? "")
    .run()

  return json({ released: res.meta.changes ?? 0 })
}