/**
 * 链接预览的**共享缓存**（模块级，全站一份）。
 *
 * 为什么要单独抽出来：同一条链接会**先后**被两处用到 ——
 * 帖子正文里的裸链接先由 `LinkCard` 抓一次预览，用户点它时「外链确认弹窗」
 * 又要展示同一份预览。各自抓一遍的话，点开弹窗还得再等一次请求，
 * 而且白费一次服务端抓取（服务端是真去访问目标站的，不算便宜）。
 *
 * 值语义：
 *   · 缓存里**没有**这个 key  → 没查过（`peek` 返回 undefined）
 *   · 缓存里是 `null`         → 查过但拿不到（也要缓存，否则坏链接会被反复重试）
 */
import { communityApi } from "@/services/api"
import type { LinkPreview } from "@/types"

const cache = new Map<string, LinkPreview | null>()
/** 同一 URL 的并发请求去重：LinkCard 与弹窗可能同时要 */
const inflight = new Map<string, Promise<LinkPreview | null>>()

/** 只看缓存，不发请求。返回 undefined 表示「没查过」 */
export function peekLinkPreview(url: string): LinkPreview | null | undefined {
  return cache.get(url)
}

/** 取预览：命中缓存直接给，否则发一次请求（同 URL 并发只发一次） */
export function loadLinkPreview(url: string): Promise<LinkPreview | null> {
  const hit = cache.get(url)
  if (hit !== undefined) return Promise.resolve(hit)
  const running = inflight.get(url)
  if (running) return running

  const task = communityApi
    .linkPreview(url)
    .then((r) => {
      const value = r.preview ?? null
      cache.set(url, value)
      return value
    })
    .catch(() => {
      // 抓不到也记下来：否则每次渲染/点开都会对同一堆坏链接重试一遍
      cache.set(url, null)
      return null
    })
    .finally(() => {
      inflight.delete(url)
    })

  inflight.set(url, task)
  return task
}

/** 从 URL 取域名，取不到就原样返回（用于展示「你要去的是哪个站」） */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
