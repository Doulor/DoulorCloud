import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { isReservedName, isReservedSubdomain } from "../reserved-names"
import { requireUser, isPrivileged } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { isAdminApiRequest } from "../api-source"
import { cfListDnsRecords, cfDeleteDnsRecord } from "../cloudflare"
import { detachCustomDomain } from "../custom-domain"
import { getSettingNumber } from "../settings"
import { pickRootDomain, zoneIdForFqdn, listEnabledRootDomains, canUseRootDomain } from "../root-domains"
import { userPermissions } from "../permissions"
import type { Env } from "../env"

/**
 * 子域名与子子域名。
 *
 * 层级：ruben.doulor.cn 之下可再建 profile.ruben.doulor.cn，依此类推。
 * 配额：一级（含 '@' 主域名）最多 5 个；**每个**子域名之下再各最多 5 个。
 * fqdn 始终存完整域名，因此 DNS 记录、名片/网盘绑定等既有逻辑无需改动。
 */
/** 一级子域名默认配额（真实值取自 app_settings.subdomain_quota_default） */
/** 每个一级之下可再建的子域名数 */
const MAX_CHILDREN = 5
/** 一级子域名的最短长度（x.doulor.cn / xx.doulor.cn 不允许） */
const MIN_ROOT_NAME_LENGTH = 3
/** 表示「无限制」的哨兵值（管理员不受配额约束）。前端见到它应显示「不限」 */
const ADMIN_UNLIMITED = 999999

interface SubdomainRow {
  id: string
  user_id: string
  name: string
  fqdn: string
  parent_id: string | null
  status: string
  created_at: string
}

function toPublicSubdomain(row: SubdomainRow, recordCount = 0) {
  return {
    id: row.id,
    name: row.name,
    fqdn: row.fqdn,
    parentId: row.parent_id ?? null,
    status: row.status,
    /**
     * 该域名下**直接挂的** DNS 记录数（不含子子域名的）。
     *
     * 为什么只算直接的：列表里每个子域名各有自己一行（缩进表示层级），
     * 若父行把后代的记录也算进去，「父行 5 条 + 子行 3 条」会让人以为
     * 一共有 8 条，而实际只有 5 条。各算各的才对得上每行点进去看到的列表。
     */
    recordCount,
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

  // 每个子域名各有多少条 DNS 记录。
  //
  // 为什么一次 GROUP BY 而不是逐个 COUNT：这是列表页，子域名可能有十几个，
  // 逐个查就是 N+1（每次 D1 查询都计费且要往返）。一条聚合查询拿全量，
  // JOIN 到 subdomains 是为了只统计当前用户的（dns_records 是全表）。
  const counts = await env.DB.prepare(
    `SELECT r.subdomain_id AS sid, COUNT(*) AS c
       FROM dns_records r
       JOIN subdomains s ON s.id = r.subdomain_id
      WHERE s.user_id = ?
      GROUP BY r.subdomain_id`
  )
    .bind(user.id)
    .all<{ sid: string; c: number }>()
  const countBySub = new Map(
    (counts.results ?? []).map((r) => [r.sid, Number(r.c ?? 0)])
  )

  // 实际配额：用户级覆盖 > 全局设置 > 默认值（管理员不受限）
  const perUser = await env.DB.prepare(
    "SELECT max_subdomains FROM users WHERE id = ?"
  )
    .bind(user.id)
    .first<{ max_subdomains: number | null }>()
  const limit =
    isPrivileged(user.role)
      ? ADMIN_UNLIMITED
      : (perUser?.max_subdomains ??
         (await getSettingNumber(env, "subdomain_quota_default")))

  // 可选根域：只给**当前用户有权限用的**那些，前端据此渲染「建在哪个域名下」。
  // 没权限的域（如未解锁 doulor 权限时的 doulor.cn）直接不下发 ——
  // 让前端先显示再拒绝，只会让人以为坏了。
  const perms = userPermissions(user)
  const roots = (await listEnabledRootDomains(env))
    .filter((r) => canUseRootDomain(perms, r))
    .map((r) => ({
      name: r.name,
      label: r.label ?? r.name,
      isDefault: r.is_default === 1,
    }))

  return json({
    subdomains: (rows.results ?? []).map((r) =>
      toPublicSubdomain(r, countBySub.get(r.id) ?? 0)
    ),
    limit,
    childLimit: MAX_CHILDREN,
    minRootNameLength: MIN_ROOT_NAME_LENGTH,
    rootDomains: roots,
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
  // 管理员 Key 的公开 API 调用：不限速、不限配额（2026-10-07）。
  // 标记头由入口剥过客户端伪造版本，见 api-source.ts::stripInternalHeaders。
  const adminApi = isAdminApiRequest(request)
  // ⚠️ 2026-09-26 审计：创建会调 cfListDnsRecords 查 CF，原先零限流。
  if (!adminApi) {
    await guardRateLimit(env, `subdomain:create:user:${user.id}`, 10, 60, "创建子域名过于频繁，请稍后再试")
  }
  const body = (await request.json()) as {
    name?: string
    parentId?: string
    /** 一级子域名建在哪个根域下（省略 = 默认域）；二级由父级决定，忽略此项 */
    rootDomain?: string
  }

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
  let fqdn: string

  if (body.parentId) {
    // ---- 二级及以下：yyy.xxx.doulor.cn ----
    parent = await env.DB.prepare(
      "SELECT * FROM subdomains WHERE id = ? AND user_id = ?"
    )
      .bind(body.parentId, user.id)
      .first<SubdomainRow>()
    if (!parent) throw new ApiError(404, "父级子域名不存在", "NOT_FOUND")

    // 二级不限位数（用户明确要求：x.xxx.doulor.cn 是允许的）
    const siblings = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subdomains WHERE parent_id = ?"
    )
      .bind(parent.id)
      .first<{ c: number }>()
    if (!adminApi && !isPrivileged(user.role) && (siblings?.c ?? 0) >= MAX_CHILDREN) {
      throw new ApiError(
        400,
        `${parent.fqdn} 之下最多可创建 ${MAX_CHILDREN} 个子域名`,
        "LIMIT_REACHED"
      )
    }

    // 管理员的保留名单只约束一级（二级是用户自己的细分空间）
    fqdn = `${name}.${parent.fqdn}`
  } else {
    // ---- 一级：xxx.doulor.cn（根域直系）----
    // 位数限制：x.doulor.cn / xx.doulor.cn 不允许，至少 3 位（管理员不受限）
    if (!isPrivileged(user.role) && name.length < MIN_ROOT_NAME_LENGTH) {
      throw new ApiError(
        400,
        `一级子域名至少需要 ${MIN_ROOT_NAME_LENGTH} 个字符`,
        "NAME_TOO_SHORT"
      )
    }

    // 管理员的保留名单：即使位数合规也拒绝
    if (await isReservedSubdomain(env.DB, name)) {
      throw new ApiError(400, "该子域名已被保留", "RESERVED_SUBDOMAIN")
    }

    // 配额：用户级覆盖优先，否则用全局设置（默认 5）
    const perUser = await env.DB.prepare(
      "SELECT max_subdomains FROM users WHERE id = ?"
    )
      .bind(user.id)
      .first<{ max_subdomains: number | null }>()

    const globalQuota = await getSettingNumber(env, "subdomain_quota_default")
    // 管理员/站长不受配额限制（用一个足够大的数字表示「无限制」，前端据此显示）
    const quota =
      isPrivileged(user.role)
        ? ADMIN_UNLIMITED
        : (perUser?.max_subdomains ?? globalQuota)

    // 一级数量 = 该用户名下所有「根域直系」的域名（含注册时分配的 'xxx.doulor.cn' 主域名）
    const used = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ? AND parent_id IS NULL"
    )
      .bind(user.id)
      .first<{ c: number }>()
    if (!adminApi && !isPrivileged(user.role) && (used?.c ?? 0) >= quota) {
      throw new ApiError(
        400,
        `最多可创建 ${quota} 个一级子域名（当前 ${used?.c ?? 0} 个）`,
        "LIMIT_REACHED"
      )
    }

    // 选根域：省略 = 默认域（tyu.me）；显式指定则要过权限闸
    // （doulor.cn 挂 `doulor` 权限，没解锁的人拿不到）。
    const root = await pickRootDomain(env, body.rootDomain, userPermissions(user))
    fqdn = `${name}.${root.name}`
  }

  const exists = await env.DB.prepare(
    "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first()
  if (exists) {
    throw new ApiError(409, "该子域名已被占用", "CONFLICT")
  }

  // 平台外冲突：该 zone 上已有同名记录（如你的其它项目），不得发放
  try {
    const zoneId = await zoneIdForFqdn(env, fqdn)
    const records = await cfListDnsRecords(env, zoneId, fqdn)
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
  // ⚠️ 2026-09-26 审计：删除会遍历全部后代并逐个 detachCustomDomain（删 Route + DNS），
  // 是本次几个接口里最重的，原先零限流。管理员 Key 不限速。
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(env, `subdomain:delete:user:${user.id}`, 10, 60, "删除子域名过于频繁，请稍后再试")
  }
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

  // ⚠️ 2026-09-25 审计（M13）：上面只清理了 `dns_records` 里**有登记**的记录。
  // 但绑定自定义域名时自动创建的占位解析（AAAA 100::）与 Worker Route
  // **从不写入 dns_records**，所以删掉子域名后它们仍然留在 Cloudflare：
  //   1. 该 fqdn 继续解析到本站、Route 继续指向本 Worker —— 名字被删了却还在服务；
  //   2. createSubdomain 的 CF 冲突检测会认为它仍被占用，
  //      于是这个域名**连原主人都再也分配不回来**。
  // 对每个待删子域名补一次完整的解绑（Route + 占位 DNS）。
  // 失败不阻断：删除本身是用户意图，CF 侧的残留可以再修。
  for (const subId of toDelete) {
    const sub = byId.get(subId)
    if (!sub) continue
    try {
      await detachCustomDomain(env, sub.fqdn)
    } catch (err) {
      console.error("删除子域名时解绑自定义域名失败:", sub.fqdn, err)
    }
  }

  // 名片与网盘直链都记了 fqdn：`subdomain_id` 会随外键置空，但 `fqdn` 不会，
  // 留下的话这个域名会被 M14a/M14b 的互斥检查永久占用。
  const ids = [...toDelete]
  const placeholders = ids.map(() => "?").join(",")
  if (ids.length > 0) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE profiles SET fqdn = NULL, subdomain_id = NULL WHERE subdomain_id IN (${placeholders})`
      ).bind(...ids),
      env.DB.prepare(
        `DELETE FROM storage_prefixes WHERE subdomain_id IN (${placeholders})`
      ).bind(...ids),
    ])
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