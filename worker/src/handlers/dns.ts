import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
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
  status: string
  created_at: string
  updated_at: string
}

const ALLOWED_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX"])

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

export async function createDns(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as {
    subdomainId?: string
    name?: string
    type?: string
    content?: string
    ttl?: number
    proxied?: boolean
    priority?: number
  }

  const type = (body.type ?? "").toUpperCase()
  if (!ALLOWED_TYPES.has(type)) {
    throw new ApiError(400, "不支持的记录类型", "INVALID_TYPE")
  }

  const domain = await loadUserDomain(env, user.id)
  if (!domain) {
    throw new ApiError(400, "尚未分配域名", "NO_DOMAIN")
  }

  const name = (body.name ?? "").trim()
  const content = (body.content ?? "").trim()
  if (!name || !content) {
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

  // 记录挂在子域名下时，fqdn 以该子域名为基准（xxx.doulor.cn → 前缀.xxx.doulor.cn）
  const base = subdomain.name === "@" ? domain.name : subdomain.fqdn
  const fqdn = name === "@" || name === "" ? base : `${name}.${base}`
  await assertFqdnOwned(env, user.id, fqdn)

  const ttl = body.ttl ?? 1
  const proxied =
    type === "A" || type === "AAAA" || type === "CNAME"
      ? (body.proxied ?? false)
      : false
  const priority = type === "MX" ? body.priority ?? 10 : undefined

  let cfId: string | null = null
  try {
    const result = await cfCreateDnsRecord(env, domain.zone_id ?? env.ZONE_ID, {
      type,
      name: fqdn,
      content,
      ttl,
      proxied,
      priority,
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
        (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      domain.id,
      subdomain.id,
      cfId,
      name,
      fqdn,
      type,
      content,
      ttl,
      proxied ? 1 : 0,
      priority ?? null,
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
  const body = (await request.json()) as {
    name?: string
    type?: string
    content?: string
    ttl?: number
    proxied?: boolean
    priority?: number
  }

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

  const name = body.name?.trim() ?? existing.name
  const content = body.content?.trim() ?? existing.content

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

  const fqdn = name === "@" || name === "" ? base : `${name}.${base}`
  await assertFqdnOwned(env, user.id, fqdn)

  const ttl = body.ttl ?? existing.ttl
  const proxied =
    type === "A" || type === "AAAA" || type === "CNAME"
      ? (body.proxied ?? existing.proxied === 1)
      : false
  const priority = type === "MX" ? (body.priority ?? existing.priority ?? 10) : undefined

  if (existing.cf_id) {
    await cfUpdateDnsRecord(env, domain!.zone_id ?? env.ZONE_ID, existing.cf_id, {
      type,
      name: fqdn,
      content,
      ttl,
      proxied,
      priority,
    })
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE dns_records
        SET name = ?, fqdn = ?, type = ?, content = ?, ttl = ?, proxied = ?, priority = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(name, fqdn, type, content, ttl, proxied ? 1 : 0, priority ?? null, now, id)
    .run()

  const row = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  return json({ record: toPublicRecord(row!) })
}

export async function deleteDns(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)

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