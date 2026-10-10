/**
 * 封禁用户时，**停用**其对外生效的资源；解封时**恢复**。
 *
 * 背景（站长 2026-10-08）：封禁此前只做三件事 —— 标记 users.status、
 * 拉黑注册 IP、停用中转站账号。用户自己确实进不来了，但他留下的东西
 * **仍然对外生效**：DNS 解析照常响应、子域名照常可访问、邮箱照常转发、
 * 邀请码照样能把人拉进来。这个模块补上前两项（邮箱与邀请码分别在
 * email-delivery.ts / handlers/auth.ts 里就地校验，不需要改数据）。
 *
 * 两条贯穿始终的原则：
 *
 *   1. **可逆**。停用**不删本地数据** —— DNS 记录的 type/content/ttl/proxied/
 *      priority/srv_* 全部留在 `dns_records`（只清掉 `cf_id`，因为 CF 上的记录
 *      已经删了）。解封时据此重建，用户拿回一模一样的解析。
 *      直接删行的话，解封就只能让用户自己重新配一遍，等于变相毁数据。
 *
 *   2. **不阻断封禁**。Cloudflare 调用可能失败（网络、限流、权限），但
 *      cloud 侧封禁是主操作、必须生效。所以这里**先落本地标记、再尽力删 CF**：
 *      CF 失败的记录会保留 `cf_id`，由维护任务（见 sweepSuspendedDns）重试。
 *      顺序很重要 —— 反过来的话，CF 全挂就等于封禁失败。
 */
import { cfCreateDnsRecord, cfDeleteDnsRecord, type CfDnsRecordPayload } from "./cloudflare"
import { mapLimit } from "./async-utils"
import type { Env } from "./env"

/**
 * 单次处理的上限。
 *
 * 每条记录要发 1 次 Cloudflare 请求。Cloudflare 免费版单请求子请求上限 50，
 * 而封禁这个请求本身已经用掉若干（查用户、审计、NewAPI 同步…），
 * 取 40 留余量。超出的部分**不丢**：它们仍是 `banned_at IS NULL` 的正常记录，
 * 由维护任务在下一轮处理。
 */
const SUSPEND_BATCH = 40
/** 并发度：CF 的 DNS 接口对并发不敏感，8 足够快也不会被限流得太狠 */
const CF_CONCURRENCY = 8

/** 本地 DNS 记录里重建 CF 记录所需的字段 */
interface BannedDnsRow {
  id: string
  domain_id: string
  fqdn: string | null
  name: string
  type: string
  content: string | null
  ttl: number
  proxied: number
  priority: number | null
  srv_weight: number | null
  srv_port: number | null
  srv_target: string | null
  cf_id: string | null
  zone_id: string | null
}

export interface SuspendResult {
  /** 已从 Cloudflare 删除并标记的记录数 */
  dnsSuspended: number
  /** 记录数超过单批上限、留给维护任务的数量 */
  dnsDeferred: number
  /** 标记为停用的子域名数 */
  subdomainsSuspended: number
  errors: string[]
}

/**
 * 「记录归属」判据 SQL 片段：**子域名优先，没有子域名才回退到域名**。
 *
 * ⚠️ 不能写成 `subdomain_id IN (…) OR domain_id IN (…)`：子域名可以被管理员转移
 * （`admin-subdomains.ts` 只改 `subdomains.user_id`，**不动** `dns_records.domain_id`），
 * 于是同一行会同时命中「原主的域名」与「新主的子域名」两侧 —— 停用方向与恢复方向
 * 各认一侧，就会每小时删一次又建一次（2026-10-10 探针实测：3 轮里 sweep 删 6 条、
 * retry 建 9 条，新主的解析每小时断一次）。
 *
 * 归属认子域名，与代码库其余部分一致：用户端列表按 `subdomain_id` 筛
 * （`handlers/dns.ts` 的 records 查询）、改名 / 删除 / 记录计数也全按
 * `subdomain_id`（`handlers/admin-subdomains.ts`）；`domain_id` 只是 zone 指针
 * （`domains` 全仓无转移路径）。`subdomain_id` 为 NULL 的历史行（0003 回填之前）
 * 才回退到域名归属 —— 两个分支互斥，每行只有一个有效归属。
 *
 * @param status 归属用户的状态；调用方需保证查询里 `dns_records` 的别名是 `r`
 */
export function ownerStatusSql(status: "active" | "suspended"): string {
  return (
    `((r.subdomain_id IS NOT NULL AND r.subdomain_id IN (` +
    `SELECT id FROM subdomains WHERE user_id IN (SELECT id FROM users WHERE status = '${status}')))` +
    ` OR (r.subdomain_id IS NULL AND r.domain_id IN (` +
    `SELECT id FROM domains WHERE user_id IN (SELECT id FROM users WHERE status = '${status}'))))`
  )
}

export interface RestoreResult {
  /** 已在 Cloudflare 重建并恢复的记录数 */
  dnsRestored: number
  /** 重建失败、仍留在待处理状态的数量 */
  dnsFailed: number
  /** 恢复的子域名数 */
  subdomainsRestored: number
  errors: string[]
}

/**
 * 把 `dns_records` 的一行还原成 Cloudflare 的写入载荷。
 *
 * ⚠️ SRV 必须走 `data` 对象、其余类型走 `content`（见 Cloudflare 的说明），
 * 传错形态 CF 会直接报参数错误 —— 这就是 `CfDnsRecordPayload` 把 content
 * 标成可选的原因。
 */
function payloadOf(row: BannedDnsRow): CfDnsRecordPayload {
  const base: CfDnsRecordPayload = {
    type: row.type,
    name: row.fqdn || row.name,
    ttl: row.ttl,
    proxied: row.proxied === 1,
  }
  if (row.type === "SRV") {
    base.data = {
      priority: row.priority ?? 0,
      weight: row.srv_weight ?? 0,
      port: row.srv_port ?? 0,
      target: row.srv_target ?? "",
    }
    return base
  }
  base.content = row.content ?? ""
  // MX 与 SRV 共用 priority；其它类型带上它是无害的（CF 会忽略）
  if (row.priority !== null && row.priority !== undefined) base.priority = row.priority
  return base
}

/** CF 删除的「记录本来就不在」类报错 —— 属于幂等成功，不该记成失败 */
function isMissingRecordError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /81044|Record does not exist|\b404\b/i.test(msg)
}

/**
 * 停用该用户**对外生效**的资源：删除 Cloudflare 上的 DNS 记录 + 标记子域名。
 *
 * 调用点：`updateUserHandler` 里 `statusChanged === "suspended"` 分支。
 * 调用方**不要**捕获异常把它当成封禁失败 —— 本函数自己吞掉 CF 错误并记在
 * 返回值的 errors 里（只有本地 SQL 错误才会抛出）。
 */
export async function suspendUserResources(
  env: Env,
  userId: string
): Promise<SuspendResult> {
  const out: SuspendResult = { dnsSuspended: 0, dnsDeferred: 0, subdomainsSuspended: 0, errors: [] }
  const now = new Date().toISOString()

  // 只取还没被停用的：重复封禁、以及「上次 CF 删失败」的行都能正确重试
  // （已标记 banned_at 的交给 sweepSuspendedDns 收尾，这里不重复动）
  const rows = await env.DB.prepare(
    `SELECT r.id, r.domain_id, r.fqdn, r.name, r.type, r.content, r.ttl, r.proxied,
            r.priority, r.srv_weight, r.srv_port, r.srv_target, r.cf_id, d.zone_id
       FROM dns_records r
       LEFT JOIN domains d ON d.id = r.domain_id
      WHERE r.banned_at IS NULL
        AND (r.subdomain_id IN (SELECT id FROM subdomains WHERE user_id = ?)
             OR r.domain_id IN (SELECT id FROM domains WHERE user_id = ?))
      ORDER BY r.created_at ASC`
  )
    .bind(userId, userId)
    .all<BannedDnsRow>()

  const all = (rows.results ?? []).filter((r) => r.fqdn || r.name)
  const batch = all.slice(0, SUSPEND_BATCH)
  out.dnsDeferred = Math.max(0, all.length - batch.length)

  await mapLimit(batch, CF_CONCURRENCY, async (row) => {
    // 先删 CF：删失败就**不动本地**，留给维护任务重试（cf_id 必须保留）
    if (row.cf_id && row.zone_id) {
      try {
        await cfDeleteDnsRecord(env, row.zone_id, row.cf_id)
      } catch (err) {
        if (!isMissingRecordError(err)) {
          out.errors.push(
            `删除 CF 记录 ${row.fqdn || row.name} 失败：${err instanceof Error ? err.message : String(err)}`
          )
          return
        }
        // 「本来就不在」= 目的已达成，继续往下标记
      }
    }
    try {
      await env.DB.prepare(
        "UPDATE dns_records SET banned_at = ?, cf_id = NULL, updated_at = ? WHERE id = ?"
      )
        .bind(now, now, row.id)
        .run()
      out.dnsSuspended += 1
    } catch (err) {
      out.errors.push(
        `标记记录 ${row.fqdn || row.name} 停用失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  // 子域名：解析靠它下面的记录（上面已处理），这里只标记本身不再可用
  const sub = await env.DB.prepare(
    "UPDATE subdomains SET banned_at = ? WHERE user_id = ? AND banned_at IS NULL"
  )
    .bind(now, userId)
    .run()
  out.subdomainsSuspended = sub.meta?.changes ?? 0

  return out
}

/**
 * 恢复该用户被停用的资源：在 Cloudflare 上**重建**记录 + 清掉子域名标记。
 *
 * 调用点：`updateUserHandler` 里 `statusChanged === "active"` 分支。
 * 重建用的是本地留存的字段，所以恢复出来的记录与封禁前一致
 * （CF 记录 id 会变，但那个 id 只在我们自己的表里用，对外无影响）。
 */
export async function restoreUserResources(
  env: Env,
  userId: string
): Promise<RestoreResult> {
  const out: RestoreResult = { dnsRestored: 0, dnsFailed: 0, subdomainsRestored: 0, errors: [] }

  const rows = await env.DB.prepare(
    `SELECT r.id, r.domain_id, r.fqdn, r.name, r.type, r.content, r.ttl, r.proxied,
            r.priority, r.srv_weight, r.srv_port, r.srv_target, r.cf_id, d.zone_id
       FROM dns_records r
       LEFT JOIN domains d ON d.id = r.domain_id
      WHERE r.banned_at IS NOT NULL
        AND (r.subdomain_id IN (SELECT id FROM subdomains WHERE user_id = ?)
             OR r.domain_id IN (SELECT id FROM domains WHERE user_id = ?))
      ORDER BY r.created_at ASC`
  )
    .bind(userId, userId)
    .all<BannedDnsRow>()

  await mapLimit(rows.results ?? [], CF_CONCURRENCY, async (row) => {
    if (!row.zone_id) {
      out.dnsFailed += 1
      out.errors.push(`恢复 ${row.fqdn || row.name} 失败：找不到所属 zone`)
      return
    }
    try {
      const { id: cfId } = await cfCreateDnsRecord(env, row.zone_id, payloadOf(row))
      await env.DB.prepare(
        "UPDATE dns_records SET banned_at = NULL, cf_id = ?, status = 'active', updated_at = ? WHERE id = ?"
      )
        .bind(cfId, new Date().toISOString(), row.id)
        .run()
      out.dnsRestored += 1
    } catch (err) {
      // 重建失败：**保留 banned_at**，下次解封/维护任务会再试（不能让记录变成
      // 「本地看着正常、CF 上其实没有」的幽灵行）
      out.dnsFailed += 1
      out.errors.push(
        `重建 CF 记录 ${row.fqdn || row.name} 失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  const sub = await env.DB.prepare(
    "UPDATE subdomains SET banned_at = NULL WHERE user_id = ? AND banned_at IS NOT NULL"
  )
    .bind(userId)
    .run()
  out.subdomainsRestored = sub.meta?.changes ?? 0

  return out
}

/**
 * 维护任务用的兜底：把封禁用户**留在 Cloudflare 上**的 DNS 记录删干净。
 *
 * 为什么需要它：封禁那一跳受单请求子请求上限约束（见 SUSPEND_BATCH），
 * 记录多的用户处理不完；另外 CF 瞬时故障也会留下一批。
 *
 * ⚠️ 筛选口径是「**归属用户当前为 suspended** 且 `cf_id` 还在」（见 ownerStatusSql），
 * 不能写成 `banned_at IS NOT NULL AND cf_id IS NOT NULL` —— 那样**恒为空集**：
 * 唯一置 `banned_at` 的语句（上面 suspendUserResources 里那次标记）在**同一条
 * UPDATE 里把 `cf_id` 清 NULL**，两个条件互斥。而真正需要收尾的两批恰恰停在
 * `banned_at IS NULL`：延迟批（超过 SUSPEND_BATCH 的部分从未被标记）与失败批
 * （CF 删失败时按「先删 CF 再标记」的顺序直接返回，从未标记）。
 * 按「用户是否仍被禁」筛与恢复方向（retrySuspendedDnsRestore 按 active 筛）
 * 对称，且归属判据互斥（见 ownerStatusSql），两个方向不会互相抢。
 *
 * 删掉后补写 `banned_at`：延迟批原本没有标记，只清 `cf_id` 会造出「本地看着正常、
 * CF 上其实没有」的幽灵行（用户端列表按 `banned_at` 过滤，解封时也不会重建）。
 */
export async function sweepSuspendedDns(
  env: Env,
  limit = SUSPEND_BATCH
): Promise<{ removed: number; errors: string[] }> {
  const errors: string[] = []
  let removed = 0
  const now = new Date().toISOString()

  const rows = await env.DB.prepare(
    `SELECT r.id, r.fqdn, r.name, r.cf_id, d.zone_id
       FROM dns_records r
       LEFT JOIN domains d ON d.id = r.domain_id
      WHERE r.cf_id IS NOT NULL AND r.cf_id != ''
        AND ${ownerStatusSql("suspended")}
      LIMIT ?`
  )
    .bind(Math.max(1, limit))
    .all<{ id: string; fqdn: string | null; name: string; cf_id: string; zone_id: string | null }>()

  /** 清 cf_id 并补标记（banned_at 已有则保留原值） */
  const clearCfId = (id: string) =>
    env.DB.prepare(
      "UPDATE dns_records SET cf_id = NULL, banned_at = COALESCE(banned_at, ?), updated_at = ? WHERE id = ?"
    ).bind(now, now, id)

  await mapLimit(rows.results ?? [], CF_CONCURRENCY, async (row) => {
    if (!row.zone_id) {
      // 连 zone 都没有，CF 上不可能有这条记录 ⇒ 直接清 cf_id 收尾
      await clearCfId(row.id).run()
      return
    }
    try {
      await cfDeleteDnsRecord(env, row.zone_id, row.cf_id)
      await clearCfId(row.id).run()
      removed += 1
    } catch (err) {
      if (isMissingRecordError(err)) {
        await clearCfId(row.id).run()
        removed += 1
        return
      }
      errors.push(
        `清理停用记录 ${row.fqdn || row.name} 失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  return { removed, errors }
}

/**
 * 维护任务用的兜底（解封方向）：把「用户已解封、但记录还没重建回来」的补上。
 *
 * 为什么需要：解封那一跳同样可能失败（CF 瞬时故障、zone 找不到…）。
 * 重建失败的记录**保留 banned_at**，用户端列表会过滤掉它 ——
 * 结果是「人解封了、解析少了一条、且他自己看不见」，只能等管理员发现。
 * 这里按「归属用户已是 active」筛出来重试，让恢复真正闭环。
 *
 * 只认**归属用户当前为 active** 的记录（判据见 ownerStatusSql）：仍封禁的那些就该
 * 保持停用状态，不能因为这里重试而被恢复。
 */
export async function retrySuspendedDnsRestore(
  env: Env,
  limit = SUSPEND_BATCH
): Promise<{ restored: number; errors: string[] }> {
  const errors: string[] = []
  let restored = 0

  const rows = await env.DB.prepare(
    `SELECT r.id, r.domain_id, r.fqdn, r.name, r.type, r.content, r.ttl, r.proxied,
            r.priority, r.srv_weight, r.srv_port, r.srv_target, d.zone_id
       FROM dns_records r
       LEFT JOIN domains d ON d.id = r.domain_id
      WHERE r.banned_at IS NOT NULL
        AND ${ownerStatusSql("active")}
      ORDER BY r.banned_at ASC
      LIMIT ?`
  )
    .bind(Math.max(1, limit))
    .all<BannedDnsRow>()

  await mapLimit(rows.results ?? [], CF_CONCURRENCY, async (row) => {
    if (!row.zone_id) {
      errors.push(`恢复 ${row.fqdn || row.name} 失败：找不到所属 zone`)
      return
    }
    try {
      const { id: cfId } = await cfCreateDnsRecord(env, row.zone_id, payloadOf(row))
      await env.DB.prepare(
        "UPDATE dns_records SET banned_at = NULL, cf_id = ?, status = 'active', updated_at = ? WHERE id = ?"
      )
        .bind(cfId, new Date().toISOString(), row.id)
        .run()
      restored += 1
    } catch (err) {
      errors.push(
        `重建 CF 记录 ${row.fqdn || row.name} 失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  return { restored, errors }
}
