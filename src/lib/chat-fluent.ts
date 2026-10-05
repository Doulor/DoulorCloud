/**
 * 聊天室 / 私信共用的「Telegram 式流畅性」小工具（2026-10-05）。
 *
 * 每个函数都标注了借鉴的 Telegram 出处（探查报告里的文件:行号），
 * 逻辑刻意保持无依赖、纯函数优先，方便两边页面复用与单测。
 */

/** 本地时区的日期键 `YYYY-MM-DD`（分组用；与 Telegram MessageObject 的 dateKey 同思路，按本地天分桶） */
export function dayKeyOf(iso: string | number | Date): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/**
 * 日期分割线文案：今天 / 昨天 / 具体日期。
 * `t` 是 useT 的翻译函数 —— 文案归 i18n 管，工具只负责算「是哪一天」。
 */
export function dayLabel(
  iso: string | number | Date,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const today = dayKeyOf(new Date())
  const yesterday = dayKeyOf(Date.now() - 24 * 60 * 60 * 1000)
  const key = dayKeyOf(iso)
  if (key === today) return t("chat.day.today")
  if (key === yesterday) return t("chat.day.yesterday")
  const d = new Date(iso)
  return t("chat.day.date", { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
}

/** 用户是否停在底部（容差 48px，与私信既有 stickBottom 判断一致；借鉴 ChatActivity 的 diff≤5dp 判据） */
export function isNearBottom(el: HTMLElement | null, tol = 48): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < tol
}

/**
 * 平滑滚到底部（回到底部按钮专用）。
 * 时长按距离线性映射：(滚动长度/视口高 + 1) × 200ms，钳在 300–1300ms ——
 * 直接抄 Telegram RecyclerAnimationScrollHelper L320-347 的参数，
 * 缓动用五次方 ease-out（≈ 它的 EASE_OUT_QUINT）。
 * 每帧重读 scrollHeight：图片/表情包异步加载把内容撑高时，轨迹会追着目标走。
 * 用户一滚动（wheel / touch）立刻打断，把滚动的主动权还给人。
 */
export function smoothScrollToBottom(el: HTMLElement | null): void {
  if (!el) return
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  if (reduce) {
    el.scrollTop = el.scrollHeight
    return
  }
  const startTop = el.scrollTop
  const t0 = performance.now()
  let dur = 0
  let cancelled = false
  const onUserScroll = () => {
    cancelled = true
  }
  el.addEventListener("wheel", onUserScroll, { passive: true, once: true })
  el.addEventListener("touchmove", onUserScroll, { passive: true, once: true })
  const step = (now: number) => {
    if (cancelled) return
    const max = el.scrollHeight - el.clientHeight
    const len = max - startTop
    if (len <= 1) return
    if (!dur) dur = Math.min(Math.max((len / Math.max(el.clientHeight, 1) + 1) * 200, 300), 1300)
    const p = Math.min((now - t0) / dur, 1)
    const ease = 1 - Math.pow(1 - p, 5)
    el.scrollTop = startTop + (max - startTop) * ease
    if (p < 1) requestAnimationFrame(step)
    else {
      el.removeEventListener("wheel", onUserScroll)
      el.removeEventListener("touchmove", onUserScroll)
    }
  }
  requestAnimationFrame(step)
}

/** 瞬时贴底（新消息自动吸底用；高度会变所以多补几帧，调用方还可在图片加载后再补滚） */
export function jumpToBottom(el: HTMLElement | null): void {
  if (!el) return
  el.scrollTop = el.scrollHeight
}

/**
 * 乐观发送的幂等键（借鉴 Telegram 的 random_id —— 服务端靠它把重复提交折叠成一条）。
 * 长度落在后端接受的 8–64 区间内。
 */
export function newClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID()
    }
  } catch {
    /* 某些环境（非安全上下文）没有 randomUUID，走兜底 */
  }
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
}
