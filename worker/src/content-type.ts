/**
 * 用户上传内容的「可内联展示」判定 —— 全站唯一事实源。
 *
 * 为什么必须集中：本仓库原先在 5 个 handler 里各写了一份类型白名单
 * （storage / tempbox / identity / profile / community），结果其中三份
 * 都把 `image/svg+xml` 当成了安全类型，而另外两份（头像、名片资源）
 * 干脆没有任何收口。同一份策略抄五遍，就一定会有一份抄错。
 *
 * ⚠️ 2026-09-25 审计（P0）：`image/*` 前缀白名单包含 `image/svg+xml`。
 * SVG 是**可执行文档**：它作为顶层文档被浏览器加载时，内嵌的 <script>
 * 会以该 URL 所属源执行。而直链 `/dl/*` 与分享箱 `/api/tempbox/*` 都
 * 挂在应用主源 `cloud.doulor.cn` 上（会话 Cookie 是 host-only，不会
 * 发到子域），所以这是**同源存储型 XSS = 完整账户接管**：
 *
 *   1. 上传 evil.svg（Content-Type: image/svg+xml）→ 分享 /dl/<自己>/evil.svg
 *   2. 或建一个自己的分享箱 → 分享 /api/tempbox/<自己的码>/evil.svg
 *
 * 上传时的 Content-Type 完全由上传者控制（预签名 PUT 只签 host，
 * proxyUpload 直接取请求头），所以服务端**只能靠这里的判定来兜底**。
 *
 * 判定规则（宁可把能展示的类型判少，也不能判多）：
 *   - 先按精确名单拒绝一切「可执行 / 可脚本化」的类型；
 *   - 再拒绝所有 `+xml` 后缀（SVG、XHTML、RSS… 都属于 XML 家族）；
 *   - 最后才套用 `image/ video/ audio/` 前缀白名单。
 */

/** 绝对不允许内联展示的类型（浏览器会以文档方式解析并执行其中的脚本） */
const BLOCKED_EXACT = new Set([
  "image/svg+xml",
  "image/svg",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/mathml+xml",
  "application/rss+xml",
  "application/atom+xml",
])

/**
 * 允许内联展示的类型前缀。
 *
 * `video/` 与 `audio/` 不是可脚本化的文档类型，保留无风险。
 * 注意 `image/` 里混着 `image/svg+xml` —— 靠上面的 BLOCKED_EXACT 与
 * `+xml` 后缀两道闸拦掉，**不要**改成"排除 svg 字符串"式的匹配。
 */
const INLINE_PREFIXES = ["image/", "video/", "audio/"]

/** 允许内联展示的精确类型 */
const INLINE_EXACT = new Set([
  "text/plain",
  // PDF 保留内联：浏览器内置 PDF 阅读器运行在独立沙箱进程里，
  // 其中的 PDF JavaScript 拿不到页面源与本站会话 Cookie，与 SVG 不同源风险。
  // 若将来要更保守，把它移到 BLOCKED_EXACT 即可（代价是失去在线预览）。
  "application/pdf",
])

/**
 * 归一化 Content-Type：去掉 `; charset=...` 参数并转小写。
 * 传进来的值可能来自 R2 的 HEAD 结果、请求头或数据库，格式不保证。
 */
export function normalizeContentType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase()
}

/**
 * 该类型是否可以 `Content-Disposition: inline` 下发展示？
 *
 * 返回 false 时调用方必须改用 `attachment`，并把 Content-Type 降级为
 * `application/octet-stream`（只改 Disposition 不改类型是不够的：
 * 部分浏览器仍会按声明类型嗅探渲染）。
 */
export function isInlineSafe(contentType: string | null | undefined): boolean {
  const t = normalizeContentType(contentType)
  if (!t) return false
  // 第一道：精确黑名单（覆盖 image/svg+xml 这个历史漏洞）
  if (BLOCKED_EXACT.has(t)) return false
  // 第二道：一切 XML 家族（`+xml` 后缀是 RFC 6839 的结构化语法后缀，
  // 未来新出现的可脚本化 XML 类型会被这道闸自动拦下）
  if (t.endsWith("+xml")) return false
  // 第三道：白名单
  if (INLINE_EXACT.has(t)) return true
  return INLINE_PREFIXES.some((p) => t.startsWith(p))
}

/**
 * 构造「用户内容」响应的 Content-Type / Content-Disposition 组合。
 *
 * 所有把用户上传的字节流回给浏览器的 handler 都应该用它，不要各写一套。
 */
export function contentDispositionFor(
  contentType: string | null | undefined,
  filename: string
): { contentType: string; contentDisposition: string } {
  const safeName = encodeURIComponent(filename || "file")
  if (isInlineSafe(contentType)) {
    return {
      contentType: normalizeContentType(contentType) || "application/octet-stream",
      contentDisposition: `inline; filename*=UTF-8''${safeName}`,
    }
  }
  return {
    contentType: "application/octet-stream",
    contentDisposition: `attachment; filename*=UTF-8''${safeName}`,
  }
}

/**
 * 给「用户内容」响应套上类型收口与安全头。
 *
 * 用于那些直接把 R2 响应透传出去的读取接口（头像 /u/<用户名>/avatar、
 * 社区图片 /c/<postId>/<file>、名片图库 /p/<用户名>/gallery/<id>）。
 * 这些接口此前**完全没有收口**：Content-Type
 * 直接来自 R2 对象的存储元数据，一旦对象是 out-of-band 写进去的
 * （或上传校验有缺口），浏览器就会按 text/html 或 image/svg+xml 渲染它。
 *
 * 注意：R2 返回的 body 是流，构造新 Response 时直接透传即可（不会缓冲）。
 */
export function hardenUserContentResponse(res: Response, filename: string): Response {
  const headers = new Headers(res.headers)
  const { contentType, contentDisposition } = contentDispositionFor(
    headers.get("content-type"),
    filename
  )
  headers.set("Content-Type", contentType)
  headers.set("Content-Disposition", contentDisposition)
  headers.set("X-Content-Type-Options", "nosniff")
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "private, no-store")
  }
  return new Response(res.body, { status: res.status, headers })
}
