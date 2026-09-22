/**
 * 自定义域名的共享工具：把某个子域名指向本 Worker。
 *
 * 网盘直链与个人名片都需要「让 <fqdn> 由本 Worker 处理」，
 * 因此把 DNS 占位记录 + Worker Route 的逻辑抽到这里，
 * 避免两处各写一份、行为漂移。
 *
 * 关键坑（务必保留）：doulor.cn 没有泛解析。只建 Worker Route 是**不够的** ——
 * Route 只决定「请求到达 Cloudflare 后转给谁」，不会让域名被解析到 Cloudflare。
 * 缺 DNS 记录时浏览器直接连接失败，但绑定时界面却显示成功，极难排查。
 */
import { ApiError } from "./http"
import {
  cfCreateDnsRecord,
  cfDeleteDnsRecord,
  cfListDnsRecords,
} from "./cloudflare"
import type { Env } from "./env"

async function cfWorkersApi(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!env.CF_WORKERS_TOKEN) {
    throw new ApiError(
      503,
      "未配置 Cloudflare Workers 权限，无法绑定自定义域名",
      "CF_NOT_CONFIGURED"
    )
  }
  return fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CF_WORKERS_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

async function listWorkerRoutes(
  env: Env
): Promise<{ id: string; pattern: string; script?: string }[]> {
  const res = await cfWorkersApi(env, `/zones/${env.ZONE_ID}/workers/routes`)
  const data = (await res.json()) as {
    result?: { id: string; pattern: string; script?: string }[]
  }
  return data.result ?? []
}

/**
 * 把 fqdn 绑定到本 Worker：建 DNS 占位记录（若不存在）+ 建 Worker Route。
 * @returns dnsCreated 是否新建了 DNS（用于前端提示「稍候 1-2 分钟生效」）
 */
export async function attachCustomDomain(
  env: Env,
  fqdn: string
): Promise<{ dnsCreated: boolean }> {
  // 1. DNS：AAAA 100:: + 橙云代理（与平台上其它 Worker 路由域名一致）
  //    已有解析则跳过，不覆盖用户既有配置
  const existing = await cfListDnsRecords(env, env.ZONE_ID, fqdn)
  const dnsCreated = existing.length === 0
  if (dnsCreated) {
    try {
      await cfCreateDnsRecord(env, env.ZONE_ID, {
        type: "AAAA",
        name: fqdn,
        content: "100::",
        ttl: 1,
        proxied: true,
      })
    } catch (err) {
      console.error("自定义域名 DNS 记录创建失败:", fqdn, err)
      throw new ApiError(502, "无法为该子域名创建 DNS 解析记录", "CF_ERROR")
    }
  }

  // 2. Worker Route
  const script = env.WORKER_NAME ?? "doulor-mail-api"
  const pattern = `${fqdn}/*`
  const found = (await listWorkerRoutes(env)).find(
    (r) => r.pattern.toLowerCase() === pattern.toLowerCase()
  )
  if (found) return { dnsCreated }

  const res = await cfWorkersApi(env, `/zones/${env.ZONE_ID}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern, script }),
  })
  const data = (await res.json()) as {
    result?: { id?: string }
    errors?: { message: string }[]
    success?: boolean
  }
  if (!data.success || !data.result?.id) {
    // 回滚刚建的 DNS，避免留下解析不到内容的空域名
    if (dnsCreated) {
      try {
        const created = await cfListDnsRecords(env, env.ZONE_ID, fqdn)
        for (const r of created) await cfDeleteDnsRecord(env, env.ZONE_ID, r.id)
      } catch (cleanupErr) {
        console.error("回滚 DNS 记录失败:", fqdn, cleanupErr)
      }
    }
    throw new ApiError(
      502,
      data.errors?.[0]?.message ?? "创建 Worker Route 失败",
      "CF_ERROR"
    )
  }
  return { dnsCreated }
}

/** 解绑自定义域名：移除 Route 与绑定期间自动创建的 DNS 记录 */
export async function detachCustomDomain(env: Env, fqdn: string): Promise<void> {
  const pattern = `${fqdn}/*`
  try {
    const found = (await listWorkerRoutes(env)).find(
      (r) => r.pattern.toLowerCase() === pattern.toLowerCase()
    )
    if (found) {
      await cfWorkersApi(
        env,
        `/zones/${env.ZONE_ID}/workers/routes/${found.id}`,
        { method: "DELETE" }
      )
    }
  } catch (err) {
    console.error("移除 Worker Route 失败:", fqdn, err)
  }

  // 清掉占位 DNS，否则该域名会一直解析到本站，且冲突检测会认为仍被占用
  try {
    const records = await cfListDnsRecords(env, env.ZONE_ID, fqdn)
    for (const r of records) await cfDeleteDnsRecord(env, env.ZONE_ID, r.id)
  } catch (err) {
    console.error("移除自定义域名 DNS 记录失败:", fqdn, err)
  }
}