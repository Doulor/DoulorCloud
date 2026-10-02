/**
 * 「用户可分配根域」注册表。
 *
 * ---------------------------------------------------------------------------
 * 为什么要把它从 `env.ROOT_DOMAIN` 拆出来（2026-10-01 站长要求）
 * ---------------------------------------------------------------------------
 * 站内发给用户的子域名与邮箱原先硬编码在 `env.ROOT_DOMAIN`（doulor.cn）上。
 * 但 doulor.cn 同时是**站点主域**：`cloud.doulor.cn`、密码重置链接、OAuth issuer
 * 都从它拼出来 —— 所以 `env.ROOT_DOMAIN` **绝不能**改成新域，改了站点自身就坏了。
 *
 * 而把所有用户的邮箱 / 子域名都挂在主域上还有个更隐蔽的代价：
 * 主域同时是「给用户发验证码 / 找回密码」的发件域。用户拿 `xxx@doulor.cn`
 * 去注册外站、收垃圾邮件、被投诉，脏掉的是**主域声誉** ⇒ 你的关键通知邮件
 * 会开始进垃圾箱。把用户域换成一个独立域名，等于把这份风险**隔离**出去。
 *
 * 于是本模块把「发给用户的域名」做成一张表（`root_domains`），默认 tyu.me；
 * doulor.cn 保留但需要 `doulor` 权限才能选（`requires_feature`）。
 *
 * ---------------------------------------------------------------------------
 * 两条容易踩的线
 * ---------------------------------------------------------------------------
 * 1. `zone_id` 必须按域存。CF 的 DNS 记录与 Worker Route 都是**按 zone** 操作的，
 *    API 路径里直接带 zone id。缺省时调 `GET /zones?name=<name>` 解析一次并回填。
 *    （`domains.zone_id` 早就是同一套思路，见 handlers/dns.ts。）
 * 2. 表**为空**时要能正常服务：回落成「就用 `env.ROOT_DOMAIN`、无权限要求」，
 *    这样新部署 / 迁移漏跑都不会把注册打挂。只有表里真有行时才以表为准。
 */
import { ApiError } from "./http"
import { callCloudflare } from "./cloudflare"
import { hasFeature, type Permissions } from "./permissions"
import type { Env } from "./env"

export interface RootDomainRow {
  name: string
  zone_id: string | null
  label: string | null
  /** 非空 = 必须先解锁该权限才能把子域名/邮箱建在这个域下 */
  requires_feature: string | null
  is_default: number
  enabled: number
  created_at: string
}

/**
 * 模块级读缓存。
 *
 * 一次注册 / 一次 DNS 写入会连着问好几次「这个 fqdn 属于哪个根域」，
 * 每次打一遍 D1 纯属浪费。10 秒 TTL + 写路径显式失效（`resetRootDomainCache`），
 * 与 wb2api/newapi 的凭据缓存同口径。
 */
let cache: { at: number; rows: RootDomainRow[] } | null = null
const CACHE_MS = 10_000

/** 写路径改完表后调用；其它 isolate 最多等 CACHE_MS */
export function resetRootDomainCache(): void {
  cache = null
}

/**
 * 表为空时的兜底：退化成「只有站点主域、且人人可用」。
 *
 * 为什么不抛错：迁移漏跑 / 新建环境时，抛错会让**注册整个挂掉**。
 * 退化成旧行为（doulor.cn）虽然不理想，但站点是可用的 ——
 * 而「可用的旧行为」远比「不可用的新行为」好收场。
 */
function fallbackRow(env: Env): RootDomainRow {
  return {
    name: env.ROOT_DOMAIN.toLowerCase(),
    zone_id: env.ZONE_ID ?? null,
    label: null,
    requires_feature: null,
    is_default: 1,
    enabled: 1,
    created_at: "",
  }
}

/** 全部根域（含被禁用的，管理端要用）；按「默认优先 → 名字」排序 */
export async function listRootDomains(env: Env): Promise<RootDomainRow[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.rows

  let rows: RootDomainRow[] = []
  try {
    const res = await env.DB.prepare(
      `SELECT name, zone_id, label, requires_feature, is_default, enabled, created_at
         FROM root_domains
        ORDER BY is_default DESC, name ASC`
    ).all<RootDomainRow>()
    rows = res.results ?? []
  } catch (err) {
    // 表不存在（迁移没跑）不该让注册挂掉，退化成旧行为
    console.error("读取 root_domains 失败，回落到 ROOT_DOMAIN:", err)
    rows = []
  }
  if (rows.length === 0) rows = [fallbackRow(env)]

  cache = { at: now, rows }
  return rows
}

/** 当前生效的根域（`enabled = 1`） */
export async function listEnabledRootDomains(env: Env): Promise<RootDomainRow[]> {
  return (await listRootDomains(env)).filter((r) => r.enabled === 1)
}

/**
 * 新用户注册 / 新建时要用的默认根域。
 *
 * ⚠️ 默认域是**管理员设的**，不按调用者的权限筛：即使某管理员自己没解锁
 * `doulor` 权限，默认域也不该因此漂到别处。真正要挡的是「用户主动选一个
 * 自己没权限的域」，那由 `pickRootDomain` 负责。
 */
export async function getDefaultRootDomain(env: Env): Promise<RootDomainRow> {
  const rows = await listRootDomains(env)
  const def = rows.find((r) => r.is_default === 1 && r.enabled === 1)
  if (def) return def
  // 没有任何默认行：取第一个启用的，保证永远有得用
  const any = rows.find((r) => r.enabled === 1)
  return any ?? fallbackRow(env)
}

export async function getRootDomainByName(
  env: Env,
  name: string
): Promise<RootDomainRow | null> {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return (await listRootDomains(env)).find((r) => r.name === target) ?? null
}

/**
 * 从「fqdn 或邮箱地址」里认出它属于哪个根域 —— 取**最长后缀匹配**。
 *
 * 必须最长匹配而不是 `endsWith` 第一个命中：`mail.doulor.cn` 同时是
 * `doulor.cn` 的后缀，但若表里真有 `mail.doulor.cn` 这一行，它才是准确答案。
 */
export function matchRootDomain(
  rows: readonly RootDomainRow[],
  hostOrAddress: string
): RootDomainRow | null {
  const s = hostOrAddress.trim().toLowerCase()
  if (!s) return null
  const host = s.includes("@") ? s.slice(s.indexOf("@") + 1) : s
  let best: RootDomainRow | null = null
  for (const r of rows) {
    if (host === r.name || host.endsWith(`.${r.name}`)) {
      if (!best || r.name.length > best.name.length) best = r
    }
  }
  return best
}

/** 便捷：直接按 fqdn / 邮箱查根域 */
export async function rootDomainFor(
  env: Env,
  hostOrAddress: string
): Promise<RootDomainRow | null> {
  return matchRootDomain(await listRootDomains(env), hostOrAddress)
}

/**
 * 这个 host 是不是**根域本身**（而不是它的子域）。
 *
 * 用途：`doulor.cn` / `tyu.me` 这样的根域是平台入口（静态站点自定义域 + 一堆
 * 邮件/API 路由），不能绑给个人名片或网盘直链 —— 绑了整站就访问不了。
 * 注意不能拿 `isOwnDomain` 代替：那个对**所有**子域都返回 true，会把
 * `card.tyu.me` 这种正常绑定也一起拦掉。
 */
export async function isRootDomainItself(env: Env, host: string): Promise<boolean> {
  const s = host.trim().toLowerCase()
  return (await listRootDomains(env)).some((r) => r.name === s)
}

/** 当前用户能否使用该根域（无 `requires_feature` 即人人可用） */
export function canUseRootDomain(
  permissions: Permissions,
  row: RootDomainRow
): boolean {
  if (row.enabled !== 1) return false
  if (!row.requires_feature) return true
  return hasFeature(permissions, row.requires_feature as never)
}

/**
 * 选根域：`requested` 为空时用默认域；非空时必须是**已启用**的域，
 * 且调用者有使用它的权限，否则 403。
 *
 * 不信任前端传来的域名字符串 —— 所有「把资源建在哪个域下」的入口都要过这里。
 */
export async function pickRootDomain(
  env: Env,
  requested: string | undefined,
  permissions: Permissions
): Promise<RootDomainRow> {
  const raw = (requested ?? "").trim().toLowerCase()
  if (!raw) return getDefaultRootDomain(env)

  const row = await getRootDomainByName(env, raw)
  if (!row) {
    throw new ApiError(400, `不支持把资源创建在 ${raw} 下`, "ROOT_DOMAIN_UNKNOWN")
  }
  if (row.enabled !== 1) {
    throw new ApiError(400, `${raw} 当前不可用`, "ROOT_DOMAIN_DISABLED")
  }
  if (!canUseRootDomain(permissions, row)) {
    throw new ApiError(
      403,
      `${raw} 需要先解锁对应权限，请联系管理员`,
      "ROOT_DOMAIN_NOT_PERMITTED"
    )
  }
  return row
}

/**
 * 解析某个根域的 Cloudflare zone id。
 *
 * 顺序：表里的值 → `env.ROOT_DOMAIN` 用 `env.ZONE_ID`（老路径，不浪费一次 API）
 * → 调 `GET /zones?name=` 解析并**回填到表**（下次就不用了）。
 *
 * 回填是刻意的：解析结果是稳定事实，缺了它每次 DNS 写入都要多打一次 CF API。
 */
export async function resolveZoneId(env: Env, name: string): Promise<string | null> {
  const target = name.trim().toLowerCase()
  if (!target) return null

  const row = await getRootDomainByName(env, target)
  if (row?.zone_id) return row.zone_id
  if (target === env.ROOT_DOMAIN.toLowerCase() && env.ZONE_ID) return env.ZONE_ID

  if (env.CLOUDFLARE_API_TOKEN_SECRET || env.CLOUDFLARE_API_TOKEN) {
    try {
      const res = await callCloudflare(
        env,
        `/zones?name=${encodeURIComponent(target)}&per_page=5`
      )
      const data = (await res.json()) as {
        result?: { id?: string; name?: string }[]
      }
      const hit =
        (data.result ?? []).find((z) => (z.name ?? "").toLowerCase() === target) ??
        (data.result ?? [])[0]
      if (hit?.id) {
        await env.DB.prepare(
          "UPDATE root_domains SET zone_id = ? WHERE name = ? AND (zone_id IS NULL OR zone_id = '')"
        )
          .bind(hit.id, target)
          .run()
        resetRootDomainCache()
        return hit.id
      }
    } catch (err) {
      console.error("解析 zone id 失败:", target, err)
    }
  }

  // 最后兜底：主域永远有 ZONE_ID
  if (target === env.ROOT_DOMAIN.toLowerCase()) return env.ZONE_ID ?? null
  return null
}

/**
 * 按 fqdn 找它所属 zone。
 *
 * 给「写入类」路径用（建 DNS 记录 / 建 Worker Route）—— 这类操作**必须有 zone**，
 * 解析不出来就得报错而不是悄悄写到主 zone 上（那会把记录建错到别的域名下）。
 */
export async function zoneIdForFqdn(env: Env, fqdn: string): Promise<string> {
  const row = await rootDomainFor(env, fqdn)
  const name = row?.name ?? env.ROOT_DOMAIN.toLowerCase()

  // `domains.zone_id` 优先：绑定自定义域时它可能被显式指定过
  const fromDomains = await env.DB.prepare(
    "SELECT zone_id FROM domains WHERE name = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first<{ zone_id: string | null }>()
  if (fromDomains?.zone_id) return fromDomains.zone_id

  const zoneId = await resolveZoneId(env, name)
  if (!zoneId) {
    throw new ApiError(
      502,
      `无法确定 ${name} 的 Cloudflare zone，请先在管理面板配置`,
      "CF_ZONE_UNRESOLVED"
    )
  }
  return zoneId
}

/**
 * 该 fqdn / 邮箱地址是否属于**本站任一已登记的根域**。
 *
 * 入站邮件与「真实邮箱不能是本站邮箱」这类校验都要用它 ——
 * 只判 `env.ROOT_DOMAIN` 的话，`xxx@tyu.me` 会被当成外部地址。
 */
export async function isOwnDomain(env: Env, hostOrAddress: string): Promise<boolean> {
  return (await rootDomainFor(env, hostOrAddress)) !== null
}

/** 所有根域名字（含禁用），给「保留名 / 冲突检测」用 */
export async function allRootDomainNames(env: Env): Promise<string[]> {
  return (await listRootDomains(env)).map((r) => r.name)
}

/**
 * 某个用户的**主邮箱地址** = 注册时分配的那一个。
 *
 * 判据取 `subdomains(name = '@')` 那行（fqdn 形如 `用户名.<根域>`），
 * 去掉根域后缀剩下的就是 local part。
 *
 * ⚠️ 两处容易写错：
 *   1. 不能写死 `env.ROOT_DOMAIN` —— 新用户都在 tyu.me 上；
 *   2. 不能直接用 `user.username` 拼 —— **改名不迁移主邮箱**（见 settings.ts
 *      的警告文案），改名后主邮箱仍是旧用户名，用它去拼会得到一个不存在的地址。
 */
export async function primaryAddressFor(
  env: Env,
  userId: string,
  username: string
): Promise<string> {
  const reg = await env.DB.prepare(
    "SELECT fqdn FROM subdomains WHERE user_id = ? AND name = '@' LIMIT 1"
  )
    .bind(userId)
    .first<{ fqdn: string }>()

  const fqdn = (
    reg?.fqdn ?? `${username}.${(await getDefaultRootDomain(env)).name}`
  ).toLowerCase()
  const row = await rootDomainFor(env, fqdn)
  const suffix = (row?.name ?? env.ROOT_DOMAIN).toLowerCase()
  const local = fqdn.endsWith(`.${suffix}`)
    ? fqdn.slice(0, -(suffix.length + 1))
    : username.toLowerCase()
  return `${local}@${suffix}`
}

/**
 * 某个用户**当前所在**的根域名。
 *
 * 用途：改名 / 冲突检测这类「不迁移、只判重」的场景必须用用户自己的域，
 * 不能写死 `env.ROOT_DOMAIN` —— 新用户都在 tyu.me 上，用主域判重会判错对象
 * （既漏掉真正的冲突，又会去拦一个跟这个用户无关的名字）。
 */
export async function userRootDomainName(
  env: Env,
  userId: string,
  username: string
): Promise<string> {
  const addr = await primaryAddressFor(env, userId, username)
  return addr.slice(addr.indexOf("@") + 1)
}
