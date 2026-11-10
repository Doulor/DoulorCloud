/**
 * 进程内短 TTL 缓存（每个 isolate 一份，不跨 colo 共享）。
 *
 * 为什么需要（2026-10-28，D1 额度优化）：
 *   本站有几处**计数类**读取属于「同一个人/同一批数据在几秒内被反复问」——
 *   侧边栏角标、聊天室角标、外部 group-sync 每 20~30 秒拉一次的白名单。
 *   这类读取每次都从头扫 D1，实测占全库行读 20% 以上，但结果在十几秒内
 *   几乎不可能变。加一层 10~20 秒的进程内缓存，用户感知不到
 *   （角标本来就跟着下一次轮询刷新），D1 行读直接少一大截。
 *
 * ⚠️ 三条使用约束：
 *   a. **只用于读**，且值必须是「可以安全陈旧十几秒」的东西（计数、派生快照）。
 *      金额、库存、订单状态这类不许这样缓存。
 *   b. key 必须带用户/对象维度（如 `chat-unread:<uid>`），否则会串号。
 *   c. 缓存 key 里要**自带版本维度**（例如最新一条消息的时间），让「数据变了」
 *      这件事自己体现在 key 上 —— 单机进程内没法可靠地跨 isolate 主动失效，
 *      靠"写的时候去通知"一定会漏。
 */

type Entry = { at: number; value: unknown }

const store = new Map<string, Entry>()

/** 粗暴上限：isolate 长跑时别把内存吃光（这里本就该是短命数据，清空比 LRU 简单） */
const MAX_ENTRIES = 5_000

export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>
): Promise<T> {
  const hit = store.get(key)
  const now = Date.now()
  if (hit && now - hit.at < ttlMs) return hit.value as T
  const value = await load()
  if (store.size >= MAX_ENTRIES) store.clear()
  store.set(key, { at: now, value })
  return value
}
