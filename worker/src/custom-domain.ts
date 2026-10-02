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
  resolveApiToken,
} from "./cloudflare"
import { fetchWithTimeout } from "./async-utils"
import { zoneIdForFqdn } from "./root-domains"
import type { Env } from "./env"

/** 绑定自定义域名的 CF API 超时（2026-09-25 审计 H15） */
const CF_WORKERS_API_TIMEOUT_MS = 15_000

async function cfWorkersApi(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  // 与 DNS 记录 / 邮件路由**共用同一个令牌**（见 cloudflare.ts 的 resolveApiToken）。
  // 该令牌含 workers_routes + dns 权限，绑定自定义域名够用；
  // 单独维护一个 CF_WORKERS_TOKEN 的结果就是「一个失效、功能半瘫」（2026-10-01 踩到）。
  let token: string
  try {
    token = await resolveApiToken(env)
  } catch {
    throw new ApiError(
      503,
      "未配置 Cloudflare API Token，无法绑定自定义域名",
      "CF_NOT_CONFIGURED"
    )
  }
  return fetchWithTimeout(
    `https://api.cloudflare.com/client/v4${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    CF_WORKERS_API_TIMEOUT_MS
  )
}

async function listWorkerRoutes(
  env: Env,
  zoneId: string
): Promise<{ id: string; pattern: string; script?: string }[]> {
  const res = await cfWorkersApi(env, `/zones/${zoneId}/workers/routes`)
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
  // ⚠️ zone 必须按 fqdn 解析，不能写死 env.ZONE_ID：
  //    用户的子域名建在哪个根域下（tyu.me / doulor.cn）就要写到哪个 zone，
  //    写死会把记录建到 doulor.cn 上 —— 域名解析不出来，且是静默错误。
  const zoneId = await zoneIdForFqdn(env, fqdn)

  // 1. DNS：AAAA 100:: + 橙云代理（与平台上其它 Worker 路由域名一致）
  //    已有解析则跳过，不覆盖用户既有配置
  const existing = await cfListDnsRecords(env, zoneId, fqdn)
  const dnsCreated = existing.length === 0
  if (dnsCreated) {
    try {
      await cfCreateDnsRecord(env, zoneId, {
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
  const found = (await listWorkerRoutes(env, zoneId)).find(
    (r) => r.pattern.toLowerCase() === pattern.toLowerCase()
  )
  if (found) return { dnsCreated }

  const res = await cfWorkersApi(env, `/zones/${zoneId}/workers/routes`, {
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
        const created = await cfListDnsRecords(env, zoneId, fqdn)
        for (const r of created) await cfDeleteDnsRecord(env, zoneId, r.id)
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

/**
 * 判断一条 DNS 记录是不是**我们自己**创建的占位解析。
 *
 * 本站绑定自定义域名时统一建 `AAAA 100::`（橙云代理）作为占位
 * （见 `attachCustomDomain` 与 `handlers/storage.ts` 的绑定分支）。
 *
 * ⚠️ 为什么必须区分「我们的」和「用户的」（2026-09-25 审计 M14b）：
 *   解绑逻辑原先把该名字下的**所有**记录全删掉。但用户完全可能为同一个子域名
 *   配了 MX / TXT（邮件收信）等记录 —— 解绑一个网盘直链或名片，代价却是
 *   把这个子域名的邮件能力抹掉。那些记录是用户的资产，不该由解绑动作处置。
 *   所以清理时只删这个谓词认得的记录，其余一律保留。
 */
export function isPlaceholderDnsRecord(record: {
  type: string
  content: string
}): boolean {
  return record.type === "AAAA" && record.content === "100::"
}

/** 解绑自定义域名：移除 Route 与绑定期间自动创建的 DNS 记录 */
export async function detachCustomDomain(env: Env, fqdn: string): Promise<void> {
  const pattern = `${fqdn}/*`
  // zone 按 fqdn 解析（用户域名可能在 tyu.me 上，写死主 zone 会删错地方）
  let zoneId: string
  try {
    zoneId = await zoneIdForFqdn(env, fqdn)
  } catch (err) {
    // 解析不出 zone ⇒ 这个域名本来就没挂在我们这，没有要清理的东西
    console.error("解绑时无法解析 zone:", fqdn, err)
    return
  }
  try {
    const found = (await listWorkerRoutes(env, zoneId)).find(
      (r) => r.pattern.toLowerCase() === pattern.toLowerCase()
    )
    if (found) {
      await cfWorkersApi(
        env,
        `/zones/${zoneId}/workers/routes/${found.id}`,
        { method: "DELETE" }
      )
    }
  } catch (err) {
    console.error("移除 Worker Route 失败:", fqdn, err)
  }

  // 清掉**占位** DNS，否则该域名会一直解析到本站，且冲突检测会认为仍被占用。
  // 只删我们自己建的 AAAA 100::，用户自建的记录（含 MX/TXT）保留 —— 见 M14b。
  try {
    const records = await cfListDnsRecords(env, zoneId, fqdn)
    for (const r of records) {
      if (!isPlaceholderDnsRecord(r)) continue
      await cfDeleteDnsRecord(env, zoneId, r.id)
    }
  } catch (err) {
    console.error("移除自定义域名 DNS 记录失败:", fqdn, err)
  }
}