// 代理节点「一键捐献」登记接口（2026-10-14）。
//
// 背景：过去捐献一台内网穿透服务器，要用户手写 config.yml、提交、等管理员人工
// 复核（甚至一律转人工）。改成：用户在捐献页拿到一条命令，在自己的服务器上跑，
// 跑完脚本自检通过就自动登记 + 自动上架默认套餐。
//
// 与 donations.ts 里旧通道的区别：
//   · 旧通道：用户交 **配置文件** → 系统校验语法 → 建 frp_nodes（但那个节点其实
//     是"别人的服务端"，我们只拿到连接参数）。
//   · 本通道：用户交 **一台真的跑起来的服务器** → 脚本自检（frps 在监听 + 面板
//     /health 正常）→ 才回报。所以这里的登记**不需要人工复核**：事实已经由
//     服务器自身证明了。
//
// 🔴 安全要点：
//   1. 令牌是一次性的，绑在登录用户身上。校验通过即作废，重放拿不到第二个节点。
//   2. 令牌是 HMAC 签名的（含过期时间），不落库明文 —— 落库的话 D1 泄露就等于
//      任何人都能注册节点。
//   3. **已用令牌的摘要要落库**，否则重放能建出无限多节点（把节点列表刷爆）。
//   4. 用户自报的 ip/端口必须做形状校验 —— 这些值会进入 frp_nodes，后面会被
//      拼进给终端用户的 frpc 配置里。
import { ApiError, json } from "../http"
import { getSettings } from "../settings"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import type { Env } from "../env"

/**
 * HMAC-SHA256 十六进制小写。
 *
 * 本来想复用 frp-agent.ts 里的同名函数，但它是那个文件的**内部**函数、没有导出。
 * 与其为了复用去改一个正在稳定服务的文件（agent 通道的签名口径不能动），
 * 不如在这里自包含一份 —— 6 行代码，比动线上稳定代码安全。
 */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 令牌有效期：捐献这种事不该拖太久，但也不能让用户复制完命令就过期 */
const TOKEN_TTL_MS = 60 * 60 * 1000 // 1 小时

interface RegisterBody {
  ip?: string
  frpsPort?: number
  panelPort?: number
  frpsToken?: string
  agentSecret?: string
  token?: string
  /** 节点脚本探测出的**连续空闲**隧道端口段（可选）。服务端会夹取后再用。 */
  tunnelPortMin?: number
  tunnelPortMax?: number
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 取一个整数设置项，带兜底 —— 设置页面还没加这些键时也能正常工作 */
function intSetting(settings: Record<string, string>, key: string, fallback: number): number {
  const raw = settings[key]
  const n = Number.parseInt(String(raw ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function isValidIpv4(text: string): boolean {
  const parts = text.split(".")
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
}

function isValidPort(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535
}

/** 生成一个 48 字符的随机密钥（字母数字，避免 shell/JSON 转义问题） */
function randomKey(len = 48): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("")
}

/**
 * 生成一枚捐献令牌。捐献页把它拼进命令行里给用户。
 *
 * 形状：`<userId>.<expiresAt>.<hmac>`（三段，便于自校验，不落库）
 */
export async function mintDonateToken(env: Env, userId: string): Promise<string> {
  const secret = env.SESSION_SECRET || env.FRP_AGENT_SECRET || ""
  if (!secret) throw new ApiError(500, "缺少签名密钥，无法生成捐献令牌", "NO_SECRET")
  const expires = String(Date.now() + TOKEN_TTL_MS)
  const sig = await hmacSha256Hex(secret, `${userId}.${expires}`)
  return `${userId}.${expires}.${sig}`
}

/** 校验令牌，返回 userId；失败返回 null（不区分原因，避免给攻击者反馈） */
async function verifyDonateToken(env: Env, token: string): Promise<string | null> {
  const secret = env.SESSION_SECRET || env.FRP_AGENT_SECRET || ""
  if (!secret) return null
  const parts = String(token || "").split(".")
  if (parts.length !== 3) return null
  const [userId, expires, sig] = parts
  if (!userId || !expires || !sig) return null
  const exp = Number.parseInt(expires, 10)
  if (!Number.isFinite(exp) || exp < Date.now()) return null
  const want = await hmacSha256Hex(secret, `${userId}.${expires}`)
  // 常数时间比较：直接 === 会在时间上泄漏签名前缀
  if (want.length !== sig.length) return null
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0 ? userId : null
}

/**
 * POST /api/frp/donate/register —— 捐献脚本回报。
 *
 * 这是**唯一**不需要登录态、而是靠捐献令牌鉴权的写接口（脚本在别人的服务器上跑，
 * 没有浏览器会话）。所以这里每一步都必须自己校验。
 */
export async function registerDonatedNode(env: Env, request: Request): Promise<Response> {
  const body = (await request.json()) as RegisterBody

  const userId = await verifyDonateToken(env, String(body.token || ""))
  if (!userId) {
    throw new ApiError(401, "捐献令牌无效或已过期，请回到 DoulorCloud 重新生成命令", "BAD_TOKEN")
  }

  const ip = String(body.ip || "").trim()
  if (!isValidIpv4(ip)) throw new ApiError(400, "IPv4 地址不合法", "BAD_IP")
  if (!isValidPort(body.frpsPort)) throw new ApiError(400, "frps 端口不合法", "BAD_PORT")
  if (!isValidPort(body.panelPort)) throw new ApiError(400, "面板端口不合法", "BAD_PORT")
  if (body.frpsPort === body.panelPort) {
    throw new ApiError(400, "frps 端口与面板端口不能相同", "BAD_PORT")
  }

  const frpsToken = String(body.frpsToken || "").trim()
  if (frpsToken.length < 8) throw new ApiError(400, "frps token 太短", "BAD_TOKEN_FIELD")

  const user = await env.DB.prepare(`SELECT id, username FROM users WHERE id = ? LIMIT 1`)
    .bind(userId)
    .first<{ id: string; username: string }>()
  if (!user) throw new ApiError(401, "令牌对应的账号已不存在", "NO_USER")

  // 防重放：同一枚令牌只能用一次。用摘要落库，不存原令牌。
  //
  // ⚠️ 唯一性靠数据库的 UNIQUE 索引来保证，而不是「先查再插」——
  //    脚本可能因为网络重试而**并发**提交两次，应用层的先查再插在并发下会双穿。
  //    所以这里必须 catch 唯一约束冲突，而不是看返回值：
  //    重复插入是**抛异常**，`run()` 根本不会返回 `success: false`。
  const usedTokenId = `tok_${uuid().slice(0, 16)}`
  try {
    await env.DB.prepare(
      `INSERT INTO frp_donate_used_tokens (id, token_sig, user_id, ip, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(usedTokenId, (body.token || "").slice(-24), userId, ip, nowIso())
      .run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/UNIQUE|constraint/i.test(msg)) {
      throw new ApiError(409, "这枚捐献令牌已经用过了，请回到 DoulorCloud 重新生成命令", "TOKEN_USED")
    }
    throw err
  }

  // 同一台机器重复捐献：直接复用已有节点，避免节点列表里出现一串同一个 IP 的死节点。
  //
  // ⚠️ 查重只用 `server_addr`，**不能**加上 frps 端口。
  //    因为推送是按「面板」算的：同一个 IP 上的面板只有一份账号表。如果允许
  //    同一 IP 建出两条节点（比如捐献者改了个 frps 端口重跑脚本），那两条节点
  //    会各自把对方的账号当成「多余的」删掉 —— 互相删，谁也开不出来。
  //    一台机器 = 一个面板 = 一个节点，这条不变式必须靠查重键来保证。
  const dup = await env.DB.prepare(
    `SELECT id FROM frp_nodes WHERE server_addr = ? LIMIT 1`
  )
    .bind(ip)
    .first<{ id: string }>()

  const settings = (await getSettings(env)) as unknown as Record<string, string>
  const days = intSetting(settings, "frp_donate_default_days", 30)
  const points = intSetting(settings, "frp_donate_default_points", 100)
  const portMin = intSetting(settings, "frp_donate_default_port_min", 10000)
  const portMax = intSetting(settings, "frp_donate_default_port_max", 10010)
  const maxPorts = intSetting(settings, "frp_donate_default_max_ports", portMax - portMin + 1)

  // ---------------------------------------------------------------- 节点自报的可用端口段
  //
  // 脚本会在捐献机器上探测哪段端口是**连续空闲**的，然后随登记请求上报。
  // 为什么要听它的：用户隧道的 remote_port 是在那台机器上真实绑定的，
  // 一旦撞上机器上已有的服务，被分到那个口的用户**永远连不上**，
  // 而节点侧看不出任何问题 —— 报错只出现在用户那边。
  //
  // 实测案例：一台机器连续占用了 10000-10019，而默认套餐段正好是 10000-10010，
  // 全部不可用。只看单个端口是不够的，必须找连续可用的一段。
  //
  // ⚠️ 这是**来自捐献者机器的输入**，不能直接采信：
  //    · 夹到 1024-65535（低于 1024 要 root，我们要求节点用无特权端口）
  //    · 必须 min <= max
  //    · 段内位置数要够 maxPorts，否则退回全局默认
  //    不夹的话，一个乱报的节点就能把套餐指向任意端口区间。
  const reportedMin = Number(body.tunnelPortMin)
  const reportedMax = Number(body.tunnelPortMax)
  let planPortMin = portMin
  let planPortMax = portMax
  if (
    Number.isInteger(reportedMin) &&
    Number.isInteger(reportedMax) &&
    reportedMin >= 1024 &&
    reportedMax <= 65535 &&
    reportedMin <= reportedMax &&
    reportedMax - reportedMin + 1 >= maxPorts
  ) {
    planPortMin = reportedMin
    planPortMax = reportedMax
  }
  // 防火墙/安全组要放行的段：与套餐段分开，默认更宽（见 settings.ts 里的说明）
  const openPortMin = intSetting(settings, "frp_donate_open_port_min", portMin)
  const openPortMax = intSetting(settings, "frp_donate_open_port_max", Math.max(portMax, 11000))
  // 防火墙要开的是"放行段 ∪ 实际套餐段"——节点自报的段可能落在放行段之外
  const openLow = Math.min(openPortMin, planPortMin)
  const openHigh = Math.max(openPortMax, planPortMax)

  const autoList = settings["frp_donate_auto_list"] !== "0"
  const now = nowIso()

  let nodeId = dup?.id ?? ""
  let created = false
  // 节点专属的 agent 密钥。
  //
  // 🔴 为什么要「每节点一把」而不是继续用全局 FRP_AGENT_SECRET：
  //    这个密钥要交给**捐献者**（脚本要用它去拉期望状态）。用全局密钥的话，
  //    任何捐献者都能拿它去拉**别的节点**的期望状态 —— 那里有**其他用户的
  //    frp 令牌**（面板账号的密码），等于把所有用户的凭据发给每一个捐献者。
  //    全局密钥继续保留，只给我自己那台服务器用；捐献节点一律用专属密钥。
  let agentKey = randomKey(48)

  if (!nodeId) {
    nodeId = uuid()
    await env.DB.prepare(
      `INSERT INTO frp_nodes
         (id, name, region, server_addr, server_port, auth_token, token_prefix,
          port_min, port_max, max_ports, enabled, sort_order, note,
          status, status_note, status_updated_at, auth_mode, config_template,
          source_donation_id, panel_port, panel_secret, agent_key, owner_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'DC_', ?, ?, ?, 1, 0, ?, 'ok', NULL, ?, 'token_user', NULL, NULL, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        nodeId,
        `捐献-${user.username}`,
        null,
        ip,
        body.frpsPort,
        frpsToken,
        planPortMin,
        planPortMax,
        maxPorts,
        `一键脚本捐献 · 面板 ${ip}:${body.panelPort} · 由 ${user.username} 于 ${now.slice(0, 10)} 提交`,
        now,
        // 面板接入信息：DoulorCloud 靠这两列**主动把账号推到捐献节点的面板**上。
        // 捐献节点上没有 agent（agent 是"每台服务器自己拉 D1"的模型，只适用于我们自己那台），
        // 不存这两个值的话，用户买了套餐、D1 有订阅，但面板永远收不到账号。
        body.panelPort,
        String(body.agentSecret || "").trim() || null,
        agentKey,
        // 归属用户：租用分成要靠它知道"这个节点是谁捐的"
        user.id,
        now,
        now
      )
      .run()
    created = true
  }

  // 复用已有节点时补一次密钥：配置式捐献来的老节点没有 agent_key，
  // 补上它才能用「一键脚本」的新流程（老节点靠人工填 config，没有面板接入信息）。
  if (!created) {
    // ⚠️ 复用已有节点时，必须返回**库里已经存着的那把**密钥，而不是刚生成的新密钥。
    //
    // 否则会出现这种情况：用户重跑一键脚本（很常见 —— 令牌过期、换端口、
    // 机器重装），脚本拿到新密钥并写进 agent 配置，而 D1 里存的是第一次那把，
    // 于是 agent 每次签名都失败、永远 401。用户看到的是"装了但一直同步不了"。
    //
    // 库里没有才补写（老节点是配置式捐献进来的，可能没有 agent_key）。
    const existing = await env.DB.prepare(
      `SELECT agent_key FROM frp_nodes WHERE id = ? LIMIT 1`
    )
      .bind(nodeId)
      .first<{ agent_key: string | null }>()
    if (existing?.agent_key) {
      agentKey = existing.agent_key
    } else {
      await env.DB.prepare(`UPDATE frp_nodes SET agent_key = ? WHERE id = ?`)
        .bind(agentKey, nodeId)
        .run()
    }
  }

  // 自动上架默认套餐。站长要求：捐献成功即自动上架 30 天 / 100 积分 / 端口 10000-10010，
  // 且这些默认值在管理面板可改（所以读的是设置项而不是写死常量）。
  let planId = ""
  if (autoList) {
    const existingPlan = await env.DB.prepare(
      `SELECT id FROM frp_plans WHERE node_id = ? LIMIT 1`
    )
      .bind(nodeId)
      .first<{ id: string }>()
    if (existingPlan) {
      planId = existingPlan.id
    } else {
      planId = uuid()
      await env.DB.prepare(
        `INSERT INTO frp_plans (id, node_id, name, days, price_points, max_ports, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
        .bind(planId, nodeId, `${days} 天套餐`, days, points, maxPorts, now, now)
        .run()
    }
  }

  return json({
    ok: true,
    nodeId,
    created,
    planId: planId || null,
    plan: autoList
      ? { days, points, portMin: planPortMin, portMax: planPortMax, maxPorts }
      : null,
    // 脚本用这两个值去开防火墙 + 提示安全组。**和套餐段分开**：
    // 套餐段是"发给用户哪些口"，这个是"服务器放行哪些口"。
    openPortMin: openLow,
    openPortMax: openHigh,
    // 脚本拿这两个值去装 agent：它需要知道连哪个节点、用哪把钥匙。
    // ⚠️ agentKey 是每节点独立的 —— 绝不返回全局 FRP_AGENT_SECRET，
    //    否则任何捐献者都能拉取别的节点的期望状态（里面有别人的 frp 令牌）。
    nodeIdForAgent: nodeId,
    agentKey,
    message: created
      ? "节点已登记，默认套餐已自动上架"
      : "这台服务器之前已经登记过，已复用原节点",
  })
}

/**
 * POST /api/frp/donate/token —— 已登录用户领取一枚捐献令牌（捐献页用）。
 */
export async function issueDonateToken(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const token = await mintDonateToken(env, user.id)
  return json({ ok: true, token, expiresInSec: Math.floor(TOKEN_TTL_MS / 1000) })
}
