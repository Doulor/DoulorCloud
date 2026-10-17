/**
 * 个人名片数据的冷缓存（stale-while-revalidate）。
 *
 * 问题：个人名片编辑页每次打开都发 `GET /api/profile` 全量请求（no-store、
 * 无任何缓存层），响应里还带着 20 多个不变的 meta 常量 —— 每次进页面都是
 * 「白屏等请求」，网络稍慢就要干等几百毫秒到秒级。
 *
 * 方案（与 sticker-panel 的「三层各管一段」同一精神，这里只做客户端层）：
 *   · 会话内存缓存：SPA 内来回切页面，内存命中 = 零请求瞬开；
 *   · localStorage 冷缓存：刷新浏览器 / 重开标签页，先把上次的数据渲染出来
 *     （秒开），后台再拉一次真数据，到了就无感替换；
 *   · 「改了卡片内容后没有及时变化」的担忧：写操作（保存/上传/删除）之后
 *     调 invalidateProfileCache() 把缓存清掉 —— 下次 load 必走网络；
 *     且后台刷新返回后总是**覆盖渲染**（除非用户已经开始改表单，见 profile.tsx
 *     的合并逻辑），所以缓存的永远是「上一次服务端确认」的数据，不会停留在
 *     过期值上。缓存只是让首屏有东西可看，不是让数据绕过服务端。
 *
 * 隐私与体积：profile 数据只含用户自己的名片内容（本来就是本人可见），
 * 存 localStorage 无泄露面；超限时直接放弃冷缓存（下次没缓存，行为同旧版）。
 */
import type { ProfileOverview } from "@/types"

const KEY = "doulor:profile-cache"
/** 冷缓存有效期：超过这个时长就只当「参考快照」，仍渲染但不当真（本来就是 SWR） */
const MAX_AGE_MS = 7 * 86_400_000

interface CachedPayload {
  at: number
  data: ProfileOverview
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

/**
 * 取冷缓存：内存层优先，localStorage 兜底（命中后回填内存层）。
 * 没有则返回 null（调用方走正常网络加载）。
 */
export function getCachedProfile(): ProfileOverview | null {
  if (memCache) return memCache.data
  const local = readLocal()
  if (local) {
    memCache = local
    return local.data
  }
  return null
}

/** 网络加载成功后写双层缓存（写入失败静默：隐私模式/超限都不影响页面） */
export function setCachedProfile(data: ProfileOverview): void {
  memCache = { at: Date.now(), data }
  try {
    localStorage.setItem(KEY, JSON.stringify(memCache))
  } catch {
    // 写不进就算了（QuotaExceeded / 隐私模式）：内存层还在
  }
}

/**
 * 清缓存：任何**写操作**（保存名片、上传/删除资源、绑域名、开通）之后调用。
 * 不清的话，下次进页面会先渲染旧数据再刷新 —— 名片这种「我改完就想看」的
 * 页面，宁可多等一次请求也不能给用户看旧内容。
 */
export function invalidateProfileCache(): void {
  memCache = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 忽略
  }
}
