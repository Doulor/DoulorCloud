import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { requireOwnedDomain, assertFqdnOwned } from "../ownership"
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
  }
}

async function loadUserDomain(env: Env, userId: string) {
  return env.DB.prepare("SELECT * FROM domains WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string; name: string; zone_id: string | null }>()
}

// GET /api/dns?subdomainId=xxx —— DNS 记录列表
export async function listDns(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const subdomainId = url.searchParams.get("subdomainId")

  let rows
  if (subdomainId) {
    // 校验该子域名属于当前用户
    const sub = await env.DB.prepare(
      "SELECT id FROM subdomains WHERE id = ? AND user_id = ?"
    )
      .bind(subdomainId, user.id)
      .first()
    if (!sub) throw new ApiError(403, "无权访问该子域名", "FORBIDDEN")

    rows = await env.DB.prepare(
      "SELECT * FROM dns_records WHERE subdomain_id = ? ORDER BY created_at ASC"
    )
      .bind(subdomainId)
      .all<DnsRow>()
  } else {
    const domain = await loadUserDomain(env, user.id)
    if (!domain) return json({ records: [] })
    rows = await env.DB.prepare(
      "SELECT * FROM dns_records WHERE domain_id = ? ORDER BY created_at ASC"
    )
      .bind(domain.id)
      .all<DnsRow>()
  }

  return json({ records: (rows.results ?? []).map(toPublicRecord) })
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
  await guardRateLimit(env, `dns:create:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
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
    const result = await cfCreateDnsRecord(env, domain.zone_id ?? env.ZONE_ID, {
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
         srv_weight, srv_port, srv_target, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  await guardRateLimit(env, `dns:update:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
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
    await cfUpdateDnsRecord(env, domain!.zone_id ?? env.ZONE_ID, existing.cf_id, {
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
  await guardRateLimit(env, `dns:delete:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")

  const existing = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  if (!existing) {
    throw new ApiError(404, "记录不存在", "NOT_FOUND")
  }

  await requireOwnedDomain(env, user.id, existing.domain_id)

  if (existing.cf_id) {
    const domain = await env.DB.prepare("SELECT zone_id FROM domains WHERE id = ?")
      .bind(existing.domain_id)
      .first<{ zone_id: string | null }>()
    await cfDeleteDnsRecord(env, domain!.zone_id ?? env.ZONE_ID, existing.cf_id)
  }

  await env.DB.prepare("DELETE FROM dns_records WHERE id = ?").bind(id).run()

  return new Response(null, { status: 204 })
}