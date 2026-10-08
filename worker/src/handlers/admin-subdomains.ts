/**
 * 管理面板 → 子域名管理（2026-10-07 新增，与 DNS 解析合并为「子域名」板块）。
 *
 * 为什么需要这套接口：
 *   用户侧 `/api/subdomains` 只能管自己的域名，配额、保留名、权限域都由本人
 *   身份决定。站长要做的是**代替平台处置**——给某个用户补发一个域名、把滥用
 *   的域名删掉、把域名转给别人、改掉用户填错的名字。这些动作的共同点是
 *   「目标用户不是当前登录人」，所以整套接口按 `dns` 管理scope 鉴权，
 *   并在审计里写明操作者与目标。
 *
 * 四个能力：
 *   · 全站列表   —— 跨用户、带归属与记录数、可搜索
 *   · 代建       —— 给指定用户建一级/子子域名（绕过配额，但保留名单与冲突照查）
 *   · 代删       —— 删任意用户的域名（级联清理与用户侧一致）
 *   · 改名/转移  —— 改名会级联更新 fqdn、DNS 记录、名片/网盘绑定与 CF 侧；
 *                   转移把整棵子树交给另一个用户
 *
 * ⚠️ 改名是四个操作里最重的：fqdn 是**冗余存储**的（子域名、DNS 记录、名片、
 *    网盘直链各存一份全路径），Cloudflare 上的记录名也要跟着改。任何一处漏改
 *    都会出现「数据库说在 bar.tyu.me，解析还指向 foo.tyu.me」的半瘫状态，
 *    所以这里的实现是显式枚举每一处、逐项更新，而不是只改一行 subdomains。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireAdminScope } from "./admin"
import { isReservedName, isReservedSubdomain } from "../reserved-names"
import { guardRateLimit } from "../ratelimit"
import { cfDeleteDnsRecord, cfListDnsRecords, cfUpdateDnsRecord } from "../cloudflare"
import { attachCustomDomain, detachCustomDomain } from "../custom-domain"
import { pickRootDomain, zoneIdForFqdn, listEnabledRootDomains } from "../root-domains"
import { audit as recordAudit } from "../settings"
import { likeContains } from "../sql-like"
import { allPermissions } from "../permissions"
import type { Env } from "../env"

interface SubdomainRow {
  id: string
  user_id: string
  name: string
  fqdn: string
  parent_id: string | null
  status: string
  created_at: string
}

interface OwnerRow {
  id: string
  username: string
  email: string
  status: string
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** 列表单行（含归属用户） */
interface AdminSubdomainView {
  id: string
  name: string
  fqdn: string
  parentId: string | null
  parentFqdn: string | null
  status: string
  /** 该域名下直接挂的 DNS 记录数（不含子子域名的） */
  recordCount: number
  createdAt: string
  owner: { id: string; username: string; email: string; status: string }
}

// GET /api/admin/subdomains —— 全站子域名列表（跨用户）
export async function listAdminSubdomains(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  const url = new URL(request.url)
  const q = (url.searchParams.get("q") ?? "").trim()
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page")) || 1))
  const pageSize = Math.min(
    Math.max(1, Math.trunc(Number(url.searchParams.get("pageSize")) || 20)),
    100
  )

  const where: string[] = []
  const binds: unknown[] = []
  if (q) {
    // 域名 / 用户名 / 邮箱都能搜 —— 站长手里通常只有其中一条线索
    where.push("(s.fqdn LIKE ? OR u.username LIKE ? OR u.email LIKE ?)")
    const like = likeContains(q)
    binds.push(like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM subdomains s JOIN users u ON u.id = s.user_id ${whereSql}`
  )
    .bind(...binds)
    .first<{ c: number }>()

  const rows = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.name, s.fqdn, s.parent_id, s.status, s.created_at,
            u.username, u.email, u.status AS user_status,
            p.fqdn AS parent_fqdn
       FROM subdomains s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN subdomains p ON p.id = s.parent_id
       ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all<{
      id: string
      user_id: string
      name: string
      fqdn: string
      parent_id: string | null
      status: string
      created_at: string
      username: string
      email: string
      user_status: string
      parent_fqdn: string | null
    }>()

  // 记录数一次聚合拿全（避免 N+1）；只统计本页这些域名直接挂的记录
  const ids = (rows.results ?? []).map((r) => r.id)
  const countBySub = new Map<string, number>()
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",")
    const counts = await env.DB.prepare(
      `SELECT subdomain_id AS sid, COUNT(*) AS c
         FROM dns_records
        WHERE subdomain_id IN (${placeholders})
        GROUP BY subdomain_id`
    )
      .bind(...ids)
      .all<{ sid: string; c: number }>()
    for (const r of counts.results ?? []) countBySub.set(r.sid, Number(r.c ?? 0))
  }

  const subdomains: AdminSubdomainView[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    fqdn: r.fqdn,
    parentId: r.parent_id ?? null,
    parentFqdn: r.parent_fqdn ?? null,
    status: r.status,
    recordCount: countBySub.get(r.id) ?? 0,
    createdAt: r.created_at,
    owner: { id: r.user_id, username: r.username, email: r.email, status: r.user_status },
  }))

  return json({
    subdomains,
    total: Number(totalRow?.c ?? 0),
    page,
    pageSize,
    // 代建一级子域名时可选哪些根域（只给已启用的；管理员代建不按目标用户
    // 的权限域过滤，所以这里也不需要带 requires_feature）
    rootDomains: (await listEnabledRootDomains(env)).map((r) => ({
      name: r.name,
      label: r.label ?? r.name,
    })),
  })
}

/**
 * GET /api/admin/subdomains/owners?q= —— 归属用户联想搜索。
 *
 * 为什么不做在列表接口里：用户表有上千行，代建/转移时只需要「搜出来挑一个」，
 * 全量拉回来既慢又占内存。这里按 dns 权限自足，不依赖 users.view。
 */
export async function searchSubdomainOwners(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  const url = new URL(request.url)
  const q = (url.searchParams.get("q") ?? "").trim()
  const like = likeContains(q)
  const rows = await env.DB.prepare(
    `SELECT id, username, email, status FROM users
      WHERE username LIKE ? OR email LIKE ?
      ORDER BY created_at DESC
      LIMIT 20`
  )
    .bind(like, like)
    .all<OwnerRow>()
  return json({ owners: rows.results ?? [] })
}

/** 按 userId 或 username 找归属用户（代建/转移时用） */
async function resolveOwner(
  env: Env,
  userId: string | undefined,
  username: string | undefined
): Promise<OwnerRow> {
  if (userId) {
    const row = await env.DB.prepare(
      "SELECT id, username, email, status FROM users WHERE id = ?"
    )
      .bind(userId)
      .first<OwnerRow>()
    if (!row) throw new ApiError(404, "目标用户不存在", "USER_NOT_FOUND")
    return row
  }
  if (username) {
    const row = await env.DB.prepare(
      "SELECT id, username, email, status FROM users WHERE username = ? COLLATE NOCASE"
    )
      .bind(username)
      .first<OwnerRow>()
    if (!row) throw new ApiError(404, "目标用户不存在", "USER_NOT_FOUND")
    return row
  }
  throw new ApiError(400, "请指定归属用户（userId 或 username）", "OWNER_REQUIRED")
}

// POST /api/admin/subdomains —— 代替指定用户创建子域名
// body: { userId?|username?, name, parentId?, rootDomain? }
export async function createAdminSubdomain(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  await guardRateLimit(env, `subdomain:admin:create:${admin.id}`, 30, 60, "操作过于频繁，请稍后再试")

  const body = (await request.json()) as {
    userId?: string
    username?: string
    name?: string
    parentId?: string
    rootDomain?: string
  }

  const name = (body.name ?? "").trim().toLowerCase().replace(/\.$/, "")
  if (!NAME_RE.test(name)) {
    throw new ApiError(400, "子域名只能包含小写字母、数字和连字符", "INVALID_NAME")
  }
  // 占住 mail/api/www 会把本站入口挡掉，管理员代建也一样不能碰
  if (isReservedName(name)) {
    throw new ApiError(400, "该子域名为系统保留名称", "RESERVED_NAME")
  }

  let owner: OwnerRow
  let parent: SubdomainRow | null = null
  let fqdn: string

  if (body.parentId) {
    // ---- 子子域名：层级归属优先于显式传的 owner ----
    // 父级属于谁，新域名就归谁：否则会出现「子树里混着两个owner」，
    // 之后任何按 user_id 查父级的逻辑都会 404。
    parent = await env.DB.prepare("SELECT * FROM subdomains WHERE id = ?")
      .bind(body.parentId)
      .first<SubdomainRow>()
    if (!parent) throw new ApiError(404, "父级子域名不存在", "NOT_FOUND")
    owner = await resolveOwner(env, parent.user_id, undefined)
    if (
      (body.userId && body.userId !== owner.id) ||
      (body.username && body.username.toLowerCase() !== owner.username.toLowerCase())
    ) {
      throw new ApiError(400, `父级 ${parent.fqdn} 属于 ${owner.username}，不能建在其他人名下`, "OWNER_MISMATCH")
    }
    fqdn = `${name}.${parent.fqdn}`
  } else {
    // ---- 一级：归属用户必填；根域由管理员选 ----
    owner = await resolveOwner(env, body.userId, body.username)
    if (await isReservedSubdomain(env.DB, name)) {
      throw new ApiError(400, "该子域名已被保留", "RESERVED_SUBDOMAIN")
    }
    // 管理员代建 = 平台显式授予，**不按目标用户的权限域过滤**（否则想给
    // 没解锁 doulor 权限的用户发 xxx.doulor.cn 都发不了）。根域仍必须已启用。
    const root = await pickRootDomain(env, body.rootDomain, allPermissions())
    fqdn = `${name}.${root.name}`
  }

  const exists = await env.DB.prepare(
    "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first()
  if (exists) throw new ApiError(409, "该子域名已被占用", "CONFLICT")

  // 平台外冲突：zone 上已有同名记录则不得发放（与用户侧一致）
  try {
    const zoneId = await zoneIdForFqdn(env, fqdn)
    const records = await cfListDnsRecords(env, zoneId, fqdn)
    if (records.length > 0) {
      throw new ApiError(409, "该子域名已被使用，无法分配", "CONFLICT")
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
    // CF 查询失败不阻断，DNS 同步时会暴露冲突
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO subdomains (id, user_id, name, fqdn, parent_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"
    ).bind(id, owner.id, name, fqdn, parent?.id ?? null, now),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'subdomain.admin.create', ?, ?, ?)"
    ).bind(
      uuid(),
      owner.id,
      `管理员 ${admin.username} 代建子域名 ${fqdn}`,
      request.headers.get("CF-Connecting-IP"),
      now
    ),
  ])

  return json(
    {
      subdomain: {
        id,
        name,
        fqdn,
        parentId: parent?.id ?? null,
        status: "active",
        createdAt: now,
        owner: { id: owner.id, username: owner.username, email: owner.email },
      },
    },
    201
  )
}

// PUT /api/admin/subdomains/:id —— 改名 / 转移所有者（可同时）
// body: { name?, userId?|username? }
export async function updateAdminSubdomain(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  await guardRateLimit(env, `subdomain:admin:update:${admin.id}`, 30, 60, "操作过于频繁，请稍后再试")

  const body = (await request.json()) as { name?: string; userId?: string; username?: string }
  const wantsRename = typeof body.name === "string" && body.name.trim() !== ""
  const wantsTransfer = Boolean(body.userId || body.username)
  if (!wantsRename && !wantsTransfer) {
    throw new ApiError(400, "没有需要修改的内容", "NOTHING_TO_UPDATE")
  }

  const row = await env.DB.prepare("SELECT * FROM subdomains WHERE id = ?")
    .bind(id)
    .first<SubdomainRow>()
  if (!row) throw new ApiError(404, "子域名不存在", "NOT_FOUND")

  // 转移后的当前归属（同名请求里「先转移再改名」时，改名审计要记在新归属下）
  let ownerId = row.user_id

  // ---- 转移 ----
  if (wantsTransfer) {
    const next = await resolveOwner(env, body.userId, body.username)
    if (next.id !== row.user_id) {
      // 整棵子树一起转：子子域名的父级查询带 user_id，只转父行会让子树变成孤儿
      const all = await env.DB.prepare(
        "SELECT id, parent_id FROM subdomains WHERE user_id = ?"
      )
        .bind(row.user_id)
        .all<{ id: string; parent_id: string | null }>()
      const move = new Set<string>([row.id])
      let grew = true
      while (grew) {
        grew = false
        for (const r of all.results ?? []) {
          if (r.parent_id && move.has(r.parent_id) && !move.has(r.id)) {
            move.add(r.id)
            grew = true
          }
        }
      }
      const ids = [...move]
      const placeholders = ids.map(() => "?").join(",")
      await env.DB.prepare(`UPDATE subdomains SET user_id = ? WHERE id IN (${placeholders})`)
        .bind(next.id, ...ids)
        .run()
      ownerId = next.id
      await recordAudit(
        env,
        next.id,
        "subdomain.admin.transfer",
        `管理员 ${admin.username} 把 ${move.size} 个域名（${row.fqdn} 起）转移给 ${next.username}`,
        request.headers.get("CF-Connecting-IP")
      )
    }
  }

  // ---- 改名 ----
  if (wantsRename) {
    const nextName = body.name!.trim().toLowerCase().replace(/\.$/, "")
    if (!NAME_RE.test(nextName)) {
      throw new ApiError(400, "子域名只能包含小写字母、数字和连字符", "INVALID_NAME")
    }
    if (nextName === row.name) {
      throw new ApiError(400, "新名字与当前相同", "NAME_UNCHANGED")
    }
    if (isReservedName(nextName)) {
      throw new ApiError(400, "该子域名为系统保留名称", "RESERVED_NAME")
    }
    // 保留名单只约束一级；子子域名是用户自己的细分空间
    if (!row.parent_id && (await isReservedSubdomain(env.DB, nextName))) {
      throw new ApiError(400, "该子域名已被保留", "RESERVED_SUBDOMAIN")
    }
    // fqdn = `<name>.<根域或父级路径>`，换名字 = 换第一段
    const nextFqdn = `${nextName}.${row.fqdn.slice(row.name.length + 1)}`

    const exists = await env.DB.prepare(
      "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE AND id != ? LIMIT 1"
    )
      .bind(nextFqdn, id)
      .first()
    if (exists) throw new ApiError(409, "该子域名已被占用", "CONFLICT")

    // 收集整棵子树（自己 + 所有后代），fqdn 全部要换后缀
    const all = await env.DB.prepare("SELECT id, parent_id, name, fqdn FROM subdomains")
      .all<{ id: string; parent_id: string | null; name: string; fqdn: string }>()
    const byId = new Map((all.results ?? []).map((r) => [r.id, r]))
    const subtree = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const r of all.results ?? []) {
        if (r.parent_id && subtree.has(r.parent_id) && !subtree.has(r.id)) {
          subtree.add(r.id)
          grew = true
        }
      }
    }

    const now = new Date().toISOString()
    // zone 只在真有 CF 记录要改时才解析（懒加载）：解析失败不该让
    // 「只是改个名字、名下没有任何解析」的操作失败
    let zoneId: string | null = null
    const ensureZone = async (): Promise<string> => {
      if (!zoneId) zoneId = await zoneIdForFqdn(env, nextFqdn)
      return zoneId
    }

    // 1) subdomains：被改名的节点换 name + fqdn；后代只换 fqdn 后缀
    for (const subId of subtree) {
      const sub = byId.get(subId)
      if (!sub) continue
      const isSelf = subId === id
      const subNextFqdn = isSelf ? nextFqdn : replaceSuffix(sub.fqdn, row.fqdn, nextFqdn)
      if (!subNextFqdn) continue
      await env.DB.prepare(
        isSelf
          ? "UPDATE subdomains SET name = ?, fqdn = ? WHERE id = ?"
          : "UPDATE subdomains SET fqdn = ? WHERE id = ?"
      )
        .bind(...(isSelf ? [nextName, subNextFqdn, subId] : [subNextFqdn, subId]))
        .run()
    }

    // 2) dns_records：fqdn 后缀跟着换；CF 上有登记的连记录名一起改
    const subIds = [...subtree]
    const placeholders = subIds.map(() => "?").join(",")
    const records = await env.DB.prepare(
      `SELECT id, fqdn, type, content, ttl, proxied, priority, cf_id,
              srv_weight, srv_port, srv_target
         FROM dns_records
        WHERE subdomain_id IN (${placeholders})`
    )
      .bind(...subIds)
      .all<{
        id: string
        fqdn: string
        type: string
        content: string
        ttl: number
        proxied: number
        priority: number | null
        cf_id: string | null
        srv_weight: number | null
        srv_port: number | null
        srv_target: string | null
      }>()
    for (const rec of records.results ?? []) {
      const recNextFqdn = replaceSuffix(rec.fqdn, row.fqdn, nextFqdn)
      if (!recNextFqdn) continue
      if (rec.cf_id) {
        try {
          await cfUpdateDnsRecord(env, await ensureZone(), rec.cf_id, {
            type: rec.type,
            name: recNextFqdn,
            ...(rec.type === "SRV"
              ? {
                  data: {
                    priority: rec.priority ?? 10,
                    weight: rec.srv_weight ?? 0,
                    port: rec.srv_port ?? 0,
                    target: rec.srv_target ?? "",
                  },
                }
              : { content: rec.content }),
            ttl: rec.ttl,
            proxied: rec.proxied === 1,
            ...(rec.priority !== null ? { priority: rec.priority } : {}),
          })
        } catch (err) {
          // CF 改失败不阻断：本地先改对，CF 侧差异由「Cloudflare 对账」页暴露
          console.error("改名时更新 Cloudflare 记录失败:", rec.fqdn, err)
        }
      }
      await env.DB.prepare("UPDATE dns_records SET fqdn = ?, updated_at = ? WHERE id = ?")
        .bind(recNextFqdn, now, rec.id)
        .run()
    }

    // 3) 名片 / 网盘直链：fqdn 同样冗余存了全路径。
    //    先按 subdomain_id 记下「哪些域名绑了服务」（fqdn 马上就要被换掉），
    //    再按 fqdn 换字符串
    const boundPairs: { oldFqdn: string; newFqdn: string }[] = []
    const boundProfiles = await env.DB.prepare(
      `SELECT subdomain_id, fqdn FROM profiles WHERE subdomain_id IN (${placeholders}) AND fqdn IS NOT NULL`
    )
      .bind(...subIds)
      .all<{ subdomain_id: string; fqdn: string }>()
    const boundStorage = await env.DB.prepare(
      `SELECT subdomain_id, fqdn FROM storage_prefixes WHERE subdomain_id IN (${placeholders})`
    )
      .bind(...subIds)
      .all<{ subdomain_id: string; fqdn: string }>()
    for (const r of [...(boundProfiles.results ?? []), ...(boundStorage.results ?? [])]) {
      const sub = byId.get(r.subdomain_id)
      if (!sub) continue
      const subNextFqdn =
        r.subdomain_id === id ? nextFqdn : replaceSuffix(sub.fqdn, row.fqdn, nextFqdn)
      if (!subNextFqdn || !r.fqdn.endsWith(sub.fqdn)) continue
      const recNextFqdn = r.fqdn.slice(0, r.fqdn.length - sub.fqdn.length) + subNextFqdn
      boundPairs.push({ oldFqdn: r.fqdn, newFqdn: recNextFqdn })
    }

    await env.DB.prepare(
      `UPDATE profiles SET fqdn = REPLACE(fqdn, ?, ?) WHERE subdomain_id IN (${placeholders})`
    )
      .bind(row.fqdn, nextFqdn, ...subIds)
      .run()
    await env.DB.prepare(
      `UPDATE storage_prefixes SET fqdn = REPLACE(fqdn, ?, ?) WHERE subdomain_id IN (${placeholders})`
    )
      .bind(row.fqdn, nextFqdn, ...subIds)
      .run()

    // 4) Worker Route 是 zone 级资源，不会自己搬家：绑过名片/网盘直链的域名
    //    拆旧挂新，否则新名字解析到了但没人在服务
    const rebound = new Set<string>()
    for (const pair of boundPairs) {
      if (rebound.has(pair.oldFqdn)) continue
      rebound.add(pair.oldFqdn)
      try {
        await detachCustomDomain(env, pair.oldFqdn)
        await attachCustomDomain(env, pair.newFqdn)
      } catch (err) {
        console.error("改名后重绑自定义域名失败:", pair.oldFqdn, "→", pair.newFqdn, err)
      }
    }

    await recordAudit(
      env,
      ownerId,
      "subdomain.admin.rename",
      `管理员 ${admin.username} 把 ${row.fqdn} 改名为 ${nextFqdn}（含 ${subtree.size - 1} 个下级）`,
      request.headers.get("CF-Connecting-IP")
    )
  }

  const fresh = await env.DB.prepare("SELECT * FROM subdomains WHERE id = ?")
    .bind(id)
    .first<SubdomainRow>()
  // 转移之后 owner 可能已经变了，响应用最新归属（与 POST 代建同形状，
  // 前端 adminSubdomainsApi.update() 的返回类型就要求带 owner）
  const freshOwner = await env.DB.prepare("SELECT id, username, email, status FROM users WHERE id = ?")
    .bind(fresh!.user_id)
    .first<OwnerRow>()
  return json({
    subdomain: {
      id: fresh!.id,
      name: fresh!.name,
      fqdn: fresh!.fqdn,
      parentId: fresh!.parent_id ?? null,
      status: fresh!.status,
      createdAt: fresh!.created_at,
      owner: freshOwner
        ? { id: freshOwner.id, username: freshOwner.username, email: freshOwner.email, status: freshOwner.status }
        : undefined,
    },
  })
}

// DELETE /api/admin/subdomains/:id —— 代替任意用户删除（级联清理与用户侧一致）
export async function deleteAdminSubdomain(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  await guardRateLimit(env, `subdomain:admin:delete:${admin.id}`, 30, 60, "操作过于频繁，请稍后再试")

  const existing = await env.DB.prepare("SELECT * FROM subdomains WHERE id = ?")
    .bind(id)
    .first<SubdomainRow>()
  if (!existing) throw new ApiError(404, "子域名不存在", "NOT_FOUND")
  // 主域名（注册时分配的 xxx.doulor.cn）删了会打断邮箱路由，管理员也不例外
  if (existing.name === "@") {
    throw new ApiError(400, "主域名不可删除", "PRIMARY_SUBDOMAIN")
  }

  // 连同所有后代一起收集（含自己）
  const all = await env.DB.prepare("SELECT id, parent_id, fqdn FROM subdomains")
    .all<{ id: string; parent_id: string | null; fqdn: string }>()
  const byId = new Map((all.results ?? []).map((r) => [r.id, r]))
  const toDelete = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const r of all.results ?? []) {
      if (r.parent_id && toDelete.has(r.parent_id) && !toDelete.has(r.id)) {
        toDelete.add(r.id)
        grew = true
      }
    }
  }

  const domain = await env.DB.prepare(
    "SELECT zone_id FROM domains WHERE user_id = ? LIMIT 1"
  )
    .bind(existing.user_id)
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
        console.error("删除 Cloudflare DNS 记录失败:", record.cf_id, err)
      }
    }
  }

  // 补一次完整解绑（Route + 占位 DNS）——这两样从不写进 dns_records
  for (const subId of toDelete) {
    const sub = byId.get(subId)
    if (!sub) continue
    try {
      await detachCustomDomain(env, sub.fqdn)
    } catch (err) {
      console.error("删除子域名时解绑自定义域名失败:", sub.fqdn, err)
    }
  }

  // 名片/网盘直链记了 fqdn：外键会置空 subdomain_id，但 fqdn 不跟着清，
  // 留着会被互斥检查永久占用
  const ids = [...toDelete]
  const placeholders = ids.map(() => "?").join(",")
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE profiles SET fqdn = NULL, subdomain_id = NULL WHERE subdomain_id IN (${placeholders})`
    ).bind(...ids),
    env.DB.prepare(
      `DELETE FROM storage_prefixes WHERE subdomain_id IN (${placeholders})`
    ).bind(...ids),
  ])

  await env.DB.prepare("DELETE FROM subdomains WHERE id = ?").bind(id).run()
  await recordAudit(
    env,
    existing.user_id,
    "subdomain.admin.delete",
    `管理员 ${admin.username} 删除 ${existing.fqdn}（含 ${toDelete.size - 1} 个下级，清理 ${cleaned} 条 DNS）`,
    request.headers.get("CF-Connecting-IP")
  )

  return new Response(null, { status: 204 })
}

/**
 * 把 `fqdn` 末尾的 `oldRoot` 后缀换成 `newRoot`。
 *
 * 例：replaceSuffix("x.foo.tyu.me", "foo.tyu.me", "bar.tyu.me") → "x.bar.tyu.me"
 * 后缀不匹配时返回 null（调用方应跳过而不是写坏数据）。
 */
function replaceSuffix(fqdn: string, oldRoot: string, newRoot: string): string | null {
  if (!fqdn.endsWith(oldRoot)) return null
  const prefix = fqdn.slice(0, fqdn.length - oldRoot.length)
  return prefix + newRoot
}
