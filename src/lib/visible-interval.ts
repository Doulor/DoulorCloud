/**
 * 「只在页面可见时轮询」的定时器。
 *
 * 为什么需要（2026-09-30）：
 *   Cloudflare Workers 免费额度是 **10 万请求/天**，而聊天页此前每 2 秒拉一次消息
 *   —— 一个开着聊天页的用户一天最多 ~5.6 万个请求，人数一多免费额度必然打满
 *   （当日实测已到 93.6%）。最大的浪费来自**用户根本没在看**的标签页。
 *
 *   浏览器对后台标签页有节流（隐藏 5 分钟后定时器最多 1 次/分钟），但那只兜底
 *   「切走很久」的情况；刚切走的那几分钟、以及分屏/小窗这类「不可见但未隐藏」的
 *   场景仍然全速轮询。这里干脆只在 `document.visibilityState === "visible"` 时跑。
 *
 * 交互上的取舍：切回标签页时**立即刷一次**再恢复轮询，所以用户看到的是最新数据，
 * 不会出现「回来先看 5 秒前的旧消息」。
 *
 * 返回值是清理函数，组件卸载时调用（与 `clearInterval` 同样的用法）。
 */
export function setVisibleInterval(
  fn: () => void,
  ms: number,
  /**
   * 可选：**窗口聚焦且页面可见**时改用这个更快的间隔（2026-10-17）。
   *
   * 为什么加这个（用户 yptcnzleri 反馈「聊天室太卡」）：
   *   5 秒轮询是为省钱降下来的，不能整体改回 2 秒；但"人正盯着聊天室"和
   *   "聊天室开着但人在别的窗口"这两种情况的额度代价完全不同 ——
   *   后者才是 9-30 那次额度打满的元凶。
   *   所以只在 `document.hasFocus()` 为真（真的在前台看这个页面）时加速，
   *   一旦失焦立刻退回慢节奏。平均请求量只多了"真在看"的那段时间。
   *
   * 不传则行为与改动前完全一致（其它页面照旧）。
   */
  focusedMs?: number
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined

  const currentMs = () => (focusedMs && document.hasFocus() ? focusedMs : ms)

  const start = () => {
    if (timer === undefined) timer = setInterval(fn, currentMs())
  }
  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
  /** 间隔变了要重建定时器：setInterval 的周期在创建时就定死了 */
  const restart = () => {
    stop()
    start()
  }

  const onVisibilityChange = () => {
    if (document.hidden) {
      stop()
    } else {
      // 切回来先立刻刷一次：这段隐藏期间的数据不能漏
      fn()
      start()
    }
  }

  /** 聚焦/失焦只影响节奏，不额外补一次请求（切标签页那条已经会立刻刷） */
  const onFocusChange = () => {
    if (document.hidden) return
    restart()
  }

  document.addEventListener("visibilitychange", onVisibilityChange)
  if (focusedMs) {
    window.addEventListener("focus", onFocusChange)
    window.addEventListener("blur", onFocusChange)
  }
  if (document.hidden) stop()
  else start()

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange)
    if (focusedMs) {
      window.removeEventListener("focus", onFocusChange)
      window.removeEventListener("blur", onFocusChange)
    }
    stop()
  }
}
