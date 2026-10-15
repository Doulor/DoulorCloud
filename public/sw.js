/**
 * Doulor Cloud 的 PWA Service Worker。
 *
 * 策略刻意保守，不能破坏站上已有的「chunk 哈希变了 → 旧 HTML → 404 → 自动刷新」自愈：
 *   - 导航（HTML）：**网络优先**，失败才回退缓存（离线还能打开壳）。这样每次更新都能拿到新 HTML，
 *     不会因为 SW 缓存了旧 HTML 而把「旧哈希 JS 404 → 刷新」这条路堵死。
 *   - 静态资源（带哈希的 JS/CSS/字体/图标）：**缓存优先**（URL 带哈希，内容不可变）。
 *   - /api/*：**永远走网络**，不缓存（接口有鉴权与实时性）。
 */
// ⚠️ 改这里 = 激活时清掉上一版缓存。2026-10-03 升 v3：此前站长反馈「关了捐献授权
//   开关、捐献页文案却还是旧的」，根因是 cache-first 的静态资源把旧 chunk 缓存住了，
//   普通刷新拿不到新版（chunk 哈希变了但旧缓存仍在）。升版本强制清一次，让所有人
//   下次加载拿到最新版本。历史：2026-10-02 升 v2 修「不存在的 /assets/*.js 被兜底成
//   200 + text/html、SW 把坏响应也缓存」的问题（见 site-worker.js）。
// 🔴 2026-10-14 升 v4：**安全**原因，不是功能原因。
//
//   攻击链（findings #3/#4，已实测）：普通用户把作品绑到 cloud.doulor.cn 后，
//   其页面以同源 text/html 交付并执行脚本，而该脚本可以 `caches.open("doulor-shell-v3")`
//   然后把**本域全部 /assets/*.js（含 SPA 入口）覆盖成攻击者载荷**。
//   本 SW 对静态资源是 cache-first、命中即返回，于是被篡改的入口脚本从此长期生效 ——
//   即使在服务端解绑、主应用完全复原之后依然如此（投毒写在**浏览器**里，服务端撤不掉）。
//
//   升级缓存名能让所有受害者恢复：新版本用新缓存名，旧的（被投毒）缓存会在
//   activate 阶段被删除，被篡改的 /assets/*.js 条目就不再可达。
//   这是唯一能"回溯修复"已中毒浏览器的手段 —— CSP 只能防住以后。
//
//   ⚠️ 代价：所有人下次加载会重新拉一遍静态资源（和 2026-10-03 升 v3 一样的代价）。
//   兜底：投毒窗口内改绑解绑过的用户，若其浏览器仍持有旧 SW，需等本 SW 更新到 v4 才恢复；
//   app 侧另有主动注销异常注册的逻辑（见 src/lib/chunk-error.ts）。
const CACHE = "doulor-shell-v4"

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"])
    )
  )
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== location.origin) return
  if (url.pathname.startsWith("/api/")) return

  // 导航请求：网络优先，断网回退缓存的壳
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put("/", copy))
          return res
        })
        .catch(() => caches.match("/"))
    )
    return
  }

  // 静态资源：缓存优先
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((res) => {
        // ⚠️ 只缓存「类型对得上」的响应。历史事故：assets 曾把不存在的 /assets/*.js
        //    兜底成 200 + text/html，SW 只按 res.ok 判断就把这份 HTML 当 chunk 缓存了，
        //    之后 cache-first 永远返回坏响应 → 用户刷新多少次都好不了（站长 2026-10-02）。
        //    服务端已修（site-worker.js 对缺失静态资源返回 404），这里再加一道：
        //    凡是「请求的资源路径不是 .html，却拿回 text/html」的，一律不缓存。
        const ct = (res.headers.get("Content-Type") || "").toLowerCase()
        const htmlFallback =
          ct.includes("text/html") && !url.pathname.endsWith(".html")
        if (res.ok && !htmlFallback) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(request, copy))
        }
        return res
      })
    })
  )
})
