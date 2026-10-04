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
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireAdminScope } from "./admin"
import { audit as recordAudit } from "../settings"
import { callCloudflare } from "../cloudflare"
import {
  listRootDomains,
  resetRootDomainCache,
  resolveZoneId,
  getRootDomainByName,
} from "../root-domains"
import { FEATURES, FEATURE_LABELS } from "../permissions"
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
    `${existing ? "更新" : "新增"}根域 ${name}${wantDefault ? "（设为默认）" : ""}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, name, zoneId, isDefault: wantDefault })
}

/**
 * POST /api/admin/root-domains/action —— 一次性动作。
 *
 * body: { name, action }
 *   resolve-zone  解析并回填 zone id
 *   enable-email  开通 Email Routing（建 MX/TXT）
 *   set-catchall  把 catch-all 指向本 Worker（建了才算「能收信」）
 *   set-default   设为默认域
 *   delete        删除（默认域不可删）
 *
 * 刻意做成一个动作一个请求：每一步都可能因为 CF 侧的前置条件失败，
 * 分开才能一眼看出卡在哪一步。
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
      const status = await emailRoutingStatus(env, zoneId)
      await recordAudit(
        env,
        admin.id,
        "admin.rootdomain.enableEmail",
        `开通 ${name} 的 Email Routing（${attempts.join(" / ")}）`,
        request.headers.get("CF-Connecting-IP")
      )
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
      if (row.is_default === 1) {
        throw new ApiError(400, "默认域不可删除，请先指定别的默认域", "IS_DEFAULT")
      }
      const used = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM domains WHERE name LIKE ? "
      )
        .bind(`%.${name}`)
        .first<{ c: number }>()
      if ((used?.c ?? 0) > 0) {
        throw new ApiError(
          400,
          `还有 ${used?.c} 个域名挂在该根域下，先处理完再删`,
          "IN_USE"
        )
      }
      await env.DB.prepare("DELETE FROM root_domains WHERE name = ?").bind(name).run()
      resetRootDomainCache()
      await recordAudit(
        env,
        admin.id,
        "admin.rootdomain.delete",
        `删除根域 ${name}`,
        request.headers.get("CF-Connecting-IP")
      )
      return json({ ok: true })
    }

    default:
      throw new ApiError(400, "未知操作", "INVALID_INPUT")
  }
}
