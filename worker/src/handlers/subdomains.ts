import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { isReservedName } from "../reserved-names"
import { requireUser } from "../auth"
import { cfListDnsRecords, cfDeleteDnsRecord } from "../cloudflare"
import type { Env } from "../env"

/**
 * 子域名与子子域名。
 *
 * 层级：ruben.doulor.cn 之下可再建 profile.ruben.doulor.cn，依此类推。
 * 配额：一级（含 '@' 主域名）最多 5 个；**每个**子域名之下再各最多 5 个。
 * fqdn 始终存完整域名，因此 DNS 记录、名片/网盘绑定等既有逻辑无需改动。
 */
const MAX_ROOT_SUBDOMAINS = 5
const MAX_CHILDREN = 5

interface SubdomainRow {
  id: string
  user_id: string
  name: string
  fqdn: string
  parent_id: string | null
  status: string
  created_at: string
}

function toPublicSubdomain(row: SubdomainRow) {
  return {
    id: row.id,
    name: row.name,
    fqdn: row.fqdn,
    parentId: row.parent_id ?? null,
    status: row.status,
    createdAt: row.created_at,
  }
}

// GET /api/subdomains —— 当前用户的子域名列表（含层级与各层配额）
export async function listSubdomains(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM subdomains WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all<SubdomainRow>()

  return json({
    subdomains: (rows.results ?? []).map(toPublicSubdomain),
    limit: MAX_ROOT_SUBDOMAINS,
    childLimit: MAX_CHILDREN,
  })
}

/**
 * POST /api/subdomains
 * body: { name, parentId? }
 *   parentId 省略 → 创建一级子域名（xxx.doulor.cn）
 *   parentId 指定 → 创建该子域名之下的子子域名（yyy.xxx.doulor.cn）
 */
export async function createSubdomain(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { name?: string; parentId?: string }

  const name = (body.name ?? "").trim().toLowerCase().replace(/\.$/, "")
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new ApiError(400, "子域名只能包含小写字母、数字和连字符", "INVALID_NAME")
  }
  // 防止占走平台自身入口（mail/api/www…）；绑定直链域名时还会创建
  // Worker Route <fqdn>/*，占用 mail 会把本站静态页面挡掉
  if (isReservedName(name)) {
    throw new ApiError(400, "该子域名为系统保留名称", "RESERVED_NAME")
  }

  // 解析父级（可选）
  let parent: SubdomainRow | null = null
  if (body.parentId) {
    parent = await env.DB.prepare(
      "SELECT * FROM subdomains WHERE id = ? AND user_id = ?"
    )
      .bind(body.parentId, user.id)
      .first<SubdomainRow>()
    if (!parent) throw new ApiError(404, "父级子域名不存在", "NOT_FOUND")

    // 父级本身是 '@' 主域名时，其下创建的就是一级子域名（配额按一级算）
    const siblings = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subdomains WHERE parent_id = ?"
    )
      .bind(parent.id)
      .first<{ c: number }>()

    if ((siblings?.c ?? 0) >= MAX_CHILDREN) {
      throw new ApiError(
        400,
        `${parent.name} 之下最多可创建 ${MAX_CHILDREN} 个子域名`,
        "LIMIT_REACHED"
      )
    }
  } else {
    // 一级：统计 parent_id 为 NULL 的数量（含 '@' 主域名）
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ? AND parent_id IS NULL"
    )
      .bind(user.id)
      .first<{ c: number }>()

    if ((count?.c ?? 0) >= MAX_ROOT_SUBDOMAINS) {
      throw new ApiError(
        400,
        `最多可拥有 ${MAX_ROOT_SUBDOMAINS} 个一级子域名（含主域名）`,
        "LIMIT_REACHED"
      )
    }

    // 一级子域名挂在用户的命名空间之下：name.<用户名>.doulor.cn
    // （不是 name.doulor.cn —— 那是根域直系，属于平台自身，不能发给用户）
    parent = await env.DB.prepare(
      "SELECT * FROM subdomains WHERE user_id = ? AND name = '@' LIMIT 1"
    )
      .bind(user.id)
      .first<SubdomainRow>()
    if (!parent) {
      throw new ApiError(400, "尚未分配主域名，无法创建子域名", "NO_PRIMARY_DOMAIN")
    }
  }

  // 完整域名：一级是 name.<用户名>.doulor.cn；子级是 name.<父 fqdn>
  const fqdn = `${name}.${parent.fqdn}`

  const exists = await env.DB.prepare(
    "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first()
  if (exists) {
    throw new ApiError(409, "该子域名已被占用", "CONFLICT")
  }

  // 平台外冲突：doulor.cn zone 上已有该名称的记录（如你的其它项目），不得发放
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
      "INSERT INTO subdomains (id, user_id, name, fqdn, parent_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"
    ).bind(id, user.id, name, fqdn, parent?.id ?? null, now),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'subdomain.create', ?, ?)"
    ).bind(uuid(), user.id, `创建子域名 ${fqdn}`, now),
  ])

  const row = await env.DB.prepare("SELECT * FROM subdomains WHERE id = ?")
    .bind(id)
    .first<SubdomainRow>()

  return json({ subdomain: toPublicSubdomain(row!) }, 201)
}

// DELETE /api/subdomains/:id —— 删除子域名（主域名不可删；其后代级联删除）
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

  // 连同所有后代一起收集（含自己），逐个清理 CF 上的 DNS 记录
  const all = await env.DB.prepare(
    "SELECT id, fqdn FROM subdomains WHERE user_id = ?"
  )
    .bind(user.id)
    .all<{ id: string; fqdn: string }>()

  const byId = new Map((all.results ?? []).map((r) => [r.id, r]))
  const toDelete = new Set<string>([id])
  // 反复扫描：父级在待删集合中的也一并加入（处理多层嵌套）
  let grew = true
  while (grew) {
    grew = false
    const allRows = await env.DB.prepare(
      "SELECT id, parent_id FROM subdomains WHERE user_id = ?"
    )
      .bind(user.id)
      .all<{ id: string; parent_id: string | null }>()
    for (const r of allRows.results ?? []) {
      if (r.parent_id && toDelete.has(r.parent_id) && !toDelete.has(r.id)) {
        toDelete.add(r.id)
        grew = true
      }
    }
  }

  const domain = await env.DB.prepare(
    "SELECT zone_id FROM domains WHERE user_id = ? LIMIT 1"
  )
    .bind(user.id)
    .first<{ zone_id: string | null }>()

  let cleaned = 0
  for (const subId of toDelete) {
    const sub = byId.get(subId)
    if (!sub) continue
    const records = await env.DB.prepare(
      "SELECT cf_id FROM dns_records WHERE subdomain_id = ? AND cf_id IS NOT NULL"
    )
      .bind(subId)
      .all<{ cf_id: string }>()
    for (const record of records.results ?? []) {
      try {
        await cfDeleteDnsRecord(env, domain?.zone_id ?? env.ZONE_ID, record.cf_id)
        cleaned++
      } catch (err) {
        // 单条失败不阻断删除（可能是已在 CF 侧被手工删除）
        console.error("删除 Cloudflare DNS 记录失败:", record.cf_id, err)
      }
    }
  }

  // 删父行即可级联删除后代（parent_id 上有 ON DELETE CASCADE）
  await env.DB.prepare("DELETE FROM subdomains WHERE id = ?").bind(id).run()
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'subdomain.delete', ?, ?)"
  )
    .bind(
      uuid(),
      user.id,
      `删除子域名 ${existing.fqdn}（含 ${toDelete.size - 1} 个下级，清理 ${cleaned} 条 DNS）`,
      new Date().toISOString()
    )
    .run()

  return new Response(null, { status: 204 })
}