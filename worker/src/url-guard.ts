/**
 * 出站地址的守卫。
 *
 * 任何「服务端去请求用户填的地址」的功能都必须过这里 —— 那是 SSRF 面：
 * 攻击者可以让服务器去访问它自己网络里的东西（内网服务、云元数据端点…）。
 * 当前用到的地方：
 *   - AI 渠道捐献的上游探测（`donation-provision.ts`）
 *   - 代理订阅捐献的订阅校验（`handlers/proxy.ts`）
 *   - 社区 / 公告里裸链接的卡片预览（`link-preview.ts`）
 *   - 工具箱「网页分享」的自动识别与图标代理（`handlers/fun-link-probe.ts`）
 *   - 商汤 Key 巡检（`sensenova.ts`）
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
  const h = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (!h) return true
  if (PRIVATE_HOST_RE.test(h)) return true
  // 172.16 – 172.31
  const m = /^172\.(\d{1,3})\./.exec(h)
  if (m) {
    const n = Number(m[1])
    if (n >= 16 && n <= 31) return true
  }
  // 100.64 – 100.127：运营商级 NAT（CGNAT），公网上路由不到
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true
  // 224 – 255：多播（224/4）与保留（240/4）。注意 220–223 是正常公网段，别一起拦了。
  if (/^(22[4-9]|23\d|24\d|25[0-5])\./.test(h)) return true
  // 特殊用途域名后缀：mDNS / 内网域名 / 私有用例
  if (/\.(local|localhost|internal|home\.arpa)$/.test(h)) return true
  // 纯 IPv6 回环 / 未指定
  if (h === "::1" || h === "::") return true
  // 其它 IPv6 字面量（形如 fe80::1、fc00::1）——正常站点用不到，一律拒
  if (h.includes(":")) return true
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

/**
 * 校验 TCP 连接目标；与 HTTP URL 守卫共用同一套字面量内网规则。
 * IPv6 节点可能带方括号，先剥掉方括号再交给主机校验。
 */
export function assertPublicTcpHost(raw: string, label = "节点地址"): string {
  const input = (raw ?? "").trim()
  if (!input) throw new Error(`${label}不能是本机或内网地址`)
  // URL 解析会规范化非标准 IPv4 写法，避免字面检查被绕过。
  const authority = input.includes(":") && !input.startsWith("[") ? `[${input}]` : input
  let parsed: URL
  try {
    parsed = new URL(`http://${authority}`)
  } catch {
    throw new Error(`${label}无效`)
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label}无效`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  if (!host || isPrivateOrLocalHost(host)) {
    throw new Error(`${label}不能是本机或内网地址`)
  }
  return host
}
