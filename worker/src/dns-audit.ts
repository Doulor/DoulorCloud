/**
 * DNS 记录合规审计（规则引擎 + 扫描器）。
 *
 * 背景（2026-10-01）：站内 DNS 解析功能此前**完全没有审核**。
 * 用户建一条记录，唯一会拒绝它的是 Cloudflare 的字段校验（IP 格式、TTL 取值…），
 * 至于这条记录**该不该存在**，没有任何环节判断。于是平台上真的出现了：
 *   · 把整段子域名转发给外部站点（`CNAME r.forwarddomain.net` + TXT `forward-domain=`）
 *   · 用平台域名去托管第三方 Pages 站点（`CNAME cf-xxx.pages.dev`）
 *   · 指向内网/测试网段（`192.168.55.154`、`192.0.2.10`）
 *   · 大量内容非法导致 CF 拒绝、本地却留着 `status='error'` 的脏数据
 * 这些在管理面板里当时**完全看不到** —— 只有翻某个用户详情时才会露出 200 条。
 *
 * 本模块只做两件事，且都是纯函数优先：
 *   1. `assessRecord()` —— 对单条记录跑规则，返回发现项（无 IO，可单测）
 *   2. `scanDns()`      —— 拉全表 → 跑规则 → 落库 → 返回汇总
 *
 * 设计取舍：
 *   · **规则宁可少而准。** 一堆误报会让站长直接无视整个面板，等于没做。
 *     所以「未开代理」这类正常用法只给 low（信息性），不冒充风险。
 *   · **严重度按「外部会不会把这笔账算到平台头上」划分，而不是按「数据干不干净」**：
 *       high   = 明确的滥用形态（域名转发、白嫖第三方托管、指向内网、泛解析…）
 *                —— 这些会被受害者、被投诉方、被搜索引擎归到 doulor.cn 上。
 *       medium = 可疑或需要看一眼（测试网段、公共解析器 IP、随机名、邮件鉴权配置…）
 *       low    = 信息性（脏数据、未开代理、台账与实际不一致）
 *     为什么要把「内容非法」从 high 降到 medium：线上实测（2026-10-01）一个用户
 *     批量造了 22 条 `A a` / `A b` 这样的非法记录，它们在 Cloudflare 侧**根本没建成**
 *     （status=error），零滥用可能。把它们算成「高风险」的结果是高风险计数 27 条、
 *     真正要紧的 6 条被淹没 —— 站长扫一眼就再也不会打开这个页面了。
 *   · **发现项落库、不每次现算。** 需要「已忽略」的处置记忆；角标也只要一条 COUNT。
 *   · **外部探测（真实解析）只在手动扫描时做。** 定时任务里打第三方是隐性依赖，
 *     对方抖动会连带 cron 变慢；手动扫描时站长在等结果，多做一点是值得的。
 */
import { fetchWithTimeout, mapLimit } from "./async-utils"
import type { Env } from "./env"
import { allRootDomainNames } from "./root-domains"

export type Severity = "high" | "medium" | "low"

export interface Finding {
  /** 规则 id，稳定不变（前端按它做图标/文案映射） */
  rule: string
  severity: Severity
  /** 面向站长的中文说明：为什么这条有问题 */
  detail: string
}

/** dns_records 的一行（含 JOIN 出来的归属信息） */
export interface DnsRecordLike {
  id: string
  domain_id: string
  subdomain_id: string | null
  cf_id: string | null
  name: string
  fqdn: string
  type: string
  content: string
  ttl: number
  proxied: number
  priority: number | null
  /** SRV 专有列（非 SRV 记录为 null） */
  srv_weight: number | null
  srv_port: number | null
  srv_target: string | null
  status: string
  created_at: string
  updated_at: string
  /** JOIN users.username */
  username?: string | null
}

// ---------------------------------------------------------------------------
// 规则常量
// ---------------------------------------------------------------------------

/**
 * 第三方托管平台后缀：CNAME 指到这些地方 = 用平台域名托管别人的站点。
 *
 * 为什么算风险：内容是对方平台**随时可改**的，平台域名就成了「信誉背书」——
 * 钓鱼页挂在 `<用户>.doulor.cn` 上，链接看着像是 we 家的站。takedown 时
 * 我们只能删记录，删不掉对方站点，对方换个名字又能再来。
 */
const THIRD_PARTY_HOSTS = [
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "netlify.com",
  "github.io",
  "gitbook.io",
  "notion.site",
  "readthedocs.io",
  "herokuapp.com",
  "azurewebsites.net",
  "web.app",
  "firebaseapp.com",
  "glitch.me",
  "repl.co",
  "replit.app",
  "surge.sh",
  "onrender.com",
  "fly.dev",
  "deno.dev",
  "pythonanywhere.com",
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "weebly.com",
  "jimdofree.com",
  "pages.gay",
  "ngrok.io",
  "trycloudflare.com",
  "localtunnel.me",
  "serveo.net",
  "cpolar.cn",
  "natappfree.cc",
  "wikidot.com",
]

/**
 * 域名转发服务后缀。
 *
 * `r.forwarddomain.net` + TXT `forward-domain=<目标>` 是一套**整段域名
 * 301 转发**的方案：打过来的任何路径都会被转到目标站。本站已经出现过一次。
 * 风险最高的一类 —— 受害者看到的域名完全是我们的，内容全在别人手里，
 * 而且一个 CNAME 就能把**任意**路径转走（含 `/login`、`/.well-known/...`）。
 */
const DOMAIN_FORWARD_HOSTS = ["forwarddomain.net", "forward-domain.net", "mydnsname.com"]

/**
 * 疑似「平台基础设施」的记录名。
 *
 * ⚠️ 注意：用户拿到的命名空间是 `<用户名>.doulor.cn`，所以这里说的是
 * **相对该命名空间**的名字。目的不是拦截（用户有权用 `api.自己域名`），
 * 而是让站长**看得见** —— 邮件相关名（`_dmarc` / `_domainkey` / `v=spf1`）
 * 一旦被用户挂上，平台域名就可能被用来发伪造邮件。
 */
const EMAIL_AUTH_NAMES = ["_dmarc", "_domainkey", "mail", "smtp", "imap", "pop", "mx", "autodiscover", "autoconfig", "dkim"]

/** 钓鱼常用名（只作 medium 提示，不拦截） */
const PHISHING_NAMES = ["login", "signin", "sign-in", "account", "secure", "verify", "verification", "wallet", "pay", "payment", "bank", "sso", "oauth", "auth", "support", "help", "official", "service", "update", "portal", "admin", "manage", "my", "id"]

/** 公共递归解析器的 IP：DNS 记录指向它们没有实际意义，多半是随手填的 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220", "223.5.5.5", "223.6.6.6", "119.29.29.29", "114.114.114.114", "114.114.115.115", "180.76.76.76", "101.226.4.6"]

/** Cloudflare 自己的边缘 IP 段（指向它们会造成解析自环） */
const CF_NET_PREFIXES = ["103.21.244.", "103.22.200.", "103.31.4.", "104.16.", "104.17.", "104.18.", "104.19.", "104.20.", "104.21.", "104.22.", "104.23.", "104.24.", "104.25.", "104.26.", "104.27.", "104.28.", "104.29.", "104.30.", "104.31.", "108.162.19", "108.162.2", "131.0.72.", "141.101.", "162.158.", "162.159.", "172.64.", "172.65.", "172.66.", "172.67.", "172.68.", "172.69.", "172.70.", "172.71.", "173.245.4", "188.114.9", "190.93.24", "197.234.24", "198.41.12"]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 解析 IPv4 成 [a,b,c,d]；不是合法 IPv4 返回 null */
function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim())
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return null
  return parts
}

/**
 * 特殊用途 IPv4 归类。
 *
 * 用分类而不是一个布尔：不同类别给不同话术，站长才知道该不该动手。
 * （`192.168.x` 是配错了，`192.0.2.x` 是随手填的占位，处理方式不一样。）
 */
function classifyIpv4(ip: string): "private" | "loopback" | "linklocal" | "test" | "reserved" | "cf" | "resolver" | "public" | "invalid" {
  const p = parseIpv4(ip)
  if (!p) return "invalid"
  const [a, b] = p
  const raw = ip.trim()
  if (PUBLIC_RESOLVERS.includes(raw)) return "resolver"
  if (CF_NET_PREFIXES.some((pre) => raw.startsWith(pre))) return "cf"
  if (a === 10) return "private"
  if (a === 172 && b >= 16 && b <= 31) return "private"
  if (a === 192 && b === 168) return "private"
  if (a === 100 && b >= 64 && b <= 127) return "private" // CGNAT
  if (a === 127) return "loopback"
  if (a === 169 && b === 254) return "linklocal"
  if (a === 192 && b === 0 && p[2] === 2) return "test"
  if (a === 198 && b === 51 && p[2] === 100) return "test"
  if (a === 203 && b === 0 && p[2] === 113) return "test"
  if (a === 0 || a >= 224 || (a === 198 && (b === 18 || b === 19))) return "reserved"
  if (a === 192 && b === 0 && p[2] === 0) return "reserved"
  return "public"
}

/** 特殊用途 IPv6（够用即可，不做完整 RFC4291 实现） */
function classifyIpv6(ip: string): "private" | "loopback" | "linklocal" | "public" | "invalid" {
  const s = ip.trim().toLowerCase()
  if (!/^[0-9a-f:]+(%[0-9a-z]+)?$/.test(s) || !s.includes(":")) return "invalid"
  const bare = s.split("%")[0]
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return "loopback"
  if (bare === "::" ) return "invalid"
  const first = bare.split(":")[0] || ""
  if (/^f[cd]/.test(first)) return "private" // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(first)) return "linklocal" // fe80::/10
  return "public"
}

/** 主机名合法性（允许结尾点，允许下划线 —— SRV target 常见） */
function isHostname(s: string): boolean {
  const v = s.trim().replace(/\.$/, "")
  if (!v || v.length > 253) return false
  return /^[a-zA-Z0-9_]([a-zA-Z0-9_-]*[a-zA-Z0-9_])?(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]*[a-zA-Z0-9_])?)*$/.test(v)
}

/** 目标主机是否落在给定后缀集合里 */
function matchesHost(host: string, list: string[]): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "")
  for (const suffix of list) {
    if (h === suffix || h.endsWith("." + suffix)) return suffix
  }
  return null
}

/**
 * 名字是否像随机串（`qrxdxfvghbjn`、`wltbas15iu58`）。
 *
 * 判据刻意保守，避免把正常拼音/英文名误判：
 *   · 长度 ≥ 8
 *   · 不含分隔符（`-` `_`）
 *   · 不含元音序列（连续 4 个字符里元音 ≥ 1 是正常可读串的特征）
 *   · 或「数字+字母混排且长度 ≥ 10」这种机器生成的形态
 * 只要命中其一即算可疑 —— 它只作 medium 提示，不单独定案。
 */
function looksRandom(label: string): boolean {
  const s = label.trim().toLowerCase()
  if (s.length < 8 || /[-_.]/.test(s)) return false
  if (/^\d+$/.test(s)) return false
  const window = 4
  let vowelWindows = 0
  for (let i = 0; i + window <= s.length; i++) {
    if (/[aeiou0-9]/.test(s.slice(i, i + window))) vowelWindows++
  }
  const total = Math.max(1, s.length - window + 1)
  // 元音覆盖不足 40% 的窗口 ⇒ 基本不是人能读的词
  if (vowelWindows / total < 0.4) return true
  // 常见机器生成形态：字母数字混排、够长、含 3 个以上数字
  if (s.length >= 10 && /[a-z]/.test(s) && /\d/.test(s) && (s.match(/\d/g) ?? []).length >= 3) return true
  return false
}

/** 短的确定性指纹（FNV-1a 32 位，取 8 位十六进制；两个拼起来降低碰撞） */
function fingerprint(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}

/** 发现项的稳定 id：同一条问题重复扫描不会产生新行 */
function findingId(rule: string, fqdn: string, type: string, content: string): string {
  return fingerprint(`${rule}|${fqdn.toLowerCase()}|${type.toUpperCase()}|${content}`)
}

// ---------------------------------------------------------------------------
// 单条记录评估
// ---------------------------------------------------------------------------

export interface AssessOptions {
  /** 站点根域名（doulor.cn），用于识别「指向平台自身命名空间」的 CNAME */
  /** 本站全部根域（tyu.me / doulor.cn …）：CNAME 指向其中任一都算「平台自身名字空间」 */
  zoneSuffixes: readonly string[]
  /** 同一 fqdn+type+content 在本表里出现的次数（>1 触发查重） */
  duplicateKey?: Map<string, number>
  /** 由深度扫描探测出的解析结果（未探测则 undefined） */
  resolution?: ResolutionProbe
}

/** 深度扫描时的真实解析探测结果 */
export interface ResolutionProbe {
  /** 记录自身的 fqdn 解析出来的地址（去重后） */
  addresses: string[]
  /** CNAME 目标是否解析失败（悬空） */
  targetDangling?: boolean
  /** 探测失败原因（探测本身出错时） */
  error?: string
}

/**
 * 对一条记录跑全部规则。
 *
 * 返回数组（一条记录可能同时违反多条），调用方按 severity 排序展示。
 */
export function assessRecord(rec: DnsRecordLike, opts: AssessOptions): Finding[] {
  const out: Finding[] = []
  const push = (rule: string, severity: Severity, detail: string) => out.push({ rule, severity, detail })

  const type = rec.type.toUpperCase()
  const content = (rec.content ?? "").trim()
  const fqdn = rec.fqdn.toLowerCase()
  const name = (rec.name ?? "").toLowerCase()
  const label = name === "@" ? "" : name.split(".").pop() ?? name
  const proxied = rec.proxied === 1

  // ---- 1. 内容本身的合法性（脏数据） ----
  if (type === "A") {
    const kind = classifyIpv4(content)
    if (kind === "invalid") {
      push("invalid-content", "medium", `A 记录的内容「${content}」不是合法 IPv4 地址，Cloudflare 会拒绝，这条记录实际不生效（属于脏数据，不是滥用）。`)
    } else if (kind === "private") {
      push("private-ip", "high", `指向内网地址 ${content}。公网 DNS 里出现内网地址没有用途，而且这是 DNS rebinding 的原材料：攻击者可以借此让访问者的浏览器去打内网服务。`)
    } else if (kind === "loopback") {
      push("loopback-ip", "medium", `指向回环地址 ${content}，任何人都访问不到，属于填错。`)
    } else if (kind === "linklocal") {
      push("linklocal-ip", "high", `指向链路本地地址 ${content}。公网上不可达，而且 169.254.169.254 是各云厂商的**实例元数据**接口，是 DNS rebinding 最经典的攻击目标。`)
    } else if (kind === "reserved") {
      push("reserved-ip", "medium", `指向保留地址 ${content}，不属于可路由的公网地址。`)
    } else if (kind === "cf") {
      push("cf-ip-selfref", "high", `指向 Cloudflare 自己的边缘 IP（${content}），会造成解析自环或把流量打回 CF。`)
    } else if (kind === "test") {
      push("test-net-ip", "medium", `指向文档示例网段 ${content}（RFC 5737），说明这条记录是占位/测试用途，不是真实服务。`)
    } else if (kind === "resolver") {
      push("resolver-ip", "medium", `指向公共 DNS 解析器地址 ${content}，对「访问一个站点」没有意义，疑似随手填写。`)
    }
  } else if (type === "AAAA") {
    const kind = classifyIpv6(content)
    if (kind === "invalid") {
      push("invalid-content", "medium", `AAAA 记录的内容「${content}」不是合法 IPv6 地址，实际不生效。`)
    } else if (kind === "private") {
      push("private-ip", "high", `指向 IPv6 唯一本地地址 ${content}，公网不可达，且属于 rebinding 素材。`)
    } else if (kind === "loopback") {
      push("loopback-ip", "medium", `指向 IPv6 回环地址 ${content}。`)
    } else if (kind === "linklocal") {
      push("linklocal-ip", "high", `指向 IPv6 链路本地地址 ${content}，公网不可达。`)
    }
  } else if (type === "CNAME" || type === "MX" || type === "SRV") {
    const target = type === "SRV" ? (content.split(/\s+/)[3] ?? "") : content
    if (!isHostname(target)) {
      push("invalid-content", "medium", `${type} 记录的目标「${target || content}」不是合法主机名，实际不生效。`)
    }
  } else if (type === "TXT") {
    if (!content) push("invalid-content", "medium", "TXT 记录内容为空。")
  }

  // ---- 2. 第三方托管 / 域名转发（最典型的两类白嫖与滥用） ----
  if (type === "CNAME") {
    const hosted = matchesHost(content, THIRD_PARTY_HOSTS)
    if (hosted) {
      push("third-party-hosting", "high", `CNAME 指向第三方托管平台 ${hosted}。内容是对方随时可改的，平台域名等于给它做了信誉背书，一旦被挂上钓鱼页只能删记录、删不掉对方站点。`)
    }
    const fwd = matchesHost(content, DOMAIN_FORWARD_HOSTS)
    if (fwd) {
      push("forward-domain", "high", `CNAME 指向域名转发服务 ${fwd}：配合 TXT 里的 forward-domain 声明，可以把本子域名的**任意路径**整体转给外部站点。受害者看到的域名完全是我们家的。`)
    }
    if (content.toLowerCase().replace(/\.$/, "") === fqdn) {
      push("cname-self", "high", "CNAME 指向自己，会形成解析环（无限套娃），必然解析失败。")
    }
    // 指向平台自身命名空间：容易与 Worker 路由打架，且对方注销后变成悬空记录
    const bare = content.toLowerCase().replace(/\.$/, "")
    const inOwnZone = opts.zoneSuffixes.some(
      (s) => bare === s || bare.endsWith("." + s)
    )
    if (inOwnZone) {
      push("platform-namespace-cname", "medium", `CNAME 指向平台自身的命名空间（${bare}）。这与 Worker 的动态路由是同一套名字空间，可能互相打架；万一目标用户注销，这条记录会变成可被接管的悬空记录。`)
    }
  }

  if (type === "TXT") {
    const m = /forward-domain\s*=\s*(\S+)/i.exec(content)
    if (m) {
      push("forward-domain", "high", `TXT 声明了 forward-domain=${m[1]}：这是把整个子域名 301 转发到外部站点的开关，配合转发服务的 CNAME 一起用。`)
    }
    if (/v=spf1/i.test(content)) {
      const hasExternal = /include:|a:|ip4:|ip6:|redirect=/i.test(content)
      push("spf-on-platform", hasExternal ? "high" : "medium", `在本站域名上配置 SPF${hasExternal ? "且包含外部来源" : ""}。这意味着可以用这个域名对外发信，平台域名有被用于伪造邮件的风险。`)
    }
  }

  // ---- 3. 名字层面 ----
  if (name === "*" || name.startsWith("*.")) {
    push("wildcard-record", "high", "泛解析（*）会让任意子域名都解析成功，等于开了无限个可用的钓鱼主机名，事后也无法逐个封禁。")
  }
  const labels = name.split(".")
  const emailHit = labels.find((l) => EMAIL_AUTH_NAMES.includes(l))
  if (emailHit) {
    push("email-auth-name", "medium", `记录名里的「${emailHit}」属于邮件鉴权/收发的命名空间，出现在用户域名下通常意味着在给这个域名配邮件能力。`)
  }
  const phishHit = label && PHISHING_NAMES.includes(label) ? label : labels.find((l) => PHISHING_NAMES.includes(l))
  if (phishHit) {
    push("phishing-name", "medium", `记录名里的「${phishHit}」是钓鱼页最爱用的名字。本身不代表有问题，但一旦来源可疑，这个名字会让链接看起来更可信。`)
  }
  if (looksRandom(label || name)) {
    push("random-name", proxied ? "medium" : "low", `记录名「${label || name}」像机器生成的随机串。随机名 + 开代理是最典型的「临时挂点东西」形态。`)
  }

  // ---- 4. 代理与源站暴露 ----
  if (!proxied && (type === "A" || type === "AAAA" || type === "CNAME")) {
    push("origin-unproxied", "low", `未开启代理，解析结果就是源站真实地址。想隐藏源站就打开小黄云，否则对方 IP 会被直接暴露。`)
  }

  // ---- 5. 状态与一致性 ----
  if (rec.status === "error") {
    push("sync-error", "low", "本地记录状态为 error：这条记录在 Cloudflare 侧没有建成（内容非法或被拒），本地却仍然留着，属于脏数据。")
  } else if (rec.status === "pending") {
    const ageMs = Date.now() - new Date(rec.created_at).getTime()
    if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
      push("stale-pending", "low", "记录创建超过 24 小时仍是 pending，多半是当时的同步没走完。")
    }
  }
  if (rec.status === "active" && !rec.cf_id) {
    push("missing-cf-id", "low", "本地标记 active 但没有 Cloudflare 记录 id，说明数据库与 Cloudflare 已经不一致。")
  }

  // ---- 6. 查重 ----
  const key = `${fqdn}|${type}|${content}`
  const dupCount = opts.duplicateKey?.get(key) ?? 0
  if (dupCount > 1) {
    push("duplicate-record", "low", `同一个名字、类型、内容重复了 ${dupCount} 条。DNS 里重复记录会随机命中，排查问题时极容易被误导。`)
  }

  // ---- 7. 深度探测结果（仅手动扫描时存在） ----
  if (opts.resolution) {
    const r = opts.resolution
    if (r.error) {
      push("resolve-failed", "low", `解析探测没有完成：${r.error}（这不代表记录有问题，只是这次没探到）。`)
    } else {
      if (r.targetDangling) {
        push("dangling-cname", "high", "CNAME 的目标现在解析不出来（NXDOMAIN/无记录）。悬空 CNAME 可以被别人抢注后接管这个域名。")
      }
      if (type !== "CNAME" && r.addresses.length === 0 && !r.targetDangling) {
        push("no-address", "medium", "这条记录当前解析不出任何地址，说明它在 DNS 上还没生效或已被删除。")
      }
    }
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

export interface DnsAuditSummary {
  ranAt: string
  mode: "hourly" | "manual"
  scanned: number
  found: number
  high: number
  medium: number
  low: number
  /** 本次新出现的问题数（用于「又冒出来几条」的提示） */
  fresh: number
  note?: string
}

interface FindingRow {
  id: string
  record_id: string | null
  status: string
  first_seen_at: string
  severity: string
  detail: string
  username: string | null
}

/**
 * 扫描全站 DNS 记录并落库。
 *
 * 幂等：发现项 id 由 (规则, fqdn, 类型, 内容) 决定，重复跑只会刷新 `last_seen_at`。
 * 消失的问题自动转 `resolved`（记录被删了、或被改好了都会走到这里）。
 * 被标记 `ignored` 的问题**不会**因为再次扫到就被改回 open —— 除非它真的消失过又回来。
 *
 * ⚠️ 表可能还不存在（线上迁移是手工执行的）。所有读写都包了 try/catch：
 * 表没建好时扫描依然返回结果，只是不落库，**绝不因此让管理面板或 cron 挂掉**。
 */
export async function scanDns(
  env: Env,
  opts: { mode: "hourly" | "manual"; resolve?: boolean } = { mode: "hourly" }
): Promise<DnsAuditSummary> {
  const now = new Date().toISOString()
  const rows = await env.DB.prepare(
    `SELECT r.*, u.username AS username
       FROM dns_records r
       LEFT JOIN domains d ON d.id = r.domain_id
       LEFT JOIN users u ON u.id = d.user_id
      ORDER BY r.fqdn ASC`
  ).all<DnsRecordLike>()

  const records = rows.results ?? []

  // 查重表：fqdn|type|content → 出现次数
  const dupKey = new Map<string, number>()
  for (const r of records) {
    const k = `${r.fqdn.toLowerCase()}|${r.type.toUpperCase()}|${r.content.trim()}`
    dupKey.set(k, (dupKey.get(k) ?? 0) + 1)
  }

  // 深度扫描：对每条记录做一次真实解析探测。
  // ⚠️ 必须有上限与并发限制：每条记录要打 1–3 次 DoH，逐条串行会在记录多时
  // 把面板请求拖到超时。这里限定并发 8、总量 400 条，剩下的留到下次扫描。
  const probes = new Map<string, ResolutionProbe>()
  if (opts.resolve) {
    const targets = records.slice(0, 400)
    const results = await mapLimit(targets, 8, (r) => probeResolution(r))
    targets.forEach((r, i) => probes.set(r.id, results[i]))
  }

  const zoneSuffixes = await allRootDomainNames(env)

  interface PendingFinding extends Finding {
    recordId: string
    fqdn: string
    type: string
    content: string
    username: string | null
  }
  const pending: PendingFinding[] = []
  for (const r of records) {
    const findings = assessRecord(r, {
      zoneSuffixes,
      duplicateKey: dupKey,
      resolution: probes.get(r.id),
    })
    for (const f of findings) {
      pending.push({
        ...f,
        recordId: r.id,
        fqdn: r.fqdn,
        type: r.type,
        content: r.content,
        username: r.username ?? null,
      })
    }
  }

  const counts = {
    high: pending.filter((f) => f.severity === "high").length,
    medium: pending.filter((f) => f.severity === "medium").length,
    low: pending.filter((f) => f.severity === "low").length,
  }

  const summary: DnsAuditSummary = {
    ranAt: now,
    mode: opts.mode,
    scanned: records.length,
    found: pending.length,
    ...counts,
    fresh: 0,
    note: opts.resolve
      ? records.length > 400
        ? `解析探测只覆盖了前 400 条（共 ${records.length} 条），其余记录仍做了静态规则检查。`
        : undefined
      : "定时扫描只做静态规则；「真实解析探测」需在面板上手动点扫描。",
  }

  try {
    const existing = await env.DB.prepare(
      "SELECT id, record_id, status, first_seen_at, severity, detail, username FROM dns_audit_findings"
    ).all<FindingRow>()
    const prev = new Map<string, FindingRow>()
    for (const row of existing.results ?? []) prev.set(row.id, row)

    const seenIds = new Set<string>()
    const stmts: D1PreparedStatement[] = []
    let fresh = 0

    for (const f of pending) {
      const id = findingId(f.rule, f.fqdn, f.type, f.content)
      seenIds.add(id)
      const old = prev.get(id)
      if (!old) {
        fresh++
        stmts.push(
          env.DB.prepare(
            `INSERT INTO dns_audit_findings
               (id, record_id, fqdn, type, content, username, rule, severity, detail,
                status, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
          ).bind(id, f.recordId, f.fqdn, f.type, f.content, f.username, f.rule, f.severity, f.detail, now, now)
        )
      } else {
        // 已存在的：只有在**内容真的变了**时才写回。
        //
        // ⚠️ 这里刻意不刷 `last_seen_at`：每小时跑一次扫描，无条件 UPDATE 会让
        // 几十条发现项每小时产生几十次 D1 写，而信息量是零。`last_seen_at`
        // 表示「最后一次发生变化的时刻」，比「最后一次被看到」更有用。
        const unchanged =
          old.severity === f.severity &&
          old.detail === f.detail &&
          old.record_id === f.recordId &&
          (old.username ?? null) === f.username &&
          old.status !== "resolved"
        if (!unchanged) {
          stmts.push(
            env.DB.prepare(
              `UPDATE dns_audit_findings
                  SET last_seen_at = ?, record_id = ?, username = ?, detail = ?, severity = ?,
                      status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END
                WHERE id = ?`
            ).bind(now, f.recordId, f.username, f.detail, f.severity, id)
          )
        }
      }
    }

    // 已经不在本次结果里的（记录被删或改好了）→ resolved
    for (const [id, row] of prev) {
      if (seenIds.has(id) || row.status === "resolved") continue
      stmts.push(
        env.DB.prepare(
          "UPDATE dns_audit_findings SET status = 'resolved', last_seen_at = ? WHERE id = ?"
        ).bind(now, id)
      )
    }

    // D1 单次 batch 上限保守取 50 条，分批提交
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50))
    }

    summary.fresh = fresh

    await env.DB.prepare(
      `INSERT INTO dns_audit_runs (id, ran_at, mode, scanned, found, high, medium, low, note)
       VALUES ('last', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ran_at = excluded.ran_at, mode = excluded.mode, scanned = excluded.scanned,
         found = excluded.found, high = excluded.high, medium = excluded.medium,
         low = excluded.low, note = excluded.note`
    )
      .bind(now, opts.mode, summary.scanned, summary.found, counts.high, counts.medium, counts.low, summary.note ?? null)
      .run()
  } catch (err) {
    // 表未建 / 写入失败：扫描结果照样返回，只是没落库
    console.error("DNS 审计落库失败（迁移 0093 是否已执行？）:", err)
    summary.note = `${summary.note ? summary.note + " " : ""}扫描结果未能写入数据库（dns_audit_findings 是否已创建？）。`
  }

  return summary
}

/**
 * 真实解析探测（DNS-over-HTTPS）。
 *
 * 为什么用 DoH 而不是 `dns.resolve`：Worker 运行时没有 Node 的 dns 模块，
 * 而 DoH 是普通 HTTPS 请求，走现有的 fetchWithTimeout 即可，还能统一超时。
 *
 * 用途只有一个：找出**悬空 CNAME**（目标已失效，可被抢注接管）和
 * **DB 里活着但 DNS 上不存在**的记录。探测失败不当作问题，只作 low 提示。
 */
async function probeResolution(rec: DnsRecordLike): Promise<ResolutionProbe> {
  try {
    const addresses = await dohQuery(rec.fqdn, rec.type === "SRV" ? "SRV" : rec.type)
    const probe: ResolutionProbe = { addresses }
    if (rec.type === "CNAME") {
      // 对 CNAME 再探目标主机，判断是否悬空
      const target = rec.content.trim().replace(/\.$/, "")
      if (target) {
        const t = await dohQuery(target, "A")
        const t6 = t.length ? t : await dohQuery(target, "AAAA")
        const cnameOfTarget = await dohQuery(target, "CNAME")
        if (t6.length === 0 && cnameOfTarget.length === 0) probe.targetDangling = true
      }
    }
    return probe
  } catch (err) {
    return { addresses: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 一次 DoH 查询，返回 Answer 里的 data 字段数组 */
async function dohQuery(name: string, type: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: "application/dns-json" } },
    8000
  )
  if (!res.ok) throw new Error(`DoH ${res.status}`)
  const data = (await res.json()) as {
    Status?: number
    Answer?: { type: number; data: string }[]
  }
  const answers = data.Answer ?? []
  if (type === "CNAME") {
    return answers.filter((a) => a.type === 5).map((a) => a.data.replace(/\.$/, ""))
  }
  if (type === "A" || type === "AAAA") {
    const want = type === "A" ? 1 : 28
    // 目标有 CNAME 时 Answer 里会先给 CNAME 再给地址，这里只要地址
    return answers.filter((a) => a.type === want).map((a) => a.data)
  }
  return answers.map((a) => a.data)
}

/**
 * 读「上次扫描」的快照。表不存在时返回 null（不抛错）。
 */
export async function getLastDnsAuditRun(env: Env): Promise<{
  ranAt: string
  mode: string
  scanned: number
  found: number
  high: number
  medium: number
  low: number
  note: string | null
} | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT ran_at, mode, scanned, found, high, medium, low, note FROM dns_audit_runs WHERE id = 'last'"
    ).first<{
      ran_at: string
      mode: string
      scanned: number
      found: number
      high: number
      medium: number
      low: number
      note: string | null
    }>()
    if (!row) return null
    return {
      ranAt: row.ran_at,
      mode: row.mode,
      scanned: row.scanned,
      found: row.found,
      high: row.high,
      medium: row.medium,
      low: row.low,
      note: row.note,
    }
  } catch {
    return null
  }
}

/**
 * 待处理（未忽略、未解决）的问题条数 —— 给角标用。
 * 表不存在时返回 0，绝不因此让 `/api/attention` 500。
 */
export async function countOpenDnsFindings(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM dns_audit_findings WHERE status = 'open'"
    ).first<{ c: number }>()
    return Number(row?.c ?? 0)
  } catch {
    return 0
  }
}
