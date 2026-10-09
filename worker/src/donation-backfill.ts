/**
 * 一次性补发：把「捐献奖励积分」上线**之前**的历史捐献，按**当前档位值**补上积分。
 *
 * 背景：捐献奖励积分是 2026-09-29 才上线的功能，此前所有捐献都没发过积分。
 * 站长要求「按现在调好的额度，把以前每一次捐献的积分补给所有人」。
 *
 * 幂等：复用与正常发放**完全相同**的 dedupKey
 *   （`donation:<单据id>` / `qoder2api:<绑定id>` / `wb2api:<绑定id>`），
 * 已经发过的（上线后新产生的捐献）会撞 `point_transactions(user_id, dedup_key)`
 * 唯一索引而被 `applyPoints` 跳过。所以这个函数可以放心重复运行。
 *
 * 计入范围（与正常发放口径严格对齐）：
 *   · `donations` 里 `status = 'approved'` 的单据（rejected / revoked / pending 不算）；
 *   · `qoder2api_bindings` / `wb2api_bindings` 里 `status = 'active'` 的绑定；
 *   · 档位认不出来的跳过（provider 是外部输入）。
 *
 * ⚠️ 已知的简化：wb2api 正常发放时还要求「登录前不在网关池里」
 *   （`inPoolBefore === false`，避免给「绑定一个池里早就有的账号」发奖）。
 *   这个快照事后无法复原，补发时**按绑定记录一律计入** —— 对多数人来说是补上
 *   他们本该拿到的分，少数「绑的是池里已有账号」的会被多补一点，量很小。
 */
import type { Env } from "./env"
import {
  applyPoints,
  donationRewardLabel,
  getDonationRewardPoints,
  isDonationRewardKind,
  type DonationRewardKind,
} from "./points"

interface Grant {
  userId: string
  kind: DonationRewardKind
  dedupKey: string
  detail: string
}

export interface BackfillKindSummary {
  kind: DonationRewardKind
  label: string
  /** 这一档要发几笔 */
  count: number
  /** 每笔多少分 */
  points: number
  /** 小计 */
  total: number
}

export interface BackfillReport {
  dryRun: boolean
  byKind: BackfillKindSummary[]
  /** 计划发放笔数 */
  totalGrants: number
  /** 计划发放积分总数 */
  totalPoints: number
  /** 涉及多少用户 */
  distinctUsers: number
  /** 实际落账笔数（dryRun 时为 0） */
  applied: number
  /** 跳过笔数（已发过 / 档位为 0 / 用户已不存在） */
  skipped: number
}

/** 收集所有「应当发、但可能还没发」的捐献奖励（按 dedupKey 去重） */
async function collectGrants(env: Env): Promise<Grant[]> {
  const grants: Grant[] = []
  const seen = new Set<string>()
  const push = (g: Grant) => {
    if (seen.has(g.dedupKey)) return
    seen.add(g.dedupKey)
    grants.push(g)
  }

  // 1) 捐献单据（只认 approved）。JOIN users 是为了跳过已注销的用户
  //    —— 对不存在的 user_id 写积分会撞外键。
  const don = await env.DB.prepare(
    `SELECT d.id AS id, d.user_id AS user_id, d.type AS type
       FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.status = 'approved'`
  ).all<{ id: string; user_id: string; type: string }>()
  for (const r of don.results ?? []) {
    if (!isDonationRewardKind(r.type)) continue
    push({
      userId: r.user_id,
      kind: r.type,
      dedupKey: `donation:${r.id}`,
      detail: `${donationRewardLabel(r.type)}捐献奖励（历史补发）`,
    })
  }

  // 2) qoder2api 反代账号绑定（该通道只对接 Qoder ⇒ 档位固定 qoder）
  const qoder2 = await env.DB.prepare(
    `SELECT b.id AS id, b.user_id AS user_id
       FROM qoder2api_bindings b
       JOIN users u ON u.id = b.user_id
      WHERE b.status = 'active'`
  ).all<{ id: string; user_id: string }>()
  for (const r of qoder2.results ?? []) {
    push({
      userId: r.user_id,
      kind: "qoder",
      dedupKey: `qoder2api:${r.id}`,
      detail: `${donationRewardLabel("qoder")}捐献奖励（历史补发）`,
    })
  }

  // 3) wb2api 反代账号绑定
  const wb = await env.DB.prepare(
    `SELECT b.id AS id, b.user_id AS user_id
       FROM wb2api_bindings b
       JOIN users u ON u.id = b.user_id
      WHERE b.status = 'active'`
  ).all<{ id: string; user_id: string }>()
  for (const r of wb.results ?? []) {
    push({
      userId: r.user_id,
      kind: "workbuddy",
      dedupKey: `wb2api:${r.id}`,
      detail: "WorkBuddy 反代账号捐献奖励（历史补发）",
    })
  }

  return grants
}

/**
 * 执行（或预演）历史捐献积分补发。
 *
 * `dryRun = true` 只统计不写库；`false` 才真正发放。
 */
export async function backfillDonationRewards(env: Env, dryRun: boolean): Promise<BackfillReport> {
  // 档位值只读一次（正常发放路径是每笔都读，补发笔数多，读一次就够）
  const values = await getDonationRewardPoints(env)
  const grants = await collectGrants(env)

  const byKindMap = new Map<DonationRewardKind, { count: number; points: number }>()
  for (const g of grants) {
    const cur = byKindMap.get(g.kind) ?? { count: 0, points: values[g.kind] }
    cur.count += 1
    byKindMap.set(g.kind, cur)
  }
  const byKind: BackfillKindSummary[] = [...byKindMap.entries()]
    .map(([kind, v]) => ({
      kind,
      label: donationRewardLabel(kind),
      count: v.count,
      points: v.points,
      total: v.count * v.points,
    }))
    .sort((a, b) => b.total - a.total)

  let applied = 0
  let skipped = 0

  if (!dryRun) {
    for (const g of grants) {
      const pts = values[g.kind]
      if (pts <= 0) {
        skipped += 1
        continue
      }
      try {
        const res = await applyPoints(env, {
          userId: g.userId,
          delta: pts,
          reason: "donation",
          detail: g.detail,
          dedupKey: g.dedupKey,
        })
        if (res.applied) applied += 1
        else skipped += 1
      } catch (err) {
        // 单笔失败不影响其余（例如用户刚好被删）
        console.error("补发捐献积分失败:", g.userId, g.dedupKey, err)
        skipped += 1
      }
    }
  }

  return {
    dryRun,
    byKind,
    totalGrants: grants.length,
    totalPoints: byKind.reduce((s, k) => s + k.total, 0),
    distinctUsers: new Set(grants.map((g) => g.userId)).size,
    applied,
    skipped,
  }
}

// ---------------------------------------------------------------------------
// 翻倍补差（把已按**旧档位值**发出去的历史补发积分，按倍数补足差额）
// ---------------------------------------------------------------------------

export interface TopUpReport {
  dryRun: boolean
  /** 本次采用的倍数（2 = 翻倍） */
  multiplier: number
  /** 参与补差的原始流水笔数 */
  entries: number
  /** 涉及多少用户 */
  distinctUsers: number
  /** 计划补发的积分总数 */
  totalPoints: number
  /** 实际落账笔数（dryRun 时为 0） */
  applied: number
  /** 跳过笔数（已补过 / 用户已不存在） */
  skipped: number
}

/**
 * 翻倍补差：把**已按旧档位值发放**的那批历史补发积分，按倍数补足差额。
 *
 * 场景（2026-09-29）：历史补发是按**当时**的档位值发的，之后站长把档位值翻倍，
 * 于是这批分要按新值补齐 —— 每笔追加 `原额 × (倍数 − 1)`，倍数默认 2（即再发等额）。
 *
 * 只作用于「首次历史补发」那批，**不会**波及后来按新值正常发放的捐献：
 *   · `detail LIKE '%（历史补发）%'` —— 那是补发代码自己写的固定标记；
 *   · 且 `dedup_key NOT LIKE '%:x%'` —— 补差流水自身带 `:x<倍数>` 后缀，天然被排除，
 *     所以重复运行不会「套娃」补第二次（第二次跑全部撞幂等键，`applied=0`）。
 *
 * 幂等键：`<原 dedup_key>:x<倍数>`。同一笔原始流水、同一倍数只会补一次。
 */
export async function topUpDonationRewards(
  env: Env,
  dryRun: boolean,
  multiplier = 2
): Promise<TopUpReport> {
  const mult =
    Number.isFinite(multiplier) && multiplier > 1 ? Math.min(Math.trunc(multiplier), 100) : 2
  const extraFactor = mult - 1

  // JOIN users：对已不存在的 user_id 写积分会撞外键（理论上 CASCADE 已清干净，防御性保留）
  const rows = await env.DB.prepare(
    `SELECT t.user_id AS user_id, t.delta AS delta, t.dedup_key AS dedup_key
       FROM point_transactions t
       JOIN users u ON u.id = t.user_id
      WHERE t.reason = 'donation' AND t.delta > 0
        AND t.detail LIKE '%（历史补发）%'
        AND t.dedup_key IS NOT NULL
        AND t.dedup_key NOT LIKE '%:x%'
      ORDER BY t.created_at`
  ).all<{ user_id: string; delta: number; dedup_key: string }>()

  const list = rows.results ?? []
  const totalPoints = list.reduce((s, r) => s + r.delta * extraFactor, 0)

  let applied = 0
  let skipped = 0
  if (!dryRun) {
    for (const r of list) {
      const add = r.delta * extraFactor
      if (add <= 0) {
        skipped += 1
        continue
      }
      try {
        const res = await applyPoints(env, {
          userId: r.user_id,
          delta: add,
          reason: "donation",
          detail: `捐献奖励翻倍补差（×${mult}）`,
          dedupKey: `${r.dedup_key}:x${mult}`,
        })
        if (res.applied) applied += 1
        else skipped += 1
      } catch (err) {
        // 单笔失败不影响其余（例如用户刚好被删）
        console.error("捐献积分翻倍补差失败:", r.user_id, r.dedup_key, err)
        skipped += 1
      }
    }
  }

  return {
    dryRun,
    multiplier: mult,
    entries: list.length,
    distinctUsers: new Set(list.map((r) => r.user_id)).size,
    totalPoints,
    applied,
    skipped,
  }
}
