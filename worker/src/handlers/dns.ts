import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { isAdminApiRequest } from "../api-source"
import { isApiRequest } from "../api-source"
import { requireOwnedDomain, assertFqdnOwned } from "../ownership"
import { zoneIdForFqdn } from "../root-domains"
import {
  cfCreateDnsRecord,
  cfUpdateDnsRecord,
  cfDeleteDnsRecord,
} from "../cloudflare"
import type { Env } from "../env"

interface DnsRow {
  id: string
  domain_id: string
  subdomain_id: string | null
  cf_id: string | null
  name: string
  fqdn: string
  type: string
  content: string
  ttl: number
  proxied: number
  priority: number | null
  srv_weight: number | null
  srv_port: number | null
  srv_target: string | null
  status: string
  /** 因封禁被停用的时刻（null = 正常）。见 migrations/0134 与 user-suspension.ts */
  banned_at: string | null
  created_at: string
  updated_at: string
}

const ALLOWED_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "SRV"])

/**
 * SRV 记录的端口/优先级/权重上限（RFC 2782 + CF 的字段约束：0–65535）。
 */
const SRV_MAX = 65535

/**
 * 把用户输入的 service / proto 规范成 `_xxx` 形态。
 *
 * 为什么要容错：SRV 的 service 与 proto 按规范必须带前导下划线
 * （`_sip._tcp.example.com`），但用户在面板上多半直接打 `sip` / `tcp`。
 * 这里统一补上下划线，省得因为少一个字符就报「记录不合法」而让人摸不着头脑。
 * 同时挡掉点号与空白 —— 它们会破坏记录名的分段结构。
 */
function normalizeSrvLabel(raw: string, field: string): string {
  const v = (raw ?? "").trim().replace(/^_+/, "")
  if (!v) throw new ApiError(400, `请填写 SRV ${field}`, "INVALID_INPUT")
  if (/[.\s]/.test(v)) {
    throw new ApiError(400, `SRV ${field} 不能包含点号或空格`, "INVALID_INPUT")
  }
  if (v.length > 30) {
    throw new ApiError(400, `SRV ${field} 过长`, "INVALID_INPUT")
  }
  return `_${v.toLowerCase()}`
}

/** 校验 0–65535 的整数（端口 / 优先级 / 权重共用） */
function parseSrvNumber(
  raw: unknown,
  field: string,
  opts: { min?: number; fallback?: number } = {}
): number {
  const min = opts.min ?? 0
  if (raw === undefined || raw === null || raw === "") {
    if (opts.fallback !== undefined) return opts.fallback
    throw new ApiError(400, `请填写 SRV ${field}`, "INVALID_INPUT")
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > SRV_MAX) {
    throw new ApiError(
      400,
      `SRV ${field} 必须是 ${min}–${SRV_MAX} 之间的整数`,
      "INVALID_INPUT"
    )
  }
  return n
}

/** SRV 的 target：提供服务的主机名。允许外部域名（SRV 本来就常指向别的域） */
function normalizeSrvTarget(raw: unknown): string {
  const v = String(raw ?? "").trim().replace(/\.$/, "")
  if (!v) throw new ApiError(400, "请填写 SRV 目标主机", "INVALID_INPUT")
  if (v.length > 253) throw new ApiError(400, "SRV 目标主机过长", "INVALID_INPUT")
  // 主机名允许字母数字、点、连字符、下划线（部分服务用下划线前缀的 target）
  if (!/^[a-zA-Z0-9._-]+$/.test(v)) {
    throw new ApiError(400, "SRV 目标主机含非法字符", "INVALID_INPUT")
  }
  return v
}

/**
 * SRV 记录的 content 展示串：`"优先级 权重 端口 目标"`。
 *
 * 这正是 CF 用 `data` 对象时它在面板上显示的样子，也是 DNS 里 SRV 的
 * rdata 顺序。存下来是为了列表展示（列表只渲染 content）与管理员排查时
 * 一眼能看懂 —— 真正的数据在 srv_* 三列里，下次更新记录时会用它们重建
 * `data` 对象。
 */
function srvContent(priority: number, weight: number, port: number, target: string): string {
  return `${priority} ${weight} ${port} ${target}`
}

function toPublicRecord(row: DnsRow) {
  return {
    id: row.id,
    subdomainId: row.subdomain_id,
    name: row.name,
    fqdn: row.fqdn,
    type: row.type,
    content: row.content,
    ttl: row.ttl,
    proxied: row.proxied === 1,
    priority: row.priority ?? undefined,
    /** SRV 专有字段；非 SRV 记录为 undefined */
    srv: row.type === "SRV"
      ? {
          weight: row.srv_weight ?? 0,
          port: row.srv_port ?? 0,
          target: row.srv_target ?? "",
        }
      : undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /**
     * 平台自动创建、只读（由 listDns 派生注入，见 loadManagedDns）。
     * 用户自建的一律 false —— 这里显式给出字段，好让派生项能推进同一个数组。
     */
    managed: false,
    managedBy: null as null | "profile" | "storage",
  }
}

async function loadUserDomain(env: Env, userId: string) {
  return env.DB.prepare("SELECT * FROM domains WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string; name: string; zone_id: string | null }>()
}

/**
 * 平台自己建的解析：个人名片 / 网盘直链绑定自定义域名时，`attachCustomDomain`
 * （见 custom-domain.ts）会为那个 fqdn 建一条 `AAAA 100::` 占位记录 —— 但它只存在
 * 于 Cloudflare，不落 `dns_records`。于是用户在「DNS 记录」页里既看不到自己名片的
 * 域名，也看不懂那个域名为什么解析得通（2026-10-01 反馈：「个人名片界面绑定域名
 * 不会在前面的 dns 记录那里显现」）。
 *
 * 这里把它**派生**出来展示，而不是绑定时补写一行，理由：
 *   1. 补写会让同一事实存在两处（dns_records 与 profiles / storage_prefixes），
 *      两边必须互相同步：用户在 DNS 页删掉那一行，就会得到「解析没了、名片却还
 *      显示已绑定」的死结 —— 正是同一条反馈里「删了很久还是在跳转」的成因。
 *   2. 派生是只读的，天然不可能不一致；而且**存量绑定立刻可见**，不必回填。
 */
interface ManagedDnsRow {
  fqdn: string
  subdomain_id: string | null
  ts: string | null
  kind: string
}

async function loadManagedDns(env: Env, userId: string): Promise<ManagedDnsRow[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT fqdn, subdomain_id, updated_at AS ts, 'profile' AS kind FROM profiles
         WHERE user_id = ? AND fqdn IS NOT NULL AND fqdn != ''
       UNION ALL
       SELECT fqdn, subdomain_id, created_at AS ts, 'storage' AS kind FROM storage_prefixes
         WHERE user_id = ? AND fqdn IS NOT NULL AND fqdn != ''`
    )
      .bind(userId, userId)
      .all<ManagedDnsRow>()
    return res.results ?? []
  } catch (err) {
    // 派生展示失败不该让整个 DNS 列表打不开
    console.error("读取平台托管解析失败:", err)
    return []
  }
}

/** 取 fqdn 相对根域名的前缀（`blog.abc.doulor.cn` + `doulor.cn` → `blog.abc`） */
function relativeName(fqdn: string, rootDomain: string): string {
  const lower = fqdn.toLowerCase()
  const root = rootDomain.toLowerCase()
  if (root && lower.endsWith(`.${root}`)) return fqdn.slice(0, fqdn.length - root.length - 1)
  return fqdn.split(".")[0]
}

// GET /api/dns?subdomainId=xxx —— DNS 记录列表
export async function listDns(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const subdomainId = url.searchParams.get("subdomainId")

  let rows
  let rootDomain = ""
  if (subdomainId) {
    // 校验该子域名属于当前用户
    const sub = await env.DB.prepare(
      "SELECT id FROM subdomains WHERE id = ? AND user_id = ?"
    )
      .bind(subdomainId, user.id)
      .first()
    if (!sub) throw new ApiError(403, "无权访问该子域名", "FORBIDDEN")

    rows = await env.DB.prepare(
      // banned_at IS NOT NULL = 因封禁被停用（CF 上已删）。过滤掉它，
      // 否则解封后用户会在列表里看到一条「本地有、CF 上没有」的幽灵记录
      // ——点它解析不到，只会让人以为站点坏了。
      "SELECT * FROM dns_records WHERE subdomain_id = ? AND banned_at IS NULL ORDER BY created_at ASC"
    )
      .bind(subdomainId)
      .all<DnsRow>()
  } else {
    const domain = await loadUserDomain(env, user.id)
    if (!domain) return json({ records: [] })
    rootDomain = domain.name
    rows = await env.DB.prepare(
      "SELECT * FROM dns_records WHERE domain_id = ? AND banned_at IS NULL ORDER BY created_at ASC"
    )
      .bind(domain.id)
      .all<DnsRow>()
  }

  const records = (rows.results ?? []).map(toPublicRecord)

  // 追加平台托管的解析（只读）。已有同 fqdn 的真实记录时不重复展示 ——
  // 那属于历史数据，用户当初手工建过，列表里以他自己那条为准。
  if (!rootDomain) {
    const d = await loadUserDomain(env, user.id)
    rootDomain = d?.name ?? ""
  }
  const seen = new Set(records.map((r) => r.fqdn.toLowerCase()))
  for (const m of await loadManagedDns(env, user.id)) {
    const key = m.fqdn.toLowerCase()
    if (seen.has(key)) continue
    if (subdomainId && m.subdomain_id !== subdomainId) continue
    seen.add(key)
    records.push({
      id: `managed:${m.kind}:${key}`,
      subdomainId: m.subdomain_id,
      name: relativeName(m.fqdn, rootDomain),
      fqdn: m.fqdn,
      type: "AAAA",
      content: "100::",
      ttl: 1,
      proxied: true,
      priority: undefined,
      srv: undefined,
      status: "active",
      createdAt: m.ts ?? "",
      updatedAt: m.ts ?? "",
      managed: true,
      managedBy: m.kind === "storage" ? "storage" : "profile",
    })
  }

  return json({ records })
}

/** 请求体里 SRV 相关字段的形状（create / update 共用） */
interface SrvInput {
  srvService?: string
  srvProto?: string
  srvWeight?: number
  srvPort?: number
  srvTarget?: string
  srvPriority?: number
}

/**
 * 校验并组装一条 SRV 记录的字段。
 *
 * 记录名为什么由后端拼：SRV 的 `service` / `proto` 必须带前导下划线且
 * 顺序固定（`_service._proto.name`），交给前端拼的话每个入口都要重复这套规则，
 * 迟早有一处漏了。这里统一拼好再走与其它类型相同的 fqdn 逻辑。
 *
 * `prefix` 是「服务标签之后、基准域名之前」的那一段（可为空或 `@`）——
 * 例如想给 `_sip._tcp.blog.xxx.doulor.cn` 配 SRV，prefix 就是 `blog`；
 * 直接挂在基准域名下则为空。
 */
function normalizeSrv(
  input: SrvInput,
  prefix: string,
  fallbackPriority?: number | null
): {
  /** 相对标签链，如 `_sip._tcp` 或 `_sip._tcp.blog` */
  name: string
  priority: number
  weight: number
  port: number
  target: string
  /** 展示串：`"优先级 权重 端口 目标"` */
  content: string
} {
  const service = normalizeSrvLabel(String(input.srvService ?? ""), "服务名")
  const proto = normalizeSrvLabel(String(input.srvProto ?? ""), "协议")
  const weight = parseSrvNumber(input.srvWeight, "权重", { fallback: 0 })
  const port = parseSrvNumber(input.srvPort, "端口", { min: 1 })
  const target = normalizeSrvTarget(input.srvTarget)
  // 优先级 0 是合法值（RFC 2782 里 0 表示最高优先），所以不能用 `||` 兜底
  const priority = parseSrvNumber(
    input.srvPriority ?? fallbackPriority ?? undefined,
    "优先级",
    { fallback: 10 }
  )

  const cleanPrefix = !prefix || prefix === "@" ? "" : prefix
  const name = cleanPrefix ? `${service}.${proto}.${cleanPrefix}` : `${service}.${proto}`
  return {
    name,
    priority,
    weight,
    port,
    target,
    content: srvContent(priority, weight, port, target),
  }
}

export async function createDns(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // ⚠️ 2026-09-26 审计：每次调用都会真发一次 Cloudflare API 请求并写一条
  // audit_logs，原先零限流 ⇒ 脚本化调用可刷爆平台 CF 配额。
  // 管理员 Key 的公开 API 调用不限速（2026-10-07）
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(env, `dns:create:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
  }
  const body = (await request.json()) as {
    subdomainId?: string
    name?: string
    type?: string
    content?: string
    ttl?: number
    proxied?: boolean
    priority?: number
  } & SrvInput

  const type = (body.type ?? "").toUpperCase()
  if (!ALLOWED_TYPES.has(type)) {
    throw new ApiError(400, "不支持的记录类型", "INVALID_TYPE")
  }

  const domain = await loadUserDomain(env, user.id)
  if (!domain) {
    throw new ApiError(400, "尚未分配域名", "NO_DOMAIN")
  }

  // SRV 的 content 由 service/proto/weight/port/target 推导，用户不直接填；
  // 其余类型的 content 是必填的。
  const rawName = (body.name ?? "").trim()
  const content = (body.content ?? "").trim()
  if (type !== "SRV" && (!rawName || !content)) {
    throw new ApiError(400, "名称和内容不能为空", "INVALID_INPUT")
  }

  // 归属的子域名：默认是 '@' 根域
  let subdomain: { id: string; name: string; fqdn: string } | null = null
  if (body.subdomainId) {
    subdomain = await env.DB.prepare(
      "SELECT id, name, fqdn FROM subdomains WHERE id = ? AND user_id = ?"
    )
      .bind(body.subdomainId, user.id)
      .first<{ id: string; name: string; fqdn: string }>()
    if (!subdomain) throw new ApiError(403, "无权访问该子域名", "FORBIDDEN")
  } else {
    subdomain = await env.DB.prepare(
      "SELECT id, name, fqdn FROM subdomains WHERE user_id = ? AND name = '@' LIMIT 1"
    )
      .bind(user.id)
      .first<{ id: string; name: string; fqdn: string }>()
  }
  if (!subdomain) throw new ApiError(400, "尚未分配域名", "NO_DOMAIN")

  // SRV：把 service/proto/prefix 拼成相对标签链；其余类型：name 就是前缀
  const srv = type === "SRV" ? normalizeSrv(body, rawName) : null
  const name = srv ? srv.name : rawName
  const finalContent = srv ? srv.content : content
  const priority = srv ? srv.priority : type === "MX" ? body.priority ?? 10 : undefined

  // 记录挂在子域名下时，fqdn 以该子域名为基准（xxx.doulor.cn → 前缀.xxx.doulor.cn）
  const base = subdomain.name === "@" ? domain.name : subdomain.fqdn
  const fqdn = name === "@" || name === "" ? base : `${name}.${base}`
  await assertFqdnOwned(env, user.id, fqdn)

  const ttl = body.ttl ?? 1
  const proxied =
    type === "A" || type === "AAAA" || type === "CNAME"
      ? (body.proxied ?? false)
      : false

  let cfId: string | null = null
  try {
    const result = await cfCreateDnsRecord(env, await zoneIdForFqdn(env, fqdn), {
      type,
      name: fqdn,
      // SRV 走 data 对象（CF 的 SRV 示例里只有 data，没有 content），其余类型反之
      ...(srv
        ? {
            data: {
              priority: srv.priority,
              weight: srv.weight,
              port: srv.port,
              target: srv.target,
            },
          }
        : { content: finalContent }),
      ttl,
      proxied,
      // 顶层的 priority 对 MX 与 SRV 都是 CF 要求的字段；SRV 时与 data.priority
      // 传同一个值，两边取值一致，无论 CF 以哪个为准都正确。
      ...(priority !== undefined ? { priority } : {}),
    })
    cfId = result.id
  } catch (err) {
    // Cloudflare 失败不阻断本地记录，标记为 error，后续可重试
    console.error("CF DNS create failed for", fqdn, ":", err)
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dns_records
        (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, priority,
         srv_weight, srv_port, srv_target, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      domain.id,
      subdomain.id,
      cfId,
      name,
      fqdn,
      type,
      finalContent,
      ttl,
      proxied ? 1 : 0,
      priority ?? null,
      srv ? srv.weight : null,
      srv ? srv.port : null,
      srv ? srv.target : null,
      cfId ? "active" : "error",
      isApiRequest(request) ? "api" : "web",
      now,
      now
    ),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'dns.create', ?, ?, ?)"
    ).bind(uuid(), user.id, `创建 DNS 记录 ${fqdn} (${type})`, request.headers.get("CF-Connecting-IP"), now),
  ])

  const row = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  return json({ record: toPublicRecord(row!) }, 201)
}

export async function updateDns(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  // 管理员 Key 的公开 API 调用不限速（2026-10-07）
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(env, `dns:update:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
  }
  const body = (await request.json()) as {
    name?: string
    type?: string
    content?: string
    ttl?: number
    proxied?: boolean
    priority?: number
  } & SrvInput

  const existing = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  if (!existing) {
    throw new ApiError(404, "记录不存在", "NOT_FOUND")
  }

  await requireOwnedDomain(env, user.id, existing.domain_id)

  const type = (body.type ?? existing.type).toUpperCase()
  if (!ALLOWED_TYPES.has(type)) {
    throw new ApiError(400, "不支持的记录类型", "INVALID_TYPE")
  }

  const domain = await env.DB.prepare("SELECT name, zone_id FROM domains WHERE id = ?")
    .bind(existing.domain_id)
    .first<{ name: string; zone_id: string | null }>()

  // fqdn 基准：挂在子域名下则以该子域名（xxx.doulor.cn）为基准
  let base = domain!.name
  if (existing.subdomain_id) {
    const sub = await env.DB.prepare("SELECT name, fqdn FROM subdomains WHERE id = ?")
      .bind(existing.subdomain_id)
      .first<{ name: string; fqdn: string }>()
    if (sub && sub.name !== "@") base = sub.fqdn
  }

  const ttl = body.ttl ?? existing.ttl
  const proxied =
    type === "A" || type === "AAAA" || type === "CNAME"
      ? (body.proxied ?? existing.proxied === 1)
      : false

  // 目标类型是 SRV 时，用新字段重建；否则沿用原有字段。
  //
  // ⚠️ 从 SRV 改成别的类型（或反过来）时，srv_* 三列会被写回 null ——
  // 留着旧值会让「列表里显示的是 SRV 的 target，实际记录是 A 记录」这种
  // 数据与展示不一致，排查起来很费劲。
  let name: string
  let content: string
  let priority: number | undefined
  let srvWeight: number | null = null
  let srvPort: number | null = null
  let srvTarget: string | null = null
  let srvData: { priority: number; weight: number; port: number; target: string } | null = null

  if (type === "SRV") {
    // 更新时通常只改端口/权重/目标，service 与 proto 要从现有记录名里取回。
    // 记录名形如 `_sip._tcp` 或 `_sip._tcp.blog`，前两段固定是 service 与 proto。
    const labels = existing.type === "SRV" ? existing.name.split(".") : []
    const fallbackService = labels[0] ?? ""
    const fallbackProto = labels[1] ?? ""
    const fallbackPrefix = labels.slice(2).join(".")

    // 前缀以本次提交的 name 为准；**没传就沿用记录名里原有的** ——
    // 否则「只改端口」会顺手把 `_sip._tcp.blog` 变成 `_sip._tcp`，
    // 记录悄悄指到了别的名字上（比报错更难发现）。
    const prefix = body.name !== undefined ? body.name.trim() : fallbackPrefix

    const srv = normalizeSrv(
      {
        srvService: body.srvService ?? fallbackService,
        srvProto: body.srvProto ?? fallbackProto,
        srvWeight: body.srvWeight ?? existing.srv_weight ?? 0,
        srvPort: body.srvPort ?? existing.srv_port ?? undefined,
        srvTarget: body.srvTarget ?? existing.srv_target ?? "",
      },
      prefix,
      existing.priority
    )
    name = srv.name
    content = srv.content
    priority = srv.priority
    srvWeight = srv.weight
    srvPort = srv.port
    srvTarget = srv.target
    srvData = { priority: srv.priority, weight: srv.weight, port: srv.port, target: srv.target }
  } else {
    name = body.name?.trim() ?? existing.name
    content = body.content?.trim() ?? existing.content
    priority = type === "MX" ? (body.priority ?? existing.priority ?? 10) : undefined
  }

  const fqdn = name === "@" || name === "" ? base : `${name}.${base}`
  await assertFqdnOwned(env, user.id, fqdn)

  if (existing.cf_id) {
    await cfUpdateDnsRecord(env, await zoneIdForFqdn(env, fqdn), existing.cf_id, {
      type,
      name: fqdn,
      ...(srvData ? { data: srvData } : { content }),
      ttl,
      proxied,
      ...(priority !== undefined ? { priority } : {}),
    })
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE dns_records
        SET name = ?, fqdn = ?, type = ?, content = ?, ttl = ?, proxied = ?, priority = ?,
            srv_weight = ?, srv_port = ?, srv_target = ?, updated_at = ?
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
      now,
      id
    )
    .run()

  const row = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  return json({ record: toPublicRecord(row!) })
}

export async function deleteDns(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  // 管理员 Key 的公开 API 调用不限速（2026-10-07）
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(env, `dns:delete:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
  }

  const existing = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  if (!existing) {
    throw new ApiError(404, "记录不存在", "NOT_FOUND")
  }

  await requireOwnedDomain(env, user.id, existing.domain_id)

  if (existing.cf_id) {
    // ⚠️ 必须用**记录自己的 fqdn** 判 zone，不能用「用户主域的名字」：
    // 两者在「主域与记录不同根域」时不一致，拿主域判会把记录写到别的 zone 里 ——
    // 表现为记录建了、CF 上却解析不出来，之后删除还会 404。
    // 2026-10-02 迁移窗口期真的踩到了：19 条 `1.luna.tyu.me` 被写进 doulor.cn 的 zone。
    try {
      await cfDeleteDnsRecord(env, await zoneIdForFqdn(env, existing.fqdn), existing.cf_id)
    } catch (err) {
      // CF 上已经不存在这条记录（`81044 Record does not exist`）⇒ **视为删除成功**，
      // 继续把 DB 行清掉。
      //
      // 为什么必须容错：上面那批历史脏数据就是「DB 里有行、CF 上根本没有」——
      // 用户点删除会一直报 `Cloudflare API 调用失败: 404 ...`，记录删不掉、
      // 永远卡在列表里（2026-10-02 用户 ventus 反馈的就是这个）。
      // 删除本身是幂等的：目标已不在，目的就算达成了。
      // 真正的失败（网络 / 权限 / 限流）仍然照常抛出。
      const msg = err instanceof Error ? err.message : String(err)
      if (!/81044|Record does not exist|\b404\b/i.test(msg)) throw err
    }
  }

  await env.DB.prepare("DELETE FROM dns_records WHERE id = ?").bind(id).run()

  return new Response(null, { status: 204 })
}