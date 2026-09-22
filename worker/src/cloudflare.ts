import { ApiError } from "./http"
import type { Env } from "./env"

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

export async function callCloudflare(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await resolveApiToken(env)
  const url = `https://api.cloudflare.com/client/v4${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    throw new ApiError(502, `Cloudflare API 调用失败: ${res.status} ${body}`, "CF_ERROR")
  }
  return res
}

export async function cfCreateDnsRecord(
  env: Env,
  zoneId: string,
  payload: {
    type: string
    name: string
    content: string
    ttl: number
    proxied: boolean
    priority?: number
  }
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
  payload: {
    type: string
    name: string
    content: string
    ttl: number
    proxied: boolean
    priority?: number
  }
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
 * Email Routing 规则（入站邮件 → Window Worker）。
 * 创建后该地址（如 test@doulor.cn）的入站邮件会调用本 Worker 的 email() 处理器。
 */
export async function cfCreateEmailRule(
  env: Env,
  zoneId: string,
  address: string,
  workerName: string
): Promise<string> {
  const res = await callCloudflare(env, `/zones/${zoneId}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify({
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [workerName] }],
      enabled: true,
      name: `Doulor Cloud: ${address}`,
    }),
  })
  const data = (await res.json()) as {
    result?: { id?: string }
    errors?: { message: string }[]
  }
  if (!data.result?.id) {
    throw new ApiError(
      502,
      data.errors?.[0]?.message ?? "创建 Email Routing 规则失败",
      "CF_ERROR"
    )
  }
  return data.result.id
}

export async function cfDeleteEmailRule(
  env: Env,
  zoneId: string,
  ruleId: string
): Promise<void> {
  await callCloudflare(env, `/zones/${zoneId}/email/routing/rules/${ruleId}`, {
    method: "DELETE",
  })
}

export async function cfListEmailRules(
  env: Env,
  zoneId: string
): Promise<{ id: string; matchers: { value: string }[] }[]> {
  const res = await callCloudflare(env, `/zones/${zoneId}/email/routing/rules?per_page=100`, {
    method: "GET",
  })
  const data = (await res.json()) as {
    result?: { id: string; matchers: { value: string }[] }[]
    errors?: { message: string }[]
  }
  if (!data.result) {
    throw new ApiError(
      502,
      data.errors?.[0]?.message ?? "获取 Email Routing 规则失败",
      "CF_ERROR"
    )
  }
  return data.result
}

// ---- Email Routing destination addresses（转发目标必须先验证） ----

export interface CfDestination {
  id: string
  email: string
  verified: string | null // ISO 时间；null = 待验证
}

export async function cfListDestinations(env: Env): Promise<CfDestination[]> {
  const res = await callCloudflare(
    env,
    `/accounts/${await resolveAccountId(env)}/email/routing/addresses?per_page=200`,
    { method: "GET" }
  )
  const data = (await res.json()) as { result?: CfDestination[]; errors?: { message: string }[] }
  if (!data.result) {
    throw new ApiError(502, data.errors?.[0]?.message ?? "获取转发地址失败", "CF_ERROR")
  }
  return data.result
}

/**
 * 注册转发目标地址。若已存在则直接返回其状态。
 * 新地址 Cloudflare 会向该邮箱发送验证邮件，用户点击后 verified 才有值。
 */
export async function cfEnsureDestination(
  env: Env,
  email: string
): Promise<CfDestination> {
  const existing = await cfListDestinations(env).catch(() => [] as CfDestination[])
  const found = existing.find((d) => d.email.toLowerCase() === email.toLowerCase())
  if (found) return found

  const res = await callCloudflare(
    env,
    `/accounts/${await resolveAccountId(env)}/email/routing/addresses`,
    {
      method: "POST",
      body: JSON.stringify({ email }),
    }
  )
  const data = (await res.json()) as { result?: CfDestination; errors?: { message: string }[] }
  if (!data.result) {
    throw new ApiError(502, data.errors?.[0]?.message ?? "注册转发地址失败", "CF_ERROR")
  }
  return data.result
}

async function resolveAccountId(env: Env): Promise<string> {
  if (env.ACCOUNT_ID) return env.ACCOUNT_ID
  throw new ApiError(500, "未配置 ACCOUNT_ID", "CF_NOT_CONFIGURED")
}
