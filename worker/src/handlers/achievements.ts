import { json } from "../http"
import { requireUser } from "../auth"
import type { Env } from "../env"

/**
 * 成就系统。
 *
 * 成就是**纯计算**的：不落库、不记录解锁时间，每次请求按当前数据实时算出
 * 每个成就的进度与是否达成。好处是无需迁移历史数据、也不会因为删除资源而
 * 出现「成就解锁了但数据没了」的矛盾。
 *
 * 两类成就：
 *   1. 单级成就（single）：达成即解锁，如「开通网盘」
 *   2. 分级成就（tiered）：同一勋章多个等级，如访问 10/100/1000 次
 *
 * 数据来源：
 *   - 各功能表的记录数 / 是否存在（子域名、邮箱、DNS、网盘、AI、名片）
 *   - user_stats.visit_count（登录访问次数，节流累计）
 *   - profiles.view_count（名片被访问次数）
 *   - users.created_at（注册时间，用于「元老」「坚守者」）
 *   - messages（是否收到过邮件）
 */

interface AchievementDef {
  id: string
  name: string
  desc: string
  /** 图标标识，前端映射成 lucide 图标 */
  icon: string
  /** 分级成就的阈值（升序）；单级成就为 undefined */
  tiers?: number[]
  /** 分级成就各等级的名称 */
  tierNames?: string[]
}

/** 成就定义表。新增成就只需在此追加。 */
const ACHIEVEMENTS: AchievementDef[] = [
  // ---- 功能开通 ----
  {
    id: "storage_enable",
    name: "云端仓库",
    desc: "开通直链网盘",
    icon: "hard-drive",
  },
  {
    id: "ai_enable",
    name: "智核接入",
    desc: "开通 AI 中转站",
    icon: "sparkles",
  },
  {
    id: "profile_enable",
    name: "数字名片",
    desc: "开通个人名片",
    icon: "contact",
  },
  {
    id: "domain_bind",
    name: "域名主权",
    desc: "为网盘直链或名片绑定自定义域名",
    icon: "globe",
  },
  // ---- 资源积累（分级） ----
  {
    id: "subdomain",
    name: "开疆拓土",
    desc: "创建子域名",
    icon: "globe",
    tiers: [1, 3, 5],
    tierNames: ["初出茅庐", "渐入佳境", "疆域辽阔"],
  },
  {
    id: "mailbox",
    name: "信箱林立",
    desc: "添加邮箱地址",
    icon: "mail",
    tiers: [1, 3],
    tierNames: ["首个信箱", "多线并行"],
  },
  {
    id: "dns",
    name: "解析大师",
    desc: "创建 DNS 记录",
    icon: "network",
    tiers: [1, 5, 20],
    tierNames: ["初次解析", "熟练运维", "解析宗师"],
  },
  // ---- 使用深度（分级） ----
  {
    id: "visit",
    name: "常客",
    desc: "访问控制台",
    icon: "log-in",
    tiers: [10, 100, 1000],
    tierNames: ["初来乍到", "熟门熟路", "常驻居民"],
  },
  {
    id: "profile_view",
    name: "声名远扬",
    desc: "名片被访问",
    icon: "eye",
    tiers: [10, 100, 1000],
    tierNames: ["小有名气", "广为人知", "名动四方"],
  },
  // ---- 特殊 ----
  {
    id: "first_mail",
    name: "见信如晤",
    desc: "收到第一封邮件",
    icon: "inbox",
  },
  {
    id: "veteran",
    name: "元老",
    desc: "首批注册用户",
    icon: "crown",
  },
  {
    id: "loyal",
    name: "坚守者",
    desc: "注册满一年",
    icon: "calendar",
    tiers: [30, 365],
    tierNames: ["满月", "周年"],
  },
]

/** 「元老」判定：注册时间排在前 N 名 */
const VETERAN_TOP_N = 20

export interface AchievementProgress {
  id: string
  name: string
  desc: string
  icon: string
  /** 是否单级成就 */
  single: boolean
  /** 分级成就的阈值与等级名 */
  tiers?: number[]
  tierNames?: string[]
  /** 当前进度值 */
  value: number
  /** 已达成的等级数（0 = 未解锁）；单级成就为 0 或 1 */
  level: number
  /** 是否完全达成（最高级） */
  maxed: boolean
  /** 下一等级阈值（无则 null） */
  nextTier: number | null
}

export async function getAchievements(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  // 一次性取回各项原始数据
  const [
    subdomainCount,
    mailboxCount,
    dnsCount,
    storageAcc,
    aiAcc,
    profileRow,
    storageBind,
    mailCount,
    statsRow,
    veteranRank,
  ] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ? AND name != '@'"
    )
      .bind(user.id)
      .first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM dns_records dr
        JOIN subdomains s ON dr.subdomain_id = s.id
       WHERE s.user_id = ?`
    )
      .bind(user.id)
      .first<{ c: number }>(),
    env.DB.prepare("SELECT 1 AS c FROM storage_accounts WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>(),
    env.DB.prepare("SELECT 1 AS c FROM newapi_accounts WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>(),
    env.DB.prepare("SELECT view_count FROM profiles WHERE user_id = ?")
      .bind(user.id)
      .first<{ view_count: number }>(),
    // 自定义域名绑定：名片 fqdn 或网盘直链前缀任一存在
    env.DB.prepare(
      `SELECT 1 AS c WHERE
        EXISTS(SELECT 1 FROM profiles WHERE user_id = ? AND fqdn IS NOT NULL)
        OR EXISTS(SELECT 1 FROM storage_prefixes WHERE user_id = ?)`
    )
      .bind(user.id, user.id)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM messages m
        JOIN mailboxes mb ON m.mailbox_id = mb.id
       WHERE mb.user_id = ?`
    )
      .bind(user.id)
      .first<{ c: number }>(),
    env.DB.prepare("SELECT visit_count FROM user_stats WHERE user_id = ?")
      .bind(user.id)
      .first<{ visit_count: number }>(),
    // 注册排名：created_at 早于我的用户数 + 1
    env.DB.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE created_at < (SELECT created_at FROM users WHERE id = ?)"
    )
      .bind(user.id)
      .first<{ c: number }>(),
  ])

  const registeredAt = user.created_at ? new Date(user.created_at) : null
  const daysSinceRegister = registeredAt
    ? Math.floor((Date.now() - registeredAt.getTime()) / 86400000)
    : 0

  // 每个成就的原始进度值
  const values: Record<string, number> = {
    storage_enable: storageAcc ? 1 : 0,
    ai_enable: aiAcc ? 1 : 0,
    profile_enable: profileRow ? 1 : 0,
    domain_bind: storageBind ? 1 : 0,
    subdomain: subdomainCount?.c ?? 0,
    mailbox: mailboxCount?.c ?? 0,
    dns: dnsCount?.c ?? 0,
    visit: statsRow?.visit_count ?? 0,
    profile_view: profileRow?.view_count ?? 0,
    first_mail: (mailCount?.c ?? 0) > 0 ? 1 : 0,
    veteran: (veteranRank?.c ?? 999) < VETERAN_TOP_N ? 1 : 0,
    loyal: daysSinceRegister,
  }

  const result: AchievementProgress[] = ACHIEVEMENTS.map((def) => {
    const value = values[def.id] ?? 0
    if (!def.tiers) {
      const unlocked = value > 0
      return {
        id: def.id,
        name: def.name,
        desc: def.desc,
        icon: def.icon,
        single: true,
        value,
        level: unlocked ? 1 : 0,
        maxed: unlocked,
        nextTier: null,
      }
    }
    const level = def.tiers.filter((t) => value >= t).length
    const nextTier = def.tiers.find((t) => value < t) ?? null
    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      icon: def.icon,
      single: false,
      tiers: def.tiers,
      tierNames: def.tierNames,
      value,
      level,
      maxed: nextTier === null,
      nextTier,
    }
  })

  const unlocked = result.filter((a) => a.level > 0).length

  return json({
    achievements: result,
    summary: { unlocked, total: result.length },
    /** 用于名片页/展示的注册时间 */
    registeredAt: user.created_at ?? null,
  })
}
