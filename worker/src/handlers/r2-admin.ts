/**
 * R2 多桶管理（管理员）。
 *
 * 背景：免费额度每账户 10 GB，单桶装不下太多用户。用多个 Cloudflare 账户的桶
 * （1 号桶 network 在 adoulor，2 号桶 network2 在 bdoulor）横向扩容。
 *
 * 凭据安全：
 *   - S3 Access Key / Secret 用 SESSION_SECRET 派生的 AES-GCM 加密后存 D1（r2_buckets）
 *   - 任何下发给前端的响应都**不含凭据**，只回是否已配置
 *   - 查看明文凭据需要管理员主动调用 reveal 接口（用于核对/迁移）
 *
 * 操作数（A/B 类）：
 *   靠 Cloudflare GraphQL Analytics API 获取，需要桶对应的 token 有
 *   Account → Account Analytics → Read 权限。未配置 token 时优雅降级为 null。
 */
import { ApiError, json } from "../http"
import { encryptSecret, uuid } from "../crypto"
import { requireAdmin } from "./admin"
import { audit as recordAudit } from "../settings"
import {
  deletePrefix,
  getBucketCredentials,
  invalidatePlatformBucketCache,
  isR2Configured,
  listBuckets,
  listObjects,
  putObject,
  type R2BucketRow,
} from "../r2"
import { fetchWithTimeout, mapLimit } from "../async-utils"
import type { Env } from "../env"

/** CF 管理 API 超时（2026-09-25 审计 H15） */
const CF_API_TIMEOUT_MS = 15_000

/**
 * 「读取 CF 账户列表并逐个列桶」的并发上限（2026-09-25 审计 M21）。
 * 4 个并发足够快，又不会触发 CF API 的速率限制。
 */
const R2_ACCOUNT_LIST_CONCURRENCY = 4

/** 免费额度基线（Cloudflare R2 免费层），用于计算占比 */
const FREE_TIER = {
  storageBytes: 10 * 1024 * 1024 * 1024, // 10 GB / month
  classAOps: 1_000_000, // A 类操作 1M / month
  classBOps: 10_000_000, // B 类操作 10M / month
} as const

/** 下发给前端的桶信息（不含任何凭据） */
function toPublicBucket(row: R2BucketRow, envHasAnalytics: boolean) {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    endpoint: row.endpoint,
    bucketName: row.bucket_name,
    maxUsers: row.max_users,
    quotaPerUser: row.quota_per_user,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    kind: row.kind,
    /** 桶级配置或全局环境变量任一存在即可读操作数 */
    hasAnalyticsToken: Boolean(row.analytics_token_enc) || envHasAnalytics,
    createdAt: row.created_at,
  }
}

/** 取 S3 凭据（供连通性测试用，不返回前端） */
async function credentialsOf(env: Env, id: string) {
  return getBucketCredentials(env, id)
}

/**
 * GET /api/admin/r2/buckets —— 桶列表 + 用量概览 + 各桶用户
 *
 * 一次性把管理面板需要的全部数据算好，减少前端往返：
 *   - 每个桶：容量上限（人数×每人配额）、已用、人数、免费额度占比
 *   - 每个桶下的用户：用户名 / 用量 / 配额
 *   - 未纳入多桶的老用户（bucket_id 为空）单独归入「默认桶」条目
 */
export async function listR2Buckets(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)

  const buckets = await listBuckets(env)

  // 各桶的实际用量与人数（按 storage_accounts 聚合）
  const agg = await env.DB.prepare(
    `SELECT bucket_id,
            COUNT(*) AS users,
            COALESCE(SUM(used_bytes), 0) AS used,
            COALESCE(SUM(quota_bytes), 0) AS quota,
            COALESCE(SUM(file_count), 0) AS files
       FROM storage_accounts
      GROUP BY bucket_id`
  ).all<{
    bucket_id: string | null
    users: number
    used: number
    quota: number
    files: number
  }>()
  const aggMap = new Map((agg.results ?? []).map((r) => [r.bucket_id ?? "", r]))

  // 每个桶的用户明细（一次查全，前端按桶分组）
  // role 一起带上：前端「同步存量用户配额」要预告「谁会被改」，而管理员是被跳过的
  const users = await env.DB.prepare(
    `SELECT sa.user_id, sa.prefix, sa.used_bytes, sa.quota_bytes, sa.file_count,
            sa.bucket_id, sa.enabled, u.username, u.role
       FROM storage_accounts sa
       JOIN users u ON u.id = sa.user_id
      ORDER BY sa.used_bytes DESC`
  ).all<{
    user_id: string
    prefix: string
    used_bytes: number
    quota_bytes: number
    file_count: number
    bucket_id: string | null
    enabled: number
    username: string
    role: string
  }>()

  const usersByBucket = new Map<string, typeof users.results>()
  for (const u of users.results ?? []) {
    const key = u.bucket_id ?? ""
    const list = usersByBucket.get(key) ?? []
    list.push(u)
    usersByBucket.set(key, list)
  }

  const items = buckets.map((b) => {
    const a = aggMap.get(b.id)
    const capacity = b.max_users * b.quota_per_user
    const used = a?.used ?? 0
    return {
      ...toPublicBucket(b, Boolean(env.R2_API_TOKEN)),
      stats: {
        users: a?.users ?? 0,
        usedBytes: used,
        /** 容量上限 = 人数上限 × 每人配额 */
        capacityBytes: capacity,
        fileCount: a?.files ?? 0,
        /** 该桶占免费额度的百分比 */
        storagePercent: FREE_TIER.storageBytes
          ? Math.min((used / FREE_TIER.storageBytes) * 100, 100)
          : 0,
      },
      users: (usersByBucket.get(b.id) ?? []).map((u) => ({
        userId: u.user_id,
        username: u.username,
        prefix: u.prefix,
        usedBytes: u.used_bytes,
        quotaBytes: u.quota_bytes,
        fileCount: u.file_count,
        enabled: u.enabled === 1,
        role: u.role,
      })),
    }
  })

  // 未纳入多桶管理的老用户（走 env 默认桶）
  const legacy = (usersByBucket.get("") ?? []).map((u) => ({
    userId: u.user_id,
    username: u.username,
    prefix: u.prefix,
    usedBytes: u.used_bytes,
    quotaBytes: u.quota_bytes,
    fileCount: u.file_count,
    enabled: u.enabled === 1,
    role: u.role,
  }))
  const legacyAgg = aggMap.get("")
  const legacyBucket = isR2Configured(env)
    ? {
        id: "",
        name: "默认桶（env 配置）",
        accountId: null,
        endpoint: env.R2_S3_ENDPOINT ?? "",
        bucketName: env.R2_BUCKET ?? "",
        maxUsers: 0,
        quotaPerUser: 0,
        enabled: true,
        sortOrder: -1,
        hasAnalyticsToken: false,
        createdAt: "",
        stats: {
          users: legacyAgg?.users ?? 0,
          usedBytes: legacyAgg?.used ?? 0,
          capacityBytes: 0,
          fileCount: legacyAgg?.files ?? 0,
          storagePercent: FREE_TIER.storageBytes
            ? Math.min(((legacyAgg?.used ?? 0) / FREE_TIER.storageBytes) * 100, 100)
            : 0,
        },
        users: legacy,
      }
    : null

  return json({
    buckets: items,
    legacyBucket,
    freeTier: FREE_TIER,
    /** 可参与用户分配的用户网盘桶（前端「改派」下拉用） */
    assignableBuckets: buckets
      .filter((b) => b.enabled === 1 && b.kind === "user")
      .map((b) => ({ id: b.id, name: b.name })),
    /** 平台数据桶 id（名片/分享箱存这里），未配置为 null */
    platformBucketId:
      buckets.find((b) => b.kind === "platform" && b.enabled === 1)?.id ?? null,
  })
}

/**
 * GET /api/admin/r2/discover —— 用全局 token 自动发现所有账户及其 R2 桶。
 *
 * 有了它，创建桶时不必手填 endpoint / 桶名 / 账户 ID —— 选一个即可，
 * 其余字段（endpoint、accountId）由服务端推导。
 * 需要环境变量 R2_API_TOKEN（权限：Account → Workers R2 Storage → Read）。
 */
export async function discoverBuckets(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const token = env.R2_API_TOKEN
  if (!token) {
    return json({
      available: false,
      reason: "未配置全局 R2_API_TOKEN（可在 Worker secret 中设置后再用自动发现）",
      accounts: [],
    })
  }

  // 已知的桶（用于标记「已导入」）
  const known = await listBuckets(env)
  const knownKeys = new Set(known.map((b) => `${b.account_id ?? ""}|${b.bucket_name}`))

  let accounts: { id: string; name: string }[] = []
  try {
    // 带超时（2026-09-25 审计 H15）
    const res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
      headers: { Authorization: `Bearer ${token}` },
    }, CF_API_TIMEOUT_MS)
    const data = (await res.json()) as {
      success?: boolean
      result?: { id: string; name: string }[]
      errors?: { message: string }[]
    }
    if (!data.success) {
      return json({
        available: false,
        reason: data.errors?.[0]?.message ?? "读取账户列表失败（token 可能缺少权限）",
        accounts: [],
      })
    }
    accounts = data.result ?? []
  } catch (err) {
    return json({
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      accounts: [],
    })
  }

  // 逐个账户列桶。
  // ⚠️ 2026-09-25 审计（M21）：原注释写着「并行，但限制并发避免触发速率限制」，
  // 代码却是裸的 `Promise.all` —— **没有任何并发上限**。账户数一多（或 CF 返回
  // 大量账户）就会瞬间打出几十个并发请求，直接撞上 CF 的 API 速率限制，
  // 而且其中每个都可能在无超时的情况下挂住。现在用 mapLimit 真正限并发 + 超时。
  const detail = await mapLimit(accounts, R2_ACCOUNT_LIST_CONCURRENCY, async (a) => {
    try {
      const res = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${a.id}/r2/buckets?per_page=100`,
        { headers: { Authorization: `Bearer ${token}` } },
        CF_API_TIMEOUT_MS
      )
      const data = (await res.json()) as {
        success?: boolean
        result?: { buckets?: { name: string; creation_date?: string }[] }
      }
      const buckets = (data.result?.buckets ?? []).map((b) => ({
        name: b.name,
        createdAt: b.creation_date ?? null,
        imported: knownKeys.has(`${a.id}|${b.name}`),
      }))
      return { id: a.id, name: a.name, buckets }
    } catch {
      return { id: a.id, name: a.name, buckets: [] }
    }
  })

  return json({ available: true, accounts: detail })
}

/**
 * POST /api/admin/r2/buckets —— 新建桶
 * body: { id, name, accountId?, endpoint, bucketName, accessKeyId, secretAccessKey, analyticsToken?, maxUsers?, quotaPerUser?, sortOrder? }
 */
export async function createR2Bucket(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  if (!env.SESSION_SECRET) {
    throw new ApiError(503, "未配置 SESSION_SECRET，无法加密凭据", "NOT_CONFIGURED")
  }

  const body = (await request.json()) as Record<string, unknown>
  const str = (k: string, max = 200) => String(body[k] ?? "").trim().slice(0, max)

  const id = str("id", 40)
  const name = str("name", 60)
  const endpoint = str("endpoint", 200)
  const bucketName = str("bucketName", 100)
  const accessKeyId = str("accessKeyId", 200)
  const secretAccessKey = str("secretAccessKey", 200)

  if (!id || !name || !endpoint || !bucketName) {
    throw new ApiError(400, "id / 名称 / endpoint / 桶名 均为必填", "INVALID_INPUT")
  }
  // 凭据可留空 —— 回退到全局 R2_API_TOKEN（推荐：一个 token 覆盖所有账户）
  if ((!accessKeyId || !secretAccessKey) && !env.R2_API_TOKEN) {
    throw new ApiError(
      400,
      "凭据留空时必须已配置全局 R2_API_TOKEN（环境变量），否则请填写 Access Key / Secret",
      "INVALID_INPUT"
    )
  }
  if (!/^[a-z0-9_-]+$/i.test(id)) {
    throw new ApiError(400, "id 只能包含字母、数字、下划线与短横线", "INVALID_INPUT")
  }

  const existing = await env.DB.prepare("SELECT id FROM r2_buckets WHERE id = ?")
    .bind(id)
    .first()
  if (existing) throw new ApiError(409, "该 id 已存在", "CONFLICT")

  const analyticsToken = str("analyticsToken", 500)
  const maxUsers = Math.max(1, Math.trunc(Number(body.maxUsers ?? 8)) || 8)
  const quotaPerUser =
    Math.max(0, Math.trunc(Number(body.quotaPerUser ?? 1073741824))) || 1073741824
  const sortOrder = Math.trunc(Number(body.sortOrder ?? 0)) || 0
  const kind = body.kind === "platform" ? "platform" : "user"
  const now = new Date().toISOString()

  // 平台数据桶只应有一个
  if (kind === "platform") {
    const dup = await env.DB.prepare(
      "SELECT id FROM r2_buckets WHERE kind = 'platform' LIMIT 1"
    ).first()
    if (dup) {
      throw new ApiError(
        409,
        "已存在平台数据桶。平台数据桶只能有一个（存名片与分享箱数据），请改用「用户网盘桶」类型",
        "PLATFORM_BUCKET_EXISTS"
      )
    }
  }

  await env.DB.prepare(
    `INSERT INTO r2_buckets
       (id, name, account_id, endpoint, bucket_name,
        access_key_id_enc, secret_key_enc, analytics_token_enc,
        max_users, quota_per_user, enabled, sort_order, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  )
    .bind(
      id,
      name,
      str("accountId", 60) || null,
      endpoint,
      bucketName,
      // 留空表示回退到全局 R2_API_TOKEN
      accessKeyId ? await encryptSecret(accessKeyId, env.SESSION_SECRET) : "",
      secretAccessKey ? await encryptSecret(secretAccessKey, env.SESSION_SECRET) : "",
      analyticsToken ? await encryptSecret(analyticsToken, env.SESSION_SECRET) : null,
      maxUsers,
      quotaPerUser,
      sortOrder,
      kind,
      now,
      now
    )
    .run()

  invalidatePlatformBucketCache()

  await recordAudit(
    env,
    admin.id,
    "admin.r2.bucket.create",
    `新建 R2 桶 ${name}（${bucketName}）`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, id }, 201)
}

/**
 * PUT /api/admin/r2/buckets/:id —— 更新桶
 * 凭据字段省略则保持不变；传空字符串表示清除（analyticsToken）。
 */
export async function updateR2Bucket(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  if (!env.SESSION_SECRET) {
    throw new ApiError(503, "未配置 SESSION_SECRET，无法加密凭据", "NOT_CONFIGURED")
  }

  const row = await env.DB.prepare("SELECT * FROM r2_buckets WHERE id = ?")
    .bind(id)
    .first<R2BucketRow>()
  if (!row) throw new ApiError(404, "桶不存在", "NOT_FOUND")

  const body = (await request.json()) as Record<string, unknown>
  const str = (k: string, max = 200) =>
    body[k] === undefined ? undefined : String(body[k] ?? "").trim().slice(0, max)

  const name = str("name", 60) ?? row.name
  const endpoint = str("endpoint", 200) ?? row.endpoint
  const bucketName = str("bucketName", 100) ?? row.bucket_name
  const accountId = str("accountId", 60) ?? row.account_id
  const maxUsers =
    body.maxUsers === undefined
      ? row.max_users
      : Math.max(1, Math.trunc(Number(body.maxUsers)) || 8)
  const quotaPerUser =
    body.quotaPerUser === undefined
      ? row.quota_per_user
      : Math.max(0, Math.trunc(Number(body.quotaPerUser))) || row.quota_per_user
  const sortOrder =
    body.sortOrder === undefined ? row.sort_order : Math.trunc(Number(body.sortOrder)) || 0
  const enabled = body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0

  // 凭据：只有显式传了非空值才重新加密覆盖
  const newAccess = str("accessKeyId", 200)
  const newSecret = str("secretAccessKey", 200)
  const accessEnc =
    newAccess ? await encryptSecret(newAccess, env.SESSION_SECRET) : row.access_key_id_enc
  const secretEnc =
    newSecret ? await encryptSecret(newSecret, env.SESSION_SECRET) : row.secret_key_enc

  // analyticsToken：显式传空串 = 清除
  let analyticsEnc = row.analytics_token_enc
  if (body.analyticsToken !== undefined) {
    const t = String(body.analyticsToken ?? "").trim()
    analyticsEnc = t ? await encryptSecret(t, env.SESSION_SECRET) : null
  }

  await env.DB.prepare(
    `UPDATE r2_buckets SET
       name = ?, account_id = ?, endpoint = ?, bucket_name = ?,
       access_key_id_enc = ?, secret_key_enc = ?, analytics_token_enc = ?,
       max_users = ?, quota_per_user = ?, enabled = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      name,
      accountId,
      endpoint,
      bucketName,
      accessEnc,
      secretEnc,
      analyticsEnc,
      maxUsers,
      quotaPerUser,
      enabled,
      sortOrder,
      new Date().toISOString(),
      id
    )
    .run()

  invalidatePlatformBucketCache()

  await recordAudit(
    env,
    admin.id,
    "admin.r2.bucket.update",
    `更新 R2 桶 ${name}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}

/**
 * DELETE /api/admin/r2/buckets/:id
 * 仍有用户分配在该桶时拒绝删除（避免文件失联），需先把用户迁走。
 */
export async function deleteR2Bucket(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const row = await env.DB.prepare("SELECT * FROM r2_buckets WHERE id = ?")
    .bind(id)
    .first<R2BucketRow>()
  if (!row) throw new ApiError(404, "桶不存在", "NOT_FOUND")

  const inUse = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM storage_accounts WHERE bucket_id = ?"
  )
    .bind(id)
    .first<{ c: number }>()
  if ((inUse?.c ?? 0) > 0) {
    throw new ApiError(
      409,
      `仍有 ${inUse?.c} 个用户分配在该桶，请先迁移到其他桶`,
      "BUCKET_IN_USE"
    )
  }

  await env.DB.prepare("DELETE FROM r2_buckets WHERE id = ?").bind(id).run()
  invalidatePlatformBucketCache()
  await recordAudit(
    env,
    admin.id,
    "admin.r2.bucket.delete",
    `删除 R2 桶 ${row.name}`,
    request.headers.get("CF-Connecting-IP")
  )
  return json({ ok: true })
}

/**
 * POST /api/admin/r2/buckets/:id/test —— 测试连通性
 * 用该桶的 S3 凭据列一次对象，确认配置可用。
 */
export async function testR2Bucket(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  const { row } = await credentialsOf(env, id)
  try {
    const page = await listObjects(env, "", { limit: 1, bucketId: id })
    return json({
      ok: true,
      message: `连通正常（${row.bucket_name}）`,
      objectCount: page.objects.length,
    })
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : String(err)
    return json({ ok: false, error: msg })
  }
}

/**
 * POST /api/admin/r2/buckets/:id/write-test —— 写入 + 删除自检
 * 上传一个临时对象再删掉，验证写权限（比单纯列对象更严格）。
 */
export async function writeTestR2Bucket(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  const { row } = await credentialsOf(env, id)
  const key = `_healthcheck/${uuid()}.txt`
  try {
    await putObject(env, key, "ok", "text/plain", id)
    await deletePrefix(env, `_healthcheck/`, 1, id)
    return json({ ok: true, message: `读写正常（${row.bucket_name}）` })
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : String(err)
    return json({ ok: false, error: msg })
  }
}

/**
 * GET /api/admin/r2/buckets/:id/operations —— A/B 类操作数（GraphQL Analytics）
 *
 * 需要该桶配置了 analytics_token（权限：Account → Account Analytics → Read）
 * 且填了 accountId。未配置时返回 configured:false，前端显示「未接入」。
 */
export async function getR2Operations(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  const { row, analyticsToken: perBucketToken } = await credentialsOf(env, id)
  // 优先用环境变量里的全局 token（全账户公用），桶级配置作为覆盖
  const analyticsToken = perBucketToken ?? env.R2_API_TOKEN ?? null

  if (!analyticsToken || !row.account_id) {
    return json({
      configured: false,
      reason: !row.account_id
        ? "未填账户 ID"
        : "未配置全局 R2_API_TOKEN（需 Account Analytics Read 权限）",
      freeTier: { classAOps: FREE_TIER.classAOps, classBOps: FREE_TIER.classBOps },
    })
  }

  // 统计「本月至今」的 A/B 类操作
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  const dateGeq = monthStart.toISOString().slice(0, 10)

  const query = `
    query($accountTag: String!, $bucket: String!, $dateGeq: String!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            limit: 100
            filter: { date_geq: $dateGeq, bucketName: $bucket }
          ) {
            dimensions { actionType }
            sum { requests }
          }
        }
      }
    }`

  try {
    // 带超时（2026-09-25 审计 H15）
    const res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${analyticsToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { accountTag: row.account_id, bucket: row.bucket_name, dateGeq },
      }),
    }, CF_API_TIMEOUT_MS)
    const data = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: {
            r2OperationsAdaptiveGroups?: {
              dimensions?: { actionType?: string }
              sum?: { requests?: number }
            }[]
          }[]
        }
      }
      errors?: { message: string }[]
    }

    if (data.errors?.length) {
      return json({
        configured: true,
        error: data.errors[0].message,
        freeTier: { classAOps: FREE_TIER.classAOps, classBOps: FREE_TIER.classBOps },
      })
    }

    const groups = data.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? []
    let classA = 0
    let classB = 0
    for (const g of groups) {
      const n = g.sum?.requests ?? 0
      // ClassA = 写/列举类（PutObject / ListObjects 等）
      // ClassB = 读类（GetObject / HeadObject 等）
      const t = (g.dimensions?.actionType ?? "").toLowerCase()
      if (t.includes("put") || t.includes("list") || t.includes("delete") || t.includes("copy")) {
        classA += n
      } else {
        classB += n
      }
    }

    return json({
      configured: true,
      since: dateGeq,
      classA,
      classB,
      classAPercent: Math.min((classA / FREE_TIER.classAOps) * 100, 100),
      classBPercent: Math.min((classB / FREE_TIER.classBOps) * 100, 100),
      freeTier: { classAOps: FREE_TIER.classAOps, classBOps: FREE_TIER.classBOps },
    })
  } catch (err) {
    return json({
      configured: true,
      error: err instanceof Error ? err.message : String(err),
      freeTier: { classAOps: FREE_TIER.classAOps, classBOps: FREE_TIER.classBOps },
    })
  }
}

/**
 * PUT /api/admin/r2/assign-all —— 把所有「未分配桶」的用户（bucket_id IS NULL）
 * 一次性改派到指定桶。
 *
 * 用途：把 env 默认桶接管为数据库管理的桶时，让老用户也纳入多桶统计。
 * 与 assign 一样**只改归属不搬文件**——但这里恰好安全：NULL 用户本来就在
 * env 默认桶，只要目标桶指向同一个物理桶（同 endpoint + 同桶名）就没有副作用。
 */
export async function assignAllUnassigned(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as { bucketId?: string; force?: boolean }
  const bucketId = String(body.bucketId ?? "").trim()
  if (!bucketId) throw new ApiError(400, "缺少 bucketId", "INVALID_INPUT")

  const bucket = await env.DB.prepare(
    "SELECT * FROM r2_buckets WHERE id = ? AND enabled = 1"
  )
    .bind(bucketId)
    .first<R2BucketRow>()
  if (!bucket) throw new ApiError(404, "目标桶不存在或未启用", "NOT_FOUND")
  if (bucket.kind !== "user") {
    throw new ApiError(400, "平台数据桶不能分配给用户网盘", "WRONG_BUCKET_KIND")
  }

  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM storage_accounts WHERE bucket_id IS NULL"
  ).first<{ c: number }>()
  const count = pending?.c ?? 0
  if (count === 0) return json({ ok: true, moved: 0 })

  // 人数上限校验：允许因为「接管 env 桶」而超限，但要显式 force
  const current = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM storage_accounts WHERE bucket_id = ?"
  )
    .bind(bucketId)
    .first<{ c: number }>()
  if ((current?.c ?? 0) + count > bucket.max_users && !body.force) {
    throw new ApiError(
      409,
      `迁入后将有 ${(current?.c ?? 0) + count} 人，超过上限 ${bucket.max_users}。请先调高上限，或确认目标桶与默认桶是同一个物理桶后强制迁移`,
      "BUCKET_FULL"
    )
  }

  await env.DB.prepare(
    "UPDATE storage_accounts SET bucket_id = ?, updated_at = ? WHERE bucket_id IS NULL"
  )
    .bind(bucketId, new Date().toISOString())
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.r2.assign-all",
    `把 ${count} 个未分配用户迁入桶 ${bucketId}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, moved: count })
}

/**
 * PUT /api/admin/r2/assign —— 把某用户改派到指定桶
 * body: { username, bucketId }（bucketId 为空 = 取消多桶归属，回到默认桶）
 *
 * 注意：**只改归属，不搬文件**。若该用户在原桶已有文件，改派后那些文件会访问不到。
 * 因此前端要提示管理员：仅对空账号或已手工搬完文件的用户使用。
 */
export async function assignUserBucket(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as { username?: string; bucketId?: string }
  const username = String(body.username ?? "").trim()
  const bucketId = String(body.bucketId ?? "").trim()

  if (!username) throw new ApiError(400, "缺少用户名", "INVALID_INPUT")

  const account = await env.DB.prepare(
    `SELECT sa.user_id, sa.prefix, sa.used_bytes FROM storage_accounts sa
      JOIN users u ON u.id = sa.user_id
     WHERE u.username = ? COLLATE NOCASE LIMIT 1`
  )
    .bind(username)
    .first<{ user_id: string; prefix: string; used_bytes: number }>()
  if (!account) throw new ApiError(404, "该用户未开通网盘", "NOT_FOUND")

  if (bucketId) {
    const bucket = await env.DB.prepare(
      "SELECT * FROM r2_buckets WHERE id = ? AND enabled = 1"
    )
      .bind(bucketId)
      .first<R2BucketRow>()
    if (!bucket) throw new ApiError(404, "目标桶不存在或未启用", "NOT_FOUND")
    if (bucket.kind !== "user") {
      throw new ApiError(
        400,
        "该桶是平台数据桶（存名片/分享箱），不能分配用户网盘，请选择「用户网盘桶」",
        "WRONG_BUCKET_KIND"
      )
    }

    // 目标桶容量校验（人数上限）
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM storage_accounts WHERE bucket_id = ?"
    )
      .bind(bucketId)
      .first<{ c: number }>()
    if ((cnt?.c ?? 0) >= bucket.max_users && account.used_bytes === 0) {
      throw new ApiError(
        409,
        `目标桶已满（${cnt?.c}/${bucket.max_users} 人）`,
        "BUCKET_FULL"
      )
    }
  }

  await env.DB.prepare(
    "UPDATE storage_accounts SET bucket_id = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(bucketId || null, new Date().toISOString(), account.user_id)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.r2.assign",
    `把 ${username} 的网盘改派到桶 ${bucketId || "（默认）"}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}