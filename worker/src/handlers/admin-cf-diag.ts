/**
 * 只读排障：把某个 zone 在 Cloudflare 上「会影响访问结果」的东西一次性拉出来。
 *
 * 起因（2026-11-02）：站长把 `7u.nz` 顶点拿去做博客，但访问时被 301 到
 * `https://cloud.doulor.cn/`。平台侧代码里没有任何「301 到主站」的逻辑
 * （见 index.ts 的 host 判断段），所以问题只能出在 CF 上的：
 *   · Worker Routes（`7u.nz/*` 被谁接走了）
 *   · 动态重定向 Ruleset（http_request_dynamic_redirect）
 *   · DN​S 记录（顶点是不是被换成了 AAAA 100:: 占位）
 *   · 邮件路由设置（顺手一起看）
 *
 * 本接口**只读**，不改任何东西；每一项单独 try/catch，缺权限时把 CF 的原始
 * 错误带回来，方便判断是「没配」还是「Token 权限不够」。
 */
import type { Env } from "../env"
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { callCloudflare } from "../cloudflare"

type CfAttempt = { path: string; ok: boolean; data?: unknown; error?: string }

async function attempt(env: Env, path: string): Promise<CfAttempt> {
  try {
    const res = await callCloudflare(env, path)
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* 非 JSON 就原样带回去 */
    }
    return { path, ok: true, data: parsed }
  } catch (err) {
    return { path, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** GET /api/admin/cf/diag?zone=7u.nz —— 只读诊断 */
export async function cfZoneDiag(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "reserved")
  const url = new URL(request.url)
  const name = (url.searchParams.get("zone") ?? "").trim().toLowerCase()
  if (!name) throw new ApiError(400, "缺少 zone 参数", "INVALID_INPUT")

  const zones = await attempt(env, `/zones?name=${encodeURIComponent(name)}&per_page=1`)
  const zoneList = (zones.data as { result?: { id?: string; name?: string; status?: string }[] } | undefined)?.result ?? []
  const zoneId = zoneList[0]?.id ?? ""
  if (!zoneId) {
    return json({ zone: name, zoneLookup: zones, note: "未拿到 zone id" })
  }

  const [dns, routes, dynRedirect, rulesets, emailRouting] = await Promise.all([
    attempt(env, `/zones/${zoneId}/dns_records?per_page=100`),
    attempt(env, `/zones/${zoneId}/workers/routes`),
    attempt(
      env,
      `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`
    ),
    attempt(env, `/zones/${zoneId}/rulesets?per_page=20`),
    attempt(env, `/zones/${zoneId}/email/routing`),
  ])

  return json({
    zone: name,
    zoneId,
    zoneStatus: zoneList[0]?.status ?? null,
    dns,
    routes,
    dynamicRedirectRuleset: dynRedirect,
    rulesets,
    emailRouting,
  })
}


/**
 * POST /api/admin/cf/worker-route —— 把某个 Route 改指到另一个 Worker 脚本。
 *
 * 用途（2026-11-02）：`7u.nz` 顶点被平台自己的 `doulor-mail` Route 接走了，
 * 站长要用同一个 zone 的 `worldlet` Worker 做博客。Route 的 script 只能按
 * route id 改，这里按 pattern 找到 route 再 PUT。
 *
 * body: { zone?: string, zoneId?: string, pattern: string, script: string }
 */
export async function cfRetargetRoute(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "reserved")
  const body = (await request.json()) as {
    zone?: string
    zoneId?: string
    pattern?: string
    script?: string
  }
  const pattern = String(body.pattern ?? "").trim().toLowerCase()
  const script = String(body.script ?? "").trim()
  if (!pattern || !script) throw new ApiError(400, "缺少 pattern 或 script", "INVALID_INPUT")

  let zoneId = String(body.zoneId ?? "").trim()
  if (!zoneId) {
    const zoneName = String(body.zone ?? "").trim().toLowerCase()
    if (!zoneName) throw new ApiError(400, "缺少 zone 或 zoneId", "INVALID_INPUT")
    const zones = await attempt(env, `/zones?name=${encodeURIComponent(zoneName)}&per_page=1`)
    zoneId =
      (zones.data as { result?: { id?: string }[] } | undefined)?.result?.[0]?.id ?? ""
    if (!zoneId) throw new ApiError(404, `找不到 zone ${zoneName}`, "ZONE_NOT_FOUND")
  }

  const list = await attempt(env, `/zones/${zoneId}/workers/routes`)
  const routes =
    (list.data as { result?: { id?: string; pattern?: string; script?: string }[] } | undefined)
      ?.result ?? []
  const target = routes.find((r) => (r.pattern ?? "").toLowerCase() === pattern)
  const before = target ? `${target.pattern} → ${target.script}` : "(不存在)"

  if (!target?.id) {
    // 没有这条 Route 就新建一条
    const res = await callCloudflare(env, `/zones/${zoneId}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern, script }),
    })
    return json({ ok: true, created: true, before, after: `${pattern} → ${script}`, raw: await res.json().catch(() => null) })
  }

  const res = await callCloudflare(env, `/zones/${zoneId}/workers/routes/${target.id}`, {
    method: "PUT",
    body: JSON.stringify({ pattern, script }),
  })
  return json({
    ok: true,
    created: false,
    routeId: target.id,
    before,
    after: `${pattern} → ${script}`,
    raw: await res.json().catch(() => null),
  })
}


/**
 * POST /api/admin/cf/dns-record —— 单个 DNS 记录的增/改/删（运维用）。
 *
 * 之所以要它：Worker Route 要生效，hostname 上必须有**橙云**记录（平台惯例是
 * `AAAA 100::` 占位）；而把老博客从 `blog.doulor.cn` 挪到 `oldblog.doulor.cn`
 * 也需要建一条 CNAME。这些原本只能在 CF 面板点，线上排障时太慢。
 *
 * body:
 *   { zone, action: "create"|"delete", id?: string,
 *     type?: "AAAA"|"CNAME"|"A"|"TXT", name?: string, content?: string, proxied?: boolean }
 */
export async function cfDnsRecord(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "reserved")
  const body = (await request.json()) as {
    zone?: string
    action?: string
    id?: string
    type?: string
    name?: string
    content?: string
    proxied?: boolean
  }
  const zoneName = String(body.zone ?? "").trim().toLowerCase()
  const action = String(body.action ?? "").trim()
  if (!zoneName) throw new ApiError(400, "缺少 zone", "INVALID_INPUT")

  const zones = await attempt(env, `/zones?name=${encodeURIComponent(zoneName)}&per_page=1`)
  const zoneId = (zones.data as { result?: { id?: string }[] } | undefined)?.result?.[0]?.id ?? ""
  if (!zoneId) throw new ApiError(404, `找不到 zone ${zoneName}`, "ZONE_NOT_FOUND")

  if (action === "delete") {
    const id = String(body.id ?? "").trim()
    if (!id) throw new ApiError(400, "缺少记录 id", "INVALID_INPUT")
    const res = await callCloudflare(env, `/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" })
    return json({ ok: true, action: "delete", id, raw: await res.json().catch(() => null) })
  }

  if (action !== "create") throw new ApiError(400, "action 只能是 create / delete", "INVALID_INPUT")
  const type = String(body.type ?? "").trim().toUpperCase()
  const name = String(body.name ?? "").trim().toLowerCase()
  const content = String(body.content ?? "").trim()
  if (!type || !name || !content) throw new ApiError(400, "缺少 type / name / content", "INVALID_INPUT")
  const payload: Record<string, unknown> = { type, name, content, ttl: 1 }
  if (type === "A" || type === "AAAA" || type === "CNAME") payload.proxied = body.proxied !== false

  const res = await callCloudflare(env, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  return json({ ok: true, action: "create", sent: payload, raw: await res.json().catch(() => null) })
}


/**
 * POST /api/admin/cf/pages-domain —— 给 Pages 项目加一个自定义域名。
 *
 * 用途（2026-11-03）：老博客是 Pages 项目 `blog-ez9`，要把 `blog.doulor.cn`
 * 让给 worldlet Worker，老博客改挂 `oldblog.doulor.cn`，就得在 Pages 侧把新域名
 * 加上（只建 DNS CNAME 不够，Pages 只认自己项目里的域名列表）。
 *
 * body: { project: string, domain: string }
 */
export async function cfPagesDomain(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "reserved")
  const body = (await request.json()) as { project?: string; domain?: string }
  const project = String(body.project ?? "").trim()
  const domain = String(body.domain ?? "").trim().toLowerCase()
  if (!project || !domain) throw new ApiError(400, "缺少 project 或 domain", "INVALID_INPUT")
  const accountId = env.ACCOUNT_ID ?? ""
  if (!accountId) throw new ApiError(500, "缺少 ACCOUNT_ID", "CONFIG")
  const res = await callCloudflare(
    env,
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains`,
    { method: "POST", body: JSON.stringify({ name: domain }) }
  )
  return json({ ok: true, project, domain, raw: await res.json().catch(() => null) })
}
