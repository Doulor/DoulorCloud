/**
 * 捐献账号健康巡检（2026-10-27）—— wb / qoder / 小浣熊 统一处理。
 *
 * 站长要求（2026-10-27）：
 *   号池里捐献的账号被封 → **该号带来的每日额度自动收回**，但**分组不变**，
 *   并站内提醒捐献者「重新登录 / 重新绑定后额度自动恢复」。
 *
 * 数据链路：
 *   Agent2API 面板（hk2，127.0.0.1:3065）
 *     ↑ 入池网关持面板凭据代为查询
 *   GET https://agent2api.doulor.cn/_donate/status   （X-Donate-Key 鉴权）
 *     ↓ 定时任务（每 15 分钟）
 *   绑定表 status = 'active' | 'invalid'
 *     ↓ group-sync：额度只算 active；分组算 active+invalid（所以分组不变）
 *   额度收回 / 恢复
 *
 * 三种 provider 与绑定表的对应关系：
 *   · workbuddy / workbuddy-intl → wb2api_bindings.uid      = 面板 id 去掉 "user-" 前缀
 *   · qoder                      → qoder2api_bindings.account_id = 面板 id（qoder-cn-xxx）
 *   · raccoon                    → raccoon_donations.account_id  = 面板 id（user-pu-xxx）
 */
import type { Env } from "../env"
import { pushMessage } from "../user-messages"

const STATUS_URL = "https://agent2api.doulor.cn/_donate/status"

type PoolAcc = {
  id?: string
  userId?: string
  name?: string
  provider?: string
  /** 面板可能不返回这个字段（autoclaw 3.4.2 起就没了），缺失时按"未知"处理 */
  available?: boolean | null
  enabled?: boolean
}
type StatusResp = { ok?: boolean; accounts?: PoolAcc[]; reason?: string }

/** 把每次巡检的结果落一行，便于事后确认 cron 到底有没有跑、跑到哪一步失败 */
async function heartbeat(env: Env, r: HealthResult): Promise<void> {
  try {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('donation_health_last_run', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(JSON.stringify({ at: now, ...r }), now)
      .run()
  } catch {
    /* 心跳失败不影响巡检 */
  }
}

export type HealthResult = {
  checked: number
  invalidated: number
  recovered: number
  byKind?: Record<string, { invalidated: number; recovered: number }>
  /** 本轮触发熔断的 provider（占比过高，已跳过失效判定） */
  suspiciousKinds?: Record<string, { dead: number; total: number }>
  skipped?: string
}

/** 拉一次号池快照：面板 id → 是否可用 */
async function fetchPool(env: Env): Promise<{ pool: Map<string, PoolAcc> | null; detail?: string }> {
  const key = env.RACCOON_DONATE_KEY
  if (!key) return { pool: null, detail: "no_key" }
  try {
    const r = await fetch(STATUS_URL, { headers: { "X-Donate-Key": key } })
    const text = await r.text()
    if (!r.ok) return { pool: null, detail: `http_${r.status}:${text.slice(0, 120)}` }
    const resp = JSON.parse(text) as StatusResp
    if (!resp.ok || !Array.isArray(resp.accounts) || resp.accounts.length === 0) {
      return { pool: null, detail: `bad_shape:${text.slice(0, 120)}` }
    }
    const m = new Map<string, PoolAcc>()
    for (const a of resp.accounts) {
      if (a?.id) m.set(a.id, a)
      // qoder 的绑定表存的是账号 uuid（= 面板的 userId），不是面板 id 里那个长哈希
      if (a?.userId) m.set(a.userId, a)
    }
    return { pool: m }
  } catch (e) {
    // 网关/面板暂时不可用：返回 null，**不**据此判失效（避免一次抖动收走所有人额度）
    return { pool: null, detail: `exception:${String(e).slice(0, 160)}` }
  }
}

/** 号池里的"可用"口径：既要启用、也要 available */
function isLive(a: PoolAcc | undefined): boolean {
  if (!a) return false
  // 字段缺失（不同 provider / 面板版本结构不一致）时不要判死：
  // 2026-11-07 autoclaw 因为面板不返回 available，被 bool(undefined)=false 全判失效。
  if (a.available === undefined || a.available === null) return a.enabled !== false
  return a.enabled !== false && a.available !== false
}

type BindingRow = {
  id: string
  user_id: string
  key: string | null
  label: string | null
  status: string
}

/** 各 provider 的绑定表差异集中在这里 */
const KINDS = [
  {
    kind: "wb",
    provider: ["workbuddy", "workbuddy-intl"],
    sql: `SELECT id, user_id, uid AS key, nickname AS label, status FROM wb2api_bindings`,
    table: "wb2api_bindings",
    /** 面板 id = "user-" + uid */
    toPoolId: (k: string) => `user-${k}`,
    title: "你捐献的 WorkBuddy 账号已失效，额度已暂停",
    body: (label: string) =>
      `捐献账号「${label}」当前在号池中不可用（可能被封禁或登录态失效）。该账号带来的每日额度已暂时收回，你的分组保持不变。重新登录 WorkBuddy 后到捐献页重新绑定同一个账号，额度会自动恢复。`,
    recoveredTitle: "你捐献的 WorkBuddy 账号已恢复，额度已重新计入",
  },
  {
    kind: "qoder",
    provider: ["qoder"],
    sql: `SELECT id, user_id, account_id AS key, nickname AS label, status FROM qoder2api_bindings`,
    table: "qoder2api_bindings",
    /** 面板 id 本身就是 account_id */
    toPoolId: (k: string) => k,
    title: "你捐献的 Qoder 账号已失效，额度已暂停",
    body: (label: string) =>
      `捐献账号「${label}」当前在号池中不可用。该账号带来的每日额度已暂时收回，你的分组保持不变。重新登录 Qoder 后到捐献页重新绑定同一个账号，额度会自动恢复。`,
    recoveredTitle: "你捐献的 Qoder 账号已恢复，额度已重新计入",
  },
  {
    kind: "autoclaw",
    provider: ["autoclaw"],
    sql: `SELECT id, user_id, account_id AS key, account_name AS label, status FROM autoclaw_donations`,
    table: "autoclaw_donations",
    toPoolId: (k: string) => k,
    title: "你捐献的 AutoClaw 账号已失效，额度已暂停",
    body: (label: string) =>
      `捐献账号「${label}」当前在号池中不可用。该账号带来的每日额度已暂时收回，你的分组保持不变。重新用手机验证码登录 AutoClaw 后到捐献页重新提交，额度会自动恢复。`,
    recoveredTitle: "你捐献的 AutoClaw 账号已恢复，额度已重新计入",
  },
  {
    kind: "raccoon",
    provider: ["raccoon"],
    sql: `SELECT id, user_id, account_id AS key, account_name AS label, status FROM raccoon_donations`,
    table: "raccoon_donations",
    toPoolId: (k: string) => k,
    title: "你捐献的小浣熊账号已失效，额度已暂停",
    body: (label: string) =>
      `捐献账号「${label}」当前在号池中不可用（可能被封禁或登录态失效）。该账号带来的每日额度已暂时收回，你的分组保持不变。重新登录小浣熊网页版后到捐献页重新捐一次同一个号，额度会自动恢复。`,
    recoveredTitle: "你捐献的小浣熊账号已恢复，额度已重新计入",
  },
] as const

/** 巡检一次：把号池可用性同步到三张绑定表，并对变化发站内提醒。 */
export async function checkDonationHealth(env: Env): Promise<HealthResult> {
  if (!env.RACCOON_DONATE_KEY) {
    const r: HealthResult = { checked: 0, invalidated: 0, recovered: 0, skipped: "no_key" }
    await heartbeat(env, r)
    return r
  }

  const { pool, detail } = await fetchPool(env)
  if (!pool) {
    const r: HealthResult = {
      checked: 0,
      invalidated: 0,
      recovered: 0,
      skipped: `pool_unavailable:${detail ?? ""}`,
    }
    await heartbeat(env, r)
    return r
  }

  const now = Math.floor(Date.now() / 1000)
  const byKind: Record<string, { invalidated: number; recovered: number }> = {}
  /** 触发熔断的 provider（本轮到「不可用」占比过高，已跳过失效判定） */
  const suspiciousKinds: Record<string, { dead: number; total: number }> = {}
  let checked = 0
  let invalidated = 0
  let recovered = 0

  for (const k of KINDS) {
    byKind[k.kind] = { invalidated: 0, recovered: 0 }
    let rows: BindingRow[] = []
    try {
      rows = ((await env.DB.prepare(k.sql).all<BindingRow>()).results ?? []) as BindingRow[]
    } catch (e) {
      // 表结构缺列（迁移没跑）时只跳过这一类，不影响其他
      console.error(`健康巡检读取 ${k.table} 失败:`, e)
      continue
    }

    /*
     * 熔断（2026-11-07）：同一 provider 里「不可用」占比过高时，先怀疑号池/上游
     * 自身出问题，而不是这一批捐献号同时被封。
     *
     * 为什么必须加：11-07 的事故是 agent2api 升级后 autoclaw provider 不再返回
     * `available` 字段，导致 29/29 账号被判"不可用"，28 条捐献一次性被收走额度。
     * 这种「全灭」几乎不可能是真封号，而是上游/面板侧的异常。
     *
     * 策略：比例 ≥80% 且样本 ≥4 时，本轮**只跳过失效判定**（恢复仍然照做），
     * 并把情况写进心跳，便于事后确认。宁可晚收一次额度，也不能误伤全部捐献者。
     */
    const considered = rows.filter((r) => r.key && pool.has(k.toPoolId(String(r.key))))
    const deadCount = considered.filter((r) => !isLive(pool.get(k.toPoolId(String(r.key))))).length
    const suspicious = considered.length >= 4 && deadCount / considered.length >= 0.8
    if (suspicious) {
      console.warn(
        `健康巡检熔断：${k.kind} 有 ${deadCount}/${considered.length} 个账号被判不可用，` +
          `本轮跳过失效判定（疑似号池/面板异常，而非真实封号）`
      )
      suspiciousKinds[k.kind] = { dead: deadCount, total: considered.length }
    }

    const stmts: D1PreparedStatement[] = []
    for (const row of rows) {
      if (!row.key) continue
      const poolId = k.toPoolId(String(row.key))
      if (!pool.has(poolId)) continue // 池里没有这个号：不判失效、不判恢复
      checked++
      const live = isLive(pool.get(poolId))
      const label = String(row.label ?? row.key)

      if (!live && row.status === "active" && suspicious) {
        // 熔断中：只刷新检查时间，不动状态
        stmts.push(
          env.DB.prepare(`UPDATE ${k.table} SET last_checked_at = ? WHERE id = ?`).bind(now, row.id)
        )
        continue
      }

      if (!live && row.status === "active") {
        stmts.push(
          env.DB.prepare(
            `UPDATE ${k.table}
                SET status = 'invalid', invalid_at = ?, last_checked_at = ?,
                    invalid_reason = '账号在号池中不可用（可能被封禁或登录态失效）'
              WHERE id = ?`
          ).bind(now, now, row.id)
        )
        invalidated++
        byKind[k.kind].invalidated++
        await pushMessage(env, row.user_id, {
          category: "system",
          type: `${k.kind}_donation_invalid`,
          title: k.title,
          body: k.body(label),
          link: "/dashboard/donations",
          dedupKey: `${k.kind}_invalid:${row.id}:${now}`,
        } as never)
      } else if (live && row.status === "invalid") {
        stmts.push(
          env.DB.prepare(
            `UPDATE ${k.table}
                SET status = 'active', invalid_at = NULL, invalid_reason = NULL, last_checked_at = ?
              WHERE id = ?`
          ).bind(now, row.id)
        )
        recovered++
        byKind[k.kind].recovered++
        await pushMessage(env, row.user_id, {
          category: "system",
          type: `${k.kind}_donation_recovered`,
          title: k.recoveredTitle,
          body: `捐献账号「${label}」恢复可用，每日额度已自动加回。`,
          link: "/dashboard/donations",
          dedupKey: `${k.kind}_recovered:${row.id}:${now}`,
        } as never)
      } else if (stmts.length < 200) {
        stmts.push(
          env.DB.prepare(`UPDATE ${k.table} SET last_checked_at = ? WHERE id = ?`).bind(now, row.id)
        )
      }
    }

    for (let i = 0; i < stmts.length; i += 60) {
      await env.DB.batch(stmts.slice(i, i + 60))
    }
  }

  const result: HealthResult = { checked, invalidated, recovered, byKind }
  if (Object.keys(suspiciousKinds).length > 0) result.suspiciousKinds = suspiciousKinds
  await heartbeat(env, result)
  return result
}

/**
 * POST /donations/raccoon/health —— 手动触发一次巡检（wb / qoder / 小浣熊 全覆盖）。
 *
 * 两种放行方式（二选一）：
 *   · 带 `?key=<RACCOON_DONATE_KEY>`（运维 curl 用）
 *   · 管理员登录态（管理面板按钮用）
 */
export async function triggerDonationHealth(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const key = url.searchParams.get("key") ?? ""
  const internalOk = !!env.RACCOON_DONATE_KEY && key === env.RACCOON_DONATE_KEY
  if (!internalOk) {
    const { requireAdmin } = await import("./admin")
    await requireAdmin(env, request)
  }
  const result = await checkDonationHealth(env)
  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}
