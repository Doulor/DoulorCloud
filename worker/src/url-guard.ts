/**
 * 出站地址的守卫。
 *
 * 任何「服务端去请求用户填的地址」的功能都必须过这里 —— 那是 SSRF 面：
 * 攻击者可以让服务器去访问它自己网络里的东西（内网服务、云元数据端点…）。
 * 当前有两处用到：
 *   - AI 渠道捐献的上游探测（`donation-provision.ts`）
 *   - 代理订阅捐献的订阅校验（`handlers/proxy.ts`）
 */

/** 本机 / 内网 / 链路本地地址的字面量前缀 */
const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i

/**
 * 判断主机名是否指向本机或内网。
 *
 * 注意这里只做**字面量**判断（不做 DNS 解析后再判断）——
 * Worker 里无法可靠地「先解析再校验」（TOCTOU），而且 Cloudflare 的出站本身
 * 也访问不到内网地址。这一层是为了挡住明显的探测请求、并给出清晰报错。
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const h = (host ?? "").trim().toLowerCase()
  if (!h) return true
  if (PRIVATE_HOST_RE.test(h)) return true
  // 172.16 – 172.31
  const m = /^172\.(\d{1,3})\./.exec(h)
  if (m) {
    const n = Number(m[1])
    if (n >= 16 && n <= 31) return true
  }
  // 纯 IPv6 回环 / 未指定
  if (h === "::1" || h === "::") return true
  return false
}

/**
 * 校验一个用户提交的 http(s) 地址；通过则返回解析结果，否则抛错。
 *
 * @param label 报错里用的名词，例如「上游 API 地址」「订阅链接」
 */
export function assertPublicHttpUrl(
  raw: string,
  label = "地址"
): { url: URL; href: string; host: string } {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) throw new Error(`请填写${label}`)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${label}不是合法 URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label}只支持 http/https`)
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error(`${label}不能是本机或内网地址`)
  }
  return { url, href: url.href, host: url.hostname }
}
