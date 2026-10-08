/**
 * 代理节点「探活」结果的判定与排序。
 *
 * ## 为什么要有这个模块
 *
 * 在本模块之前，节点级的健康信息是**过目即忘**的：
 *   * `POST /api/proxy/check` 只探「订阅地址」本身能不能拉到 —— 测不到任何一个具体节点；
 *   * `POST /api/proxy/latency` 能对**逐节点**做 TCP 握手，但结果只回给那一次请求，
 *     页面一刷新就没了，列表顺序也只由 `proxy_subscriptions.sort_order` 决定。
 *
 * 于是「这个节点到底还活着吗」无法沉淀，也谈不上据此排序。这里把逐节点探活结果
 * 按**节点指纹**落库（表 `proxy_node_health`，见 migrations/0128），
 * 由每小时运维任务定期刷新，并对外提供「可用 → 未知 → 不可用」的重排序。
 *
 * ## 三条不能破的判定原则（与 proxy-latency.ts 一脉相承）
 *
 * 1. **只有三态，没有「不可用」这个断言。** 握手失败完全可能是本站 Worker 出网
 *    被该节点挡了（Cloudflare 封了部分目标 IP），或在路上抖了一下 ——
 *    「没能验证 ≠ 不可用」。所以对外文案一律是「测不到」，内部状态用中性的 `down`
 *    （含义是「连续多轮都没握上手」，不是「这节点坏了」）。
 *
 * 2. **成功与失败的证据强度不对称，所以迟滞也不对称。**
 *    握手成功是**硬证据**（真的建起了 TCP 连接），因此一次成功即可判 `up`；
 *    握手失败是**弱证据**（可能是我们自己的出网问题），因此要连续
 *    `HANDSHAKE_FAIL_STREAK_TO_DOWN` 轮都失败才降级为 `down`。
 *    两者合起来的效果：恢复快、降级慢 —— 把可用节点误标成不可用（用户会错过好节点）
 *    比把不可用节点多留一轮（点一下就知道连不上）更伤用户。
 *
 * 3. **探不动的协议一律「未知」，绝不算失败。** hysteria / hysteria2 / tuic 走
 *    QUIC/UDP，Worker 建不了 UDP 连接。这类节点**不会有行**落库，
 *    读取时按「无记录」处理 —— 也就是 `unknown`，正好排在中段，不会被冤枉成 `down`。
 *
 * ## 排序口径
 *
 * `orderNodesByHealth` 输出顺序：`up`（按握手耗时升序，快的在前）→ `unknown`
 * → `down`；**同组内保持订阅源给出的原顺序**（稳定排序），这样即使一个节点都没探过，
 * 列表也不会莫名其妙地跳动。
 */
import type { Env } from "./env"

/** 节点健康状态（三态；刻意没有「不可用」，见模块注释第 1 条） */
export type NodeHealthStatus = "up" | "down" | "unknown"

/** 一次探活得到的**原始观测**（不含历史，历史由 nextHealthRecord 合并） */
export interface NodeProbe {
  ok: boolean
  /** ok=true 时的 TCP 握手耗时（毫秒） */
  latencyMs: number | null
  /** ok=false 时面向用户的中性原因（如「超时（3 秒内没连上）」） */
  reason: string
}

/** 落库的一行健康记录（对应 proxy_node_health 的一行） */
export interface NodeHealthRecord {
  status: NodeHealthStatus
  /** **最近一次握手成功**的耗时；从未成功过为 null（失败时不会把它清掉） */
  latencyMs: number | null
  okStreak: number
  failStreak: number
  /** 最近一次探活时间（ISO）；轮转与「数据是否新鲜」都看它 */
  checkedAt: string
  /** 最近一次失败原因；最近一次是成功则为 null */
  lastError: string | null
}

/** 连续成功几次算「可用」。1 —— 握手成功是硬证据，见模块注释第 2 条 */
export const HANDSHAKE_OK_STREAK_TO_UP = 1

/**
 * 连续失败几次算「不可用」。2 —— 一次失败太容易是抖动，
 * 订阅站 / 节点偶发超时非常常见（同 handlers/proxy.ts 里订阅抓取的「抖动重试」思路）。
 */
export const HANDSHAKE_FAIL_STREAK_TO_DOWN = 2

/** 从未探过的节点（也包含探不动的 QUIC 协议节点） */
export function emptyHealthRecord(): NodeHealthRecord {
  return {
    status: "unknown",
    latencyMs: null,
    okStreak: 0,
    failStreak: 0,
    checkedAt: "",
    lastError: null,
  }
}

/**
 * 把一次探活观测合并进历史，得到新的健康记录。
 *
 * 纯函数（不改入参、不碰时钟之外的任何外部状态），因此判定规则可以被单元测试
 * 逐条锁死 —— 这块规则一旦写错，表现是「所有节点都排到后面」这类静默的错误排序，
 * 光靠肉眼看线上列表根本发现不了。
 *
 * @param now 本次探活时间（ISO 字符串）。由调用方传入而不是内部取，
 *            是为了让同一个订阅源下的所有节点用**同一个时间戳**（便于按轮次比对）。
 */
export function nextHealthRecord(
  prev: NodeHealthRecord,
  probe: NodeProbe,
  now: string
): NodeHealthRecord {
  if (probe.ok) {
    const okStreak = prev.okStreak + 1
    return {
      // okStreak 到阈值即判 up；阈值恒为 1，这里的比较写法是为了让
      // 以后真要调阈值时改一处常量即可，而不是散在各处
      status: okStreak >= HANDSHAKE_OK_STREAK_TO_UP ? "up" : prev.status,
      latencyMs: probe.latencyMs,
      okStreak,
      failStreak: 0,
      checkedAt: now,
      lastError: null,
    }
  }

  const failStreak = prev.failStreak + 1
  // 尚未达到「连续失败」阈值时：此前可用的节点**保持可用**（容忍单轮抖动），
  // 此前未知的保持未知（不因为一次失败就给人家盖棺）
  const status: NodeHealthStatus =
    failStreak >= HANDSHAKE_FAIL_STREAK_TO_DOWN
      ? "down"
      : prev.status === "up"
        ? "up"
        : "unknown"

  return {
    status,
    // latencyMs 语义是「最近一次握手成功的耗时」—— 失败不清空它，
    // 否则一个刚抖了一下的节点会突然没有耗时数据可展示
    latencyMs: prev.latencyMs,
    okStreak: 0,
    failStreak,
    checkedAt: now,
    lastError: probe.reason,
  }
}

/** 排序权重：可用 0 → 未知 1 → 不可用 2（无记录按未知处理） */
const HEALTH_RANK: Record<NodeHealthStatus, number> = { up: 0, unknown: 1, down: 2 }

/** 状态在排序里的权重；`undefined`（无记录 = 未探过/探不了）等同 unknown */
export function nodeHealthRank(status: NodeHealthStatus | undefined): number {
  return status ? HEALTH_RANK[status] : HEALTH_RANK.unknown
}

/**
 * 按健康度重排节点：**可用在前 → 未知居中 → 不可用在最后**。
 *
 * 返回新数组（不改调用方持有的那份），且是**稳定**排序 —— 同一档内保持传入顺序，
 * 这样「还没探过任何节点」时列表与改动前完全一致，不会平白无故地重排。
 *
 * @param keyOf 从节点取指纹的函数。之所以由调用方传入而不是在这里 import
 *              `nodeFingerprint`，是为了避免 `handlers/proxy.ts ↔ 本模块` 的循环依赖
 *              （本模块被 proxy.ts 引用，同时要按它定义的节点形状排序）。
 */
export function orderNodesByHealth<T>(
  nodes: readonly T[],
  keyOf: (node: T) => string,
  health: ReadonlyMap<string, NodeHealthRecord>
): T[] {
  return nodes
    .map((node, index) => ({ node, index, record: health.get(keyOf(node)) }))
    .sort((a, b) => {
      const rankA = nodeHealthRank(a.record?.status)
      const rankB = nodeHealthRank(b.record?.status)
      if (rankA !== rankB) return rankA - rankB
      // 同为「可用」才有可比信息：握手耗时快的放前面。
      // 未知 / 不可用之间没有可靠信息，硬比会造出「看起来有意义其实随机」的顺序。
      if (rankA === HEALTH_RANK.up) {
        const la = a.record?.latencyMs ?? Number.MAX_SAFE_INTEGER
        const lb = b.record?.latencyMs ?? Number.MAX_SAFE_INTEGER
        if (la !== lb) return la - lb
      }
      return a.index - b.index
    })
    .map((entry) => entry.node)
}

/** 一个订阅源的节点健康概览（前端订阅卡片上的「可用 / 未知 / 不可用」） */
export interface NodeHealthSummary {
  up: number
  unknown: number
  down: number
  total: number
  /** 该订阅源里**最新**的一次探活时间；一个都没探过则为 null */
  checkedAt: string | null
}

/** 统计一份节点列表的健康分布（与 orderNodesByHealth 用同一套 keyOf 口径） */
export function summarizeNodeHealth<T>(
  nodes: readonly T[],
  keyOf: (node: T) => string,
  health: ReadonlyMap<string, NodeHealthRecord>
): NodeHealthSummary {
  const summary: NodeHealthSummary = { up: 0, unknown: 0, down: 0, total: nodes.length, checkedAt: null }
  for (const node of nodes) {
    const record = health.get(keyOf(node))
    summary[nodeHealthRank(record?.status) === HEALTH_RANK.up
      ? "up"
      : record?.status === "down"
        ? "down"
        : "unknown"] += 1
    if (record?.checkedAt && (!summary.checkedAt || record.checkedAt > summary.checkedAt)) {
      summary.checkedAt = record.checkedAt
    }
  }
  return summary
}

// ---- 落库 ----

/** 读取某个订阅源的全部健康行（key = 节点指纹） */
export async function loadSubscriptionNodeHealth(
  env: Env,
  subscriptionId: string
): Promise<Map<string, NodeHealthRecord>> {
  const rows = await env.DB.prepare(
    `SELECT fingerprint, status, latency_ms, ok_streak, fail_streak, checked_at, last_error
       FROM proxy_node_health WHERE subscription_id = ?`
  )
    .bind(subscriptionId)
    .all<{
      fingerprint: string
      status: string
      latency_ms: number | null
      ok_streak: number
      fail_streak: number
      checked_at: string | null
      last_error: string | null
    }>()

  const out = new Map<string, NodeHealthRecord>()
  for (const row of rows.results ?? []) {
    out.set(row.fingerprint, {
      status: normalizeStatus(row.status),
      latencyMs: row.latency_ms,
      okStreak: row.ok_streak ?? 0,
      failStreak: row.fail_streak ?? 0,
      checkedAt: row.checked_at ?? "",
      lastError: row.last_error,
    })
  }
  return out
}

/** 库里读出来的状态是裸字符串（表是手写的 SQL），不认识的取值一律按 unknown 处理 */
function normalizeStatus(raw: string): NodeHealthStatus {
  return raw === "up" || raw === "down" ? raw : "unknown"
}

/**
 * 写入一批健康记录。
 *
 * @param records     指纹 → 新记录
 * @param staleKeys   需要**删除**的旧行（节点已从订阅里消失）。由调用方从
 *                    `loadSubscriptionNodeHealth` 的结果里差出来 —— 这样不用在
 *                    SQL 里拼 `NOT IN (...)`（指纹数量可能上百，会撞 D1 的绑定参数上限）。
 */
export async function saveNodeHealth(
  env: Env,
  subscriptionId: string,
  records: ReadonlyMap<string, NodeHealthRecord>,
  staleKeys: readonly string[] = []
): Promise<void> {
  const now = new Date().toISOString()
  const statements = [...records.entries()].map(([fingerprint, record]) =>
    env.DB.prepare(
      `INSERT INTO proxy_node_health
         (fingerprint, subscription_id, status, latency_ms, ok_streak, fail_streak,
          checked_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint, subscription_id) DO UPDATE SET
         status = excluded.status,
         latency_ms = excluded.latency_ms,
         ok_streak = excluded.ok_streak,
         fail_streak = excluded.fail_streak,
         checked_at = excluded.checked_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    ).bind(
      fingerprint,
      subscriptionId,
      record.status,
      record.latencyMs,
      record.okStreak,
      record.failStreak,
      record.checkedAt || now,
      record.lastError,
      now,
      now
    )
  )

  for (const key of staleKeys) {
    statements.push(
      env.DB.prepare(
        "DELETE FROM proxy_node_health WHERE subscription_id = ? AND fingerprint = ?"
      ).bind(subscriptionId, key)
    )
  }

  if (statements.length > 0) await env.DB.batch(statements)
}
