import { ApiError } from "./http"
import { fetchWithTimeout } from "./async-utils"
import type { Env } from "./env"

/**
 * 调用 Cloudflare 管理 API 的超时（2026-09-25 审计 H15）。
 * 15 秒：CF 控制面偶尔慢，但绝不该慢到把 Worker 请求挂住。
 */
const CF_API_TIMEOUT_MS = 15_000

/**
 * 调用 Cloudflare API。
 * Token 与 Zone ID 仅存在于 Worker 端，绝不暴露给前端。
 *
 * Token 解析顺序：
 *   1. 绑定 Secret `CLOUDFLARE_API_TOKEN_SECRET`（推荐）
 *   2. 普通环境变量 `CLOUDFLARE_API_TOKEN`
 *   3. KV 兜底 `CF_TOKEN_KV` 的 key `token`（跨 Worker 共享）
 */
async function resolveApiToken(env: Env): Promise<string> {
  if (env.CLOUDFLARE_API_TOKEN_SECRET) return env.CLOUDFLARE_API_TOKEN_SECRET
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN
  throw new ApiError(500, "未配置 Cloudflare API Token", "CF_NOT_CONFIGURED")
}

/**
 * 导出给**其它**需要直接打 CF API 的模块用（自定义域名绑定等）。
 *
 * 2026-10-01 起全站只认这一份令牌：以前「绑定自定义域名」单独读 `CF_WORKERS_TOKEN`，
 * 那个令牌一旦失效，绑定功能整个挂掉（报 Cloudflare 的 Authentication error），
 * 而同期 DNS 记录、邮件路由都还正常 —— 因为它们读的是 CLOUDFLARE_API_TOKEN_SECRET。
 * 同一个 CF 账号维护两套凭证，出问题必然对不上号。
 */
export { resolveApiToken }

/** 有没有可用的 CF Token（给「功能是否可用」的布尔判断用，不抛错） */
export function hasCfApiToken(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN_SECRET || env.CLOUDFLARE_API_TOKEN)
}

export async function callCloudflare(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await resolveApiToken(env)
  const url = `https://api.cloudflare.com/client/v4${path}`
  // 带超时（2026-09-25 审计 H15）：CF API 卡住时不能把 Worker 请求一起挂死
  const res = await fetchWithTimeout(
    url,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    CF_API_TIMEOUT_MS
  )

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    throw new ApiError(502, `Cloudflare API 调用失败: ${res.status} ${body}`, "CF_ERROR")
  }
  return res
}

/**
 * Cloudflare DNS 记录的写入载荷。
 *
 * 为什么 `content` 是可选的：SRV 记录**必须**用 `data` 对象传
 * （CF 文档的 SRV 示例里只有 data，没有 content），其余类型用 content。
 * 传错形态 CF 会报参数错误，所以调用方要按类型二选一。
 */
export interface CfDnsRecordPayload {
  type: string
  name: string
  /** A/AAAA/CNAME/TXT/MX 用；SRV 不用（改用 data） */
  content?: string
  ttl: number
  proxied: boolean
  /** MX 与 SRV 共用：值小者优先 */
  priority?: number
  /**
   * SRV 专有字段。
   *
   * 按 CF 官方示例，`service` / `proto` **不放在这里** —— 它们已经体现在
   * 顶层 `name` 里（形如 `_sip._tcp.example.com`），data 只放这四个。
   */
  data?: {
    priority: number
    weight: number
    port: number
    target: string
  }
}

export async function cfCreateDnsRecord(
  env: Env,
  zoneId: string,
  payload: CfDnsRecordPayload
): Promise<{ id: string }> {
  const res = await callCloudflare(env, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    result?: { id?: string }
    errors?: { message: string }[]
  }
  if (!data.result?.id) {
    throw new ApiError(
      502,
      data.errors?.[0]?.message ?? "创建 Cloudflare DNS 记录失败",
      "CF_ERROR"
    )
  }
  return { id: data.result.id }
}

export async function cfUpdateDnsRecord(
  env: Env,
  zoneId: string,
  cfId: string,
  payload: CfDnsRecordPayload
): Promise<void> {
  await callCloudflare(env, `/zones/${zoneId}/dns_records/${cfId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  })
}

export async function cfDeleteDnsRecord(
  env: Env,
  zoneId: string,
  cfId: string
): Promise<void> {
  await callCloudflare(env, `/zones/${zoneId}/dns_records/${cfId}`, {
    method: "DELETE",
  })
}

/**
 * 查询 zone 上某 fqdn 的现有记录（用于分配子域名前的占位冲突检测）。
 */
export async function cfListDnsRecords(
  env: Env,
  zoneId: string,
  fqdn: string
): Promise<{ id: string; type: string; content: string }[]> {
  const res = await callCloudflare(
    env,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(fqdn)}&per_page=20`,
    { method: "GET" }
  )
  const data = (await res.json()) as {
    result?: { id: string; type: string; content: string }[]
    errors?: { message: string }[]
  }
  if (!data.result) {
    throw new ApiError(
      502,
      data.errors?.[0]?.message ?? "查询 DNS 记录失败",
      "CF_ERROR"
    )
  }
  return data.result
}

/**
 * 删除一条 Email Routing 规则。
 *
 * ⚠️ 2026-09-26：这里**只保留删除，没有对应的创建函数**了 ——
 * 线上 catch-all 已改为「Send to a Worker」，所有 *@doulor.cn 的信都会进本 Worker
 * （由代码查 mailboxes 表决定去处），因此不再逐地址建规则（那是「每域 200 条」的硬配额）。
 * 保留删除是为了摘掉**历史遗留**的规则（线上尚存数十条），以及删号时的资源回收。
 */
export async function cfDeleteEmailRule(
  env: Env,
  zoneId: string,
  ruleId: string
): Promise<void> {
  await callCloudflare(env, `/zones/${zoneId}/email/routing/rules/${ruleId}`, {
    method: "DELETE",
  })
}

// ---- Email Routing destination addresses（转发目标必须先验证） ----

export interface CfDestination {
  id: string
  email: string
  verified: string | null // ISO 时间；null = 待验证
}

export async function cfListDestinations(env: Env): Promise<CfDestination[]> {
  // 分页拉全：destination 是账户级的，线上已超过 200 条。若只拉一页，
  // 老地址（创建早、排在后面）会被截断，其 verified 状态就「消失」，
  // 导致已验证的转发邮箱被误报成「待验证」（2026-09-27 实测踩到）。
  // ⚠️ per_page 最大 50（CF 文档明确），超过会被拒或截断。
  const all: CfDestination[] = []
  let page = 1
  for (;;) {
    const res = await callCloudflare(
      env,
      `/accounts/${await resolveAccountId(env)}/email/routing/addresses?per_page=50&page=${page}`,
      { method: "GET" }
    )
    const data = (await res.json()) as {
      result?: CfDestination[]
      result_info?: { total_pages?: number }
      errors?: { message: string }[]
    }
    if (!data.result) {
      throw new ApiError(
        502,
        data.errors?.[0]?.message ?? "获取转发地址失败",
        "CF_ERROR"
      )
    }
    all.push(...data.result)
    const totalPages = data.result_info?.total_pages ?? 1
    if (data.result.length === 0 || page >= totalPages) break
    page++
  }
  return all
}

/**
 * 删除一个转发目标地址。
 *
 * 为什么需要它（2026-09-25 审计 M10）：
 *   Cloudflare 的 destination 是**账户级**的，`verified` 也只属于账户而不属于某个用户。
 *   本站曾把这个全局 `verified` 直接当成用户级邮箱验证状态，于是：
 *     用户 A 验证过 a@x.com → A 改成 a2@x.com（**旧地址仍留在账户里且仍是 verified**）
 *     → 攻击者 B 用 a@x.com 注册 → 被判定 email_verified = 1，
 *     而 B **从未**能读取那个邮箱（该标志会经 OAuth /userinfo 暴露、也是 FRP 准入条件）。
 *
 *   2026-10-04 起，所有邮箱验证/换绑都改为「用户专属验证码」，不再读 CF 状态，
 *   这条洞的判定路径已彻底移除。这里保留删除旧 destination，是为了：
 *   ① 释放「每账户 200 条」的硬配额；② 不留账户级残留，避免以后再有代码误用它。
 *
 * 失败不阻断：删不掉最多是保留一份残留，而阻断会让用户改不了邮箱。
 */
export async function cfDeleteDestination(env: Env, email: string): Promise<boolean> {
  const list = await cfListDestinations(env)
  const found = list.find((d) => d.email.toLowerCase() === email.toLowerCase())
  if (!found) return false
  await callCloudflare(
    env,
    `/accounts/${await resolveAccountId(env)}/email/routing/addresses/${found.id}`,
    { method: "DELETE" }
  )
  return true
}

async function resolveAccountId(env: Env): Promise<string> {
  if (env.ACCOUNT_ID) return env.ACCOUNT_ID
  throw new ApiError(500, "未配置 ACCOUNT_ID", "CF_NOT_CONFIGURED")
}
