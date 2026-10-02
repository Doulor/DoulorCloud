/**
 * 管理面板 → Cloudflare 额度。
 *
 * 把本站所在 Cloudflare 账号的**额度用量**集中读出来给站长看（图形化占用 + 费用估算）。
 *
 * 数据只有两条来源，令牌只存在于 Worker 端：
 *   1. **GraphQL Analytics**（`/graphql`）→ 按天/按月的**用量**
 *      （Workers 请求、D1 行读行写、KV 增删改查、R2 操作、Workers AI neurons）。
 *   2. **REST 管理 API** → **资源数量与存储量**（另加 `/subscriptions` 判套餐）
 *      （D1 file_size、KV 存储、R2 存储、Pages 项目与部署…）。
 *
 * ⚠️ 六条设计约束（踩过才知道的）：
 *   a. **额度数字必须逐条核对官网**，凭记忆写会误导人。免费版集中在 `FREE_LIMITS`、
 *      付费版集中在 `PAID_LIMITS`（各自注明核对日期与出处）—— 改之前先去官网复查。
 *   b. **免费版与付费版的差别是「口径」不是「数字」**：免费版是**按天硬上限**
 *      （撞上直接拒绝服务），付费版是**按自然月的套餐内含量**（超出只计费、不断服）。
 *      所以每个 item 都带 `scope` + `limitKind`，UI 必须按它们选措辞与配色 ——
 *      把付费版的月含量当成「硬上限」画成红色告警，会让站长以为站点要挂了。
 *   c. **套餐要如实说明怎么判出来的**（`planSource`）：自动判定可能落到「无法确认」，
 *      这时必须让站长能在面板里手动指定，而不是默默按免费版显示。
 *   d. **每组独立降级**：某一块读不到（最常见是 API 令牌缺「账户分析」权限）
 *      只让那一组显示错误原因，不影响其它组。全有或全无会让人以为整个模块坏了。
 *   e. **口径**：日额度按 **UTC 当天**（CF 就是 00:00 UTC 重置），月额度按自然月。
 *   f. GraphQL 里**一个字段名写错会让整条查询失败**，所以字段名都是逐条实测过的；
 *      且按主题拆成 3 条查询，避免一条出错全灭。
 *
 * 关键字段名（2026-09-25 实测，改前先复核）：
 *   - `workersInvocationsAdaptive` → `sum.requests|errors`，`dimensions.date`
 *   - `d1AnalyticsAdaptiveGroups` → `sum.rowsRead|rowsWritten`，`dimensions.date`
 *   - `kvOperationsAdaptiveGroups` → `sum.requests`，`dimensions.actionType`（read/write/delete/list）
 *   - `kvStorageAdaptiveGroups` → `max.byteCount|keyCount`（**没有** `byteCount` 之外的别名）
 *   - `r2OperationsAdaptiveGroups` → `sum.requests`，`dimensions.actionType`
 *   - `r2StorageAdaptiveGroups` → `max.payloadSize|metadataSize`（**没有** `byteCount`！）
 *   - `aiInferenceAdaptiveGroups` → `sum.totalNeurons`（**没有** `totalRequests`！）
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { callCloudflare } from "../cloudflare"
import { fetchWithTimeout } from "../async-utils"
import { getSetting } from "../settings"
import type { Env } from "../env"

/** 历史窗口天数（前端画小柱状图用） */
const HISTORY_DAYS = 14
/** 同一次打开面板的缓存时长：避免反复点刷新把 CF API 打爆 */
const CACHE_MS = 60_000
/** 调 Cloudflare GraphQL 的超时（与 cloudflare.ts 的 CF_API_TIMEOUT_MS 一致） */
const CF_API_TIMEOUT_MS = 15_000

/**
 * 免费额度（2026-09-25 逐条核对 Cloudflare 官方文档，来源见每条注释）。
 * ⚠️ 官网改了就得改这里，否则会给出错误的占用率。
 */
export const FREE_LIMITS = {
  /** Workers 请求：100,000/天（Workers Limits 页「Daily requests」） */
  workersRequestsPerDay: 100_000,
  /** Workers 脚本数：100/账户（Workers Limits 页「Number of Workers」，Free） */
  workersScripts: 100,
  /** D1 行读：5,000,000/天（D1 Pricing 页 Billing metrics，Workers Free） */
  d1RowsReadPerDay: 5_000_000,
  /** D1 行写：100,000/天（同上） */
  d1RowsWrittenPerDay: 100_000,
  /** D1 存储：5 GB/账户（D1 Pricing「Storage 5 GB (total)」；Free 下**单库**上限 500 MB） */
  d1StorageBytes: 5 * 1024 ** 3,
  /** KV 读：100,000/天（KV Pricing 页 Free plan） */
  kvReadsPerDay: 100_000,
  /** KV 写：1,000/天（同上） */
  kvWritesPerDay: 1_000,
  /** KV 删：1,000/天（同上） */
  kvDeletesPerDay: 1_000,
  /** KV list：1,000/天（同上） */
  kvListsPerDay: 1_000,
  /** KV 存储：1 GB（同上） */
  kvStorageBytes: 1 * 1024 ** 3,
  /** R2 存储：10 GB-month/月（R2 Pricing 页 Free tier） */
  r2StorageBytes: 10 * 1024 ** 3,
  /** R2 Class A：1,000,000 请求/月（同上） */
  r2ClassAPerMonth: 1_000_000,
  /** R2 Class B：10,000,000 请求/月（同上） */
  r2ClassBPerMonth: 10_000_000,
  /** Pages 构建：500/月（Pages Limits 页「Builds per month」，Free） */
  pagesBuildsPerMonth: 500,
  /** Pages 项目数：100/账户（Pages Limits 页「Projects」） */
  pagesProjects: 100,
  /** Workers AI：10,000 neurons/天（Workers AI Pricing 页 Free allocation） */
  aiNeuronsPerDay: 10_000,
} as const

/**
 * Workers Paid（$5/月）下的额度（2026-09-30 逐条核对官网）。
 *
 * ⚠️ 与免费版最大的区别**不是数字变大，而是口径从「天」变成「月」**：
 *   免费版撞上日上限会**直接拒绝服务**（Workers 报 1027、D1 拒绝查询），
 *   付费版没有每日上限，只有「每月含多少、超出按量付费」。
 * 所以付费版下面的 `limit` 语义是「**含在套餐内的量**」而不是「硬上限」，
 * 超出不会挂站，只会产生费用 —— 这一点在 UI 上必须分开表达
 * （见 QuotaItem.limitKind）。
 *
 * 来源：
 *   - Workers：Workers Pricing 页 Standard 列（10M 请求/月、30M CPU 毫秒/月，
 *     超量 $0.30/百万请求、$0.02/百万 CPU 毫秒）；脚本数 500/账户。
 *   - D1：D1 Pricing 页 Workers Paid 列（25B 行读/月、50M 行写/月含在套餐内，
 *     超量 $0.001/百万行读、$1.00/百万行写；存储 5 GB 含，超出 $0.75/GB-月）。
 *   - KV：KV Pricing 页 Paid 列（10M 读/月、1M 写·删·列表各/月，
 *     超量读 $0.50/百万、写删列 $5.00/百万；存储 1 GB 含，超出 $0.50/GB-月）。
 *   - Workers AI：免费分配 10,000 neurons/天 **两份套餐都一样**。
 *   - Pages 构建：仍然是 500/月 —— Pages 的构建额度跟的是域名套餐
 *     （Free 500 / Pro 5,000 / Business 20,000），Workers Paid 并不升档。
 *   - R2：不用订阅，免费层 10 GB-月 + 1M Class A + 10M Class B 两份套餐一样。
 */
export const PAID_LIMITS = {
  /** Workers 请求：10M/月含，超出 $0.30/百万 */
  workersRequestsPerMonth: 10_000_000,
  /** Workers CPU 时间：30M 毫秒/月含，超出 $0.02/百万毫秒 */
  workersCpuMsPerMonth: 30_000_000,
  /** Worker 脚本数：500/账户 */
  workersScripts: 500,
  /** D1 行读：25B/月含，超出 $0.001/百万行 */
  d1RowsReadPerMonth: 25_000_000_000,
  /** D1 行写：50M/月含，超出 $1.00/百万行 */
  d1RowsWrittenPerMonth: 50_000_000,
  /** D1 存储：5 GB 含，超出 $0.75/GB-月 */
  d1StorageBytes: 5 * 1024 ** 3,
  /** KV 读：10M/月含，超出 $0.50/百万 */
  kvReadsPerMonth: 10_000_000,
  /** KV 写：1M/月含，超出 $5.00/百万 */
  kvWritesPerMonth: 1_000_000,
  /** KV 删：1M/月含，超出 $5.00/百万 */
  kvDeletesPerMonth: 1_000_000,
  /** KV 列表：1M/月含，超出 $5.00/百万 */
  kvListsPerMonth: 1_000_000,
  /** KV 存储：1 GB 含，超出 $0.50/GB-月 */
  kvStorageBytes: 1 * 1024 ** 3,
  /** Workers AI：免费分配，两份套餐相同 */
  aiNeuronsPerDay: 10_000,
} as const

/** 账号套餐：免费版 / 付费版（Workers Paid，$5/月起） */
export type CfPlan = "free" | "paid"

/** 套餐是怎么判出来的（面板要如实告诉管理员，别让他猜） */
export type CfPlanSource = "manual" | "subscription" | "usage" | "default"

/**
 * 按量计费的单价（美元）。只有付费版用得上：
 * 免费版撞上限是「直接失败」，不存在「超量付钱」这条路。
 */
export const PAID_RATES = {
  /** $/百万 请求 */
  workersRequests: 0.3,
  /** $/百万 CPU 毫秒 */
  workersCpuMs: 0.02,
  /** $/百万 行读 */
  d1RowsRead: 0.001,
  /** $/百万 行写 */
  d1RowsWritten: 1.0,
  /** $/GB-月 */
  d1Storage: 0.75,
  /** $/百万 读 */
  kvReads: 0.5,
  /** $/百万 写·删·列表 */
  kvOps: 5.0,
  /** $/GB-月 */
  kvStorage: 0.5,
  /** $/百万 Class A */
  r2ClassA: 4.5,
  /** $/百万 Class B */
  r2ClassB: 0.36,
  /** $/GB-月 */
  r2Storage: 0.015,
  /** $/月 订阅最低消费（Workers Paid） */
  subscription: 5.0,
} as const

/**
 * R2 操作分类（R2 Pricing 页 Class A / Class B 列表，逐字对照）。
 * 删对象等属于「免费操作」，**不计入任何一类**，所以刻意不在下表里。
 */
export const R2_CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
])
export const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
])

/** 该 R2 actionType 属于哪一类；免费操作（Delete* 等）返回 null */
export function classifyR2Op(actionType: string): "A" | "B" | null {
  if (R2_CLASS_A.has(actionType)) return "A"
  if (R2_CLASS_B.has(actionType)) return "B"
  return null
}

/** UTC 当天（`YYYY-MM-DD`）—— CF 的日额度就是按 00:00 UTC 重置的 */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10)
}

/** 本月第一天（`YYYY-MM-01`）—— R2 / Pages 的额度按月算 */
export function utcMonthStart(at: Date = new Date()): string {
  return `${at.toISOString().slice(0, 7)}-01`
}

/** 把 `[{dimensions:{date},sum:{x}}]` 摊平成按天序列，日期升序 */
export function toDailySeries<T extends { dimensions?: { date?: string }; sum?: Record<string, number> }>(
  rows: T[] | undefined,
  field: string
): { date: string; value: number }[] {
  const out = (rows ?? [])
    .map((r) => ({ date: r.dimensions?.date ?? "", value: Number(r.sum?.[field] ?? 0) }))
    .filter((r) => r.date)
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}

/** 取某一天的用量（没有记录 = 0 —— CF 没有流量时该天就不返回行） */
export function valueOnDate(
  rows: { dimensions?: { date?: string }; sum?: Record<string, number> }[] | undefined,
  field: string,
  date: string
): number {
  for (const r of rows ?? []) {
    if (r.dimensions?.date === date) return Number(r.sum?.[field] ?? 0)
  }
  return 0
}

/** 按 actionType 汇总（取某一天或整个窗口） */
export function sumByAction(
  rows: { dimensions?: { actionType?: string; date?: string }; sum?: { requests?: number } }[] | undefined,
  opts: { date?: string; actions?: string[]; since?: string } = {}
): number {
  let total = 0
  for (const r of rows ?? []) {
    if (opts.date && r.dimensions?.date !== opts.date) continue
    // since：本自然月以来的合计（付费版是月口径，光看「今天」没有意义）
    if (opts.since && (r.dimensions?.date ?? "") < opts.since) continue
    if (opts.actions && !opts.actions.includes(r.dimensions?.actionType ?? "")) continue
    total += Number(r.sum?.requests ?? 0)
  }
  return total
}

/** 按天序列里 `since`（含）之后的合计 —— 用来算「本自然月至今」 */
export function sumSeriesSince(
  series: { date: string; value: number }[],
  since: string
): number {
  let total = 0
  for (const p of series) {
    if (p.date >= since) total += p.value
  }
  return total
}

/** 只保留最近 n 天的历史（柱状图用；取窗口被拉长到整月后必须裁一下） */
export function tailDays<T extends { date: string }>(series: T[], n: number): T[] {
  return series.length <= n ? series : series.slice(series.length - n)
}

export interface QuotaItem {
  key: string
  label: string
  /** 已用量；读不到时为 null */
  used: number | null
  /** 上限（免费版=每日硬上限；付费版=套餐内含量）；无上限为 null */
  limit: number | null
  /** 展示单位：次 / 行 / 个 / 字节 */
  unit: "times" | "rows" | "items" | "bytes"
  /** 重置周期说明 */
  period: string
  /**
   * 上面 `limit` / `used` 是哪个周期的量。
   *   day   = 当天（UTC）
   *   month = 本自然月至今
   *   none  = 不重置（存量，如存储占用、资源数量）
   */
  scope: "day" | "month" | "none"
  /**
   * 上限的性质 —— 决定 UI 用「危险色」还是「费用色」表达：
   *   hard     = 撞上就**拒绝服务**（免费版的日上限）
   *   included = 套餐内含量，超出**按量付费**，不中断服务（付费版）
   *   null     = 无上限
   */
  limitKind: "hard" | "included" | null
  /** 最近若干天的用量（画柱状图），无历史则为空 */
  history?: { date: string; value: number }[]
  note?: string
  /** 读不到时的原因（面向站长，要能指导他改令牌权限） */
  error?: string
  /** 付费版专属：本项本月已产生的**超额**估算费用（美元）；未超额为 0 */
  costUsd?: number
  /** 付费版专属：超额单价说明，如「超出后 $0.30 / 百万次」 */
  overageNote?: string
  /** 免费版专属：一旦升级到付费版，这一项的额度会变成什么（一句话） */
  paidNote?: string
}

export interface QuotaGroup {
  key: string
  label: string
  description: string
  items: QuotaItem[]
}

/** 面板顶部的图形化概览（只挑最该盯的几项画环） */
export interface QuotaHighlight {
  key: string
  label: string
  used: number
  limit: number
  percent: number
  unit: QuotaItem["unit"]
  limitKind: "hard" | "included"
  costUsd: number
}

export interface CfQuotaOverview {
  generatedAt: string
  accountId: string
  /** 判定出的套餐（额度数字按它来选） */
  plan: CfPlan
  /** 判定依据 —— UI 要显示「为什么认为是付费版」，否则管理员没法纠错 */
  planSource: CfPlanSource
  /** 当前设置里存的值：auto / free / paid */
  planSetting: string
  /** 判定过程的一句人话解释 */
  planNote: string
  /** 付费版：本月（截至现在）估算的**总费用**，含 $5 订阅底价 */
  estimatedCostUsd: number | null
  /** 付费版：费用拆解（订阅 + 各项超量），供 UI 列明细 */
  costBreakdown: { label: string; detail: string; usd: number }[]
  /** 图形化概览用的几项（按占用率从高到低） */
  highlights: QuotaHighlight[]
  groups: QuotaGroup[]
  /** 整体性提醒（例如分析数据整体读不到时给一条统一的处置建议） */
  warnings: string[]
}

// ---- GraphQL 辅助 ----

interface GqlEnvelope {
  data?: { viewer?: { accounts?: Record<string, unknown>[] } }
  errors?: { message?: string }[]
}

async function runGql(
  env: Env,
  accountId: string,
  query: string,
  vars: Record<string, string>
): Promise<Record<string, unknown>> {
  // 用量类数据要「账户分析（Account Analytics）· 读取」权限。
  // 站点里 `CLOUDFLARE_API_TOKEN_SECRET` 只有 Email Routing / Workers 等写权限、
  // **没有** Analytics 读取；真正带这个权限的是 `R2_API_TOKEN`
  // （见 env.ts 的注释：Account Analytics → Read）。所以 GraphQL 用量**优先用它**。
  const analyticsToken = env.R2_API_TOKEN?.trim()
  let res: Response
  if (analyticsToken) {
    res = await fetchWithTimeout(
      "https://api.cloudflare.com/client/v4/graphql",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${analyticsToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: { acct: accountId, ...vars } }),
      },
      CF_API_TIMEOUT_MS
    )
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(`Cloudflare GraphQL 调用失败: ${res.status} ${body}`)
    }
  } else {
    res = await callCloudflare(env, "/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables: { acct: accountId, ...vars } }),
    })
  }
  const body = (await res.json()) as GqlEnvelope
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? "?").join("；"))
  }
  const acct = body.data?.viewer?.accounts?.[0]
  return acct ?? {}
}

/** 把 CF 的原始报错压成一句能指导操作的话 */
function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/authentication|10000|not authorized|permission|forbidden|403/i.test(raw)) {
    return (
      "读取被拒绝。请给 Worker 的 R2_API_TOKEN 补上对应读取权限后重试：" +
      "用量类需「账户分析 · 读取」，D1 存储需「D1 · 读取」，Pages 需「Pages · 读取」。" +
      `原始报错：${raw.slice(0, 160)}`
    )
  }
  return raw.slice(0, 240)
}

// ---- 各数据源 ----

interface AnalyticsBundle {
  workers: { dimensions?: { date?: string }; sum?: Record<string, number> }[]
  d1: { dimensions?: { date?: string }; sum?: Record<string, number> }[]
  kvOps: { dimensions?: { actionType?: string; date?: string }; sum?: { requests?: number } }[]
  kvStorage: { dimensions?: { date?: string }; max?: Record<string, number> }[]
  r2Ops: { dimensions?: { actionType?: string }; sum?: { requests?: number } }[]
  r2Storage: { dimensions?: { date?: string }; max?: Record<string, number> }[]
  aiNeurons: { dimensions?: { date?: string }; sum?: Record<string, number> }[]
}

/**
 * 拉分析数据。拆成 3 条查询：GraphQL 里一个字段出错整条查询就废，
 * 拆开才能做到「KV 读不到不影响 Workers 的显示」。
 */
async function fetchAnalytics(env: Env, accountId: string): Promise<{
  data: AnalyticsBundle
  errors: Partial<Record<keyof AnalyticsBundle, string>>
}> {
  const now = new Date()
  const until = utcDay(now)
  const monthStart = utcMonthStart(now)
  // 窗口取「最近 HISTORY_DAYS 天」与「本自然月」中更早的那个：
  // 付费版的额度是**月**口径，只看最近 14 天算不出「本月至今」。
  // 多拉的那些天由 tailDays() 在展示层裁掉，不影响柱状图。
  const fortnightAgo = new Date(now.getTime() - (HISTORY_DAYS - 1) * 86400_000)
    .toISOString()
    .slice(0, 10)
  const since = fortnightAgo < monthStart ? fortnightAgo : monthStart
  const vars = { since, until, monthStart }

  const data: AnalyticsBundle = {
    workers: [],
    d1: [],
    kvOps: [],
    kvStorage: [],
    r2Ops: [],
    r2Storage: [],
    aiNeurons: [],
  }
  const errors: Partial<Record<keyof AnalyticsBundle, string>> = {}

  // ⚠️ 必须写成 `[GraphQL 返回的字段名, 本模块的键]` 两元组 ——
  // 两者名字不一样（`workersInvocationsAdaptive` → `workers`），
  // 直接按本模块的键去取会永远拿到 undefined（曾经就踩了这个坑）。
  const queries: { fields: [string, keyof AnalyticsBundle][]; query: string }[] = [
    {
      fields: [
        ["workersInvocationsAdaptive", "workers"],
        ["d1AnalyticsAdaptiveGroups", "d1"],
      ],
      // limit 必须 ≥ 窗口天数：窗口最长是「本月至今」（31 天），
      // 给 100 留足余量 —— 给 50 的话月末会静默截掉最早那几天，
      // 表现为「本月合计偏小」，这种错很难被发现。
      query: `query ($acct: String!, $since: String!, $until: String!) {
        viewer { accounts(filter: {accountTag: $acct}) {
          workersInvocationsAdaptive(limit: 100, filter: {date_geq: $since, date_leq: $until}) {
            sum { requests errors } dimensions { date }
          }
          d1AnalyticsAdaptiveGroups(limit: 100, filter: {date_geq: $since, date_leq: $until}) {
            sum { rowsRead rowsWritten } dimensions { date }
          }
        } }
      }`,
    },
    {
      fields: [
        ["kvOperationsAdaptiveGroups", "kvOps"],
        ["kvStorageAdaptiveGroups", "kvStorage"],
        ["r2StorageAdaptiveGroups", "r2Storage"],
        ["r2OperationsAdaptiveGroups", "r2Ops"],
      ],
      query: `query ($acct: String!, $since: String!, $until: String!, $monthStart: String!) {
        viewer { accounts(filter: {accountTag: $acct}) {
          kvOperationsAdaptiveGroups(limit: 400, filter: {date_geq: $since, date_leq: $until}) {
            sum { requests } dimensions { actionType date }
          }
          kvStorageAdaptiveGroups(limit: 100, filter: {date_geq: $since, date_leq: $until}) {
            max { byteCount keyCount } dimensions { date }
          }
          r2StorageAdaptiveGroups(limit: 100, filter: {date_geq: $since, date_leq: $until}) {
            max { payloadSize metadataSize } dimensions { date }
          }
          r2OperationsAdaptiveGroups(limit: 300, filter: {date_geq: $monthStart, date_leq: $until}) {
            sum { requests } dimensions { actionType }
          }
        } }
      }`,
    },
    {
      fields: [["aiInferenceAdaptiveGroups", "aiNeurons"]],
      query: `query ($acct: String!, $since: String!, $until: String!) {
        viewer { accounts(filter: {accountTag: $acct}) {
          aiInferenceAdaptiveGroups(limit: 100, filter: {date_geq: $since, date_leq: $until}) {
            sum { totalNeurons } dimensions { date }
          }
        } }
      }`,
    },
  ]

  for (const q of queries) {
    try {
      const result = await runGql(env, accountId, q.query, vars)
      for (const [field, key] of q.fields) {
        ;(data as unknown as Record<string, unknown>)[key] = result[field] ?? []
      }
    } catch (err) {
      for (const [, key] of q.fields) errors[key] = explain(err)
    }
  }
  return { data, errors }
}

/**
 * REST 侧读一个 CF 接口（返回解析后的 JSON 信封）。
 *
 * REST 资源类（Worker 数量 / D1 存储 / Pages / 订阅）同样**优先用 R2_API_TOKEN**：
 * 它带了 Account Analytics Read，若能再补「账户设置·读取」「Pages·读取」就能全通；
 * 没有它才回退到 CLOUDFLARE_API_TOKEN_SECRET（那个 token 缺账户设置/Pages 读权限，
 * 正是线上「读不到」的根因）。
 */
async function cfJsonOf<T>(env: Env, path: string): Promise<T> {
  const token = env.R2_API_TOKEN?.trim()
  let res: Response
  if (token) {
    res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      CF_API_TIMEOUT_MS
    )
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(`Cloudflare API 调用失败: ${res.status} ${body}`)
    }
  } else {
    res = await callCloudflare(env, path)
  }
  return (await res.json()) as T
}

/**
 * 判定账号套餐。
 *
 * 三级判定，逐级放宽（详见 settings.ts 的 `cf_plan` 注释）：
 *   1. 设置里**手动指定**过 → 直接采信（管理员的判断优先于任何推断）；
 *   2. 读 `/accounts/{id}/subscriptions` 找 WORKERS_PAID（需要「账户账单·读取」权限，
 *      我们这个令牌多半没有，所以**失败是常态**，必须静默降级）；
 *   3. **用量反证**：免费版的日上限撞上就是硬失败，所以「任何一天超出免费日上限」
 *      等价于「已经是付费版」。这条是**单向可靠**的 —— 它只会把确实的付费版认出来，
 *      绝不会把免费版误判成付费版；反过来（付费版但用量一直很低）认不出来，
 *      那就回落免费版并在面板上提示管理员手动选。
 */
async function detectPlan(
  env: Env,
  accountId: string,
  usage: { workers: number; d1Read: number; d1Write: number; kvRead: number; kvOps: number }
): Promise<{ plan: CfPlan; source: CfPlanSource; note: string }> {
  const setting = (await getSetting(env, "cf_plan")).trim().toLowerCase()
  if (setting === "free" || setting === "paid") {
    return {
      plan: setting,
      source: "manual",
      note: `按管理面板里的手动指定：${setting === "paid" ? "付费版" : "免费版"}。`,
    }
  }

  // 2. 订阅接口（能读到就是权威答案）
  try {
    const r = await cfJsonOf<{ result?: { rate_plan?: { id?: string; name?: string } }[] }>(
      env,
      `/accounts/${accountId}/subscriptions`
    )
    const subs = r.result ?? []
    const hit = subs.find((s) => /WORKERS[_-]?(PAID|STANDARD)/i.test(s.rate_plan?.id ?? ""))
    if (hit) {
      return {
        plan: "paid",
        source: "subscription",
        note: `订阅接口显示已订阅 ${hit.rate_plan?.name ?? hit.rate_plan?.id ?? "Workers Paid"}。`,
      }
    }
    if (subs.length > 0) {
      // 读到了订阅列表但没有 Workers Paid —— 明确是免费版
      return {
        plan: "free",
        source: "subscription",
        note: "订阅接口可读，且没有 Workers Paid 订阅，判定为免费版。",
      }
    }
  } catch (err) {
    // 静默：令牌通常没有账单读取权限，不值得把整块面板搞成报错
    console.log("读取 Cloudflare 订阅失败（将改用用量反证）:", err)
  }

  // 3. 用量反证
  const exceededFree =
    usage.workers > FREE_LIMITS.workersRequestsPerDay ||
    usage.d1Read > FREE_LIMITS.d1RowsReadPerDay ||
    usage.d1Write > FREE_LIMITS.d1RowsWrittenPerDay ||
    usage.kvRead > FREE_LIMITS.kvReadsPerDay ||
    usage.kvOps > FREE_LIMITS.kvWritesPerDay
  if (exceededFree) {
    return {
      plan: "paid",
      source: "usage",
      note:
        "订阅接口读不到（令牌缺「账户账单·读取」权限），但观察到单日用量已超过免费版的日上限 —— " +
        "免费版撞上日上限会直接中断服务，所以本账号必定已是付费版。",
    }
  }

  return {
    plan: "free",
    source: "default",
    note:
      "无法自动确认套餐（订阅接口读不到，且用量未超过免费版日上限 —— 付费版但用量偏低时就会这样）。" +
      "若你确信已付费，请在下方把套餐手动切到「付费版」。",
  }
}

/** REST 侧的计数/体积。每一项独立失败，只写进 errors */
async function fetchResources(env: Env, accountId: string): Promise<{
  counts: {
    workersScripts: number | null
    d1Bytes: number | null
    d1Databases: number | null
    pagesProjects: number | null
    pagesBuildsThisMonth: number | null
  }
  errors: Record<string, string>
}> {
  const counts = {
    workersScripts: null as number | null,
    d1Bytes: null as number | null,
    d1Databases: null as number | null,
    pagesProjects: null as number | null,
    pagesBuildsThisMonth: null as number | null,
  }
  const errors: Record<string, string> = {}

  // REST 资源类（Worker 数量 / D1 存储 / Pages）同样**优先用 R2_API_TOKEN**：
  // 它带了 Account Analytics Read，若能再补「账户设置·读取」「Pages·读取」就能全通；
  // 没有它才回退到 CLOUDFLARE_API_TOKEN_SECRET（那个 token 缺账户设置/Pages 读权限，
  // 正是线上「读不到」的根因）。
  const jsonOf = <T,>(path: string): Promise<T> => cfJsonOf<T>(env, path)

  await Promise.all([
    (async () => {
      try {
        const r = await jsonOf<{ result: { id: string }[] }>(
          `/accounts/${accountId}/workers/scripts`
        )
        counts.workersScripts = (r.result ?? []).length
      } catch (err) {
        errors.workersScripts = explain(err)
      }
    })(),
    (async () => {
      try {
        const r = await jsonOf<{ result: { file_size?: number }[] }>(
          `/accounts/${accountId}/d1/database`
        )
        const list = r.result ?? []
        counts.d1Databases = list.length
        counts.d1Bytes = list.reduce((n, d) => n + Number(d.file_size ?? 0), 0)
      } catch (err) {
        errors.d1Bytes = explain(err)
      }
    })(),
    (async () => {
      try {
        const r = await jsonOf<{
          result: {
            name: string
            latest_deployment?: { created_on?: string } | null
          }[]
        }>(`/accounts/${accountId}/pages/projects`)
        const projects = r.result ?? []
        counts.pagesProjects = projects.length

        // 只对「最近有部署」的项目去数部署次数：把 6 个项目全拉一遍没必要，
        // 而且每个项目一次请求（子请求额度要省着用）。
        const monthStart = utcMonthStart()
        const candidates = projects.filter(
          (p) => (p.latest_deployment?.created_on ?? "") >= monthStart
        )
        let builds = 0
        for (const p of candidates) {
          // ⚠️ 这个接口的 `per_page` **上限就是 25**：传 50/100 会被 CF 直接拒绝
          //（8000024 Invalid list options），实测踩到过 —— 表现是构建数恒为 0。
          // 所以按 25 分页，并且一页里出现「上个月的部署」就不再往下翻
          //（列表按时间倒序，后面的只会更早）。
          for (let page = 1; page <= 3; page++) {
            let deps: { created_on?: string }[] = []
            try {
              const d = await jsonOf<{ result: { created_on?: string }[] }>(
                `/accounts/${accountId}/pages/projects/${encodeURIComponent(
                  p.name
                )}/deployments?per_page=25&page=${page}`
              )
              deps = d.result ?? []
            } catch {
              break // 单个项目读不到就跳过，note 里说明了这是近似值
            }
            if (deps.length === 0) break
            const inMonth = deps.filter((x) => (x.created_on ?? "") >= monthStart)
            builds += inMonth.length
            if (inMonth.length < deps.length || deps.length < 25) break
          }
        }
        counts.pagesBuildsThisMonth = builds
      } catch (err) {
        errors.pagesProjects = explain(err)
      }
    })(),
  ])

  return { counts, errors }
}

// ---- 组装 ----

const dayPeriod = "每天 00:00 UTC 重置"
const monthPeriod = "每月重置（自然月，按订阅日推算）"
const stockPeriod = "不重置（存量）"

const GIB = 1024 ** 3

/** 超出 `limit` 的部分按「每 per 单位 usd 美元」计费；未超出返回 0 */
export function overCost(used: number, limit: number, per: number, usd: number): number {
  const over = used - limit
  if (over <= 0) return 0
  return (over / per) * usd
}

/** 序列里的最大值（窗口内单日峰值 —— 用来做「免费日上限被突破」的反证） */
export function maxValue(series: { value: number }[]): number {
  let m = 0
  for (const p of series) if (p.value > m) m = p.value
  return m
}

export async function collectQuota(env: Env, accountId: string): Promise<CfQuotaOverview> {
  const now = new Date()
  const today = utcDay(now)
  const monthStart = utcMonthStart(now)

  const [analytics, resources] = await Promise.all([
    fetchAnalytics(env, accountId),
    fetchResources(env, accountId),
  ])
  const { data, errors } = analytics
  const { counts } = resources

  const warnings: string[] = []
  // 分析数据整块读不到是最常见的坑（令牌缺权限），给一条统一提示
  const analyticsFailed = Object.keys(errors).length >= 5
  if (analyticsFailed) {
    warnings.push(
      "用量类数据（Workers 请求、D1 行读写、KV、R2 操作、AI）整体读不到，通常是 " +
        "Worker 的 API 令牌缺少「账户分析 · 读取」权限。资源数量与存储量不受影响，仍可正常显示。"
    )
  }

  // ---- 序列：窗口可能被拉到整月，展示层再裁成最近 14 天 ----
  const workersSeries = toDailySeries(data.workers, "requests")
  const d1ReadSeries = toDailySeries(data.d1, "rowsRead")
  const d1WriteSeries = toDailySeries(data.d1, "rowsWritten")
  const aiSeries = toDailySeries(data.aiNeurons, "totalNeurons")

  const kvSeries = (action: string): { date: string; value: number }[] => {
    const dates = Array.from(
      new Set((data.kvOps ?? []).map((r) => r.dimensions?.date ?? "").filter(Boolean))
    ).sort()
    return dates.map((date) => ({ date, value: sumByAction(data.kvOps, { date, actions: [action] }) }))
  }
  const kvReadSeries = kvSeries("read")
  const kvWriteSeries = kvSeries("write")
  const kvDeleteSeries = kvSeries("delete")
  const kvListSeries = kvSeries("list")

  // ---- 套餐判定（必须在算每个 item 的 limit 之前）----
  const planInfo = await detectPlan(env, accountId, {
    workers: maxValue(workersSeries),
    d1Read: maxValue(d1ReadSeries),
    d1Write: maxValue(d1WriteSeries),
    kvRead: maxValue(kvReadSeries),
    kvOps: Math.max(
      maxValue(kvWriteSeries),
      maxValue(kvDeleteSeries),
      maxValue(kvListSeries)
    ),
  })
  const paid = planInfo.plan === "paid"

  if (planInfo.source === "default") {
    warnings.push(planInfo.note)
  }

  // KV 存储 / R2 存储：取窗口内最新一天的 max
  const latestMax = (
    rows: { dimensions?: { date?: string }; max?: Record<string, number> }[] | undefined,
    pick: (m: Record<string, number>) => number
  ): number | null => {
    const dated = (rows ?? [])
      .filter((r) => r.dimensions?.date)
      .sort((a, b) => (a.dimensions?.date ?? "").localeCompare(b.dimensions?.date ?? ""))
    const last = dated[dated.length - 1]
    return last ? pick(last.max ?? {}) : null
  }
  const kvBytes = latestMax(data.kvStorage, (m) => Number(m.byteCount ?? 0))
  const r2Bytes = latestMax(
    data.r2Storage,
    (m) => Number(m.payloadSize ?? 0) + Number(m.metadataSize ?? 0)
  )

  // R2 操作按 Class A / B 分类（免费操作不计）
  let classA = 0
  let classB = 0
  for (const r of data.r2Ops ?? []) {
    const kind = classifyR2Op(r.dimensions?.actionType ?? "")
    if (kind === "A") classA += Number(r.sum?.requests ?? 0)
    else if (kind === "B") classB += Number(r.sum?.requests ?? 0)
  }

  // ---- item 工厂 ----
  // 两种口径差异全在这里收口：免费版拿「当天 vs 日上限」，付费版拿「本月至今 vs 月含量」。
  // 别在下面每个 item 里写 if (paid) —— 漏一处就会给出错误占用的数字。

  /** 流量项（按天/按月计量的请求数、行数） */
  const flowItem = (o: {
    key: string
    label: string
    unit?: QuotaItem["unit"]
    today: number | null
    mtd: number | null
    limitFreePerDay: number
    limitPaidPerMonth: number
    rate?: { per: number; usd: number }
    overageNote?: string
    paidNote?: string
    history?: { date: string; value: number }[]
    note?: string
    error?: string
  }): QuotaItem => {
    if (!paid) {
      return {
        key: o.key,
        label: o.label,
        unit: o.unit ?? "times",
        used: o.today,
        limit: o.limitFreePerDay,
        scope: "day",
        limitKind: "hard",
        period: dayPeriod,
        history: o.history,
        note: o.note,
        error: o.error,
        paidNote: o.paidNote,
      }
    }
    const cost =
      o.rate && o.mtd != null ? overCost(o.mtd, o.limitPaidPerMonth, o.rate.per, o.rate.usd) : 0
    return {
      key: o.key,
      label: o.label,
      unit: o.unit ?? "times",
      used: o.mtd,
      limit: o.limitPaidPerMonth,
      scope: "month",
      limitKind: "included",
      period: monthPeriod,
      history: o.history,
      note: o.note,
      error: o.error,
      costUsd: cost > 0 ? cost : undefined,
      overageNote: o.overageNote,
    }
  }

  /** 存量项（存储占用、资源数量） */
  const stockItem = (o: {
    key: string
    label: string
    unit?: QuotaItem["unit"]
    used: number | null
    limitFree: number
    limitPaid: number
    /** 给了 rate 才算「含额度、超出付费」 */
    rate?: { per: number; usd: number; always?: boolean }
    overageNote?: string
    paidNote?: string
    note?: string
    error?: string
    period?: string
  }): QuotaItem => {
    const limit = paid ? o.limitPaid : o.limitFree
    const billable = !!o.rate && (o.rate.always || paid)
    const cost =
      billable && o.used != null
        ? overCost(o.used, limit, o.rate!.per, o.rate!.usd)
        : 0
    return {
      key: o.key,
      label: o.label,
      unit: o.unit ?? "items",
      used: o.used,
      limit,
      scope: "none",
      limitKind: o.rate ? "included" : "hard",
      period: o.period ?? stockPeriod,
      note: o.note,
      error: o.error,
      costUsd: cost > 0 ? cost : undefined,
      overageNote: o.rate ? o.overageNote : undefined,
      paidNote: paid ? undefined : o.paidNote,
    }
  }

  const groups: QuotaGroup[] = [
    {
      key: "workers",
      label: "Workers",
      description: paid
        ? "付费版没有每日请求上限：每月含 1000 万次请求，超出按 $0.30/百万计费，不会中断服务。CPU 时间单独计量（月含 3000 万毫秒）。Pages Functions 的请求也计入这里。"
        : "免费版每日 10 万次请求，超额后接口返回 1027 错误（站点会直接挂）。Pages Functions 的请求也计入这里。",
      items: [
        flowItem({
          key: "workers.requests",
          label: paid ? "本月请求数" : "今日请求数",
          today: errors.workers ? null : valueOnDate(data.workers, "requests", today),
          mtd: errors.workers ? null : sumSeriesSince(workersSeries, monthStart),
          limitFreePerDay: FREE_LIMITS.workersRequestsPerDay,
          limitPaidPerMonth: PAID_LIMITS.workersRequestsPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.workersRequests },
          overageNote: "月含 1000 万次，超出后 $0.30 / 百万次",
          paidNote: "升级后：每月含 1000 万次、无每日上限，超出 $0.30/百万次",
          history: tailDays(workersSeries, HISTORY_DAYS),
          error: errors.workers,
        }),
        stockItem({
          key: "workers.scripts",
          label: "Worker 数量",
          used: counts.workersScripts,
          limitFree: FREE_LIMITS.workersScripts,
          limitPaid: PAID_LIMITS.workersScripts,
          paidNote: "升级后上限 500 个 / 账户",
          error: resources.errors.workersScripts,
        }),
      ],
    },
    {
      key: "d1",
      label: "D1 数据库",
      description: paid
        ? "付费版没有每日行读写上限：每月含 250 亿行读、5000 万行写，超出分别按 $0.001 / $1.00 每百万行计费。存储 5 GB 含，超出 $0.75/GB-月。"
        : "行读、行写按天限额，超额后数据库拒绝所有查询；存储是账户总量，免费版单个库另有 500 MB 上限。",
      items: [
        flowItem({
          key: "d1.rowsRead",
          label: paid ? "本月行读" : "今日行读",
          unit: "rows",
          today: errors.d1 ? null : valueOnDate(data.d1, "rowsRead", today),
          mtd: errors.d1 ? null : sumSeriesSince(d1ReadSeries, monthStart),
          limitFreePerDay: FREE_LIMITS.d1RowsReadPerDay,
          limitPaidPerMonth: PAID_LIMITS.d1RowsReadPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.d1RowsRead },
          overageNote: "月含 250 亿行，超出后 $0.001 / 百万行",
          paidNote: "升级后：每月含 250 亿行、无每日上限",
          history: tailDays(d1ReadSeries, HISTORY_DAYS),
          error: errors.d1,
        }),
        flowItem({
          key: "d1.rowsWritten",
          label: paid ? "本月行写" : "今日行写",
          unit: "rows",
          today: errors.d1 ? null : valueOnDate(data.d1, "rowsWritten", today),
          mtd: errors.d1 ? null : sumSeriesSince(d1WriteSeries, monthStart),
          limitFreePerDay: FREE_LIMITS.d1RowsWrittenPerDay,
          limitPaidPerMonth: PAID_LIMITS.d1RowsWrittenPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.d1RowsWritten },
          overageNote: "月含 5000 万行，超出后 $1.00 / 百万行",
          paidNote: "升级后：每月含 5000 万行、无每日上限",
          history: tailDays(d1WriteSeries, HISTORY_DAYS),
          error: errors.d1,
        }),
        stockItem({
          key: "d1.storage",
          label: "存储",
          unit: "bytes",
          used: counts.d1Bytes,
          limitFree: FREE_LIMITS.d1StorageBytes,
          limitPaid: PAID_LIMITS.d1StorageBytes,
          rate: { per: GIB, usd: PAID_RATES.d1Storage },
          overageNote: "含 5 GB，超出后 $0.75 / GB-月",
          paidNote: "升级后：仍是 5 GB 含，但超出只计费、不阻断写入",
          note:
            counts.d1Databases != null
              ? `${counts.d1Databases} 个数据库` +
                (paid ? "" : "；免费版单库上限 500 MB，满了连建表都会被拒")
              : undefined,
          error: resources.errors.d1Bytes,
        }),
      ],
    },
    {
      key: "r2",
      label: "R2 对象存储",
      description:
        "R2 不需要订阅，免费层（10 GB-月存储 + 100 万 Class A + 1000 万 Class B，按自然月）两份套餐都一样，超出按量计费后仍然可用、不会中断。出口流量免费；删除对象不计入 Class A / B。",
      items: [
        stockItem({
          key: "r2.storage",
          label: "存储",
          unit: "bytes",
          used: r2Bytes,
          limitFree: FREE_LIMITS.r2StorageBytes,
          limitPaid: FREE_LIMITS.r2StorageBytes,
          rate: { per: GIB, usd: PAID_RATES.r2Storage, always: true },
          overageNote: "含 10 GB-月，超出后 $0.015 / GB-月",
          period: "每月（GB-month，按每日峰值平均）",
          error: errors.r2Storage,
        }),
        stockItem({
          key: "r2.classA",
          label: "Class A 操作（写/列举）",
          used: errors.r2Ops ? null : classA,
          limitFree: FREE_LIMITS.r2ClassAPerMonth,
          limitPaid: FREE_LIMITS.r2ClassAPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.r2ClassA, always: true },
          overageNote: "月含 100 万次，超出后 $4.50 / 百万次",
          period: monthPeriod,
          error: errors.r2Ops,
          note: "PutObject / ListObjects / CopyObject / 分片上传等",
        }),
        stockItem({
          key: "r2.classB",
          label: "Class B 操作（读）",
          used: errors.r2Ops ? null : classB,
          limitFree: FREE_LIMITS.r2ClassBPerMonth,
          limitPaid: FREE_LIMITS.r2ClassBPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.r2ClassB, always: true },
          overageNote: "月含 1000 万次，超出后 $0.36 / 百万次",
          period: monthPeriod,
          error: errors.r2Ops,
          note: "GetObject / HeadObject / HeadBucket 等",
        }),
      ],
    },
    {
      key: "pages",
      label: "Pages",
      description:
        "⚠️ Pages 的构建额度跟的是域名套餐（Free 500 / Pro 5,000 / Business 20,000），Workers Paid 并不升档。项目数上限 100 且不随套餐变化。",
      items: [
        stockItem({
          key: "pages.builds",
          label: "本月构建",
          used: counts.pagesBuildsThisMonth,
          limitFree: FREE_LIMITS.pagesBuildsPerMonth,
          limitPaid: FREE_LIMITS.pagesBuildsPerMonth,
          period: monthPeriod,
          note: "按「本月部署次数」统计，含直接上传（wrangler pages deploy）",
          error: resources.errors.pagesProjects,
        }),
        stockItem({
          key: "pages.projects",
          label: "项目数",
          used: counts.pagesProjects,
          limitFree: FREE_LIMITS.pagesProjects,
          limitPaid: FREE_LIMITS.pagesProjects,
          error: resources.errors.pagesProjects,
        }),
      ],
    },
    {
      key: "kv",
      label: "Workers KV",
      description: paid
        ? "付费版按月计量：读 1000 万/月、写·删·列表各 100 万/月，超出分别按 $0.50 / $5.00 每百万计费，不会因为超额而失败。"
        : "免费版读、写、删、列表四项各有每日上限，任意一项超额，该类操作直接失败。",
      items: [
        flowItem({
          key: "kv.reads",
          label: paid ? "本月键读取" : "今日键读取",
          today: errors.kvOps ? null : sumByAction(data.kvOps, { date: today, actions: ["read"] }),
          mtd: errors.kvOps ? null : sumByAction(data.kvOps, { since: monthStart, actions: ["read"] }),
          limitFreePerDay: FREE_LIMITS.kvReadsPerDay,
          limitPaidPerMonth: PAID_LIMITS.kvReadsPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.kvReads },
          overageNote: "月含 1000 万次，超出后 $0.50 / 百万次",
          paidNote: "升级后：每月含 1000 万次读",
          history: tailDays(kvReadSeries, HISTORY_DAYS),
          error: errors.kvOps,
        }),
        flowItem({
          key: "kv.writes",
          label: paid ? "本月键写入" : "今日键写入",
          today: errors.kvOps ? null : sumByAction(data.kvOps, { date: today, actions: ["write"] }),
          mtd: errors.kvOps ? null : sumByAction(data.kvOps, { since: monthStart, actions: ["write"] }),
          limitFreePerDay: FREE_LIMITS.kvWritesPerDay,
          limitPaidPerMonth: PAID_LIMITS.kvWritesPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.kvOps },
          overageNote: "月含 100 万次，超出后 $5.00 / 百万次",
          paidNote: "升级后：每月含 100 万次写",
          history: tailDays(kvWriteSeries, HISTORY_DAYS),
          error: errors.kvOps,
        }),
        flowItem({
          key: "kv.deletes",
          label: paid ? "本月键删除" : "今日键删除",
          today: errors.kvOps ? null : sumByAction(data.kvOps, { date: today, actions: ["delete"] }),
          mtd: errors.kvOps
            ? null
            : sumByAction(data.kvOps, { since: monthStart, actions: ["delete"] }),
          limitFreePerDay: FREE_LIMITS.kvDeletesPerDay,
          limitPaidPerMonth: PAID_LIMITS.kvDeletesPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.kvOps },
          overageNote: "月含 100 万次，超出后 $5.00 / 百万次",
          paidNote: "升级后：每月含 100 万次删除",
          history: tailDays(kvDeleteSeries, HISTORY_DAYS),
          error: errors.kvOps,
        }),
        flowItem({
          key: "kv.lists",
          label: paid ? "本月列表请求" : "今日列表请求",
          today: errors.kvOps ? null : sumByAction(data.kvOps, { date: today, actions: ["list"] }),
          mtd: errors.kvOps ? null : sumByAction(data.kvOps, { since: monthStart, actions: ["list"] }),
          limitFreePerDay: FREE_LIMITS.kvListsPerDay,
          limitPaidPerMonth: PAID_LIMITS.kvListsPerMonth,
          rate: { per: 1_000_000, usd: PAID_RATES.kvOps },
          overageNote: "月含 100 万次，超出后 $5.00 / 百万次",
          paidNote: "升级后：每月含 100 万次列表",
          history: tailDays(kvListSeries, HISTORY_DAYS),
          error: errors.kvOps,
        }),
        stockItem({
          key: "kv.storage",
          label: "存储",
          unit: "bytes",
          used: kvBytes,
          limitFree: FREE_LIMITS.kvStorageBytes,
          limitPaid: PAID_LIMITS.kvStorageBytes,
          rate: { per: GIB, usd: PAID_RATES.kvStorage },
          overageNote: "含 1 GB，超出后 $0.50 / GB-月",
          paidNote: "升级后：仍是 1 GB 含，超出只计费",
          error: errors.kvStorage,
        }),
      ],
    },
    {
      key: "ai",
      label: "Workers AI",
      description:
        "免费分配每天 10,000 neurons，两份套餐相同；超出后按 $0.011 / 千 neurons 计费。本站目前没有使用 Workers AI。",
      items: [
        // ⚠️ 这一项**不能**走 flowItem：Workers AI 的免费分配是**按天**的 10,000 neurons，
        // 付费版并没有把它改成「月含量」。走 flowItem 会拿「本月至今」去比一个日上限，
        // 数字看着没问题（本站用量为 0）但口径是错的 —— 一旦真用起来会误导。
        (() => {
          const usedToday = errors.aiNeurons
            ? null
            : valueOnDate(data.aiNeurons, "totalNeurons", today)
          const cost =
            paid && usedToday != null
              ? overCost(usedToday, FREE_LIMITS.aiNeuronsPerDay, 1000, 0.011)
              : 0
          return {
            key: "ai.neurons",
            label: "今日 Neurons",
            unit: "times" as const,
            used: usedToday,
            limit: FREE_LIMITS.aiNeuronsPerDay,
            scope: "day" as const,
            limitKind: paid ? ("included" as const) : ("hard" as const),
            period: dayPeriod,
            history: tailDays(aiSeries, HISTORY_DAYS),
            error: errors.aiNeurons,
            costUsd: cost > 0 ? cost : undefined,
            overageNote: "每天免费 10,000 neurons，超出后 $0.011 / 千 neurons",
            note: "按天的免费分配，两份套餐相同；本站目前没有使用 Workers AI",
          }
        })(),
      ],
    },
  ]

  // ---- 图形化概览：占用率最高的几项 ----
  const allItems = groups.flatMap((g) => g.items)
  const highlights: QuotaHighlight[] = allItems
    .filter(
      (i): i is QuotaItem & { used: number; limit: number; limitKind: "hard" | "included" } =>
        i.used != null && i.limit != null && i.limit > 0 && (i.limitKind === "hard" || i.limitKind === "included")
    )
    .map((i) => ({
      key: i.key,
      label: i.label,
      used: i.used,
      limit: i.limit,
      percent: (i.used / i.limit) * 100,
      unit: i.unit,
      limitKind: i.limitKind,
      costUsd: i.costUsd ?? 0,
    }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 6)

  // ---- 费用估算（只有付费版会真的产生账单）----
  // ⚠️ 这是**估算**：CF 对用量按计费单位向上取整（1.1 GB-月 按 2 GB-月 算），
  // 且 CPU 时间、日志写入等未采集的计量项不在这里。真实账单以 CF 后台为准。
  const costBreakdown: { label: string; detail: string; usd: number }[] = []
  let estimatedCostUsd: number | null = null
  if (paid) {
    costBreakdown.push({
      label: "Workers Paid 订阅",
      detail: "账户月度最低消费，已含 1000 万请求 + 3000 万 CPU 毫秒",
      usd: PAID_RATES.subscription,
    })
    for (const i of allItems) {
      if ((i.costUsd ?? 0) > 0) {
        costBreakdown.push({
          label: `${i.label} 超额`,
          detail: i.overageNote ?? "",
          usd: i.costUsd as number,
        })
      }
    }
    estimatedCostUsd = costBreakdown.reduce((s, x) => s + x.usd, 0)
  }

  return {
    generatedAt: new Date().toISOString(),
    accountId,
    plan: planInfo.plan,
    planSource: planInfo.source,
    planSetting: (await getSetting(env, "cf_plan")).trim().toLowerCase() || "auto",
    planNote: planInfo.note,
    estimatedCostUsd,
    costBreakdown,
    highlights,
    groups,
    warnings,
  }
}

/** 上一次成功汇总的缓存（进程内，60 秒） */
let cache: { at: number; value: CfQuotaOverview } | null = null

/**
 * GET /api/admin/cloudflare/quota —— Cloudflare 额度总览（仅管理员）。
 * 额度数字按 `cf_plan` 设置选免费版/付费版口径（auto 时自动判定，见 detectPlan）。
 * `?fresh=1` 绕过 60 秒缓存。
 */
export async function getCloudflareQuota(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  if (user.role !== "admin" && user.role !== "root") {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  const accountId = env.ACCOUNT_ID
  if (!accountId) {
    throw new ApiError(500, "未配置 ACCOUNT_ID（Worker 变量）", "CF_NOT_CONFIGURED")
  }

  const fresh = new URL(request.url).searchParams.get("fresh") === "1"
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) {
    return json(cache.value)
  }

  const value = await collectQuota(env, accountId)
  cache = { at: Date.now(), value }
  return json(value)
}
