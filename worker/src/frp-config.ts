/**
 * frp 服务端配置：把捐献者给的 frpc.toml 样例**参数化**成模板，再为每个用户渲染配置。
 *
 * ## 为什么要这么绕
 *
 * 不同的 frps 部署，客户端配置差别很大：
 *   · 裸 frps            —— 只要 serverAddr / serverPort
 *   · 全局 token         —— 再加 auth.token
 *   · 用户级鉴权         —— 再加 user + metadatas.token（本站现有两台节点就是这个形态）
 *   · 第三方鉴权插件     —— 还有只有服务器主人才知道的字段（OIDC / HTTP 插件 / 自定义）
 *
 * 把生成逻辑写死，就只能支持我们自己那一种部署；别人捐一台带插件的服务器，
 * 我们生不出能用的配置，那份捐献就是废的。
 *
 * 所以改成：捐献者粘贴一份「**能连上他这台服务器**的 frpc.toml」，我们把它参数化成
 * 模板（把他自己的个人凭据换成占位符），再按每个用户实际的端口/隧道渲染。
 * 插件的额外字段会**原样保留**，我们不需要理解它是什么插件。
 *
 * ## 安全边界（重要）
 *
 * 样例里有捐献者自己的 `user` / `metadatas.token` —— 那是他在那台服务器上的账号口令。
 * 因此：
 *   · 参数化必须发生在**服务端**（批准建节点时），入库的是剥掉个人凭据的模板；
 *   · 原样样例只留在 `donations.payload`（管理员可见，对外一律打码）；
 *   · **配置由服务端渲染后下发**，模板本身不出库、不下发（少一个泄漏面）。
 *
 * ## 解析策略
 *
 * 行式扫描，不引 TOML 库（workerd 里没有 Node 的生态，也没必要）：
 * 只认「`[段]` / `[[数组段]]` / `键 = 值` / 注释 / 空行」五种行，
 * 认不出的行**原样保留**（宁可多留一行也不猜着删）。
 */

// ---------------------------------------------------------------- 鉴权方式

export const FRP_AUTH_MODES = ["none", "token", "token_user", "custom"] as const
export type FrpAuthMode = (typeof FRP_AUTH_MODES)[number]

export const FRP_AUTH_MODE_LABELS: Record<FrpAuthMode, string> = {
  none: "无鉴权（最基础的 frps）",
  token: "全局 auth.token",
  token_user: "全局 token + 每用户账号（带鉴权插件）",
  custom: "其它 / 自定义插件",
}

export function isFrpAuthMode(v: unknown): v is FrpAuthMode {
  return typeof v === "string" && (FRP_AUTH_MODES as readonly string[]).includes(v)
}

// ---------------------------------------------------------------- 占位符

/** 键路径 → 占位符。键路径按 `段.键` 拼，顶层键就是键名本身。 */
const PLACEHOLDER_BY_KEY: Record<string, string> = {
  serverAddr: "{serverAddr}",
  serverPort: "{serverPort}",
  user: "{user}",
  "auth.token": "{authToken}",
  "metadatas.token": "{password}",
}

const PLACEHOLDER_KEYS = ["{serverAddr}", "{serverPort}", "{authToken}", "{user}", "{password}"] as const

/**
 * 没有模板时的兜底（等价于改版前前端写死的那份生成器）。
 * 老节点（config_template 为空）走这条，行为与改版前完全一致。
 */
export const DEFAULT_FRP_TEMPLATE = [
  'serverAddr = "{serverAddr}"',
  "serverPort = {serverPort}",
  "",
  'auth.token = "{authToken}"',
  "",
  'user = "{user}"',
  'metadatas.token = "{password}"',
].join("\n")

// ---------------------------------------------------------------- 扫描

interface ScannedLine {
  kind: "section" | "array" | "kv" | "other"
  /** 段路径，如 ["auth"] / ["proxies","transport"] */
  section: string[]
  key: string | null
  value: string | null
}

const SECTION_RE = /^\[\[?([^\]]*)\]\]?$/
// 键允许点号（TOML dotted key：`auth.token = "..."` 等价于 `[auth] token = "..."`）
const KV_RE = /^([A-Za-z_][\w.-]*)\s*=\s*(.+)$/

function scan(sample: string): ScannedLine[] {
  const out: ScannedLine[] = []
  let section: string[] = []
  for (const raw of sample.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim()
    const sec = SECTION_RE.exec(line)
    if (sec) {
      section = sec[1]
        .split(".")
        .map((s) => s.trim())
        .filter(Boolean)
      out.push({ kind: line.startsWith("[[") ? "array" : "section", section, key: null, value: null })
      continue
    }
    if (!line || line.startsWith("#")) {
      out.push({ kind: "other", section, key: null, value: raw })
      continue
    }
    const kv = KV_RE.exec(line)
    if (!kv) {
      out.push({ kind: "other", section, key: null, value: raw })
      continue
    }
    // key 存**完整路径**（段 + 点号键），例如 "auth.token" / "metadatas.token" / "serverAddr"
    out.push({ kind: "kv", section, key: kv[1], value: kv[2].trim() })
  }
  return out
}

/** 去掉值两边的引号 */
function unquote(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** 该行是不是在 proxies 段里（`[[proxies]]` 或 `[proxies.transport]` 都算） */
function inProxies(section: string[]): boolean {
  return section[0] === "proxies"
}

// ---------------------------------------------------------------- 解析样例

export interface FrpcSampleInfo {
  /** 样例里出现过的键路径集合，如 "auth.token" / "user" */
  keys: Set<string>
  serverAddr: string | null
  serverPort: number | null
  /** 样例里的个人凭据 —— **仅供比对/展示，绝不入库到节点模板** */
  authToken: string | null
  user: string | null
  password: string | null
}

/** 从 frpc.toml 样例里提取服务端信息与个人凭据 */
export function parseFrpcSample(sample: string): FrpcSampleInfo {
  const info: FrpcSampleInfo = {
    keys: new Set(),
    serverAddr: null,
    serverPort: null,
    authToken: null,
    user: null,
    password: null,
  }
  for (const l of scan(sample)) {
    if (l.kind !== "kv" || !l.key || l.value === null) continue
    if (inProxies(l.section)) continue
    // 完整路径 = 段 + 键（键本身可能含点号，如顶层的 `auth.token`）
    const path = [...l.section, l.key].join(".")
    info.keys.add(path)
    const val = unquote(l.value)
    if (path === "serverAddr") info.serverAddr = val
    else if (path === "serverPort") {
      const n = Math.trunc(Number(val))
      info.serverPort = Number.isFinite(n) ? n : null
    } else if (path === "auth.token") info.authToken = val
    else if (path === "user") info.user = val
    else if (path === "metadatas.token") info.password = val
  }
  return info
}

/** 从样例反推鉴权方式（供表单自动勾选，用户仍可手动改） */
export function detectAuthMode(sample: string): FrpAuthMode {
  const { keys } = parseFrpcSample(sample)
  if (keys.has("metadatas.token") || keys.has("user")) return "token_user"
  if (keys.has("auth.token")) return "token"
  return "none"
}

// ---------------------------------------------------------------- 参数化

/**
 * 把捐献者的样例参数化成模板。
 *
 * 做的事：
 *   1. 丢掉所有 `[[proxies]]` 及其子段 —— 那是捐献者自己的隧道，与用户无关；
 *   2. 把 serverAddr / serverPort / auth.token / user / metadatas.token 的值换成占位符；
 *   3. 按 authMode 补上样例里缺的必需行。
 * 其余行（含各种插件字段）**原样保留**。
 */
export function buildTemplateFromSample(sample: string, authMode: FrpAuthMode): string {
  const out: string[] = []
  const seen = new Set<string>()

  for (const l of scan(sample)) {
    if (l.kind === "section") {
      out.push(`[${l.section.join(".")}]`)
      continue
    }
    if (l.kind === "array") {
      // `[[proxies]]` 及子段全部丢掉 —— 那是捐献者自己的隧道
      if (inProxies(l.section)) continue
      out.push(`[[${l.section.join(".")}]]`)
      continue
    }
    if (l.kind === "other") {
      out.push(l.value ?? "") // 注释 / 空行
      continue
    }
    // kv：完整路径 = 段 + 键
    const path = [...l.section, (l.key as string)].join(".")
    if (inProxies(l.section)) continue
    const ph = PLACEHOLDER_BY_KEY[path]
    if (ph) {
      seen.add(path)
      out.push(`${l.key} = "${ph}"`)
      continue
    }
    out.push(`${l.key} = ${l.value}`)
  }

  // 按鉴权方式补齐样例里缺的必需行
  const extra: string[] = []
  const needAuthToken = authMode === "token" || authMode === "token_user"
  if (needAuthToken && !seen.has("auth.token")) extra.push('auth.token = "{authToken}"')
  if (authMode === "token_user") {
    if (!seen.has("user")) extra.push('user = "{user}"')
    if (!seen.has("metadatas.token")) extra.push("[metadatas]", 'token = "{password}"')
  }

  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()
  const tail = extra.length > 0 ? `\n\n${extra.join("\n")}` : ""
  return `${body}${tail}`.trim()
}

// ---------------------------------------------------------------- 渲染

export interface FrpRenderContext {
  serverAddr: string
  serverPort: number
  authToken?: string | null
  user?: string | null
  password?: string | null
  /** 已拼好的 `[[proxies]]` 段（每段之间用空行隔开） */
  proxies: string
}

/**
 * 渲染某个用户的 config.toml。
 *
 * 某个占位符没有值时，**整行删掉**（而不是留一个空值）——
 * `auth.token = ""` 会让 frpc 直接连不上，不如不要这一行。
 */
export function renderFrpcConfig(template: string | null | undefined, ctx: FrpRenderContext): string {
  const tpl = (template ?? "").trim() || DEFAULT_FRP_TEMPLATE

  const values: Record<string, string> = {
    "{serverAddr}": ctx.serverAddr,
    "{serverPort}": String(ctx.serverPort),
    "{authToken}": (ctx.authToken ?? "").trim(),
    "{user}": (ctx.user ?? "").trim(),
    "{password}": (ctx.password ?? "").trim(),
  }

  // 值为空的占位符 → 删掉整行
  const empty = PLACEHOLDER_KEYS.filter((k) => !values[k])
  const kept = tpl
    .split("\n")
    .filter((line) => !empty.some((ph) => line.includes(ph)))
    .join("\n")

  let body = kept
  for (const [ph, v] of Object.entries(values)) {
    body = body.split(ph).join(v)
  }

  const proxiesBlock =
    ctx.proxies.trim() ||
    "# 你还没有添加隧道，请在网页上添加后重新生成"

  body = body.includes("{proxies}") ? body.split("{proxies}").join(proxiesBlock) : `${body}\n\n${proxiesBlock}`

  return `${body.replace(/\n{3,}/g, "\n\n").trimEnd()}\n\n# 由 Doulor Cloud 生成 · ${new Date().toLocaleString("zh-CN")}\n`
}

// ---------------------------------------------------------------- 捐献表单校验

export interface FrpDonationValue {
  nodeName: string
  region: string | null
  serverAddr: string
  serverPort: number
  portMin: number
  portMax: number
  maxPorts: number
  authMode: FrpAuthMode
  authToken: string
  configSample: string
  note: string | null
}

const MAX_SAMPLE_BYTES = 16 * 1024
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/

/** 内网 / 保留地址：对外提供服务的 frps 不该是这些 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * 校验并归一化 frp 捐献 payload。
 *
 * 这里的失败**全部属于「我们自己的输入规则」**（字段缺失、地址格式不对、
 * 端口范围不合理），与对端服务器的可用性无关 —— 所以可以在提交时就明确拒绝，
 * 让用户当场改，而不是丢进待审队列。
 * 与可用性有关的判断（能不能连上）本站根本做不了，见 `autoReviewFrpDonation`。
 */
export function normalizeFrpDonationPayload(
  raw: unknown
): { ok: true; value: FrpDonationValue } | { ok: false; error: string } {
  const p = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

  const nodeName = str(p.nodeName)
  if (!nodeName) return { ok: false, error: "请填写节点名称" }
  if (nodeName.length > 40) return { ok: false, error: "节点名称最多 40 个字符" }

  const serverAddr = str(p.serverAddr)
  if (!serverAddr) return { ok: false, error: "请填写服务端地址（serverAddr）" }
  if (serverAddr.length > 255) return { ok: false, error: "服务端地址过长" }
  if (serverAddr.includes("/") || serverAddr.includes(":") || /\s/.test(serverAddr)) {
    return { ok: false, error: "服务端地址只填主机名或 IP，不要带协议、端口或路径" }
  }
  if (!HOST_RE.test(serverAddr)) return { ok: false, error: "服务端地址格式不正确" }
  if (isPrivateHost(serverAddr)) {
    return { ok: false, error: "服务端地址是内网 / 本机地址，别人连不上" }
  }

  const int = (v: unknown, dflt: number) => {
    const n = Math.trunc(Number(v))
    return Number.isFinite(n) ? n : dflt
  }

  const serverPort = int(p.serverPort, 7000)
  if (serverPort < 1 || serverPort > 65535) return { ok: false, error: "服务端端口不在 1–65535 之间" }

  const portMin = int(p.portMin, 0)
  const portMax = int(p.portMax, 0)
  if (!portMin || !portMax) return { ok: false, error: "请填写可用的端口范围" }
  if (portMin < 1 || portMax > 65535) return { ok: false, error: "端口范围必须在 1–65535 之间" }
  if (portMin >= portMax) return { ok: false, error: "端口范围的起始值必须小于结束值" }
  if (portMax - portMin > 50000) {
    return { ok: false, error: "端口范围最多 50000 个，避免一次开放整段端口" }
  }

  const maxPorts = int(p.maxPorts, 5)
  if (maxPorts < 1 || maxPorts > 50) return { ok: false, error: "每用户端口数上限应在 1–50 之间" }

  const authModeRaw = p.authMode
  if (!isFrpAuthMode(authModeRaw)) return { ok: false, error: "请选择服务端的鉴权方式" }
  const authMode = authModeRaw

  const authToken = str(p.authToken)
  if ((authMode === "token" || authMode === "token_user") && !authToken) {
    return { ok: false, error: "该鉴权方式需要填写服务端的全局 token（auth.token）" }
  }
  if (authToken.length > 256) return { ok: false, error: "token 过长" }

  const configSample = str(p.configSample)
  if (!configSample) {
    return { ok: false, error: "请粘贴一份能连上这台服务器的 frpc.toml（我们会用它当模板）" }
  }
  if (configSample.length > MAX_SAMPLE_BYTES) {
    return { ok: false, error: "frpc.toml 示例超过 16 KB，请只保留必要字段" }
  }
  const sample = parseFrpcSample(configSample)
  if (!sample.serverAddr) {
    return { ok: false, error: "示例里没有找到 serverAddr，请确认粘的是 frpc.toml" }
  }
  if (sample.serverAddr !== serverAddr) {
    return {
      ok: false,
      error: `示例里的 serverAddr 是「${sample.serverAddr}」，与上面填的「${serverAddr}」不一致`,
    }
  }
  if (sample.serverPort !== null && sample.serverPort !== serverPort) {
    return {
      ok: false,
      error: `示例里的 serverPort 是 ${sample.serverPort}，与上面填的 ${serverPort} 不一致`,
    }
  }

  const region = str(p.region)
  const note = str(p.note)

  return {
    ok: true,
    value: {
      nodeName,
      region: region || null,
      serverAddr,
      serverPort,
      portMin,
      portMax,
      maxPorts,
      authMode,
      authToken,
      configSample,
      note: note || null,
    },
  }
}
