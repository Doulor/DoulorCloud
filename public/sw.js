/**
 * Doulor Cloud 的 PWA Service Worker。
 *
 * 策略刻意保守，不能破坏站上已有的「chunk 哈希变了 → 旧 HTML → 404 → 自动刷新」自愈：
 *   - 导航（HTML）：**网络优先**，失败才回退缓存（离线还能打开壳）。这样每次更新都能拿到新 HTML，
 *     不会因为 SW 缓存了旧 HTML 而把「旧哈希 JS 404 → 刷新」这条路堵死。
 *   - 静态资源（带哈希的 JS/CSS/字体/图标）：**缓存优先**（URL 带哈希，内容不可变）。
 *   - /api/*：**永远走网络**，不缓存（接口有鉴权与实时性）。
 */
// ⚠️ 改这里 = 激活时清掉上一版缓存。2026-10-02 升 v2：此前 assets 会把「不存在的
//    /assets/*.js」兜底成 200 + text/html，SW 按 res.ok 把这个坏响应也缓存了；
//    服务端已修（site-worker.js 对这类路径返回 404），这里升版本把历史坏缓存清掉。
const CACHE = "doulor-shell-v2"

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
