/**
 * 登录 IP 的**记录**与**同 IP 反查**（管理端「IP 监管」的数据层）。
 *
 * 为什么要这张表：
 *   在这之前，全站只在**注册**时通过 `audit_logs` 留下一个 IP，
 *   之后用户再登录多少次都看不到来源 —— 想查「这两个账号是不是同一个人」
 *   完全没有线索。登录 IP 是最直接的那条线索。
 *
 * ⚠️ 定位是**线索**，不是证据：同一 IP 可能是一家人、一个宿舍、同一个公司出口、
 *   同一个机场 WiFi，也可能只是都挂了同一个机场节点。管理端只做「提示有风险」，
 *   不做任何自动处置 —— 误判的代价远大于漏判。
 */

import { uuid } from "./crypto"
import type { Env } from "./env"

/** 管理端一次最多返回多少个「可疑 IP」，防止极端情况下把页面撑爆 */
const MAX_RISKY_IPS = 500
/** 明细行上限（一个 IP 下的用户数 × IP 数） */
const MAX_DETAIL_ROWS = 3000

/**
 * 记一次登录 IP。
 *
 * · 同一 (user, ip) 只留一行：重复出现累加 `times`、刷新 `last_seen_at`；
 * · **失败静默** —— 这是审计辅助数据，不该让一次已经验证通过的登录失败
 *   （迁移没跑时 `user_login_ips` 不存在，也不能因此登不进来）。
 */
export async function recordLoginIp(
  env: Env,
  userId: string,
  ip: string | null | undefined
): Promise<void> {
  const clean = (ip ?? "").trim()
  if (!clean) return
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      `INSERT INTO user_login_ips (id, user_id, ip, first_seen_at, last_seen_at, times)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id, ip) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         times = user_login_ips.times + 1`
    )
      .bind(uuid(), userId, clean, now, now)
      .run()
  } catch (err) {
    console.error("记录登录 IP 失败:", userId, err)
  }
}

/** 一个共用 IP 下的某个用户 */
export interface SharedIpUser {
  username: string
  nickname: string | null
  /** 该用户用这个 IP 第一次/最后一次登录的时间 */
  firstSeenAt: string
  lastSeenAt: string
  /** 见过几次 */
  times: number
}

export interface SharedIpGroup {
  ip: string
  /** 共用这个 IP 的不同账号数（只算未被封禁的） */
  userCount: number
  users: SharedIpUser[]
}

/**
 * 查出「被 ≥2 个**未被封禁**账号共用过的 IP」及其用户明细。
 *
 * 口径（别改松）：
 *   · 只算 `status = 'active'` 的账号 —— 已封禁的账号不该再制造噪音；
 *   · 同一个用户在同一 IP 上登 100 次也只算 1 个人（DISTINCT user_id）；
 *   · 按共用人数从多到少排，最像「团伙」的排最前。
 *
 * 注意：这是**全表聚合**，`user_login_ips` 的行数是「用户数 × 每人去重后的 IP 数」，
 * 正常规模下（千人级）影响不大；万一将来涨到十万行级，再考虑加时间窗或落快照。
 */
export async function listSharedLoginIps(env: Env): Promise<SharedIpGroup[]> {
  const groups = await env.DB.prepare(
    `SELECT l.ip AS ip, COUNT(DISTINCT l.user_id) AS userCount
       FROM user_login_ips l
       JOIN users u ON u.id = l.user_id
      WHERE u.status = 'active'
      GROUP BY l.ip
     HAVING COUNT(DISTINCT l.user_id) > 1
      ORDER BY userCount DESC, l.ip ASC
      LIMIT ?`
  )
    .bind(MAX_RISKY_IPS)
    .all<{ ip: string; userCount: number }>()

  const risky = groups.results ?? []
  if (risky.length === 0) return []

  // 明细：一次把上述 IP 下的所有（未封禁）用户取回来，再在内存里归组。
  // 用子查询而不是把 IP 拼进 IN(...)：500 个占位符接近 D1 的参数上限，
  // 而且要维护拼接逻辑。子查询与上面口径完全一致。
  const details = await env.DB.prepare(
    `SELECT l.ip AS ip, u.username AS username, u.nickname AS nickname,
            l.first_seen_at AS firstSeenAt, l.last_seen_at AS lastSeenAt, l.times AS times
       FROM user_login_ips l
       JOIN users u ON u.id = l.user_id
      WHERE u.status = 'active'
        AND l.ip IN (
          SELECT l2.ip
            FROM user_login_ips l2
            JOIN users u2 ON u2.id = l2.user_id
           WHERE u2.status = 'active'
           GROUP BY l2.ip
          HAVING COUNT(DISTINCT l2.user_id) > 1
        )
      ORDER BY l.ip ASC, u.username ASC
      LIMIT ?`
  )
    .bind(MAX_DETAIL_ROWS)
    .all<SharedIpUser & { ip: string }>()

  const byIp = new Map<string, SharedIpUser[]>()
  for (const r of details.results ?? []) {
    if (!byIp.has(r.ip)) byIp.set(r.ip, [])
    byIp.get(r.ip)!.push({
      username: r.username,
      nickname: r.nickname,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      times: r.times,
    })
  }

  return risky.map((g) => ({
    ip: g.ip,
    userCount: g.userCount,
    users: byIp.get(g.ip) ?? [],
  }))
}
