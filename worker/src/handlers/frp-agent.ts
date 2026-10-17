/**
 * frp-agent 通道：服务器侧的 agent 从这里拉「期望状态」，再把「实际状态」回报上来。
 *
 * 为什么需要这个反向通道（2026-10-13 实测确认，别再想着直连面板）：
 *   Cloudflare Worker **到不了** frps 服务器上的 frps-panel —— 裸 IP
 *   （`http://1.2.3.4:7200`）被 Cloudflare 出网策略拦截（1ms 返回 403，请求根本没有
 *   离开边缘）；改走域名时北京节点返回「Non-compliance ICP Filing」未备案拦截，
 *   香港节点 520。所以方向必须反过来：**服务器主动出网来拉**。
 *
 * 分工：
 *   · D1 是唯一真值 —— 谁可以用、用到什么时候、占哪些端口都在这边决定
 *   · agent 只负责把期望状态投影到面板，并把实际结果回报
 *   · 面板（frps-panel）退化成纯鉴权插件，不再需要人工登网页操作
 *
 * ⚠️ 安全边界：这两个端点**不使用会话鉴权**（调用方是服务器上的守护进程，没有 cookie），
 * 改用共享密钥 + HMAC-SHA256 签名 + 时间戳窗口。签名覆盖「时间戳 / 方法 / 路径+查询串 /
 * 请求体摘要」，因此：
 *   · 重放被时间戳窗口挡住
 *   · 路径与查询串不可替换（不能把 /desired 的签名挪到别的路径）
 *   · 请求体不可篡改
 *   · 节点身份不可混淆（2026-10-15 补，渗透报告 #28）：签名用哪把节点密钥验过，
 *     就只能操作那个节点 —— 见 requireAgent() / assertSameNode()。
 * 未配置 `FRP_AGENT_SECRET` 时整个通道 503 关闭，不会退化成公开接口。
 */
import { ApiError, json } from "../http"
import { timingSafeEqual } from "../crypto"
import type { Env } from "../env"

/**
 * 本站创建的账号统一前缀。
 *
 * 🔴 **这个常量必须与服务器上 agent 的 `USER_PREFIX` 完全一致。**
 * 面板里存在 46 个管理员人工建的历史账号，agent 靠这个前缀区分
 * 「本站创建的账号」与「别人的账号」，从而保证 prune 时**绝不会误删他人账号**。
 * 实测这 46 个账号里没有任何一个以 `dcfrp_` 开头。
 */
const FRP_USER_PREFIXES = ["DC_"]
/** 下发给 agent 的边界说明（逗号分隔），agent 会按它过滤要管的账号 */
const FRP_USER_PREFIX = FRP_USER_PREFIXES.join(",")

/** 允许的签名时间偏差（秒）。服务器时间与 Cloudflare 通常只差毫秒级，300s 已经很宽松。 */
const AGENT_TS_TOLERANCE_SEC = 300

interface NodeRow {
  id: string
  name: string
  server_addr: string
  server_port: number
  auth_mode: string | null
  enabled: number
}

interface SubscriptionRow {
  id: string
  user_id: string
  node_id: string
  frp_user: string
  frp_token: string
  ports: string
  status: string
  expires_at: string
  /** 归属用户的账号状态（`users.status`）。LEFT JOIN 不到用户行时为 null */
  user_status: string | null
}

/**
 * 平台里「用户可正常使用」的**唯一**合法值就是 `'active'`（依据见下）。
 *
 * 🔴 2026-10-15 修：以前这里算「期望状态」只看 `frp_subscriptions.status` 与
 * `expires_at`，**完全没看 `users.status`** —— 站长把 `wei` 改成 `suspended` 之后，
 * 他的 frp 隧道照旧在跑（报障时的线上状态：users.status='suspended'，那条订阅
 * 还是 active 且未到期；复查时该行已被人手工改成 status='disabled'，但那只是
 * 临时处置，机制上的漏洞不变）。真实访问控制在 frps + 面板那一层，D1 的期望状态
 * 同步是**唯一**的传导机制，所以判定必须落在这里。
 *
 * 为什么**不**改成「在封禁接口里顺手把 frp_subscriptions 也停掉」：
 *   那只是堵住一个入口。之后管理员手动改 `frp_subscriptions.status`、用户续期
 *   （`renewRental` 会把 status 写回 active）、或任何新写的代码路径，都会把隧道
 *   重新激活；而「禁用用户」这个动作与「面板该不该放行」之间就又多了一条需要
 *   维护的隐式约定。只要判定在**算期望状态时**成立，上面所有路径都自动正确，
 *   用户被解封后也会在下一个同步周期自动恢复（自愈，不需要管理员再操作一次）。
 *
 * 判定口径的依据（全部已核实）：
 *   · `worker/schema.sql:13` —— `status TEXT NOT NULL DEFAULT 'active'  -- active | suspended`
 *   · `handlers/admin.ts:972` —— 管理端只接受 `["active","suspended"]` 两个值
 *   · `auth.ts:250` 的 `requireUser` —— `if (valid.status !== "active") throw 401`，
 *     全站「正常用户」的判定就是 `=== 'active'`
 *   · 线上 D1 实测（2026-10-15）：
 *     `SELECT status, COUNT(*) AS n FROM users GROUP BY status`
 *     → 只有 `active`(1332) 与 `suspended`(126)，**没有** banned/disabled/deleted
 * 所以这里写成「必须等于 active」而不是「排除某几个值」：将来真加了新状态，
 * 默认是**停用**（fail-closed），不会因为漏写一个值就漏放行。
 */
function isActiveUser(userStatus: string | null | undefined): boolean {
  return userStatus === "active"
}

/**
 * 这条租约现在该不该对面板 `enable=true`。
 *
 * ⚠️ 捐献节点的推送口径（`handlers/frp-node-push.ts` 的 `pushNodeState`）是这份逻辑的
 * **孪生实现**，两边必须完全一致：一个走拉、一个走推，任何一边漏了用户状态，
 * 那条路径上的被禁用户就还能连。改这里记得同步改那边。
 */
function isSubscriptionLive(row: SubscriptionRow, now: number): boolean {
  const expiresAt = Date.parse(row.expires_at)
  return (
    isActiveUser(row.user_status) &&
    (row.status === "active" || row.status === "pending") &&
    Number.isFinite(expiresAt) &&
    expiresAt > now
  )
}

export interface DesiredUser {
  user: string
  token: string
  comment: string
  enable: boolean
  ports: number[]
}

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input))
  return toHex(new Uint8Array(digest))
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return toHex(new Uint8Array(sig))
}

/**
 * agent 鉴权的结论。
 *
 * `claimedNode` 是**签名实际绑定**的那一个节点标识，而且只有用「节点专属 agent_key」
 * 验过签名时才有值：
 *   · 用节点专属密钥通过 → claimedNode = 该节点 id，调用方必须保证「验的」与「写的是」
 *     同一个节点（2026-10-15，渗透报告 #28：修复前两步用的标识可以不一样 ——
 *     拿 A 的密钥签 nodeId=A 过验签，却用 node=B 落库，等于跨节点签名混淆）。
 *   · 用全局 FRP_AGENT_SECRET 通过 → claimedNode = null。全局密钥是**我们自己那台
 *     服务器**的身份（它管着 node-bj，且没有"某一个节点"的概念），它本来就能跨节点，
 *     所以对它跳过相等校验 —— 这样已部署的自己人也完全不受影响。
 */
interface AgentAuth {
  claimedNode: string | null
}

/**
 * 校验 agent 签名，并返回「这次签名到底绑定到了哪个节点」。
 *
 * @param rawBody 请求体原文（GET 传空串）。**调用方必须先把它读出来**——
 *   读流是一次性的，这里再读就永远为空，签名会永远对不上。
 */
async function requireAgent(env: Env, request: Request, rawBody: string): Promise<AgentAuth> {
  const secret = env.FRP_AGENT_SECRET
  if (!secret) {
    throw new ApiError(
      503,
      "frp agent 通道未启用（未配置 FRP_AGENT_SECRET）",
      "FRP_AGENT_DISABLED"
    )
  }

  const ts = request.headers.get("X-Frp-Agent-Ts") ?? ""
  const sig = (request.headers.get("X-Frp-Agent-Signature") ?? "").toLowerCase()
  if (!ts || !sig) {
    throw new ApiError(401, "缺少 agent 签名头", "FRP_AGENT_UNAUTHORIZED")
  }

  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) {
    throw new ApiError(401, "agent 时间戳格式不正确", "FRP_AGENT_UNAUTHORIZED")
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - tsNum) > AGENT_TS_TOLERANCE_SEC) {
    throw new ApiError(
      401,
      `agent 时间戳超出 ±${AGENT_TS_TOLERANCE_SEC}s 容忍范围（差 ${
        nowSec - tsNum
      }s），请检查服务器时间`,
      "FRP_AGENT_CLOCK_SKEW"
    )
  }

  const url = new URL(request.url)
  // 查询串也要签：否则拿到 /desired?node=A 的签名后可以把 node 换成 B
  const canonical = [
    ts,
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    await sha256Hex(rawBody),
  ].join("\n")

  // 候选密钥：
  //   1. 全局 FRP_AGENT_SECRET —— **只给我自己那台服务器**用（它管着 node-bj）。
  //   2. 该节点的专属 agent_key —— 给**捐献节点**用。
  //
  // 🔴 为什么要分开：这个密钥要交给捐献者（脚本靠它拉期望状态）。如果所有捐献者
  //    共用全局密钥，任何一个人都能把 `?node=` 换成别人的节点，拉到**其他用户的
  //    frp 令牌**（那是面板账号的密码）。每节点一把密钥，泄露的半径就限于他自己那台。
  //
  // 候选按「密钥 → 它代表的节点」成对存：验签通过时要能说清是哪一把钥匙过的，
  // 否则后端无法判断「这次请求被允许以哪个节点的身份行事」（报告 #28）。
  //
  // 关于要不要把节点标识绑进签名串（报告 #28 第 3 条）—— **不需要，也不该改**：
  //   节点标识本来就在签名覆盖范围内：/desired 的 `?node=` 落在 canonical 的
  //   `pathname+search` 段，/report 的 `nodeId` / `node` 落在 body 里，而 body 以
  //   sha256 摘要的形式进 canonical。所以签名本身早就把标识绑住了，漏的是**验签
  //   与落库各取一个来源**。真正要修的只有下面的相等校验。
  //   改签名串（例如把节点 id 追加成第 5 段）会让所有**已部署**的 agent 立刻 401 ——
  //   它们跑在用户机器上、按旧口径签名，我们没法保证它们能同步升级。这是红线。
  const candidates: { secret: string | null | undefined; node: string | null }[] = [
    { secret, node: null },
  ]
  // 节点标识两种来源都要认：
  //   · /desired 是 GET，节点在 query（?node=xxx）
  //   · /report 是 POST，节点在 **body**（{"nodeId": "xxx"}）
  // 只看 query 的话，report 永远匹配不到节点密钥，会一直 401 ——
  // 表现为「账号能同步过去，但管理端的同步状态永远停在待同步」。
  let claimedNode = url.searchParams.get("node")
  if (!claimedNode && rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as { nodeId?: unknown; node?: unknown }
      const fromBody = parsed.nodeId ?? parsed.node
      if (typeof fromBody === "string") claimedNode = fromBody
    } catch {
      /* body 不是 JSON 就当没有节点标识，回落到全局密钥 */
    }
  }
  if (claimedNode) {
    const row = await env.DB.prepare(`SELECT agent_key FROM frp_nodes WHERE id = ? LIMIT 1`)
      .bind(claimedNode)
      .first<{ agent_key: string | null }>()
    if (row?.agent_key) candidates.push({ secret: row.agent_key, node: claimedNode })
  }

  for (const candidate of candidates) {
    if (!candidate.secret) continue
    const expected = await hmacSha256Hex(candidate.secret, canonical)
    if (timingSafeEqual(expected, sig)) {
      // 用哪把钥匙过的验签，就返回哪把钥匙代表的节点（全局钥匙 → null）
      return { claimedNode: candidate.node }
    }
  }
  throw new ApiError(401, "agent 签名不匹配", "FRP_AGENT_UNAUTHORIZED")
}

/**
 * 断言「验签用的节点」与「这次要读/写的节点」是同一个。
 *
 * 报告 #28（MEDIUM）就是这一步缺失：持 A 节点密钥的人可以声明 nodeId=A 过验签，
 * 却用 node=B 让写入落到 B 上。global 密钥（claimedNode=null）不参与该约束 —— 见
 * AgentAuth 的说明。
 */
function assertSameNode(auth: AgentAuth, nodeId: string): void {
  if (auth.claimedNode && auth.claimedNode !== nodeId) {
    throw new ApiError(
      403,
      `签名绑定的节点（${auth.claimedNode}）与请求的节点（${nodeId}）不一致：不允许用某个节点的密钥操作另一个节点`,
      "FRP_AGENT_NODE_MISMATCH"
    )
  }
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

/**
 * 解析 agent 请求的节点。
 *
 * 显式传 `?node=<id>` 时用它；否则回落到「第一个启用了的、且需要每用户账号的节点」——
 * 这样单节点部署的 agent 不必带参数。
 */
async function resolveNode(env: Env, requested: string): Promise<NodeRow> {
  if (requested) {
    const row = await env.DB.prepare(
      `SELECT id, name, server_addr, server_port, auth_mode, enabled
         FROM frp_nodes WHERE id = ? LIMIT 1`
    )
      .bind(requested)
      .first<NodeRow>()
    if (!row) {
      throw new ApiError(404, `节点不存在：${requested}`, "FRP_NODE_NOT_FOUND")
    }
    return row
  }

  const row = await env.DB.prepare(
    `SELECT id, name, server_addr, server_port, auth_mode, enabled
       FROM frp_nodes
      WHERE enabled = 1 AND auth_mode IN ('token_user','custom')
      ORDER BY sort_order ASC LIMIT 1`
  ).first<NodeRow>()
  if (!row) {
    throw new ApiError(
      404,
      "没有可用于租用的节点（需要一个启用的、带每用户账号鉴权的节点）",
      "FRP_NODE_NOT_FOUND"
    )
  }
  return row
}

/**
 * `GET /frp/agent/desired` —— 拉期望状态。
 *
 * 返回**全部**本站管理的账号（包含已过期/已取消的，`enable=false`），而不是只返回有效的。
 * 原因：agent 需要知道「哪些账号是自己的」，才能在不误伤历史账号的前提下把它们停用。
 * 真正要删除一个账号时，是管理员在管理端删掉 `frp_subscriptions` 行，
 * agent 下一次收到 `prune=true` 且列表里没有它，才会从面板移除。
 */
export async function getFrpAgentDesired(env: Env, request: Request): Promise<Response> {
  const auth = await requireAgent(env, request, "")

  const url = new URL(request.url)
  // 目标节点：优先用显式 `?node=`，退了就用「签名实际绑定的那个节点」。
  // 后者是给「签名里带节点、但没写 query」的调用方兜底，保证「验的」和「读的」同源。
  const node = await resolveNode(env, url.searchParams.get("node") ?? auth.claimedNode ?? "")
  // 报告 #28：验签用的节点必须就是这次要读的节点（否则拿 A 的密钥能读 B 的账号表）
  assertSameNode(auth, node.id)

  // ⚠️ 必须带 `users.status`（2026-10-15，见 isActiveUser 的注释）：
  //   查询里以前只有 frp_subscriptions 一张表，被禁用户的期望状态就永远是"放行"。
  // 用 LEFT JOIN 而不是 INNER JOIN：用户行万一缺失（历史脏数据/删号残留），
  // 租约仍要出现在下发列表里 → `enable=false`（停用），而不是从列表里消失
  // （消失会让 agent 认为「这个账号不归我们管了」，反而与 prune 的语义打架）。
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.node_id, s.frp_user, s.frp_token, s.ports, s.status, s.expires_at,
            u.status AS user_status
       FROM frp_subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.node_id = ?
      ORDER BY s.frp_user ASC`
  )
    .bind(node.id)
    .all<SubscriptionRow>()

  const rows = results ?? []
  const now = Date.now()

  const users: DesiredUser[] = rows.map((row) => {
    const expiresAt = Date.parse(row.expires_at)
    // 只有「用户正常 + 订阅 active/pending + 未到期」才允许连接。
    // pending（刚下单、等待首次同步）先放行，否则用户付款后要等两轮同步才能连上；
    // 真正的拦截在过期判断与用户状态判断上。
    const live = isSubscriptionLive(row, now)

    const expDate = Number.isFinite(expiresAt)
      ? new Date(expiresAt).toISOString().slice(0, 10)
      : "unknown"

    // 面板的 comment 是给人看的（管理员过去就是在这里手写到期日），
    // 所以这里也写成可读文本，便于以后直接看面板时一眼认出来。
    // 用户被停用时要**明确写出原因** —— 否则面板上只会看到一条"到期 2026-11-15
    // 却连不上"的账号，没人知道是账号被封了（这正是这次 bug 的现场）。
    const comment = isActiveUser(row.user_status)
      ? `DoulorCloud | ${row.status} | 到期 ${expDate}`
      : `DoulorCloud | 用户${row.user_status ?? "缺失"}（已停用） | 到期 ${expDate}`

    return {
      user: row.frp_user,
      token: row.frp_token,
      comment,
      enable: live,
      ports: parsePorts(row.ports),
    }
  })

  // 给 agent 一个内容指纹，让它能跳过没有变化的轮次（少打日志、少调面板接口）。
  const revision = (await sha256Hex(JSON.stringify(users))).slice(0, 16)

  return json({
    ok: true,
    revision,
    serverTime: new Date().toISOString(),
    /** agent 用这个前缀识别「本站创建的账号」，必须与代码里的常量一致 */
    userPrefix: FRP_USER_PREFIX,
    /** 是否清理「面板里有、但这张列表里没有」的本站账号 */
    prune: true,
    node: {
      id: node.id,
      name: node.name,
      serverAddr: node.server_addr,
      serverPort: node.server_port,
      authMode: node.auth_mode ?? "token",
    },
    users,
  })
}

interface AgentReportUser {
  user?: unknown
  enable?: unknown
  present?: unknown
  ports?: unknown
  error?: unknown
}

/**
 * `POST /frp/agent/report` —— 回报实际落地结果。
 *
 * 每行更新 `sync_state` / `synced_at` / `last_error`，管理端据此显示
 * 「D1 期望」vs「面板实际」是否一致 —— 这是替代「人工去面板肉眼比对」的关键观测点。
 */
export async function reportFrpAgentState(env: Env, request: Request): Promise<Response> {
  const raw = await request.text()
  const auth = await requireAgent(env, request, raw)

  let body: {
    node?: string
    revision?: string
    users?: AgentReportUser[]
    serverInfo?: Record<string, unknown>
    error?: string
  }
  try {
    body = JSON.parse(raw || "{}") as typeof body
  } catch {
    throw new ApiError(400, "报告体不是合法 JSON", "FRP_AGENT_BAD_REPORT")
  }

  // 目标节点：**优先认 body.node**（这是本接口的历史口径，已部署 agent 就是这么发的），
  // 没有才退到「签名实际绑定的节点」。
  //
  // ⚠️ 为什么「没有 body.node 时退到 claimedNode」而不是继续退到 resolveNode 的
  //    「第一个启用节点」：旧版 agent 只在 body 里发 `nodeId`，如果这里退到"第一个
  //    启用节点"，那么加上下面的相等校验后这些 agent 会集体 403（多节点部署下一个都
  //    同步不了）。退到 claimedNode 既保住了它们，也顺手修掉一个**既有的写错节点**
  //    隐患：以前这类报告其实把同步状态/心跳写到了 sort_order 最小的那个节点上。
  const requestedNode =
    typeof body.node === "string" && body.node ? body.node : (auth.claimedNode ?? "")
  const node = await resolveNode(env, requestedNode)
  // 报告 #28：验签用的节点必须就是这次要写的节点 —— 否则「持 A 的密钥、写 B」成立，
  // 等于一个捐献者能改别人节点的同步状态与心跳。
  assertSameNode(auth, node.id)

  const reported = Array.isArray(body.users) ? body.users : []
  const now = new Date().toISOString()

  const statements = reported
    .filter(
      (u): u is AgentReportUser & { user: string } =>
        typeof u.user === "string" &&
        // ⚠️ 这里必须把 u.user 收进局部变量：TS 的类型收窄**进不去** arrow function，
        //    直接写 u.user.startsWith(p) 会报「'u.user' is of type 'unknown'」。
        FRP_USER_PREFIXES.some((p) => (u.user as string).startsWith(p))
    )
    .map((u) => {
      const present = u.present !== false
      const error = typeof u.error === "string" && u.error ? u.error : null
      const state = error ? "error" : present ? "synced" : "error"
      return env.DB.prepare(
        `UPDATE frp_subscriptions
            SET sync_state = ?, synced_at = ?, last_error = ?, updated_at = ?
          WHERE node_id = ? AND frp_user = ?`
      ).bind(
        state,
        now,
        error ?? (present ? null : "agent 报告该账号在面板中不存在"),
        now,
        node.id,
        u.user
      )
    })

  if (statements.length > 0) {
    await env.DB.batch(statements)
  }

  // 记录 agent 最近一次心跳与它看到的 frps 实况（管理端「在线实况」用）
  await env.DB.prepare(
    `INSERT INTO frp_agent_state (node_id, last_seen_at, revision, server_info, last_error, report_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(node_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       revision     = excluded.revision,
       server_info  = excluded.server_info,
       last_error   = excluded.last_error,
       report_count = frp_agent_state.report_count + 1`
  )
    .bind(
      node.id,
      now,
      typeof body.revision === "string" ? body.revision : null,
      body.serverInfo ? JSON.stringify(body.serverInfo) : null,
      typeof body.error === "string" ? body.error : null
    )
    .run()

  return json({ ok: true, applied: statements.length, serverTime: now })
}
