/**
 * 「部署后页面报 Failed to fetch dynamically imported module」的自动恢复。
 *
 * 根因（不是代码错，是版本错）：
 *   前端是 SPA + Vite 内容哈希 chunk（`achievements-CYEQzn7r.js`）。每次部署，
 *   改动过的 chunk 会换一个新哈希名，旧文件随即从静态资产里消失。
 *   但用户浏览器里可能还开着**旧版本的页面**（它记的是旧 chunk 名）——
 *   此时点进某个懒加载路由，就会去请求一个服务器上已经不存在的 JS，得到 404，
 *   React.lazy 抛出「Failed to fetch dynamically imported module」。
 *   刷新能好，是因为刷新会重新拉 index.html（HTML 是 no-store），拿到新 chunk 名。
 *
 * 所以正确的修复不是改业务代码，而是**检测到这种失败就自动刷新一次**，
 * 让用户无感地换到新版本。必须带防循环：刷新后如果还是失败（例如真的网络断了），
 * 不能再刷，否则会无限刷新。
 */

const RELOAD_FLAG = "chunk-reload-at"
/** 这个窗口内已经刷过就不再刷，避免死循环 */
const RELOAD_WINDOW_MS = 10_000

/** 判断一个错误是不是「旧 chunk 加载失败」（而不是别的业务异常） */
export function isChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "")
  if (!msg) return false
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("dynamically imported module") ||
    /Loading chunk [\s\S]* failed/.test(msg) ||
    /Loading CSS chunk [\s\S]* failed/.test(msg)
  )
}

/**
 * 若是 chunk 加载失败就自动刷新一次。
 * @returns 是否触发了刷新（true 表示调用方不用再展示错误页）
 */
export function reloadOnceForChunkError(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false
  try {
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0)
    if (Date.now() - last < RELOAD_WINDOW_MS) return false // 刚刷过 → 放弃，交给错误页
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
  } catch {
    // sessionStorage 不可用（隐私模式等）时仍尝试刷新一次
  }
  window.location.reload()
  return true
}
