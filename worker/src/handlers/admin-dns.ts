/**
 * 管理面板 → DNS 解析管理（2026-10-01 新增）。
 *
 * 为什么单独开一套接口，而不复用 /api/admin/users/:username 里的 dns 数组：
 *   1. 那个数组是**按用户**取 200 条，站长要回答的是「全站现在有哪些解析记录、
 *      哪些有问题」，跨用户的问题按用户翻是翻不出来的（1074 个命名空间）。
 *   2. 它不含风险判断，也不含「这条记录在 Cloudflare 上到底存不存在」。
 *
 * 四个能力：
 *   · 全站列表  —— 跨用户、带归属与风险标记、可筛选
 *   · 编辑/删除 —— 站长能直接处置（改内容、开关代理、删除）
 *   · 合规扫描  —— 跑规则引擎（可选做真实解析探测），发现问题落库
 *   · CF 比对   —— 拿 Cloudflare 上的**实际**记录和本地表对账
 *
 * ⚠️ CF 比对是最容易被忽略但最要紧的一项：本地表只是「通过本站建过什么」的台账，
 *    真正生效的是 Cloudflare 上的记录。别人绕过本站（或历史手工操作）建在
 *    zone 上的记录，只有对账才看得见。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { guardRateLimit } from "../ratelimit"
import {
  callCloudflare,
  cfCreateDnsRecord,
  cfDeleteDnsRecord,
  cfListDnsRecords,
  cfUpdateDnsRecord,
} from "../cloudflare"
import { allRootDomainNames, zoneIdForFqdn } from "../root-domains"
import { attachCustomDomain, detachCustomDomain } from "../custom-domain"
import { audit as recordAudit } from "../settings"
import { likeContains } from "../sql-like"
import {
  assessRecord,
  countOpenDnsFindings,
  getLastDnsAuditRun,
  scanDns,
  type DnsRecordLike,
  type Finding,
  type Severity,
} from "../dns-audit"
import type { Env } from "../env"

const ALLOWED_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "SRV"])

/** 一次最多在内存里评估多少条记录（风险严重度是算出来的，没法在 SQL 里筛） */
const SCAN_LIMIT = 1000

interface DnsRow extends DnsRecordLike {
  username?: string | null
  uid?: number | null
  domain?: string | null
  /** 归属域名所在的 CF zone（JOIN domains.zone_id） */
  zone_id?: string | null
  /** 归属用户的账号状态（banned 等）—— 被禁用户还留着解析记录值得关注 */
  user_status?: string | null
}

/** 列表里的单条记录（含风险标记） */
interface AdminDnsRecordView {
  id: string
  fqdn: string
  name: string
  type: string
  content: string
  ttl: number
  proxied: boolean
  priority: number | null
  srv: { weight: number; port: number; target: string } | null
  status: string
  hasCf: boolean
  subdomainId: string | null
  createdAt: string
  updatedAt: string
  username: string | null
  uid: number | null
  userStatus: string | null
  domain: string | null
  risks: (Finding & { ignored: boolean })[]
  topSeverity: Severity | null
}

/**
 * 记录名合法性。
 *
 * 比用户侧宽松一点（站长可能是为了修正历史脏数据，需要能填进「看着不规范但
 * Cloudflare 允许」的值），但仍然挡掉会破坏记录结构的东西：
 * 空白、换行、通配符以外的特殊字符。`*` 必须单独处理 —— 泛解析是合法的，
 * 但 `*` 混在其它标签里（`a*.b`）不是。
 */
function validateName(name: string): void {
  if (!name) return
  if (name.length > 253) throw new ApiError(400, "记录名过长", "INVALID_INPUT")
  if (/[\s]/.test(name)) throw new ApiError(400, "记录名不能包含空白", "INVALID_INPUT")
  if (name === "*" || name === "@") return
  if (name.includes("*")) {
    throw new ApiError(400, "通配符只能整段使用（`*` 或 `*.xxx`）", "INVALID_INPUT")
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new ApiError(400, "记录名含非法字符", "INVALID_INPUT")
  }
  if (name.startsWith(".") || name.endsWith(".")) {
    throw new ApiError(400, "记录名不能以点开头或结尾", "INVALID_INPUT")
  }
}

/** 按类型粗校验内容，挡掉显然写错的值（管理员也难免手滑） */
function validateContent(type: string, content: string): void {
  const v = content.trim()
  if (!v) throw new ApiError(400, "内容不能为空", "INVALID_INPUT")
  if (type === "A") {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) throw new ApiError(400, "A 记录内容必须是 IPv4 地址", "INVALID_INPUT")
  } else if (type === "AAAA") {
    if (!v.includes(":")) throw new ApiError(400, "AAAA 记录内容必须是 IPv6 地址", "INVALID_INPUT")
  } else if (type === "CNAME") {
    if (/\s/.test(v) || !v.includes(".")) throw new ApiError(400, "CNAME 内容必须是主机名", "INVALID_INPUT")
  } else if (type === "MX") {
    if (/\s/.test(v) || !v.includes(".")) throw new ApiError(400, "MX 内容必须是主机名", "INVALID_INPUT")
  } else if (type === "SRV") {
    // 展示串形如 `10 0 13300 target.example.com`
    const parts = v.split(/\s+/)
    if (parts.length !== 4) {
      throw new ApiError(400, "SRV 内容格式应是「优先级 权重 端口 目标主机」", "INVALID_INPUT")
    }
    const [prio, weight, port] = parts
    for (const [label, raw] of [["优先级", prio], ["权重", weight], ["端口", port]] as const) {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new ApiError(400, `SRV ${label} 必须是 0–65535 的整数`, "INVALID_INPUT")
      }
    }
    if (Number(port) < 1) throw new ApiError(400, "SRV 端口不能为 0", "INVALID_INPUT")
    if (!parts[3].includes(".")) throw new ApiError(400, "SRV 目标必须是主机名", "INVALID_INPUT")
  }
}

/** 把一条 DB 行转成前端视图 */
function toView(
  row: DnsRow,
  risks: Finding[],
  ignoredRules: Set<string>,
  userStatus: string | null
): AdminDnsRecordView {
  const decorated = risks.map((f) => ({ ...f, ignored: ignoredRules.has(f.rule) }))
  const top = decorated.find((f) => !f.ignored)?.severity ?? null
  return {
    id: row.id,
    fqdn: row.fqdn,
    name: row.name,
    type: row.type,
    content: row.content,
    ttl: row.ttl,
    proxied: row.proxied === 1,
    priority: row.priority,
    srv:
      row.type === "SRV"
        ? {
            weight: row.srv_weight ?? 0,
            port: row.srv_port ?? 0,
            target: row.srv_target ?? "",
          }
        : null,
    status: row.status,
    hasCf: Boolean(row.cf_id),
    subdomainId: row.subdomain_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    username: row.username ?? null,
    uid: row.uid ?? null,
    userStatus,
    domain: row.domain ?? null,
    risks: decorated,
    topSeverity: top,
  }
}

/**
 * 读「已忽略」的规则集合（按 fqdn+type+content 维度）。
 *
 * 规则 id 是 (rule, fqdn, type, content) 的指纹，指纹函数在 dns-audit 内部不对外导
 * 出，所以这里反过来按业务键聚合：`fqdn|type|content → 已忽略的规则 id 集合`。
 *
 * 一次性把全部 ignored 行取回来（带 LIMIT 兜底）而不是按当前页的 fqdn 过滤：
 * 被忽略的问题数量天然很少（每条都是站长看完后手动放过的），而按页过滤会漏掉
 * 超出 IN 上限的那部分记录，表现为「明明忽略过却还在标红」。
 */
async function loadIgnoredMap(env: Env): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  try {
    const res = await env.DB.prepare(
      "SELECT rule, fqdn, type, content FROM dns_audit_findings WHERE status = 'ignored' LIMIT 2000"
    ).all<{ rule: string; fqdn: string; type: string; content: string }>()
    for (const r of res.results ?? []) {
      const key = `${r.fqdn.toLowerCase()}|${r.type.toUpperCase()}|${r.content}`
      const set = out.get(key) ?? new Set<string>()
      set.add(r.rule)
      out.set(key, set)
    }
  } catch {
    // 表未建 / 查询失败：当作「没有忽略项」
  }
  return out
}

/** GET /api/admin/dns —— 全站 DNS 记录列表（跨用户，带风险标记） */
export async function listAdminDns(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  const url = new URL(request.url)
  const q = (url.searchParams.get("q") ?? "").trim()
  const typeFilter = (url.searchParams.get("type") ?? "").trim().toUpperCase()
  const severityFilter = (url.searchParams.get("severity") ?? "").trim().toLowerCase()
  const proxiedFilter = url.searchParams.get("proxied") ?? ""
  const statusFilter = (url.searchParams.get("status") ?? "").trim().toLowerCase()
  const usernameFilter = (url.searchParams.get("username") ?? "").trim()
  const includeIgnored = url.searchParams.get("includeIgnored") === "1"
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") ?? 50) || 50))

  const where: string[] = []
  const binds: unknown[] = []
  if (q) {
    where.push("(r.fqdn LIKE ? OR r.content LIKE ? OR u.username LIKE ?)")
    const like = likeContains(q)
    binds.push(like, like, like)
  }
  if (typeFilter && ALLOWED_TYPES.has(typeFilter)) {
    where.push("r.type = ?")
    binds.push(typeFilter)
  }
  if (proxiedFilter === "1" || proxiedFilter === "0") {
    where.push("r.proxied = ?")
    binds.push(Number(proxiedFilter))
  }
  if (statusFilter) {
    where.push("r.status = ?")
    binds.push(statusFilter)
  }
  if (usernameFilter) {
    where.push("u.username LIKE ?")
    binds.push(likeContains(usernameFilter))
  }

  const sql = `SELECT r.*, u.username AS username, u.uid AS uid, u.status AS user_status, d.name AS domain
                 FROM dns_records r
                 LEFT JOIN domains d ON d.id = r.domain_id
                 LEFT JOIN users u ON u.id = d.user_id
                ${where.length ? "WHERE " + where.join(" AND ") : ""}
                ORDER BY r.fqdn ASC
                LIMIT ${SCAN_LIMIT}`

  const res = await env.DB.prepare(sql).bind(...binds).all<DnsRow>()
  const rawRows = res.results ?? []
  const truncated = rawRows.length >= SCAN_LIMIT

  const dupKey = new Map<string, number>()
  for (const r of rawRows) {
    const k = `${r.fqdn.toLowerCase()}|${r.type.toUpperCase()}|${r.content.trim()}`
    dupKey.set(k, (dupKey.get(k) ?? 0) + 1)
  }

  const zoneSuffixes = await allRootDomainNames(env)
  const ignoredMap = await loadIgnoredMap(env)

  const allViews = rawRows.map((r) => {
    const risks = assessRecord(r, { zoneSuffixes, duplicateKey: dupKey })
    const ignoredKey = `${r.fqdn.toLowerCase()}|${r.type.toUpperCase()}|${r.content}`
    return toView(r, risks, ignoredMap.get(ignoredKey) ?? new Set<string>(), r.user_status ?? null)
  })

  // 统计口径 = **SQL 筛选后、严重度筛选前**的全部记录。
  // 不能拿筛选后的集合去算：那样一点「只看高风险」，中/低风险的统计就变成 0，
  // 卡片上的数字会随筛选跳动，反而看不出全站到底什么情况。
  const statsSet = allViews

  let views = allViews

  // 严重度是算出来的，只能在这层筛
  if (severityFilter === "high" || severityFilter === "medium" || severityFilter === "low") {
    views = views.filter((v) => v.topSeverity === severityFilter)
  } else if (severityFilter === "any" || severityFilter === "risky") {
    views = views.filter((v) => v.topSeverity !== null)
  } else if (severityFilter === "none") {
    views = views.filter((v) => v.topSeverity === null)
  }

  // 默认视图里隐藏「问题已全部被忽略」的记录：它们已经处置过了，
  // 再占着屏幕只会让真正待处理的记录往后排。用 includeIgnored=1 可以看全。
  if (!includeIgnored) {
    views = views.filter((v) => v.topSeverity !== null || v.risks.length === 0)
  }

  const total = views.length
  const start = (page - 1) * pageSize
  const pageRows = views.slice(start, start + pageSize)

  const openFindings = await countOpenDnsFindings(env)
  const lastRun = await getLastDnsAuditRun(env)

  return json({
    records: pageRows,
    total,
    page,
    pageSize,
    truncated,
    stats: {
      high: statsSet.filter((v) => v.topSeverity === "high").length,
      medium: statsSet.filter((v) => v.topSeverity === "medium").length,
      low: statsSet.filter((v) => v.topSeverity === "low").length,
      clean: statsSet.filter((v) => v.topSeverity === null).length,
      scanned: statsSet.length,
      openFindings,
    },
    lastRun,
  })
}

/** 供编辑/删除共用的取行逻辑 */
async function loadRow(env: Env, id: string): Promise<DnsRow> {
  const row = await env.DB.prepare(
    `SELECT r.*, u.username AS username, u.uid AS uid, d.name AS domain,
            d.zone_id AS zone_id, u.status AS user_status
       FROM dns_records r
       LEFT JOIN domains d ON d.id = r.domain_id
       LEFT JOIN users u ON u.id = d.user_id
      WHERE r.id = ?`
  )
    .bind(id)
    .first<DnsRow>()
  if (!row) throw new ApiError(404, "记录不存在", "NOT_FOUND")
  return row
}

/**
 * PUT /api/admin/dns/:id —— 站长编辑记录。
 *
 * 与用户侧 updateDns 的差别：不做归属校验（站长对全站负责），
 * 并且**允许改类型**（处置滥用时经常要把 CNAME 改成 A 或直接删掉）。
 * 但内容校验更严：站长手滑写进去的脏值同样会在 CF 侧失败，
 * 而失败只写 status='error'，本地看起来「还在」，很容易被忽略。
 */
export async function updateAdminDns(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const body = (await request.json()) as {
    name?: string
    type?: string
    content?: string
    ttl?: number
    proxied?: boolean
    priority?: number
  }

  const existing = await loadRow(env, id)
  const type = (body.type ?? existing.type).toUpperCase()
  if (!ALLOWED_TYPES.has(type)) throw new ApiError(400, "不支持的记录类型", "INVALID_TYPE")

  const name = (body.name ?? existing.name).trim()
  validateName(name)

  const content = (body.content ?? existing.content).trim()
  validateContent(type, content)

  const ttl = body.ttl ?? existing.ttl
  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) {
    // Cloudflare 只接受 1（自动）或 60–86400 之间的秒数。
    // 卡在这里比让它打到 CF 再被判 400 好：那样只会写回 status='error'，
    // 站长在列表上看到的是「保存成功了但记录不生效」。
    throw new ApiError(400, "TTL 必须为 1（自动）或 60–86400 之间的整数", "INVALID_INPUT")
  }

  const proxied =
    type === "A" || type === "AAAA" || type === "CNAME" ? (body.proxied ?? existing.proxied === 1) : false

  // fqdn 基准：挂在子域名下就以该子域名为基准
  let base = existing.domain ?? ""
  if (existing.subdomain_id) {
    const sub = await env.DB.prepare("SELECT name, fqdn FROM subdomains WHERE id = ?")
      .bind(existing.subdomain_id)
      .first<{ name: string; fqdn: string }>()
    if (sub && sub.name !== "@") base = sub.fqdn
  }
  const fqdn = name === "@" || name === "" ? base : `${name}.${base}`
  // 必须落在**任一已登记根域**之内（tyu.me 与 doulor.cn 都算），只判主域会让
  // 管理端连自己新域上的记录都改不了。
  const zoneSuffixes = await allRootDomainNames(env)
  const fqdnLower = fqdn.toLowerCase()
  if (!zoneSuffixes.some((x) => fqdnLower === x || fqdnLower.endsWith(`.${x}`))) {
    throw new ApiError(
      400,
      `记录必须落在本站根域之内（${zoneSuffixes.join(" / ")}），算出来是 ${fqdn}`,
      "INVALID_INPUT"
    )
  }

  // SRV 的 content 是展示串，真正的数据在 srv_* 三列 —— 编辑时按同一规则拆回去
  let priority: number | undefined = undefined
  let srvWeight: number | null = null
  let srvPort: number | null = null
  let srvTarget: string | null = null
  let cfPayloadContent: { content?: string; data?: { priority: number; weight: number; port: number; target: string } }
  if (type === "SRV") {
    const [prio, weight, port, target] = content.split(/\s+/)
    priority = Number(prio)
    srvWeight = Number(weight)
    srvPort = Number(port)
    srvTarget = target
    cfPayloadContent = {
      data: { priority: Number(prio), weight: Number(weight), port: Number(port), target },
    }
  } else {
    if (type === "MX") priority = body.priority ?? existing.priority ?? 10
    cfPayloadContent = { content }
  }

  const zoneId = existing.zone_id ?? env.ZONE_ID
  let cfError: string | null = null
  try {
    if (existing.cf_id) {
      await cfUpdateDnsRecord(env, zoneId, existing.cf_id, {
        type,
        name: fqdn,
        ttl,
        proxied,
        ...cfPayloadContent,
        ...(priority !== undefined ? { priority } : {}),
      })
    } else {
      // 本地有、Cloudflare 上没有：借编辑动作顺手补建，否则这条记录永远不生效
      const created = await cfCreateDnsRecord(env, zoneId, {
        type,
        name: fqdn,
        ttl,
        proxied,
        ...cfPayloadContent,
        ...(priority !== undefined ? { priority } : {}),
      })
      await env.DB.prepare("UPDATE dns_records SET cf_id = ? WHERE id = ?").bind(created.id, id).run()
    }
  } catch (err) {
    cfError = err instanceof Error ? err.message : String(err)
    console.error("管理端修改 DNS 记录时 Cloudflare 拒绝:", fqdn, err)
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE dns_records
        SET name = ?, fqdn = ?, type = ?, content = ?, ttl = ?, proxied = ?, priority = ?,
            srv_weight = ?, srv_port = ?, srv_target = ?, status = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(
      name,
      fqdn,
      type,
      content,
      ttl,
      proxied ? 1 : 0,
      priority ?? null,
      srvWeight,
      srvPort,
      srvTarget,
      cfError ? "error" : "active",
      now,
      id
    )
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.dns.update",
    `修改用户 ${existing.username ?? "?"} 的 DNS 记录 ${existing.fqdn} → ${fqdn} (${type} ${content})` +
      (cfError ? `；Cloudflare 拒绝：${cfError}` : ""),
    request.headers.get("CF-Connecting-IP")
  )

  const updated = await loadRow(env, id)
  const risks = assessRecord(updated, { zoneSuffixes: await allRootDomainNames(env) })
  return json({
    record: toView(updated, risks, new Set<string>(), updated.user_status ?? null),
    cfError,
  })
}

/** DELETE /api/admin/dns/:id —— 删除记录（Cloudflare 侧一并删） */
export async function deleteAdminDns(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const existing = await loadRow(env, id)

  let cfError: string | null = null
  if (existing.cf_id) {
    const zoneId = existing.zone_id ?? env.ZONE_ID
    try {
      await cfDeleteDnsRecord(env, zoneId, existing.cf_id)
    } catch (err) {
      // 删不掉也继续删本地：记录在 CF 上可能已经被手工删了（404），
      // 或者令牌权限不足。让站长看到原因比卡住不动更有用。
      cfError = err instanceof Error ? err.message : String(err)
      console.error("管理端删除 DNS 记录时 Cloudflare 失败:", existing.fqdn, err)
    }
  }

  await env.DB.prepare("DELETE FROM dns_records WHERE id = ?").bind(id).run()

  await recordAudit(
    env,
    admin.id,
    "admin.dns.delete",
    `删除用户 ${existing.username ?? "?"} 的 DNS 记录 ${existing.fqdn} (${existing.type} ${existing.content})` +
      (cfError ? `；Cloudflare 删除失败：${cfError}` : ""),
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, cfError })
}

/**
 * POST /api/admin/dns/audit —— 立刻扫一遍。
 *
 * `deep=1` 时额外对每条记录做真实解析探测（DNS-over-HTTPS），能发现悬空 CNAME
 * 与「本地活着但 DNS 上不存在」的记录。探测有外部请求，所以单独限流。
 */
export async function runDnsAudit(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const url = new URL(request.url)
  const deep = url.searchParams.get("deep") === "1"
  await guardRateLimit(env, `admin:dns:audit:${admin.id}`, deep ? 6 : 30, 300, "扫描过于频繁")

  const summary = await scanDns(env, { mode: "manual", resolve: deep })
  await recordAudit(
    env,
    admin.id,
    "admin.dns.audit",
    `执行 DNS 合规扫描（${deep ? "含解析探测" : "仅静态规则"}）：扫描 ${summary.scanned} 条，发现 ${summary.found} 项（高 ${summary.high} / 中 ${summary.medium} / 低 ${summary.low}）`,
    request.headers.get("CF-Connecting-IP")
  )
  return json({ summary })
}

/** GET /api/admin/dns/findings —— 扫描发现项列表 */
export async function listDnsFindings(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  const url = new URL(request.url)
  const status = (url.searchParams.get("status") ?? "open").trim().toLowerCase()
  const severity = (url.searchParams.get("severity") ?? "").trim().toLowerCase()
  const q = (url.searchParams.get("q") ?? "").trim()
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1)
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get("pageSize") ?? 100) || 100))

  const where: string[] = []
  const binds: unknown[] = []
  if (status && status !== "all") {
    where.push("status = ?")
    binds.push(status)
  }
  if (severity === "high" || severity === "medium" || severity === "low") {
    where.push("severity = ?")
    binds.push(severity)
  }
  if (q) {
    where.push("(fqdn LIKE ? OR content LIKE ? OR username LIKE ? OR detail LIKE ?)")
    const like = likeContains(q)
    binds.push(like, like, like, like)
  }

  const clause = where.length ? "WHERE " + where.join(" AND ") : ""
  let rows: { results?: unknown[] } = {}
  let total = 0
  try {
    rows = await env.DB.prepare(
      `SELECT * FROM dns_audit_findings ${clause}
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC
        LIMIT ? OFFSET ?`
    )
      .bind(...binds, pageSize, (page - 1) * pageSize)
      .all()
    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM dns_audit_findings ${clause}`)
      .bind(...binds)
      .first<{ c: number }>()
    total = Number(countRow?.c ?? 0)
  } catch {
    // 迁移未执行：返回空列表而不是 500，页面照样能打开
    return json({
      findings: [],
      total: 0,
      page,
      pageSize,
      tableReady: false,
      lastRun: null,
      message: "审计表尚未创建，请先执行 migrations/0092_dns_audit.sql",
    })
  }

  const findings = ((rows.results ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    recordId: r.record_id ? String(r.record_id) : null,
    fqdn: String(r.fqdn),
    type: String(r.type),
    content: String(r.content),
    username: r.username ? String(r.username) : null,
    rule: String(r.rule),
    severity: String(r.severity) as Severity,
    detail: String(r.detail),
    status: String(r.status),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
    reviewedBy: r.reviewed_by ? String(r.reviewed_by) : null,
    reviewedAt: r.reviewed_at ? String(r.reviewed_at) : null,
    note: r.note ? String(r.note) : null,
  }))

  const lastRun = await getLastDnsAuditRun(env)

  // 各状态计数（角标与统计卡片用）
  let counts = { open: 0, ignored: 0, resolved: 0 }
  try {
    const cs = await env.DB.prepare(
      "SELECT status, COUNT(*) AS c FROM dns_audit_findings GROUP BY status"
    ).all<{ status: string; c: number }>()
    counts = { open: 0, ignored: 0, resolved: 0 }
    for (const r of cs.results ?? []) {
      if (r.status === "open") counts.open = Number(r.c)
      else if (r.status === "ignored") counts.ignored = Number(r.c)
      else if (r.status === "resolved") counts.resolved = Number(r.c)
    }
  } catch {
    // 忽略
  }

  return json({ findings, total, page, pageSize, tableReady: true, counts, lastRun })
}

/**
 * PUT /api/admin/dns/findings/:id —— 处置一条发现项。
 *
 * 只支持两种动作：
 *   · `ignored`  —— 看过了，判定为可接受（必须写备注，否则几个月后没人记得为什么放过）
 *   · `open`     —— 撤销忽略，重新变成待处理
 * 不提供「删除」：留档本身就是这张表存在的理由。
 */
export async function reviewDnsFinding(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const body = (await request.json()) as { status?: string; note?: string }
  const status = body.status === "open" ? "open" : body.status === "ignored" ? "ignored" : null
  if (!status) throw new ApiError(400, "status 只能是 ignored 或 open", "INVALID_INPUT")

  const note = (body.note ?? "").trim().slice(0, 500)
  if (status === "ignored" && !note) {
    throw new ApiError(400, "忽略时必须写明原因（备注）", "INVALID_INPUT")
  }

  const row = await env.DB.prepare("SELECT id, fqdn, rule, severity FROM dns_audit_findings WHERE id = ?")
    .bind(id)
    .first<{ id: string; fqdn: string; rule: string; severity: string }>()
  if (!row) throw new ApiError(404, "发现项不存在（可能尚未执行过扫描）", "NOT_FOUND")

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE dns_audit_findings SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?"
  )
    .bind(status, note || null, admin.username, now, id)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.dns.review",
    `${status === "ignored" ? "忽略" : "恢复"} DNS 问题 ${row.fqdn} / ${row.rule}（${row.severity}）${note ? "：" + note : ""}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}

// ---------------------------------------------------------------------------
// 与 Cloudflare 实际记录对账
// ---------------------------------------------------------------------------

interface CfRecord {
  id: string
  name: string
  type: string
  content: string
  proxied?: boolean
  ttl?: number
  comment?: string | null
}

/** 拉取 zone 上**全部** DNS 记录（分页拉全，翻页上限兜底） */
async function listAllZoneRecords(env: Env, zoneId: string): Promise<CfRecord[]> {
  const all: CfRecord[] = []
  for (let page = 1; page <= 20; page++) {
    const res = await callCloudflare(
      env,
      `/zones/${zoneId}/dns_records?per_page=100&page=${page}`,
      { method: "GET" }
    )
    const data = (await res.json()) as {
      result?: CfRecord[]
      result_info?: { total_pages?: number }
      errors?: { message: string }[]
    }
    const batch = data.result ?? []
    all.push(...batch)
    const totalPages = data.result_info?.total_pages ?? 1
    if (batch.length === 0 || page >= totalPages) break
  }
  return all
}

/**
 * 平台自建记录的特征。
 *
 * 这些是 CF 上**应该**存在、但**不**走 dns_records 表的记录（Worker 路由占位、
 * 邮件收发、站点验证…）。对账时必须把它们和「来历不明的记录」分开，
 * 否则每次对账都会有一屏噪声，站长很快就会不再看这个功能。
 */
function classifyPlatformRecord(rec: CfRecord, rootDomain: string): string | null {
  const name = rec.name.toLowerCase().replace(/\.$/, "")
  const root = rootDomain.toLowerCase()
  // Worker 路由的占位记录：CF 用 100:: 的 AAAA 把 hostname 挂到 Worker 上
  if (rec.type === "AAAA" && rec.content === "100::") return "Worker 路由占位"
  if (rec.type === "AAAA" && rec.content.startsWith("100::")) return "Worker 路由占位"
  // 邮件：MX / SPF / DKIM / DMARC 落在根域上
  if (name === root || name === `mail.${root}`) return "根域基础设施"
  if (name === `_dmarc.${root}` || name.endsWith(`._domainkey.${root}`)) return "邮件鉴权"
  if (name.startsWith("cf2024-") || name.startsWith("cf202")) return "Cloudflare 邮件路由校验"
  if (rec.comment && /doulor|platform|auto/i.test(rec.comment)) return "带平台标记"
  return null
}

/**
 * GET /api/admin/dns/cf-diff —— 本地台账 vs Cloudflare 实际记录。
 *
 * 两类差异都有意义：
 *   · `onlyInCf` —— CF 上有、本地表里没有：**绕过本站建的记录**，或者本地表数据丢了。
 *     这是本次「没有任何审核」问题的真正盲区：光看站内表永远看不到它。
 *   · `onlyInDb` —— 本地表有、CF 上没有：记录实际不生效（用户以为配好了）。
 */
export async function compareCfDns(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  await guardRateLimit(env, `admin:dns:cfdiff`, 20, 300, "对账过于频繁")

  const zoneId = env.ZONE_ID
  if (!zoneId) throw new ApiError(500, "未配置 ZONE_ID", "CF_NOT_CONFIGURED")

  const cfRecords = await listAllZoneRecords(env, zoneId)

  const dbRows = await env.DB.prepare(
    `SELECT r.id, r.cf_id, r.fqdn, r.type, r.content, r.proxied, r.status,
            d.name AS domain, u.username AS username
       FROM dns_records r
       LEFT JOIN domains d ON d.id = r.domain_id
       LEFT JOIN users u ON u.id = d.user_id`
  ).all<{
    id: string
    cf_id: string | null
    fqdn: string
    type: string
    content: string
    proxied: number
    status: string
    domain: string | null
    username: string | null
  }>()
  const rows = dbRows.results ?? []

  const dbByCfId = new Map(rows.filter((r) => r.cf_id).map((r) => [r.cf_id as string, r]))
  const rootDomain = (env.ROOT_DOMAIN || "doulor.cn").toLowerCase()

  const onlyInCf: {
    id: string
    name: string
    type: string
    content: string
    proxied: boolean
    hint: string | null
  }[] = []
  const managedCount = { value: 0 }
  for (const rec of cfRecords) {
    if (dbByCfId.has(rec.id)) continue
    const hint = classifyPlatformRecord(rec, rootDomain)
    if (hint) {
      managedCount.value++
      continue
    }
    onlyInCf.push({
      id: rec.id,
      name: rec.name,
      type: rec.type,
      content: rec.content,
      proxied: Boolean(rec.proxied),
      hint: null,
    })
  }

  const cfIds = new Set(cfRecords.map((r) => r.id))
  const onlyInDb = rows
    .filter((r) => !r.cf_id || !cfIds.has(r.cf_id))
    .map((r) => ({
      id: r.id,
      fqdn: r.fqdn,
      type: r.type,
      content: r.content,
      status: r.status,
      username: r.username,
      cfId: r.cf_id,
      reason: r.cf_id ? "Cloudflare 上已不存在该记录 id" : "本地从未成功写入 Cloudflare（无 cf_id）",
    }))

  return json({
    cfTotal: cfRecords.length,
    dbTotal: rows.length,
    platformManaged: managedCount.value,
    onlyInCf,
    onlyInDb,
    checkedAt: new Date().toISOString(),
    note:
      "只列出「非平台自建」的差异。Worker 路由占位 / 邮件鉴权 / 根域基础设施等记录已自动排除：" +
      `本次排除 ${managedCount.value} 条。`,
  })
}

/**
 * DELETE /api/admin/dns/cf-orphan/:cfId —— 直接删 Cloudflare 上一条无主记录。
 *
 * 必须提供 cfId 且该 id **不在**本地表里 —— 否则走记录删除入口，
 * 免得留下「表里有、CF 上没了」的不一致。
 */
export async function deleteOrphanCfRecord(
  env: Env,
  request: Request,
  cfId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const known = await env.DB.prepare("SELECT id, fqdn FROM dns_records WHERE cf_id = ?")
    .bind(cfId)
    .first<{ id: string; fqdn: string }>()
  if (known) {
    throw new ApiError(
      400,
      `该 Cloudflare 记录对应站内记录 ${known.fqdn}，请从记录列表删除，以保持台账一致`,
      "INVALID_INPUT"
    )
  }
  await cfDeleteDnsRecord(env, env.ZONE_ID, cfId)
  await recordAudit(
    env,
    admin.id,
    "admin.dns.delete-orphan",
    `删除 Cloudflare 上的无主 DNS 记录 ${cfId}`,
    request.headers.get("CF-Connecting-IP")
  )
  return json({ ok: true })
}

/**
 * POST /api/admin/dns/recreate —— 在 Cloudflare 上按当前 fqdn **重建**一条记录。
 *
 * 为什么需要它：`dns_records.fqdn` 与 `cf_id` 分属两处事实 —— fqdn 是本站在
 * 哪个名字下登记的，cf_id 是 Cloudflare 上**那个 zone 里**的记录 id。
 * 一旦 fqdn 改了归属域（例如 2026-10-02 把用户域名整体从 doulor.cn 迁到 tyu.me），
 * 老的 cf_id 就指向了**另一个 zone** 的记录：列表里看着是「新名字」，
 * 实际 CF 上什么都没有、而旧名字还挂着 —— 既解析不通，编辑/删除也会 404。
 *
 * 本接口就是修这种「台账与 CF 对不上」的：按当前 fqdn 解析出正确 zone 重建一条，
 * 回填新 cf_id，并把旧 zone 里的那条删掉（调用方给出 oldZoneId 时才删）。
 *
 * body: `{ id, oldZoneId? }`
 */
export async function recreateDnsRecord(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const body = (await request.json()) as { id?: string; oldZoneId?: string }
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少记录 id", "INVALID_INPUT")

  const row = await loadRow(env, id)
  if (!row) throw new ApiError(404, "记录不存在", "NOT_FOUND")

  const oldCfId = (row as unknown as { cf_id?: string | null }).cf_id ?? null
  const targetZone = await zoneIdForFqdn(env, row.fqdn)

  const srv = row as unknown as {
    srv_weight?: number | null
    srv_port?: number | null
    srv_target?: string | null
  }

  // 幂等：目标 zone 里已经有同名记录了就直接认领，不重复建。
  // 不能拿「JOIN 出来的 zone_id」判是否需要重建 —— 那个值随 domains 表一起
  // 被迁移改过了，迁移后它显示的就是目标 zone，而 cf_id 仍指向旧 zone，
  // 两者不一致恰恰是「需要重建」的判据，用 zone_id 判会把该做的活判成不必做。
  let created: { id: string }
  let reused = false
  const existingInTarget = await cfListDnsRecords(env, targetZone, row.fqdn).catch(
    () => []
  )
  if (existingInTarget.length > 0) {
    created = { id: existingInTarget[0].id }
    reused = true
  } else
  try {
    created = await cfCreateDnsRecord(env, targetZone, {
      type: row.type,
      name: row.fqdn,
      // SRV 必须走 data 对象（CF 的 SRV 示例里只有 data，没有 content）
      ...(row.type === "SRV"
        ? {
            data: {
              priority: row.priority ?? 0,
              weight: srv.srv_weight ?? 0,
              port: srv.srv_port ?? 0,
              target: srv.srv_target ?? "",
            },
          }
        : { content: row.content }),
      ttl: row.ttl ?? 1,
      proxied: Boolean(row.proxied),
      ...(row.type === "MX" ? { priority: row.priority ?? 10 } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ApiError(502, `在 Cloudflare 上重建失败：${msg}`, "CF_ERROR")
  }

  await env.DB.prepare(
    "UPDATE dns_records SET cf_id = ?, status = 'active', updated_at = ? WHERE id = ?"
  )
    .bind(created.id, new Date().toISOString(), id)
    .run()

  // 旧 zone 里的那条：best-effort 删掉。删不掉只记日志 —— 记录已重建成功，
  // 不该因为清理失败把整个操作判为失败（调用方会看到 deletedOld=false）。
  let deletedOld = false
  if (oldCfId && body.oldZoneId) {
    try {
      await cfDeleteDnsRecord(env, body.oldZoneId, oldCfId)
      deletedOld = true
    } catch (err) {
      console.error("重建后清理旧 zone 记录失败:", row.fqdn, oldCfId, err)
    }
  }

  await recordAudit(
    env,
    admin.id,
    "admin.dns.recreate",
    `在 Cloudflare 上重建 ${row.fqdn}（${row.type}）→ zone ${targetZone}` +
      (deletedOld ? `，已清理旧记录 ${oldCfId}` : ""),
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, cfId: created.id, zoneId: targetZone, reused, deletedOld })
}

/**
 * POST /api/admin/domains/rebind —— 把「绑定在子域名上的服务」（名片/网盘直链）
 * 在新域名下重新挂上 Worker Route + 占位解析，并拆掉旧域名那一套。
 *
 * 与 `recreateDnsRecord` 同源的问题：Route 是 zone 级资源，
 * 域名改了归属域之后，旧 zone 里的 `<fqdn>/*` 路由不会自己搬家 ——
 * 新域名能解析到 Cloudflare，但没有 Route 匹配，访问就 404。
 *
 * body: `{ newFqdn, oldFqdn? }`
 */
export async function rebindCustomDomain(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const body = (await request.json()) as { newFqdn?: string; oldFqdn?: string }
  const newFqdn = String(body.newFqdn ?? "").trim().toLowerCase()
  const oldFqdn = String(body.oldFqdn ?? "").trim().toLowerCase()
  if (!newFqdn) throw new ApiError(400, "缺少 newFqdn", "INVALID_INPUT")

  const attached = await attachCustomDomain(env, newFqdn)

  let detached = false
  if (oldFqdn && oldFqdn !== newFqdn) {
    // 只拆我们自己建的那套（Route + AAAA 100:: 占位），用户自建的 MX/TXT 会保留
    await detachCustomDomain(env, oldFqdn)
    detached = true
  }

  await recordAudit(
    env,
    admin.id,
    "admin.domain.rebind",
    `重新绑定自定义域名 ${oldFqdn || "-"} → ${newFqdn}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, dnsCreated: attached.dnsCreated, detached })
}
