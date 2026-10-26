/**
 * 「积分与商城」总览数据的冷缓存（stale-while-revalidate）。
 *
 * 问题：积分页每次挂载都发 `GET /api/points` 全量请求（API 响应本身 no-store），
 * 用户从「积分与商城」切到别的侧边栏再切回，整页数据 + 封面图全部重新请求 ——
 * 网络稍慢时列表先塌成骨架屏再一根根长回来，滚动位置也丢。
 *
 * 方案与 profile-cache.ts（名片冷缓存）同一套：
 *   · 会话内存缓存：SPA 内来回切页，内存命中 = 零请求瞬开（滚动位置自然保住）；
 *   · localStorage 冷缓存：刷新 / 重开标签页，先渲染上次的数据（秒开），
 *     后台再拉真数据，到了无感替换；
 *   · 页面挂载时**总是**重新请求（load() 不因缓存命中而跳过），写入操作后页面
 *     本来就会重拉 —— 缓存里永远是「上一次服务端确认」的数据，余额/订单最多
 *     陈旧一个后台刷新的间隙，不会停留在过期值上。缓存只管首屏有东西可看。
 *
 * 隐私与体积：总览只含用户自己的余额 / 订单 / 商品（本人本就可见），存
 * localStorage 无泄露面；JSON 超过 2 MB（极端订单量）就放弃持久化，内存层还在；
 * 写不进（隐私模式 / 配额超限）同样静默放弃，行为与无缓存版一致。
 */
import type { PointsOverview } from "@/types"

const KEY = "doulor:points-cache"
/** 冷缓存有效期：超过就只当「参考快照」，仍渲染但不当真（挂载必重拉） */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** localStorage 持久化的体积上限：超过只留内存层（正常数据远小于此） */
const MAX_PERSIST_BYTES = 2 * 1024 * 1024

interface CachedPayload {
  at: number
  data: PointsOverview
}

/** 会话内存层：SPA 来回切页面时零请求 */
let memCache: CachedPayload | null = null

function readLocal(): CachedPayload | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedPayload
    if (!parsed || typeof parsed.at !== "number" || !parsed.data) return null
    if (Date.now() - parsed.at > MAX_AGE_MS) return null
    return parsed
  } catch {
    return null
  }
}

/** 取冷缓存：内存层优先，localStorage 兜底（命中后回填内存层） */
export function getCachedPointsOverview(): PointsOverview | null {
  if (memCache) return memCache.data
  const local = readLocal()
  if (local) {
    memCache = local
    return local.data
  }
  return null
}

/** 网络加载成功后写双层缓存（写入失败静默：隐私模式/超限都不影响页面） */
export function setCachedPointsOverview(data: PointsOverview): void {
  memCache = { at: Date.now(), data }
  try {
    const raw = JSON.stringify(memCache)
    if (raw.length <= MAX_PERSIST_BYTES) localStorage.setItem(KEY, raw)
  } catch {
    // 写不进就算了（QuotaExceeded / 隐私模式）：内存层还在
  }
}
