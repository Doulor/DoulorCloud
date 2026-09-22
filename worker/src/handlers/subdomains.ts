import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { isReservedName } from "../reserved-names"
import { requireUser } from "../auth"
import { cfListDnsRecords, cfDeleteDnsRecord } from "../cloudflare"
import type { Env } from "../env"

const MAX_SUBDOMAINS_PER_USER = 5

interface SubdomainRow {
  id: string
  user_id: string
  name: string
  fqdn: string
  status: string
  created_at: string
}

function toPublicSubdomain(row: SubdomainRow) {
  return {
    id: row.id,
    name: row.name,
    fqdn: row.fqdn,
    status: row.status,
    createdAt: row.created_at,
  }
}

// GET /api/subdomains —— 当前用户的子域名列表
export async function listSubdomains(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM subdomains WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all<SubdomainRow>()

  return json({
    subdomains: (rows.results ?? []).map(toPublicSubdomain),
    limit: MAX_SUBDOMAINS_PER_USER,
  })
}

// POST /api/subdomains —— 创建根域直系子域名（xxx.doulor.cn）
// 配额：含主域名共 5 个
export async function createSubdomain(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { name?: string }

  const name = (body.name ?? "").trim().toLowerCase().replace(/\.$/, "")
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new ApiError(400, "子域名只能包含小写字母、数字和连字符", "INVALID_NAME")
  }
  // 防止占走平台自身入口（mail/api/www…）；绑定直链域名时还会创建
  // Worker Route <fqdn>/*，占用 mail 会把本站静态页面挡掉
  if (isReservedName(name)) {
    throw new ApiError(400, "该子域名为系统保留名称", "RESERVED_NAME")
  }

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()

  if ((count?.c ?? 0) >= MAX_SUBDOMAINS_PER_USER) {
    throw new ApiError(
      400,
      `最多可拥有 ${MAX_SUBDOMAINS_PER_USER} 个子域名（含主域名）`,
      "LIMIT_REACHED"
    )
  }

  // 根域直系：xxx.doulor.cn
  const fqdn = `${name}.${env.ROOT_DOMAIN.toLowerCase()}`

  const exists = await env.DB.prepare(
    "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first()

  if (exists) {
    throw new ApiError(409, "该子域名已被占用", "CONFLICT")
  }

  // 平台外冲突：doulor.cn zone 上已有该名称的记录（如你的 Pages 项目），不得发放
  try {
    const records = await cfListDnsRecords(env, env.ZONE_ID, fqdn)
    if (records.length > 0) {
      throw new ApiError(409, "该子域名已被使用，无法分配", "CONFLICT")
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
    // CF 查询失败不阻断创建，DNS 同步时会暴露冲突
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
    ).bind(id, user.id, name, fqdn, now),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'subdomain.create', ?, ?)"
    ).bind(uuid(), user.id, `创建子域名 ${fqdn}`, now),
  ])

  const row = await env.DB.prepare("SELECT * FROM subdomains WHERE id = ?")
    .bind(id)
    .first<SubdomainRow>()

  return json({ subdomain: toPublicSubdomain(row!) }, 201)
}

// DELETE /api/subdomains/:id —— 删除子域名（主域名不可删；其 DNS 记录会级联删除）
export async function deleteSubdomain(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const existing = await env.DB.prepare("SELECT * FROM subdomains WHERE id = ?")
    .bind(id)
    .first<SubdomainRow>()

  if (!existing || existing.user_id !== user.id) {
    throw new ApiError(404, "子域名不存在", "NOT_FOUND")
  }
  if (existing.name === "@") {
    throw new ApiError(400, "主域名不可删除", "PRIMARY_SUBDOMAIN")
  }

  // 先清掉 Cloudflare 上的 DNS 记录，再删本地行（本地行会级联删除 dns_records）。
  // 若只删本地：CF 上的记录会继续解析，且 createSubdomain 的冲突检测
  // （cfListDnsRecords）会永久拒绝该名字重新分配。
  const records = await env.DB.prepare(
    "SELECT cf_id FROM dns_records WHERE subdomain_id = ? AND cf_id IS NOT NULL"
  )
    .bind(id)
    .all<{ cf_id: string }>()

  const domain = await env.DB.prepare(
    "SELECT zone_id FROM domains WHERE user_id = ? LIMIT 1"
  )
    .bind(user.id)
    .first<{ zone_id: string | null }>()

  for (const record of records.results ?? []) {
    try {
      await cfDeleteDnsRecord(env, domain?.zone_id ?? env.ZONE_ID, record.cf_id)
    } catch (err) {
      // 单条失败不阻断删除（可能是已在 CF 侧被手工删除）
      console.error("删除 Cloudflare DNS 记录失败:", record.cf_id, err)
    }
  }

  await env.DB.prepare("DELETE FROM subdomains WHERE id = ?").bind(id).run()
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'subdomain.delete', ?, ?)"
  ).bind(uuid(), user.id, `删除子域名 ${existing.fqdn}（清理 ${records.results?.length ?? 0} 条 DNS）`, new Date().toISOString()).run()

  return new Response(null, { status: 204 })
}