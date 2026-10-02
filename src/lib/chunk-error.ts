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
    /Loading CSS chunk [\s\S]* failed/.test(msg) ||
    // 「缺失的 chunk 被 SPA 兜底成了 HTML」时浏览器报的是这句（而不是上面那些），
    // 因为 HTML 被当 JS 模块解析、模块对象是空的。服务端已改成返回 404（见
    // site-worker.js），这里再兜一层：万一还有缓存的坏响应，也照样自动刷新自愈。
    /Cannot read propert.*\(reading 'default'\)/.test(msg)
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
  void hardResetAndReload()
  return true
}

/**
 * 彻底重置客户端缓存后刷新：**注销 Service Worker + 清空 Cache Storage**，再重新加载。
 *
 * 为什么不能只用 `location.reload()`：
 *   本站有 Service Worker，静态资源走「缓存优先」。一旦某个响应被缓存成坏的
 *   （历史事故：assets 曾把「不存在的 chunk」兜底成 200 + text/html，SW 按 res.ok
 *   也把它缓存了），`location.reload()` 会直接从 SW 缓存里再拿回那份坏响应，
 *   于是**刷新多少次都没用**（站长 2026-10-02 就是这么被卡死的）。
 *   只有把 SW 注销、Cache Storage 清空，才能拿到真正的新版本。
 *
 * 同时带一个 cache-busting 查询参数，绕过 浏览器/边缘 对 HTML 的缓存。
 * SW 会在下次加载时自动重新注册，用户无感。
 */
export async function hardResetAndReload(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
  } catch {
    /* 注销失败也继续 */
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* 清缓存失败也继续 */
  }
  try {
    const u = new URL(window.location.href)
    u.searchParams.set("_r", String(Date.now()))
    window.location.replace(u.toString())
  } catch {
    window.location.reload()
  }
}
