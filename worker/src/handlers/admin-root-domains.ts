/**
 * 管理端：用户可分配根域（`root_domains`）的配置与 Cloudflare 侧开通。
 *
 * 为什么需要它：把用户邮箱/子域名迁到一个新域名（如 tyu.me）不只是改一行配置 ——
 * 那个域名在 Cloudflare 上必须
 *   1. 能解析出 zone id（DNS 记录 / Worker Route 都按 zone 操作）；
 *   2. 开通 Email Routing 并把 catch-all 指向本 Worker，否则 `用户名@新域` **收不到任何信**。
 *
 * 这两步都要用只有 Worker 持有的 CF Token，所以必须由后端代劳 ——
 * 站长的 CF Token 只存在于 Worker Secret 里（D1 的 `_cf_KV` 读 key 被
 * `SQLITE_AUTH 7500` 禁止），本机拿不到。
 *
 * 边界：全部 `requireAdmin`；写操作一律记审计。禁止删除默认域（否则注册无处可去）。
 *
 * ---------------------------------------------------------------------------
 * 2026-10-15：新增「从 Cloudflare 导入 + 自动初始化」与「删除根域」
 * ---------------------------------------------------------------------------
 * 站长要求「以后直接在管理面板加根域名，自动识别 CF 里的根域名，自动初始化」——
 * 手工加一行 `root_domains` 是不够的：那个域在 CF 上还必须有 `*.{root}` 的
 * 泛解析（AAAA 100:: + 橙云），否则它下面的子域**解析不了**（见 settings.ts 的
 * `dns_wildcard_roots` 注释）；少了这一步，加进去的域看起来正常、用起来是坏的。
 *
 * 因此本模块把「登记」和「开通」合成一条幂等的导入链路（GET cf-zones 找候选、
 * POST import 一次做完），细节与取舍见 importAdminRootDomain 的注释。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireAdminScope } from "./admin"
import { audit as recordAudit, getSetting, updateSettings } from "../settings"
import {
  callCloudflare,
  cfCreateDnsRecord,
  cfDeleteDnsRecord,
  cfListAllDnsRecords,
  cfListDnsRecords,
} from "../cloudflare"
import {
  listRootDomains,
  resetRootDomainCache,
  resolveZoneId,
  getRootDomainByName,
  addWildcardRoot,
  removeWildcardRoot,
} from "../root-domains"
import { FEATURES, FEATURE_LABELS } from "../permissions"
import { CF_ZONE_RECORD_LIMIT } from "./admin-dns"
import type { Env } from "../env"

/** Email Routing 的 catch-all 要指向的 Worker 名（与 wrangler.toml 的 name 一致） */
function emailWorkerName(env: Env): string {
  return env.EMAIL_WORKER_NAME?.trim() || env.WORKER_NAME?.trim() || "doulor-mail-api"
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const buf = await readBodyCapped(request, 16 * 1024, "请求体过大")
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError(400, "请求格式不正确", "INVALID_JSON")
  }
}

/** CF 的 GET，返回 result（失败时抛可读错误） */
async function cfGet<T>(env: Env, path: string): Promise<T | null> {
  try {
    const res = await callCloudflare(env, path)
    const data = (await res.json()) as { result?: T }
    return data.result ?? null
  } catch {
    return null
  }
}

/** Email Routing 与 catch-all 的现状（只读探测，用于列表展示与排障） */
async function emailRoutingStatus(
  env: Env,
  zoneId: string | null
): Promise<{
  enabled: boolean
  catchAllTarget: string | null
  catchAllEnabled: boolean
  workerMatches: boolean
}> {
  const empty = {
    enabled: false,
    catchAllTarget: null as string | null,
    catchAllEnabled: false,
    workerMatches: false,
  }
  if (!zoneId) return empty

  const settings = await cfGet<{ enabled?: boolean }>(
    env,
    `/zones/${zoneId}/email/routing`
  )
  const enabled = Boolean(settings?.enabled)

  const rule = await cfGet<{
    enabled?: boolean
    actions?: { type?: string; value?: string[] }[]
  }>(env, `/zones/${zoneId}/email/routing/rules/catch_all`)

  const action = (rule?.actions ?? []).find((a) => a.type === "worker")
  const targets = action?.value ?? []
  const want = emailWorkerName(env)

  return {
    enabled,
    catchAllTarget: targets[0] ?? null,
    catchAllEnabled: Boolean(rule?.enabled),
    workerMatches: targets.includes(want),
  }
}

// ---------------------------------------------------------------------------
// 「从 Cloudflare 导入」用的只读探测
// ---------------------------------------------------------------------------

/** CF zone 里我们真正用到的字段（`/zones` 的 result 项） */
interface CfZone {
  id?: string
  name?: string
  status?: string
  paused?: boolean
  plan?: { id?: string; name?: string }
}

/**
 * 拉取 Token 能看见的**全部** zone（分页拉全）。
 *
 * `/zones` 返回的是「这个 Token 的可见范围」：账户级 Token 是整个账户，
 * 单 zone Token 只有它自己。所以「导入列表里少了某个域」的两种成因
 * —— 域不在本账户 / Token 没授权这个 zone —— 从结果上无法区分，
 * 界面文案要如实说清楚（见 listImportableCfZones 的 tokenScope 字段）。
 *
 * 翻页上限 10 页（per_page=50 ⇒ 500 个 zone）：正常账户远远够，
 * 兜底是为了不让一个异常响应把请求拖到超时。
 */
async function listAllCfZones(env: Env): Promise<CfZone[]> {
  const all: CfZone[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await callCloudflare(env, `/zones?per_page=50&page=${page}`, {
      method: "GET",
    })
    const data = (await res.json()) as {
      result?: CfZone[]
      result_info?: { total_pages?: number }
      errors?: { message: string }[]
    }
    if (!data.result) {
      throw new ApiError(
        502,
        data.errors?.[0]?.message ?? "读取 Cloudflare zone 列表失败",
        "CF_ERROR"
      )
    }
    all.push(...data.result)
    const totalPages = data.result_info?.total_pages ?? 1
    if (data.result.length === 0 || page >= totalPages) break
  }
  return all
}

/**
 * zone 上已用多少条 DNS 记录。
 *
 * 用 `per_page=1` 只为读 `result_info.total_count` —— 配额是**整个 zone** 的
 * 记录总数（含邮件 MX/TXT、Worker 路由占位），不是本站台账里那几行，
 * 所以必须问 CF 而不是查 D1。
 */
async function cfZoneRecordCount(env: Env, zoneId: string): Promise<number | null> {
  try {
    const res = await callCloudflare(
      env,
      `/zones/${zoneId}/dns_records?per_page=1&page=1`,
      { method: "GET" }
    )
    const data = (await res.json()) as {
      result_info?: { total_count?: number; total?: number }
    }
    const n = data.result_info?.total_count ?? data.result_info?.total
    return typeof n === "number" ? n : null
  } catch {
    // 读不到用量不该让整个候选列表失败：返回 null，界面显示「未知」
    return null
  }
}

/** `*.{root}` 泛解析在 CF 上的现状 */
type WildcardStatus =
  /** AAAA 100:: 且开着代理 —— 正是本站需要的形态，可以复用 */
  | "ok"
  /** 有 AAAA 100:: 但**没开代理**（灰云）：Worker 路由接不住，必须修 */
  | "no-proxy"
  /** 有同名记录，但类型/内容都不是本站的占位 —— 绝不能覆盖站长的自有解析 */
  | "conflict"
  /** 一条都没有 —— 导入时新建 */
  | "missing"
  /** 查询失败（Token 权限不足等），界面标注「未知」 */
  | "unknown"

/**
 * 探测某个 zone 的泛解析现状。
 *
 * 判据刻意按「能不能真的接住用户子域」来定：泛解析必须 **AAAA 100:: + 橙云代理**
 * 才有意义 —— CF 的 Worker Route 只对**代理**流量生效，灰云的 AAAA 100::
 * 在客户端看来是一个黑洞地址。只按 type/content 判断会把这种半坏状态
 * 当成「已配好」放行，用户子域解析不了却查不出原因（这正是 settings.ts 里
 * `dns_wildcard_roots` 那段警告要防的事）。
 */
async function wildcardStatusOf(
  env: Env,
  zoneId: string,
  root: string
): Promise<{ status: WildcardStatus; detail: string | null }> {
  let records: { id: string; type: string; content: string; proxied?: boolean }[]
  try {
    records = await cfListDnsRecords(env, zoneId, `*.${root}`)
  } catch (err) {
    console.error("探测泛解析失败:", root, err)
    return { status: "unknown", detail: null }
  }

  const placeholder = records.find(
    (r) => r.type.toUpperCase() === "AAAA" && r.content.trim().startsWith("100::")
  )
  if (placeholder) {
    return {
      status: placeholder.proxied === false ? "no-proxy" : "ok",
      detail: `AAAA ${placeholder.content}${placeholder.proxied === false ? "（未开代理）" : "（已开代理）"}`,
    }
  }
  if (records.length > 0) {
    return {
      status: "conflict",
      detail: `${records[0].type} ${records[0].content}`,
    }
  }
  return { status: "missing", detail: null }
}

/**
 * GET /api/admin/root-domains/cf-zones —— 「从 Cloudflare 导入」的候选 zone。
 *
 * 已经登记在 `root_domains` 里的域**不返回**（站长要的是「还有哪些能加」，
 * 把已有的混在候选里点一次就报「已存在」，纯属噪音）；但它们的名字会放在
 * `registered` 里回去，界面据此显示「已登记 N 个」这类上下文。
 *
 * 每个候选都带上「已用记录数 / 上限」和泛解析现状：这两个数字决定导入之后
 * 会不会立刻撞上 CF 的 81045 配额，以及导入时会不会需要新建泛解析记录。
 * 单个 zone 的探测失败（权限不足 / 接口抖动）**只降级这一行**：用量显示「?」、
 * 泛解析显示「未知」，不让整张列表失败 —— 一个 zone 出问题不该让站长看不到其它 zone。
 */
export async function listImportableCfZones(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminScope(env, request, "reserved")

  // 直接查表而不是走 listRootDomains()：那个读缓存（10 秒 TTL）在「刚导入完
  // 再点一次导入」时会漏掉新行，候选里会重复出现刚加进去的域。
  const registered = (
    (await env.DB.prepare("SELECT name FROM root_domains").all<{ name: string }>())
      .results ?? []
  ).map((r) => r.name.toLowerCase())
  if (registered.length === 0) {
    // 表空的兜底：此时 listRootDomains() 会把 env.ROOT_DOMAIN 当成「隐式已登记」，
    // 这里跟着一起排除，避免把站点主域当成可导入的候选。
    registered.push(env.ROOT_DOMAIN.trim().toLowerCase())
  }

  const hasCfToken = Boolean(
    env.CLOUDFLARE_API_TOKEN_SECRET || env.CLOUDFLARE_API_TOKEN
  )
  const zones: Record<string, unknown>[] = []
  let tokenScope: "account" | "single-zone" | "unknown" = "unknown"
  let truncated = false

  if (hasCfToken) {
    const all = await listAllCfZones(env)
    truncated = all.length >= 500
    // 只看得到 1 个 zone ⇒ 大概率为单 zone 粒度的 Token，把这一点告诉站长，
    // 否则「导入列表里没有我的新域」会被误认为代码坏了。
    if (all.length === 1) tokenScope = "single-zone"
    else if (all.length > 1) tokenScope = "account"

    for (const z of all) {
      const name = (z.name ?? "").trim().toLowerCase()
      if (!name || !z.id) continue
      if (registered.includes(name)) continue
      const [recordsUsed, wildcard] = await Promise.all([
        cfZoneRecordCount(env, z.id),
        wildcardStatusOf(env, z.id, name),
      ])
      zones.push({
        name,
        zoneId: z.id,
        status: z.status ?? "unknown",
        paused: Boolean(z.paused),
        plan: z.plan?.name ?? null,
        recordsUsed,
        recordsLimit: CF_ZONE_RECORD_LIMIT,
        wildcard: wildcard.status,
        wildcardDetail: wildcard.detail,
      })
    }
  }

  return json({
    zones,
    registered,
    recordsLimit: CF_ZONE_RECORD_LIMIT,
    hasCfToken,
    tokenScope,
    truncated,
    siteDomain: env.ROOT_DOMAIN,
  })
}

/**
 * 按名字在 Cloudflare 上**精确**查 zone id（名字不完全相等就返回 null）。
 *
 * 与 root-domains.ts 的 `resolveZoneId` 的区别（刻意不复用它）：那个函数在「按名查不到」
 * 时会回落到结果里的第一条，服务的是「Token 只能看到一个 zone」的场景；而导入前的
 * 「你传的 zoneId 是不是这个域的」校验里，这种回落会把正常请求误判成串 zone。
 */
async function cfZoneIdByName(env: Env, name: string): Promise<string | null> {
  try {
    const res = await callCloudflare(
      env,
      `/zones?name=${encodeURIComponent(name)}&per_page=5`
    )
    const data = (await res.json()) as {
      result?: { id?: string; name?: string }[]
    }
    const hit = (data.result ?? []).find(
      (z) => (z.name ?? "").trim().toLowerCase() === name
    )
    return hit?.id ?? null
  } catch (err) {
    // 查不到就当作「无法校验」放行（见调用处注释），但要把原因留在日志里
    console.error("导入前按名校验 zone 失败:", name, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// 导入 + 自动初始化
// ---------------------------------------------------------------------------

/**
 * 「追加到 dns_wildcard_roots」这一步。
 *
 * 单独抽出来是为了让 importAdminRootDomain 的步骤列表一眼可读：
 * 读当前值 → 规范化去重 → 有变化才写（**幂等**：重试时第二次是无操作）。
 */
async function addRootToWildcardSetting(env: Env, name: string): Promise<string> {
  const raw = await getSetting(env, "dns_wildcard_roots")
  const next = addWildcardRoot(raw, name)
  if (next !== raw) await updateSettings(env, { dns_wildcard_roots: next })
  return next
}

/** 「从 dns_wildcard_roots 摘掉」—— 删除路径用；同样是幂等的 */
async function removeRootFromWildcardSetting(env: Env, name: string): Promise<string> {
  const raw = await getSetting(env, "dns_wildcard_roots")
  const next = removeWildcardRoot(raw, name)
  if (next !== raw) await updateSettings(env, { dns_wildcard_roots: next })
  return next
}

/**
 * 确保 `*.{root}` 泛解析存在（幂等）。
 *
 * 三种既有记录的处理差异（这是整个导入里最需要「不猜」的地方）：
 *   · AAAA 100:: + 橙云  → 直接复用（`existed`），**不重建**（重建会撞 CF 的
 *     同内容记录冲突，而且没必要）；
 *   · AAAA 100:: + 灰云  → **报错拒绝**。它看着像配好了，实际上 Worker 路由
 *     接不住流量，静默放行等于把「用户子域解析不了」埋进一个查不出的地方；
 *   · 其它类型 / 其它内容 → **报错拒绝**。同名泛解析很可能是站长自己的
 *     通配跳转，覆盖它属于「改别人的生产记录」，必须由人来决定。
 *
 * 只有「一条都没有」时才创建，此时失败会由调用方回滚掉刚插入的表行
 * （见 importAdminRootDomain），所以不会留下半成品。
 */
async function ensureWildcardRecord(
  env: Env,
  zoneId: string,
  root: string
): Promise<{ state: "created" | "existed"; detail: string }> {
  const fqdn = `*.${root}`
  const probe = await wildcardStatusOf(env, zoneId, root)

  if (probe.status === "ok") {
    return { state: "existed", detail: probe.detail ?? "AAAA 100::" }
  }
  if (probe.status === "no-proxy") {
    throw new ApiError(
      409,
      `*.${root} 已存在（${probe.detail}），但没有开 Cloudflare 代理（灰云）。` +
        `泛解析必须走代理才能被 Worker 路由接住，否则用户子域解析不了。` +
        `请先在 Cloudflare 打开它的代理再导入。`,
      "CF_WILDCARD_NO_PROXY"
    )
  }
  if (probe.status === "conflict") {
    throw new ApiError(
      409,
      `*.${root} 上已存在记录（${probe.detail}），不是本站的占位解析（AAAA 100::）。` +
        `为避免覆盖你自己的通配解析，导入已中止：请在 Cloudflare 上先处理它。`,
      "CF_WILDCARD_CONFLICT"
    )
  }
  if (probe.status === "unknown") {
    throw new ApiError(
      502,
      `无法确认 *.${root} 的现状（查询 Cloudflare 失败）。` +
        `可能是 Token 缺少该 zone 的 DNS 读权限 —— 不确认现状就不能建记录，避免与既有解析冲突。`,
      "CF_WILDCARD_UNKNOWN"
    )
  }

  const created = await cfCreateDnsRecord(env, zoneId, {
    type: "AAAA",
    name: fqdn,
    /**
     * 100:: 是 IPv6 的「黑洞」地址段（RFC 6666 的 discard prefix）。
     *
     * 与 handlers/dns.ts、custom-domain.ts 建占位记录时**同一个值**：
     * 记录本身不该把流量导到任何真实主机上，真正接流量的是 CF 里指向本 Worker
     * 的路由；这里只是让 hostname 在 CF 上「存在且被代理」。
     */
    content: "100::",
    // ttl = 1 是 CF 的「自动」；代理开启时 TTL 由 CF 接管，写别的值没有意义
    ttl: 1,
    proxied: true,
  })
  return { state: "created", detail: `AAAA 100::（已开代理，id=${created.id}）` }
}

/**
 * POST /api/admin/root-domains/import —— 选中一个 CF zone，登记并**自动初始化**。
 *
 * body: { name, zoneId?, label?, requiresFeature?, isDefault?, dnsPricePerYear? }
 *
 * ---------------------------------------------------------------------------
 * 初始化顺序与幂等性（为什么这么排）
 * ---------------------------------------------------------------------------
 * 唯一的硬性不变量是：**`dns_wildcard_roots` 里出现的域，其泛解析记录必须真的存在**。
 * 那条设置项的含义就是「这个域下的子域不用逐条建记录也能解析」（见 settings.ts），
 * 一旦它与 CF 事实不符，用户新建的子域会「看着建好了、其实解析不了」，
 * 而且没有任何报错 —— 这是全仓最贵的一类故障。
 *
 * 于是顺序定为：**先插表 → 再建 CF 记录 → 最后才写 dns_wildcard_roots**。
 *   · 表行是「意图」，先落它可在任何一步失败后重试（重试 = 再 POST 一次本接口，
 *     每一步都幂等：INSERT ... ON CONFLICT 只补 zone_id、泛解析存在则跳过、
 *     设置项是集合去重追加）；
 *   · CF 记录建失败（配额满 81045 / 内容冲突 / 权限不足）时**回滚掉刚插的表行**，
 *     得到「什么都没发生」的干净结果 —— 前提是那一行本来就是本次请求新建的；
 *     如果行此前已存在（说明上一次尝试已经走到后面几步），**不删**它：
 *     那是站长已登记的配置，删了才是破坏。此时留下的状态是「已登记、未初始化」，
 *     它不在 dns_wildcard_roots 里，所以既不骗人也不影响任何已有服务；
 *   · 设置项写在最后，因此永远不会出现「设置宣称有泛解析、CF 上其实没有」。
 *     反过来若设置项写失败（D1 抖动），状态是「有泛解析记录但站点仍按逐条建记录
 *     处理」—— 多耗配额，但功能完好、重试可收敛。
 *
 * 不做的两件事（都是有意的）：
 *   1. **不自动开 Email Routing / catch-all**：那属于「收信通道」，会改既有 MX 与
 *      路由规则，站长在同一个面板里有独立按钮（action=enable-email / set-catchall）
 *      可以逐步做、逐步验；导入顺手改，出问题时分不清是哪一步造成的。
 *   2. **不动已有 DNS 记录**（除新建泛解析外一条都不写），避免碰站长的生产解析。
 */
export async function importAdminRootDomain(
  env: Env,
  request: Request
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "reserved")
  const body = await readJson(request)
  const ip = request.headers.get("CF-Connecting-IP")

  const name = String(body.name ?? "").trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)) {
    throw new ApiError(400, "域名格式不正确", "INVALID_INPUT")
  }

  const rawFeature = String(body.requiresFeature ?? "").trim()
  if (rawFeature && !(FEATURES as readonly string[]).includes(rawFeature)) {
    throw new ApiError(400, "未知的权限名", "INVALID_INPUT")
  }

  const label = String(body.label ?? "").trim() || null
  const enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0
  const wantDefault = body.isDefault === true

  const price = Math.trunc(Number(body.dnsPricePerYear ?? 0))
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000) {
    throw new ApiError(
      400,
      "年价必须是 0–1000000 之间的整数（积分/年，0 = 不租用）",
      "INVALID_INPUT"
    )
  }

  // 直查库（不走 10 秒读缓存）：这条路径上「是不是本次新建的」决定失败时要不要回滚
  const existingRow = await env.DB.prepare(
    "SELECT name, zone_id FROM root_domains WHERE name = ? COLLATE NOCASE"
  )
    .bind(name)
    .first<{ name: string; zone_id: string | null }>()

  // zone：优先用前端从候选列表带过来的（省一次查询），否则按名字解析（会回填到表）
  const providedZoneId = String(body.zoneId ?? "").trim()
  let zoneId = providedZoneId || existingRow?.zone_id || ""
  if (!zoneId) {
    zoneId = (await resolveZoneId(env, name)) ?? ""
  }
  if (!zoneId) {
    throw new ApiError(
      502,
      `无法确定 ${name} 的 Cloudflare zone：该域可能不在本账户下，或 Token 未授权这个 zone`,
      "CF_ZONE_UNRESOLVED"
    )
  }

  /**
   * 前端传来的 zoneId 只当「省一次查询」用，**不当事实**：写泛解析时它是 CF 路径的一部分，
   * 传错了就会把 `*.{name}` 建到别人的 zone 里去（CF 大多会以「记录名不在本 zone」拒绝，
   * 但那是一条依赖上游校验的防线，不该拿来当本模块的正确性保证）。
   *
   * 校验方式：只在「表里本来没有这一行」（= 真正的新导入，不是重试）时按名字回查一次 CF，
   * 且**只认名字完全相等的结果**（不用 resolveZoneId：它有个「按名查不到就取第一条」的
   * 兜底，那是给「只看得到单个 zone 的 Token」用的，用在这里会把正常导入误判成串 zone）。
   *   · 查得到且与传入值不一致 ⇒ 明确拒绝，一个字节都不写；
   *   · 查不到（Token 看不到这个域 / 该域不在本账户）⇒ 放行 —— 无法证明传入值是错的，
   *     而把「查不到」当成错会让单 zone 粒度的 Token 永远导入不了。
   */
  if (providedZoneId && !existingRow) {
    const resolved = await cfZoneIdByName(env, name)
    if (resolved && resolved !== providedZoneId) {
      throw new ApiError(
        409,
        `${name} 在 Cloudflare 上对应的 zone 是 ${resolved}，与请求里带的 ${providedZoneId} 不一致。` +
          `已拒绝：把泛解析建到别的 zone 里会同时污染两个域。请刷新候选列表后重试。`,
        "CF_ZONE_MISMATCH"
      )
    }
  }

  const steps: { step: string; state: string }[] = []

  // ---- 步骤 1：登记表行（幂等；已存在只补 zone_id）----
  await env.DB.prepare(
    `INSERT INTO root_domains
       (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(name) DO UPDATE SET zone_id = excluded.zone_id`
  )
    .bind(name, zoneId, label, rawFeature || null, price, enabled, new Date().toISOString())
    .run()
  resetRootDomainCache()
  steps.push({ step: "register", state: existingRow ? "existed" : "created" })

  // ---- 步骤 2：泛解析（失败则回滚步骤 1，见上方注释）----
  let wildcard: { state: string; detail: string }
  try {
    wildcard = await ensureWildcardRecord(env, zoneId, name)
  } catch (err) {
    let rolledBack = false
    if (!existingRow) {
      try {
        await env.DB.prepare("DELETE FROM root_domains WHERE name = ?").bind(name).run()
        resetRootDomainCache()
        rolledBack = true
      } catch (rollbackErr) {
        // 回滚失败要说出来：否则站长会以为表里没这行，而实际上它还在
        console.error("回滚 root_domains 失败:", name, rollbackErr)
      }
    }
    await recordAudit(
      env,
      admin.id,
      "admin.rootdomain.importFailed",
      `导入 ${name} 失败于「建泛解析」：${err instanceof Error ? err.message : String(err)}` +
        `（表行：${rolledBack ? "已回滚" : existingRow ? "既有行保留" : "回滚失败，请手工检查"}）`,
      ip
    )
    const msg = err instanceof ApiError ? err.message : `创建泛解析失败：${String(err)}`
    throw new ApiError(
      err instanceof ApiError ? err.status : 502,
      `${msg}${rolledBack ? "（已回滚，数据库无残留，可修正后重试）" : ""}`,
      err instanceof ApiError && err.code ? err.code : "CF_WILDCARD_FAILED"
    )
  }
  steps.push({ step: "wildcard", state: wildcard.state })

  // ---- 步骤 3：dns_wildcard_roots（放在泛解析确认存在之后）----
  let wildcardRoots = ""
  try {
    wildcardRoots = await addRootToWildcardSetting(env, name)
    steps.push({ step: "wildcardRoots", state: "ok" })
  } catch (err) {
    await recordAudit(
      env,
      admin.id,
      "admin.rootdomain.importFailed",
      `导入 ${name} 失败于「写入 dns_wildcard_roots」：${err instanceof Error ? err.message : String(err)}` +
        `（泛解析已建，重新导入即可跳过）`,
      ip
    )
    throw new ApiError(
      500,
      `泛解析已建好，但写入设置项 dns_wildcard_roots 失败：${
        err instanceof Error ? err.message : String(err)
      }。当前该域仍会逐条建记录（功能正常，只是吃配额），重新导入即可补上这一步。`,
      "SETTING_WRITE_FAILED"
    )
  }

  // ---- 步骤 4：设为默认域（可选；全局唯一所以整批清后再置）----
  if (wantDefault) {
    await env.DB.batch([
      env.DB.prepare("UPDATE root_domains SET is_default = 0"),
      env.DB.prepare("UPDATE root_domains SET is_default = 1 WHERE name = ?").bind(name),
    ])
    steps.push({ step: "setDefault", state: "ok" })
  }

  resetRootDomainCache()

  await recordAudit(
    env,
    admin.id,
    "admin.rootdomain.import",
    `${existingRow ? "重新初始化" : "导入"}根域 ${name}（zone ${zoneId}，年价 ${price}${
      rawFeature ? `，需 ${rawFeature} 权限` : ""
    }${wantDefault ? "，设为默认" : ""}）：泛解析 ${wildcard.state}/${wildcard.detail}`,
    ip
  )

  return json({
    ok: true,
    name,
    zoneId,
    steps,
    wildcard,
    wildcardRoots,
    isDefault: wantDefault,
    wasExisting: Boolean(existingRow),
  })
}

/** GET /api/admin/root-domains —— 列表 + Cloudflare 实时状态 */
export async function listAdminRootDomains(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminScope(env, request, "reserved")
  const rows = await listRootDomains(env)

  const items = []
  for (const r of rows) {
    let zoneId = r.zone_id
    if (!zoneId) {
      try {
        zoneId = await resolveZoneId(env, r.name)
      } catch {
        /* 解析失败保持 null，前端会显示「未解析」 */
      }
    }
    const mail = await emailRoutingStatus(env, zoneId)
    items.push({
      name: r.name,
      label: r.label,
      zoneId,
      requiresFeature: r.requires_feature,
      /**
       * DNS 解析租用的年价（积分/年，迁移 0160）。0 = 不参与租用售卖。
       * 放在这里一并下发，是因为「根域」这一张表既管分配也管定价 ——
       * 管理端两个入口（这里与「DNS → 根域与租用」）读的是同一行数据，
       * 不该各写一份价格查询。
       */
      dnsPricePerYear: Number(r.dns_price_per_year ?? 0),
      isDefault: r.is_default === 1,
      enabled: r.enabled === 1,
      emailRouting: mail,
    })
  }

  return json({
    rootDomains: items,
    emailWorker: emailWorkerName(env),
    // 前端权限勾选用；与 permissions.ts 的 FEATURES 同源，避免两边漂移
    features: FEATURES.map((f) => ({ key: f, label: FEATURE_LABELS[f] })),
    siteDomain: env.ROOT_DOMAIN,
    hasCfToken: Boolean(env.CLOUDFLARE_API_TOKEN_SECRET || env.CLOUDFLARE_API_TOKEN),
  })
}

/**
 * POST /api/admin/root-domains —— 新增 / 更新一个根域。
 *
 * body: { name, label?, requiresFeature?, isDefault?, enabled? }
 * 新增时会自动解析 zone id（失败也不阻断，只是标成未解析，可在后端补）。
 */
export async function upsertAdminRootDomain(
  env: Env,
  request: Request
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "reserved")
  const body = await readJson(request)

  const name = String(body.name ?? "").trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)) {
    throw new ApiError(400, "域名格式不正确", "INVALID_INPUT")
  }

  const rawFeature = String(body.requiresFeature ?? "").trim()
  if (rawFeature && !(FEATURES as readonly string[]).includes(rawFeature)) {
    throw new ApiError(400, "未知的权限名", "INVALID_INPUT")
  }

  const enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0
  const wantDefault = body.isDefault === true
  const label = String(body.label ?? "").trim() || null
  const now = new Date().toISOString()

  /**
   * DNS 解析租用的年价（积分/年）。
   *
   * ⚠️ **只有显式传了这个字段才改**（`undefined` = 不动）：
   * 这个接口也用在「只改启用状态 / 只换 label」的场景上，顺手把价格写成 0
   * 会让站长在不知情的情况下把某个根域下架（0 = 不参与租用售卖）。
   * 与 `enabled` 的默认值处理刻意不同 —— 那个是「不传 = 默认启用」的历史行为，
   * 已经写进了调用方的预期里，不能动。
   */
  let dnsPricePerYear: number | null = null
  if (body.dnsPricePerYear !== undefined && body.dnsPricePerYear !== null) {
    const n = Math.trunc(Number(body.dnsPricePerYear))
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      throw new ApiError(400, "年价必须是 0–1000000 之间的整数（积分/年，0 = 不租用）", "INVALID_INPUT")
    }
    dnsPricePerYear = n
  }

  const existing = await getRootDomainByName(env, name)
  await env.DB.prepare(
    `INSERT INTO root_domains (name, zone_id, label, requires_feature, is_default, enabled, created_at)
     VALUES (?, NULL, ?, ?, 0, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       label = excluded.label,
       requires_feature = excluded.requires_feature,
       enabled = excluded.enabled`
  )
    .bind(name, label, rawFeature || null, enabled, now)
    .run()

  // 默认域全局唯一：设新的之前先把别的清掉（同一批里先清后置）
  if (wantDefault) {
    await env.DB.batch([
      env.DB.prepare("UPDATE root_domains SET is_default = 0"),
      env.DB.prepare("UPDATE root_domains SET is_default = 1 WHERE name = ?").bind(name),
    ])
  }

  // 年价单独一条 UPDATE：见上方 dnsPricePerYear 的注释（不传就不动）。
  if (dnsPricePerYear !== null) {
    await env.DB.prepare(
      "UPDATE root_domains SET dns_price_per_year = ? WHERE name = ?"
    )
      .bind(dnsPricePerYear, name)
      .run()
  }

  resetRootDomainCache()

  // 新增时顺手解析 zone id（拿不到也不报错，管理端会显示「未解析」）
  let zoneId: string | null = existing?.zone_id ?? null
  try {
    zoneId = await resolveZoneId(env, name)
  } catch (err) {
    console.error("新增根域时解析 zone 失败:", name, err)
  }

  await recordAudit(
    env,
    admin.id,
    "admin.rootdomain.upsert",
    `${existing ? "更新" : "新增"}根域 ${name}${wantDefault ? "（设为默认）" : ""}` +
      `${dnsPricePerYear !== null ? `（DNS 年价 ${dnsPricePerYear}）` : ""}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, name, zoneId, isDefault: wantDefault })
}

/**
 * 删根域前要摊在桌面上的事实：多少条解析、多少个子域名、多少份租约。
 *
 * 全部**服务端现算**：前端那份数字是给站长看的提示，写进审计日志的必须是这里的值
 * （否则「前端显示 3 条、实际删掉 300 条」这种事故在日志里查不出来）。
 *
 * `domains` 的计数同时匹配「根域本身」与「挂在它下面的子域」——`domains.name`
 * 存的是完整 fqdn，所以两个条件都要。
 */
async function rootDomainUsage(
  env: Env,
  name: string
): Promise<{
  records: number
  domains: number
  rentalsTotal: number
  rentalsActive: number
}> {
  const records = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM dns_records
      WHERE fqdn = ? COLLATE NOCASE OR fqdn LIKE ? COLLATE NOCASE`
  )
    .bind(name, `%.${name}`)
    .first<{ c: number }>()

  const domains = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM domains
      WHERE name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE`
  )
    .bind(name, `%.${name}`)
    .first<{ c: number }>()

  // 租约表可能没建（迁移 0161 未跑）：那种情况下「数不出来」不该拦住删除，
  // 但也**不能**当成 0 —— 返回 -1 让界面显示「未知」而不是一个可能骗人的 0。
  let rentalsTotal = -1
  let rentalsActive = -1
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' AND expires_at > ? THEN 1 ELSE 0 END) AS active
         FROM dns_rentals WHERE root_domain = ? COLLATE NOCASE`
    )
      .bind(new Date().toISOString(), name)
      .first<{ total: number; active: number | null }>()
    rentalsTotal = Number(r?.total ?? 0)
    rentalsActive = Number(r?.active ?? 0)
  } catch (err) {
    console.error("读取 dns_rentals 失败（当作未知）:", err)
  }

  return {
    records: Number(records?.c ?? 0),
    domains: Number(domains?.c ?? 0),
    rentalsTotal,
    rentalsActive,
  }
}

/**
 * 删掉某根域下**平台自己建的** Cloudflare 解析记录。
 *
 * 为什么是「平台自己的」而不是「这个域下的全部」——这条线是本功能最容易做错的地方：
 *   · `*.{root}` 泛解析：不管内容，它是根域导入时建立的，删根域就该走；
 *   · 其余按 **AAAA 100::** 判定：那是本站给子域建的占位记录（与 handlers/dns.ts、
 *     custom-domain.ts、storage.ts 建的同一种，见 audit 里的 classifyPlatformRecord）。
 * 而 MX / TXT（SPF/DKIM/DMARC）/ 指向真实源站的 A、CNAME **一律不碰**：
 * 它们可能是邮件通道，也可能根本不属于本站（同一个 zone 里站长还挂着自己的东西）。
 * 删错一条 MX，全站收信就断了，而界面上的「连带删除」按钮不应该有这种杀伤半径。
 * 跳过的记录会连同名字一起回报，站长想彻底清场可以自己去 CF 删。
 *
 * 返回删除成败明细：**只要有一条失败，调用方就会中止整个删除**（见 delete 分支），
 * 这样「数据库里还有这个根域、CF 上少了几条记录」是一个可见且可重试的中间态，
 * 而不是「根域没了、CF 上还残留一堆解析」。
 */
async function deletePlatformRecordsUnderRoot(
  env: Env,
  zoneId: string,
  root: string
): Promise<{ deleted: string[]; failed: string[]; kept: string[]; keptTotal: number }> {
  const all = await cfListAllDnsRecords(env, zoneId)
  const wildcard = `*.${root}`
  const norm = (n: string) => (n ?? "").toLowerCase().replace(/\.$/, "")
  const under = (n: string) => n === root || n.endsWith(`.${root}`)

  const targets = all.filter((r) => {
    const n = norm(r.name)
    if (n === wildcard) return true
    if (!under(n)) return false
    return (
      (r.type ?? "").toUpperCase() === "AAAA" &&
      (r.content ?? "").trim().startsWith("100::")
    )
  })
  const targetIds = new Set(targets.map((r) => r.id))

  const deleted: string[] = []
  const failed: string[] = []
  for (const r of targets) {
    try {
      await cfDeleteDnsRecord(env, zoneId, r.id)
      deleted.push(`${r.type} ${norm(r.name)}`)
    } catch (err) {
      failed.push(
        `${r.type} ${norm(r.name)}：${
          err instanceof Error ? err.message.slice(0, 160) : String(err)
        }`
      )
    }
  }

  const kept = all
    .filter((r) => under(norm(r.name)) && !targetIds.has(r.id))
    .map((r) => `${r.type} ${norm(r.name)}`)

  return { deleted, failed, kept: kept.slice(0, 50), keptTotal: kept.length }
}

/**
 * POST /api/admin/root-domains/action —— 一次性动作。
 *
 * body: { name, action }
 *   resolve-zone  解析并回填 zone id
 *   enable-email  开通 Email Routing（建 MX/TXT）
 *   set-catchall  把 catch-all 指向本 Worker（建了才算「能收信」）
 *   set-default   设为默认域
 *   delete        删除（默认域 / 站点主域不可删；必须带 confirm；默认**不**动 CF 记录）
 *
 * 刻意做成一个动作一个请求：每一步都可能因为 CF 侧的前置条件失败，
 * 分开才能一眼看出卡在哪一步。
 *
 * ---------------------------------------------------------------------------
 * 2026-10-15 起 delete 的契约变了（原来是「有域名挂在下面就直接拒绝」）
 * ---------------------------------------------------------------------------
 * 站长要的是「能在面板里删根域」，而一个域只要还有用户就用不了，等于没有这个功能；
 * 但「静默删掉 N 个人的解析」同样不可接受。折中办法不是放宽成一句「确定吗」，
 * 而是把三层闸门叠起来：
 *   1. 前端对话框列出**服务端算出来的**影响面（解析条数、子域个数、租约数），
 *      并要求站长**手输完整域名**；
 *   2. 后端独立校验 `confirm === name`（不信任前端做过校验），
 *      再拒绝 is_default 与站点主域（env.ROOT_DOMAIN）——这两个删了是**站点自身**坏掉，
 *      不属于「站长有权决定的业务取舍」；
 *   3. CF 记录默认保留，只有显式 `deleteCfRecords: true` 才删，
 *      且只删平台占位记录（见 deletePlatformRecordsUnderRoot）。
 * 影响面（含遗留在库里的 domains / dns_rentals 行数）会写进审计日志。
 * 注意**不**清 `dns_rentals`：那是用户付过积分的凭据，删根域不等于抹掉历史。
 */
export async function rootDomainAction(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "reserved")
  const body = await readJson(request)
  const name = String(body.name ?? "").trim().toLowerCase()
  const action = String(body.action ?? "").trim()

  const row = await getRootDomainByName(env, name)
  if (!row) throw new ApiError(404, "根域不存在", "NOT_FOUND")

  const zoneId = await resolveZoneId(env, name)
  // probe-zone 就是来查「为什么解析不到」的，delete 不需要 zone；
  // 其它动作都必须先有 zone 才能往下走。
  if (!zoneId && action !== "delete" && action !== "probe-zone") {
    throw new ApiError(
      502,
      `无法解析 ${name} 的 Cloudflare zone（Token 可能缺 Zone:Read，或该域不在本账户下）`,
      "CF_ZONE_UNRESOLVED"
    )
  }

  switch (action) {
    case "probe-zone": {
      // 排障用：把 CF 的原始回答带出来。
      // 分两步问 —— 「按名字查」失败往往是 Token 作用域太窄（只授权了单个 zone），
      // 那就列一下这个 Token 到底能看见哪些 zone，一眼就能区分
      // 「权限不够」与「域名不在本账户」。
      const out: Record<string, unknown> = {}
      try {
        const res = await callCloudflare(
          env,
          `/zones?name=${encodeURIComponent(name)}&per_page=5`
        )
        out.byName = (await res.json()) as unknown
      } catch (err) {
        out.byNameError = err instanceof Error ? err.message : String(err)
      }
      try {
        const res = await callCloudflare(env, "/zones?per_page=50")
        const data = (await res.json()) as {
          result?: { id?: string; name?: string; status?: string }[]
        }
        out.visibleZones = (data.result ?? []).map((z) => ({
          id: z.id,
          name: z.name,
          status: z.status,
        }))
      } catch (err) {
        out.listError = err instanceof Error ? err.message : String(err)
      }
      // 「能不能自己给自己扩权」——只报成败，不回显 Token 列表内容（那是账号级敏感信息）。
      // Token 列表可读 ⇒ 大概率也能建 Token，就能把 tyu.me 加进作用域，不必麻烦站长。
      for (const [label, path] of [
        ["userTokens", "/user/tokens?per_page=1"],
        ["accountTokens", `/accounts/${env.ACCOUNT_ID ?? ""}/tokens?per_page=1`],
      ] as const) {
        if (label === "accountTokens" && !env.ACCOUNT_ID) {
          out[label] = "skipped (no ACCOUNT_ID)"
          continue
        }
        try {
          await callCloudflare(env, path)
          out[label] = "readable"
        } catch (err) {
          out[label] = err instanceof Error ? err.message.slice(0, 160) : "error"
        }
      }
      return json(out)
    }

    case "resolve-zone": {
      return json({ ok: true, zoneId })
    }

    case "enable-email": {
      // CF 的历史包袱：早期用 `/email/routing/dns` 建记录，后来是 `/email/routing/enable`。
      // 两个都试，谁先成功算谁 —— 报错时把状态码带出来，便于判断是权限问题还是已开启。
      const attempts: string[] = []
      let ok = false
      for (const p of ["/email/routing/enable", "/email/routing/dns"]) {
        try {
          await callCloudflare(env, `/zones/${zoneId}${p}`, { method: "POST" })
          ok = true
          attempts.push(`${p}=ok`)
          break
        } catch (err) {
          attempts.push(`${p}=${err instanceof Error ? err.message.slice(0, 120) : "err"}`)
        }
      }

      // 现状探测放在判定**之前**：两个接口都报错，未必等于「没开通」。
      // 典型的假失败是「这个 zone 早就开好了，CF 对重复开通回 4xx」——
      // 此时真实状态（`enabled`）才是唯一可信的依据，只看 POST 的成败会把
      // 「本来就配好了」报成错误。所以先读状态，再决定要不要失败。
      const status = await emailRoutingStatus(env, zoneId)
      if (!ok && status.enabled) {
        attempts.push("(两个接口都报错，但 Email Routing 处于已启用状态，按成功处理)")
        ok = true
      }

      // 审计在**判定之前**写：这条记的是「谁在什么时候试图开通哪个域」，
      // 失败也要留下痕迹（detail 里带着两次失败的原因）。
      // ⚠️ 注意这与 set-catchall 相反 —— 那边的审计在 PUT **成功之后**，
      // 因为它的 detail 是「已经把 catch-all 指过去了」这种既成事实。
      // 两处口径不同是刻意的，别为了「统一」把某一边改齐。
      await recordAudit(
        env,
        admin.id,
        "admin.rootdomain.enableEmail",
        `开通 ${name} 的 Email Routing（${attempts.join(" / ")}）`,
        request.headers.get("CF-Connecting-IP")
      )

      // ⚠️ 失败必须是**非 2xx**，不能是 200 + `ok:false`（2026-10-16 修）。
      //
      // 原先这里失败时返回 200 + `ok:false`，而前端的请求封装只把非 2xx 当错误
      // （见 src/services/api.ts 的 throwHttpError），于是「CF 上一条记录都没建」
      // 会被前端当成成功、弹出「已开通 Email Routing」。假成功比报错更坏：
      // 站长以为配好了，而那个域**收不到任何信**，且界面上看不出异常。
      //
      // 选 502 + `EMAIL_ROUTING_ENABLE_FAILED`：与本文件其它 CF 侧失败
      // （CF_ERROR / CF_ZONE_UNRESOLVED / CF_DELETE_FAILED）保持同一口径 ——
      // 故障出在上游（Cloudflare），不是请求本身有问题，所以不是 4xx。
      // `ok` 字段两边都保留（成功 true、失败 false）：万一还有调用方在读它，
      // 行为不变；只是它**不再是**失败的唯一信号，状态码才是。
      if (!ok) {
        throw new ApiError(
          502,
          `开通 ${name} 的 Email Routing 失败：Cloudflare 未接受 enable 与 dns 两条路径` +
            `（${attempts.join(" / ")}）`,
          "EMAIL_ROUTING_ENABLE_FAILED",
          { ok: false, attempts, emailRouting: status }
        )
      }
      return json({ ok, attempts, emailRouting: status })
    }

    case "set-catchall": {
      const worker = emailWorkerName(env)
      const payload = {
        enabled: true,
        name: "Doulor Cloud catch-all",
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [worker] }],
      }
      await callCloudflare(env, `/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const status = await emailRoutingStatus(env, zoneId)
      await recordAudit(
        env,
        admin.id,
        "admin.rootdomain.setCatchAll",
        `把 ${name} 的 catch-all 指向 ${worker}`,
        request.headers.get("CF-Connecting-IP")
      )
      return json({ ok: true, emailRouting: status, worker })
    }

    case "set-default": {
      await env.DB.batch([
        env.DB.prepare("UPDATE root_domains SET is_default = 0"),
        env.DB.prepare("UPDATE root_domains SET is_default = 1 WHERE name = ?").bind(name),
      ])
      resetRootDomainCache()
      await recordAudit(
        env,
        admin.id,
        "admin.rootdomain.setDefault",
        `把默认分配域设为 ${name}`,
        request.headers.get("CF-Connecting-IP")
      )
      return json({ ok: true })
    }

    case "delete": {
      // 二次确认：站长必须手输完整域名。后端**独立**校验一遍 ——
      // 前端弹窗只是「防手滑」，不构成安全边界（接口是可以被直接调的）。
      const confirm = String(body.confirm ?? "").trim().toLowerCase()
      if (confirm !== name) {
        throw new ApiError(
          400,
          `删除根域需要二次确认：请在确认框里输入完整域名「${name}」`,
          "CONFIRM_REQUIRED"
        )
      }
      if (row.is_default === 1) {
        throw new ApiError(400, "默认域不可删除，请先指定别的默认域", "IS_DEFAULT")
      }
      // 站点主域（env.ROOT_DOMAIN）删不得：`cloud.doulor.cn`、密码重置链接、OAuth
      // issuer 都从它拼出来，而且它的 catch-all 是整个收信链路的入口 ——
      // 删掉它不是「少一个可分配域」，是站点自己坏掉。这条与 is_default 同类，
      // 属于代码里的硬线，不交给「站长手输域名」来行使。
      const siteRoot = (env.ROOT_DOMAIN ?? "").trim().toLowerCase()
      if (siteRoot && name === siteRoot) {
        throw new ApiError(
          400,
          `${name} 是站点主域（env.ROOT_DOMAIN），删除会让站点自身的解析与邮件路由一起失效，已拒绝`,
          "SITE_ROOT"
        )
      }

      const usage = await rootDomainUsage(env, name)

      // 连带删 CF 记录是**显式选项**，默认关闭：删记录会静默掐断用户正在跑的服务
      // （邮件、网站、网盘直链），而「从登记表里摘掉」不产生任何中断。
      let cf: Awaited<ReturnType<typeof deletePlatformRecordsUnderRoot>> | null = null
      if (body.deleteCfRecords === true) {
        if (!zoneId) {
          throw new ApiError(
            502,
            `无法解析 ${name} 的 Cloudflare zone，不能连带删除记录。` +
              `可以改为「只删登记」（不勾选该项），或先修好 zone 解析。`,
            "CF_ZONE_UNRESOLVED"
          )
        }
        cf = await deletePlatformRecordsUnderRoot(env, zoneId, name)
        if (cf.failed.length > 0) {
          // 中止：数据库里的根域保持不动，站长修好权限/冲突后重试即可。
          // 已经删掉的那几条不会回滚（CF 没有事务），这一点要在报错里讲清楚 ——
          // 否则站长会以为什么都没发生，重试时对不上数。
          await recordAudit(
            env,
            admin.id,
            "admin.rootdomain.deleteFailed",
            `删除 ${name} 中止：Cloudflare 记录删除失败 ${cf.failed.length} 条` +
              `（已删 ${cf.deleted.length} 条不回滚）`,
            request.headers.get("CF-Connecting-IP")
          )
          throw new ApiError(
            502,
            `有 ${cf.failed.length} 条 Cloudflare 记录删除失败：${cf.failed.join("；")}。` +
              `已中止，数据库里的根域**未改动**（但已删掉的 ${cf.deleted.length} 条不会回滚）。` +
              `修好之后重新执行删除即可。`,
            "CF_DELETE_FAILED",
            { deleted: cf.deleted, failed: cf.failed }
          )
        }
      }

      // 顺序：先摘 dns_wildcard_roots，再删表行。
      // 反过来（先删行）一旦设置项写失败，就会留下「表里没有这个域、设置里却宣称
      // 它有泛解析」的幽灵状态 —— 那条设置项的含义是「子域不用逐条建记录」，
      // 与事实不符时用户新建的子域会静默解析不了。先摘设置则最坏只是
      // 「域还在、开始逐条建记录」，功能完好、重试可收敛。
      const wildcardRoots = await removeRootFromWildcardSetting(env, name)

      const del = await env.DB.prepare("DELETE FROM root_domains WHERE name = ?")
        .bind(name)
        .run()
      resetRootDomainCache()
      if (!del.meta.changes) {
        // 走到这里说明表里其实没有这一行（`row` 来自读缓存或空表兜底），
        // 报 404 比回一个 ok 诚实 —— 站长看到 ok 会以为真的删掉了。
        throw new ApiError(404, "根域不存在（可能已被删除）", "NOT_FOUND")
      }

      await recordAudit(
        env,
        admin.id,
        "admin.rootdomain.delete",
        `删除根域 ${name}：解析 ${usage.records} 条 / 子域 ${usage.domains} 个 / ` +
          `租约 ${usage.rentalsActive < 0 ? "未知" : `${usage.rentalsActive} 有效、${usage.rentalsTotal} 全部`}` +
          `；Cloudflare 记录 ${
            cf
              ? `删除 ${cf.deleted.length} 条、跳过 ${cf.keptTotal} 条`
              : "按默认保留（未连带删除）"
          }`,
        request.headers.get("CF-Connecting-IP")
      )
      return json({ ok: true, name, usage, cf, wildcardRoots })
    }

    default:
      throw new ApiError(400, "未知操作", "INVALID_INPUT")
  }
}
