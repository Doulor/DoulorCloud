/**
 * R2 直链网盘。
 *
 * 存储模型：R2 桶 `network` 内，每个用户一个顶层目录 = 用户名（storage_accounts.prefix）。
 * 配额与文件数记账在 D1，实际上传/读取都以 R2 为准。
 *
 * 直链有两种形态：
 *   1. 默认：https://cloud.doulor.cn/dl/<用户名>/<文件名>（无需任何额外配置）
 *   2. 自定义二级域名：https://<子域名>/<文件名>
 *      storage_prefixes 把某个子域名映射到同一份 R2 目录（通常就是该子域名本身）；
 *      需要 Worker Routes 权限把该域名指到本 Worker，未配置时前端自动隐藏入口。
 *
 * 桶保持私有：所有下载都经本 Worker 反代（跨账户无法使用 R2 自定义域）。
 */
import { ApiError, json, safeDecode, readBodyCapped } from "../http"
import { uuid } from "../crypto"
import { requireFeatureUser } from "../auth"
import {
  deleteObject,
  getObject,
  headObject,
  isStorageConfigured,
  listObjects,
  presign,
  putObject,
  supportsPresign,
  deletePrefix,
  pickBucketForNewUser,
  type R2Object,
} from "../r2"
import { audit, getSettingBool, getSettingNumber, getSettings } from "../settings"
import {
  cfCreateDnsRecord,
  cfDeleteDnsRecord,
  cfListDnsRecords,
  hasCfApiToken,
  resolveApiToken,
} from "../cloudflare"
import { zoneIdForFqdn } from "../root-domains"
import { guardRateLimit } from "../ratelimit"
import { contentDispositionFor } from "../content-type"
import { isPlaceholderDnsRecord } from "../custom-domain"
import type { Env } from "../env"

const MARKER_SUFFIX = "/" // 目录占位对象，如 "ruben/"

/**
 * 上传类接口的限流额度。
 *
 * 为什么需要：上传接口都会真实触发 R2 的写入操作（Class A，按次计费），
 * 而登录用户（含被泄露的账号）可以高频调用 createUploadUrl / commitUpload
 * 反复触发 headObject 与记账查询。配额只限制「总量」，拦不住短时间内的密集请求。
 *
 * 额度取 60 次 / 分钟 —— 正常人上传文件达不到这个频率，
 * 但批量上传（多图/多文件）也不会被误伤。
 */
const UPLOAD_RATE_LIMIT = 60
const UPLOAD_RATE_WINDOW = 60

async function guardUploadRate(env: Env, userId: string): Promise<void> {
  await guardRateLimit(env, `upload:${userId}`, UPLOAD_RATE_LIMIT, UPLOAD_RATE_WINDOW, "上传过于频繁")
}

/**
 * 网盘「使用协议」版本。与前端 STORAGE_CONSENT_VERSION 保持一致。
 * 用户点「开通网盘」前必须勾选同意，服务端记录同意的版本；
 * 提升此数字即要求所有用户重新同意（与代理节点同一套机制）。
 */
export const STORAGE_CONSENT_VERSION = 1

/** 管理员配额「不限」哨兵值（1 PiB，实际用不完）。前端见到应显示「不限」 */
const ADMIN_UNLIMITED_QUOTA = 1024 ** 5

interface StorageAccountRow {
  user_id: string
  prefix: string
  quota_bytes: number
  used_bytes: number
  file_count: number
  enabled: number
  /** 默认分享前缀：storage_prefixes.id；为空则用 /dl/<用户名>/ */
  default_prefix_id?: string | null
  /** 已同意的协议版本；NULL = 老账号（协议系统上线前开通） */
  consent_version?: number | null
  consented_at?: string | null
  /** 归属的 R2 桶（r2_buckets.id）；NULL = 未纳入多桶管理，走 env 默认桶 */
  bucket_id?: string | null
  created_at: string
  updated_at: string
}

function toPublicAccount(row: StorageAccountRow, directLinkBase: string) {
  return {
    prefix: row.prefix,
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
    fileCount: row.file_count,
    enabled: row.enabled === 1,
    defaultPrefixId: row.default_prefix_id ?? null,
    createdAt: row.created_at,
    directLinkBase: `${directLinkBase}/${row.prefix}`,
  }
}

/**
 * 桶级容量守卫：网盘是「共享池」，桶内所有用户的总用量不得超过桶的真实容量。
 * 桶满则拒绝上传 —— 这就是「桶没满才能继续传」的边界；与 per-user 限额（软上限）
 * 是两层独立约束。桶被删 / 无 bucket_id（老账号）时不额外拦，回落 per-user 判断。
 */
async function assertBucketHasRoom(
  env: Env,
  bucketId: string | null | undefined,
  delta: number
): Promise<void> {
  if (!bucketId || delta <= 0) return
  const bucket = await env.DB.prepare(
    "SELECT capacity_bytes FROM r2_buckets WHERE id = ?"
  )
    .bind(bucketId)
    .first<{ capacity_bytes: number }>()
  if (!bucket) return
  const total = await env.DB.prepare(
    "SELECT COALESCE(SUM(used_bytes), 0) AS t FROM storage_accounts WHERE bucket_id = ?"
  )
    .bind(bucketId)
    .first<{ t: number }>()
  if ((total?.t ?? 0) + delta > bucket.capacity_bytes) {
    throw new ApiError(400, "存储桶已满，上传已取消", "BUCKET_FULL")
  }
}

async function loadAccount(
  env: Env,
  userId: string
): Promise<StorageAccountRow | null> {
  const row = await env.DB.prepare("SELECT * FROM storage_accounts WHERE user_id = ?")
    .bind(userId)
    .first<StorageAccountRow>()
  if (!row) return null

  // 自愈：历史遗留的「没分到桶」账号（bucket_id = NULL）。
  //
  // 背景（2026-10-03 站长反馈 deity 用不了网盘）：旧的分配逻辑按「每桶人数上限」分桶，
  // 桶满时开通的账号拿到 bucket_id = NULL。此后它的一切存储操作都会回落到 env 默认桶
  // （见 r2.ts::resolveBucket → envConfig），而本站从没配那套 env 变量 ⇒ 用户看到
  // 「网盘存储未配置（缺少 R2 S3 凭据）」。**其实一个字节都没存**（used_bytes = 0），
  // 纯属被卡死。全站 49 个网盘账号里有 15 个是这种。
  // 现在分配逻辑已改成「共享池按剩余容量选桶」，这里顺手把没桶的补上，杜绝再卡。
  if (!row.bucket_id) {
    const picked = await pickBucketForNewUser(env)
    if (picked) {
      await env.DB.prepare(
        "UPDATE storage_accounts SET bucket_id = ?, updated_at = ? WHERE user_id = ?"
      )
        .bind(picked.id, new Date().toISOString(), userId)
        .run()
      row.bucket_id = picked.id
    }
  }
  return row
}

/** 校验用户对某个 R2 key 的所有权（key 必须落在其 prefix 目录内） */
function assertKeyOwned(account: StorageAccountRow, key: string): void {
  if (!key.startsWith(`${account.prefix}/`)) {
    throw new ApiError(403, "无权访问该文件", "FORBIDDEN")
  }
  // ⚠️ 2026-09-25 审计（低）：原实现用 `key.includes("..")` 判穿越，会**误伤合法文件名**。
  // sanitizeFilename 只去掉**前导**点，所以 `a..b.png` 能通过 createUploadUrl 并成功直传，
  // 但随后 commitUpload / deleteStorageObject 一律 403 —— 结果是既不计入 used_bytes、
  // 也删不掉的孤儿对象（用户界面上看得到，却永远删不掉）。
  // 正确做法是按路径段判断：只有恰好等于 `..`（或 `.`）的段才是穿越。
  if (hasDotSegment(key)) {
    throw new ApiError(403, "无权访问该文件", "FORBIDDEN")
  }
}

/** key 中是否含有 `.` / `..` 这类路径穿越段（按段判断，不误伤 `a..b.png`） */
function hasDotSegment(key: string): boolean {
  return key.split("/").some((seg) => seg === ".." || seg === ".")
}

/** 清洗文件名：去掉路径分隔与控制字符，防止目录穿越 */
export function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // 收敛连续点：`..` 与 `...` 都要压成一个点，否则会撞上 hasDotSegment
    // 的段判断（`a..b.png` 合法，但 `..png` 这类仍应被归一化掉）
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim()
  const limited = cleaned.slice(0, 200)
  return limited || `file-${Date.now()}`
}

/**
 * 重算某用户的实际用量（以 R2 为准）。
 * 用于开通时初始化，以及记账被异常流程弄脏后的校正。
 */
async function recalculateUsage(
  env: Env,
  account: StorageAccountRow
): Promise<{ usedBytes: number; fileCount: number }> {
  let usedBytes = 0
  let fileCount = 0
  let cursor: string | undefined

  for (let round = 0; round < 50; round++) {
    const page = await listObjects(env, `${account.prefix}/`, {
      limit: 1000,
      cursor,
      bucketId: account.bucket_id,
    })
    for (const obj of page.objects) {
      if (obj.key.endsWith(MARKER_SUFFIX)) continue
      usedBytes += obj.size
      fileCount++
    }
    if (!page.truncated || !page.cursor) break
    cursor = page.cursor
  }

  await env.DB.prepare(
    "UPDATE storage_accounts SET used_bytes = ?, file_count = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(usedBytes, fileCount, new Date().toISOString(), account.user_id)
    .run()

  account.used_bytes = usedBytes
  account.file_count = fileCount
  return { usedBytes, fileCount }
}

// ---- 账户状态 ----

/** GET /api/storage —— 开通状态、配额、直链前缀、自定义域名 */
export async function getStorage(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const url = new URL(request.url)
  const settings = await getSettings(env)
  const configured = await isStorageConfigured(env)
  const account = configured ? await loadAccount(env, user.id) : null

  const prefixes = account
    ? await env.DB.prepare(
        "SELECT id, fqdn, r2_prefix, created_at FROM storage_prefixes WHERE user_id = ? ORDER BY created_at ASC"
      )
        .bind(user.id)
        .all<{ id: string; fqdn: string; r2_prefix: string; created_at: string }>()
    : { results: [] as { id: string; fqdn: string; r2_prefix: string; created_at: string }[] }

  // 可绑定的子域名（排除主域名 '@' 和已绑定的）
  const subdomains = account
    ? await env.DB.prepare(
        `SELECT s.id, s.name, s.fqdn FROM subdomains s
          WHERE s.user_id = ? AND s.name != '@'
            AND s.id NOT IN (SELECT subdomain_id FROM storage_prefixes WHERE user_id = ?)
          ORDER BY s.created_at ASC`
      )
        .bind(user.id, user.id)
        .all<{ id: string; name: string; fqdn: string }>()
    : { results: [] as { id: string; name: string; fqdn: string }[] }

  const list = prefixes.results ?? []
  const defaultPrefix =
    list.find((p) => p.id === account?.default_prefix_id) ?? null

  return json({
    configured,
    featureEnabled: settings.storage_enabled === "1",
    // 自定义域名需要 Doulor 账户的 Worker Routes 权限
    // 不再单独看 CF_WORKERS_TOKEN：绑定用的是与 DNS 共用的那个令牌
    customDomainSupported: hasCfApiToken(env),
    account: account ? toPublicAccount(account, `${url.origin}/dl`) : null,
    defaultQuotaBytes: Number(settings.storage_quota_bytes),
    maxFileBytes: Number(settings.storage_max_file_bytes),
    prefixes: list,
    // 默认分享前缀（null = 用 /dl/<用户名>/）
    defaultPrefix,
    // 直接给前端一个可复制的分享基址，省去它自己拼接
    shareBase: defaultPrefix
      ? `https://${defaultPrefix.fqdn}`
      : account
        ? `${url.origin}/dl/${account.prefix}`
        : null,
    availableSubdomains: subdomains.results ?? [],
    /** 前端内嵌协议文本的版本；不一致时前端应提示重新确认 */
    consentVersion: STORAGE_CONSENT_VERSION,
    /** 已同意的协议版本（enable 时写入）；0 表示从未同意 */
    consentedVersion: account?.consent_version ?? 0,
  })
}

/**
 * POST /api/storage/default-prefix —— 设置默认分享链接前缀。
 * body: { prefixId: string | null }；null 表示恢复为 /dl/<用户名>/。
 */
export async function setDefaultPrefix(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const body = (await request.json()) as { prefixId?: string | null }
  const prefixId = body.prefixId ?? null

  if (prefixId !== null) {
    // 必须属于当前用户，避免把别人的域名设成自己的默认前缀
    const owned = await env.DB.prepare(
      "SELECT id, fqdn FROM storage_prefixes WHERE id = ? AND user_id = ?"
    )
      .bind(prefixId, user.id)
      .first<{ id: string; fqdn: string }>()
    if (!owned) throw new ApiError(403, "无权使用该前缀", "FORBIDDEN")
  }

  await env.DB.prepare(
    "UPDATE storage_accounts SET default_prefix_id = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(prefixId, new Date().toISOString(), user.id)
    .run()

  await audit(
    env,
    user.id,
    "storage.default_prefix",
    prefixId ? `默认分享前缀设为 ${prefixId}` : "默认分享前缀恢复为默认路径"
  )

  return json({ defaultPrefixId: prefixId })
}

/**
 * POST /api/storage/enable —— 开通（建立以用户名命名的目录）
 * body: { consent: true, consentVersion: STORAGE_CONSENT_VERSION }
 * 必须勾选同意使用协议，服务端才写入启用状态。
 */
export async function enableStorage(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "网盘存储未配置", "R2_NOT_CONFIGURED")
  }
  if (!(await getSettingBool(env, "storage_enabled"))) {
    throw new ApiError(403, "网盘功能已关闭", "FEATURE_DISABLED")
  }

  // 协议同意校验：不信任前端，必须显式传 consent 且版本匹配
  const body = (await request.json().catch(() => ({}))) as {
    consent?: unknown
    consentVersion?: unknown
  }
  if (body.consent !== true) {
    throw new ApiError(400, "请先阅读并勾选同意使用协议", "CONSENT_REQUIRED")
  }
  const version = Math.trunc(Number(body.consentVersion))
  if (version !== STORAGE_CONSENT_VERSION) {
    throw new ApiError(400, "使用协议已更新，请重新阅读并同意", "CONSENT_VERSION_MISMATCH")
  }

  const now = new Date().toISOString()

  const existing = await loadAccount(env, user.id)
  if (existing) {
    // 已开通：重新启用即可（保留原有文件），同时刷新协议同意记录
    await env.DB.prepare(
      "UPDATE storage_accounts SET enabled = 1, quota_bytes = ?, consent_version = ?, consented_at = ?, updated_at = ? WHERE user_id = ?"
    )
      .bind(
        // 管理员/站长配额不限（哨兵值）
        user.role === "admin" || user.role === "root"
          ? ADMIN_UNLIMITED_QUOTA
          : await getSettingNumber(env, "storage_quota_bytes"),
        STORAGE_CONSENT_VERSION,
        now,
        now,
        user.id
      )
      .run()
    const updated = await loadAccount(env, user.id)
    const url = new URL(request.url)
    return json({ account: toPublicAccount(updated!, `${url.origin}/dl`) })
  }

  const prefix = user.username.toLowerCase()
  const defaultQuota = await getSettingNumber(env, "storage_quota_bytes")

  // 自动均衡分配桶：有可用桶则记下归属，并用该桶的「每人配额」覆盖全局默认值。
  // 全部桶都满（或未配置多桶）时 bucket_id 为 null → 回退 env 默认桶。
  const picked = await pickBucketForNewUser(env)
  const bucketId = picked?.id ?? null
  // 管理员配额不限（哨兵值）；普通用户取桶配置的每人配额，回退全局默认
  const quota =
    user.role === "admin" || user.role === "root"
      ? ADMIN_UNLIMITED_QUOTA
      : (picked?.quotaPerUser ?? defaultQuota)

  // ⚠️ 2026-09-25 审计（M12）：`storage_accounts.prefix` 是 UNIQUE，而它的值
  // 取自用户名。注册预检现在会拦住「旧存储仍占用该名字」的情况
  // （见 handlers/auth.ts 的 conflicts 批次），但仍有两条残余路径：
  //   1. 同一用户并发点两次「开通网盘」；
  //   2. 预检之后、INSERT 之前有人释放/占用了同名 prefix。
  // 原实现直接让 UNIQUE 冲突冒泡成 500，用户看到的是一个无法理解的错误。
  // 这里兜底成明确的 409，让前端能给出「该用户名下的存储命名空间已被占用」的提示。
  try {
    await env.DB.prepare(
      `INSERT INTO storage_accounts
         (user_id, prefix, quota_bytes, used_bytes, file_count, enabled,
          consent_version, consented_at, bucket_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 1, ?, ?, ?, ?, ?)`
    )
      .bind(user.id, prefix, quota, STORAGE_CONSENT_VERSION, now, bucketId, now, now)
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/UNIQUE|constraint/i.test(message)) {
      throw new ApiError(
        409,
        "该用户名对应的存储命名空间已被占用（可能是改名后遗留的旧存储），请联系管理员",
        "PREFIX_TAKEN"
      )
    }
    throw err
  }

  // 目录占位对象，使 R2 控制台里能看到以用户名命名的目录
  try {
    await putObject(env, `${prefix}/`, "", "application/x-directory", bucketId)
  } catch (err) {
    // 占位对象失败不影响使用（R2 上传时会自动建目录）
    console.error("目录占位对象创建失败:", err)
  }

  await audit(
    env,
    user.id,
    "storage.enable",
    `开通网盘，目录 ${prefix}/${bucketId ? `（桶 ${bucketId}）` : ""}`
  )

  const account = await loadAccount(env, user.id)
  const url = new URL(request.url)
  return json({ account: toPublicAccount(account!, `${url.origin}/dl`) }, 201)
}

/** POST /api/storage/disable —— 关闭直链（保留文件，重新启用后恢复） */
export async function disableStorage(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) {
    throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")
  }

  await env.DB.prepare(
    "UPDATE storage_accounts SET enabled = 0, updated_at = ? WHERE user_id = ?"
  )
    .bind(new Date().toISOString(), user.id)
    .run()

  await audit(env, user.id, "storage.disable", `关闭网盘直链 ${account.prefix}/`)
  return json({ ok: true })
}

// ---- 文件操作 ----

/** GET /api/storage/objects —— 列出文件（以 R2 为准） */
export async function listStorageObjects(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const url = new URL(request.url)
  const cursor = url.searchParams.get("cursor") ?? undefined
  const page = await listObjects(env, `${account.prefix}/`, {
    limit: 200,
    cursor,
    bucketId: account.bucket_id,
  })

  const objects = page.objects
    .filter((o) => !o.key.endsWith(MARKER_SUFFIX))
    .map((o) => toPublicObject(o, account.prefix))

  return json({
    objects,
    cursor: page.cursor,
    truncated: page.truncated,
    usedBytes: account.used_bytes,
    quotaBytes: account.quota_bytes,
  })
}

function toPublicObject(obj: R2Object, prefix: string) {
  const filename = obj.key.slice(prefix.length + 1)
  return {
    key: obj.key,
    filename,
    size: obj.size,
    lastModified: obj.lastModified,
    etag: obj.etag,
  }
}

/**
 * POST /api/storage/upload-url —— 申请预签名上传地址。
 * 浏览器直传 R2：可显示真实进度，且不受 Worker 请求体大小限制。
 */
export async function createUploadUrl(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  await guardUploadRate(env, user.id)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")
  if (account.enabled !== 1) {
    throw new ApiError(403, "网盘已关闭，请先启用", "STORAGE_DISABLED")
  }

  const body = (await request.json()) as {
    filename?: string
    size?: number
    contentType?: string
  }

  const filename = sanitizeFilename(body.filename ?? "")
  const size = Math.max(0, Math.trunc(Number(body.size ?? 0)))
  // 管理员不受单文件大小限制（仍受 Worker 请求体上限约束）
  const maxFile =
    user.role === "admin" || user.role === "root"
      ? ADMIN_UNLIMITED_QUOTA
      : await getSettingNumber(env, "storage_max_file_bytes")

  if (size > maxFile) {
    throw new ApiError(
      400,
      `单个文件不能超过 ${Math.round(maxFile / 1024 / 1024)} MB`,
      "FILE_TOO_LARGE"
    )
  }

  // 同名文件已存在时按覆盖处理，配额只算增量
  const key = `${account.prefix}/${filename}`
  const existing = await headObject(env, key, account.bucket_id)
  const delta = size - (existing?.size ?? 0)

  if (account.used_bytes + delta > account.quota_bytes) {
    throw new ApiError(
      400,
      `存储空间不足（已用 ${account.used_bytes} / ${account.quota_bytes} 字节）`,
      "QUOTA_EXCEEDED"
    )
  }
  // 桶级共享池容量守卫
  await assertBucketHasRoom(env, account.bucket_id, delta)

  const uploadUrl = (await supportsPresign(env, account.bucket_id))
    ? // content-length 参与签名（见 r2.ts 的 presign）：否则客户端可以声明
      // size=1 通过配额校验，再用同一个预签名 URL PUT 任意大小的对象。
      await presign(env, "PUT", key, 3600, account.bucket_id, size)
    : // token 模式不支持预签名：改走 Worker 转发上传（见 proxyUpload）
      `/api/storage/proxy-upload?key=${encodeURIComponent(key)}`

  return json({
    uploadUrl,
    key,
    filename,
    directLink: `/dl/${encodeURIComponent(account.prefix)}/${encodeURIComponent(filename)}`,
  })
}

/**
 * PUT /api/storage/proxy-upload?key=xxx —— Workered 中转上传。
 *
 * 仅在桶使用 API Token 凭据（不支持预签名）时启用：
 * 前端仍走同样的「PUT 文件到 uploadUrl」流程，请求打到 Worker 再转发给 R2。
 * 代价是文件经 Worker 内存中转，受 Worker 请求体上限约束。
 */
export async function proxyUpload(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  await guardUploadRate(env, user.id)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")
  if (account.enabled !== 1) {
    throw new ApiError(403, "网盘已关闭，请先启用", "STORAGE_DISABLED")
  }

  const key = new URL(request.url).searchParams.get("key") ?? ""
  assertKeyOwned(account, key)

  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream"

  // 管理员不受单文件大小限制（仍受 Worker 请求体上限约束）
  const maxFile =
    user.role === "admin" || user.role === "root"
      ? ADMIN_UNLIMITED_QUOTA
      : await getSettingNumber(env, "storage_max_file_bytes")

  // ⚠️ 2026-09-26 审计：原先是「先整体读进内存再判大小」（`arrayBuffer()` → 比对 maxFile），
  // 单请求即可放大到 100MB 级内存。`readBodyCapped` 先看 Content-Length 快速拒绝，
  // 读完再复核真实长度。上限必须先算出来，所以上面两步调换了顺序。
  const buf = await readBodyCapped(
    request,
    maxFile,
    `单个文件不能超过 ${Math.round(maxFile / 1024 / 1024)} MB`,
    400,
    "FILE_TOO_LARGE"
  )
  if (buf.byteLength === 0) {
    throw new ApiError(400, "文件为空", "INVALID_INPUT")
  }

  // ⚠️ 2026-09-25 审计（P0-6 的配套）：token 模式走 Worker 转发时，
  // 字节数**已经在内存里**，所以这里能在落盘前就把配额判掉 —— 与预签名
  // 直传不同（那条路径的大小由客户端声明，见 r2.ts 的 presign 签名改动）。
  // 注意记账仍由 commitUpload 完成，这里只是「不满足配额就别写进 R2」。
  const existing = await headObject(env, key, account.bucket_id)
  const delta = buf.byteLength - (existing?.size ?? 0)
  if (account.used_bytes + delta > account.quota_bytes) {
    throw new ApiError(400, "存储空间不足，上传已取消", "QUOTA_EXCEEDED")
  }
  await assertBucketHasRoom(env, account.bucket_id, delta)

  await putObject(env, key, buf, contentType, account.bucket_id)
  return json({ ok: true, key, size: buf.byteLength })
}

/**
 * POST /api/storage/commit —— 上传完成后登记。
 * 用 HEAD 读取 R2 中的真实大小（不信任前端传值），再更新记账。
 */
export async function commitUpload(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  await guardUploadRate(env, user.id)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const body = (await request.json()) as { key?: string; contentType?: string }
  const key = body.key ?? ""
  assertKeyOwned(account, key)

  const head = await headObject(env, key, account.bucket_id)
  if (!head) {
    throw new ApiError(404, "上传未完成或文件不存在", "NOT_FOUND")
  }

  const filename = key.slice(account.prefix.length + 1)
  const now = new Date().toISOString()

  const prev = await env.DB.prepare(
    "SELECT size FROM storage_objects WHERE r2_key = ? AND user_id = ?"
  )
    .bind(key, user.id)
    .first<{ size: number }>()

  const delta = head.size - (prev?.size ?? 0)

  // 个人限额 + 桶级共享池容量：任一超限都回滚刚上传的文件，保持账实一致
  const overQuota = account.used_bytes + delta > account.quota_bytes
  let bucketFull = false
  if (!overQuota && account.bucket_id) {
    try {
      await assertBucketHasRoom(env, account.bucket_id, delta)
    } catch (err) {
      if (err instanceof ApiError && err.code === "BUCKET_FULL") bucketFull = true
      else throw err
    }
  }
  if (overQuota || bucketFull) {
    await deleteObject(env, key, account.bucket_id)
    throw new ApiError(
      400,
      overQuota ? "存储空间不足，上传已取消" : "存储桶已满，上传已取消",
      overQuota ? "QUOTA_EXCEEDED" : "BUCKET_FULL"
    )
  }

  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO storage_objects (id, user_id, r2_key, filename, size, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(r2_key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type`
    ).bind(
      uuid(),
      user.id,
      key,
      filename,
      head.size,
      body.contentType ?? head.contentType ?? null,
      now
    ),
    // ⚠️ 2026-09-26 审计：配额守卫必须写进 WHERE。上面的前置检查基于
    // `account` 的内存快照，两个并发上传会各自通过它，把 used_bytes 推过配额。
    env.DB.prepare(
      `UPDATE storage_accounts
          SET used_bytes = used_bytes + ?,
              file_count = (SELECT COUNT(*) FROM storage_objects WHERE user_id = ?),
              updated_at = ?
        WHERE user_id = ? AND used_bytes + ? <= quota_bytes`
    ).bind(delta, user.id, now, user.id, delta),
  ])

  // 守卫没过 ⇒ 并发下别人先占满了配额。补偿：撤掉刚写的记账与文件
  // （覆盖上传的场景要把 size 还原成旧值，不能直接删行）。
  if ((res[1]?.meta?.changes ?? 0) === 0) {
    if (prev) {
      await env.DB.prepare(
        "UPDATE storage_objects SET size = ? WHERE r2_key = ? AND user_id = ?"
      )
        .bind(prev.size, key, user.id)
        .run()
    } else {
      await env.DB.prepare("DELETE FROM storage_objects WHERE r2_key = ? AND user_id = ?")
        .bind(key, user.id)
        .run()
    }
    await deleteObject(env, key, account.bucket_id)
    throw new ApiError(400, "存储空间不足，上传已取消", "QUOTA_EXCEEDED")
  }

  const updated = await loadAccount(env, user.id)
  return json({
    object: { key, filename, size: head.size },
    usedBytes: updated?.used_bytes ?? 0,
    quotaBytes: updated?.quota_bytes ?? account.quota_bytes,
  })
}

/** DELETE /api/storage/object?key=xxx —— 删除文件 */
export async function deleteStorageObject(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const key = new URL(request.url).searchParams.get("key") ?? ""
  assertKeyOwned(account, key)

  const prev = await env.DB.prepare(
    "SELECT size FROM storage_objects WHERE r2_key = ? AND user_id = ?"
  )
    .bind(key, user.id)
    .first<{ size: number }>()

  await deleteObject(env, key, account.bucket_id)

  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare("DELETE FROM storage_objects WHERE r2_key = ? AND user_id = ?").bind(
      key,
      user.id
    ),
    env.DB.prepare(
      `UPDATE storage_accounts
          SET used_bytes = MAX(0, used_bytes - ?),
              file_count = (SELECT COUNT(*) FROM storage_objects WHERE user_id = ?),
              updated_at = ?
        WHERE user_id = ?`
    ).bind(prev?.size ?? 0, user.id, now, user.id),
  ])

  return new Response(null, { status: 204 })
}

/** GET /api/storage/download?key=xxx —— 鉴权下载（供后台预览） */
export async function downloadStorageObject(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const key = new URL(request.url).searchParams.get("key") ?? ""
  assertKeyOwned(account, key)

  return proxyObject(env, key, request, false, account.bucket_id)
}

// ---- 自定义直链前缀 ----

/** POST /api/storage/domain —— 绑定 / 解绑自定义二级域名 */
export async function bindStorageDomain(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const body = (await request.json()) as {
    subdomainId?: string
    action?: "bind" | "unbind"
  }

  if (body.action === "unbind") {
    const prefixId = body.subdomainId ?? ""
    const existing = await env.DB.prepare(
      "SELECT * FROM storage_prefixes WHERE id = ? AND user_id = ?"
    )
      .bind(prefixId, user.id)
      .first<{ id: string; fqdn: string }>()
    if (!existing) throw new ApiError(404, "绑定不存在", "NOT_FOUND")

    // 移除 Worker Route（失败不阻断，路由可能已不存在）
    try {
      await removeWorkerRoute(env, existing.fqdn)
    } catch (err) {
      console.error("移除 Worker Route 失败:", err)
    }

    // 移除绑定期间自动创建的 DNS 占位记录，否则该子域名会一直解析到本站
    // 且 deleteSubdomain 的冲突检测会认为它仍被占用。
    //
    // ⚠️ 2026-09-25 审计（M14b）：原实现把该名字下的**所有** DNS 记录全删掉，
    // 注释写着「用户在绑定期自行添加的记录也一并清理，避免留下悬空解析」。
    // 但这条规则会连用户为这个子域名配的 **MX / TXT（邮件）** 记录一起删掉 ——
    // 解绑一个网盘直链前缀，代价是把这个子域名的邮件收信能力抹掉。
    // 那些记录是用户自己的资产，不该由「解绑直链」这个动作处置。
    //
    // 现在只删**我们自己建的那种占位记录**：AAAA + `100::`
    // （与下面绑定分支 cfCreateDnsRecord 的参数一一对应）。
    // 用户自行添加的记录一律保留 —— 它们本来就指向别处，不存在「悬空」问题。
    try {
      // zone 按 fqdn 解析：用户子域名可能建在 tyu.me 上
      const zoneId = await zoneIdForFqdn(env, existing.fqdn)
      const records = await cfListDnsRecords(env, zoneId, existing.fqdn)
      for (const record of records) {
        if (!isPlaceholderDnsRecord(record)) continue
        await cfDeleteDnsRecord(env, zoneId, record.id)
      }
    } catch (err) {
      console.error("移除直链域名 DNS 记录失败:", err)
    }

    await env.DB.prepare("DELETE FROM storage_prefixes WHERE id = ?")
      .bind(existing.id)
      .run()
    await audit(env, user.id, "storage.domain.unbind", `解绑直链域名 ${existing.fqdn}`)
    return json({ ok: true })
  }

  // 绑定
  const subdomainId = body.subdomainId ?? ""
  const sub = await env.DB.prepare(
    "SELECT id, name, fqdn FROM subdomains WHERE id = ? AND user_id = ?"
  )
    .bind(subdomainId, user.id)
    .first<{ id: string; name: string; fqdn: string }>()
  if (!sub) throw new ApiError(403, "无权使用该子域名", "FORBIDDEN")
  if (sub.name === "@") {
    throw new ApiError(400, "主域名不能作为直链前缀", "INVALID_SUBDOMAIN")
  }

  if (!hasCfApiToken(env)) {
    throw new ApiError(
      503,
      "自定义直链域名未启用（管理员需配置 CF_WORKERS_TOKEN）",
      "CUSTOM_DOMAIN_UNAVAILABLE"
    )
  }

  const taken = await env.DB.prepare(
    "SELECT id FROM storage_prefixes WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(sub.fqdn)
    .first()
  if (taken) throw new ApiError(409, "该域名已绑定了直链", "CONFLICT")

  // ⚠️ 2026-09-25 审计（M14a）：与个人名片互斥 —— **这个方向原先漏了检查**。
  //
  // `bindProfileDomain`（profile.ts:1159-1171）会拒绝已被网盘直链占用的子域名，
  // 但网盘这边从不检查名片。于是同一个子域名可以同时绑给「名片」和「直链」：
  //   - 实际生效的是名片（路由优先级），网盘直链静默失效，用户以为配好了；
  //   - 更糟的是之后解绑网盘时，会把该名字上的 Worker Route 与占位 DNS 一起删掉，
  //     连带把**名片**的域名打坏。
  // 互斥必须是双向的，只查一边等于没查。
  const usedByProfile = await env.DB.prepare(
    "SELECT user_id FROM profiles WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(sub.fqdn)
    .first()
  if (usedByProfile) {
    throw new ApiError(
      409,
      "该子域名已绑定个人名片，请先在「名片」中解绑",
      "CONFLICT"
    )
  }

  // 该域名上不能已有用户自己建的 DNS 记录（避免抢走他的站点）
  const dns = await env.DB.prepare(
    "SELECT id FROM dns_records WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(sub.fqdn)
    .first()
  if (dns) {
    throw new ApiError(
      409,
      "该子域名已存在 DNS 记录，请先删除或改用其它子域名",
      "CONFLICT"
    )
  }

  // 1. 先建 DNS 记录：doulor.cn 上没有泛解析，只有 Worker Route 的话
  //    该域名根本不会被解析到 Cloudflare，浏览器会直接连接失败。
  //    用 AAAA 100:: 占位并开启代理（与平台上其它 Worker 路由域名一致）。
  //    若该域名已有解析（例如管理员手工建过），则跳过，不覆盖既有配置。
  // ⚠️ zone 按 fqdn 解析，不能写死 env.ZONE_ID：写死会把记录建到 doulor.cn 上，
  //    而该子域名其实在 tyu.me 下 —— 解析不出来，且是静默错误。
  const zoneId = await zoneIdForFqdn(env, sub.fqdn)
  const existingCf = await cfListDnsRecords(env, zoneId, sub.fqdn)
  const ensuredDns = existingCf.length > 0
  if (!ensuredDns) {
    try {
      await cfCreateDnsRecord(env, zoneId, {
        type: "AAAA",
        name: sub.fqdn,
        content: "100::",
        ttl: 1,
        proxied: true,
      })
    } catch (err) {
      console.error("直链域名 DNS 记录创建失败:", sub.fqdn, err)
      throw new ApiError(
        502,
        "无法为该子域名创建 DNS 解析记录，请稍后重试",
        "CF_ERROR"
      )
    }
  }

  // 2. 再把该域名指到本 Worker
  let route: string | null = null
  try {
    route = await createWorkerRoute(env, sub.fqdn)
  } catch (err) {
    // 路由创建失败则回滚刚建的 DNS 记录，避免留下解析不到内容的空域名
    if (!ensuredDns) {
      try {
        const created = await cfListDnsRecords(env, zoneId, sub.fqdn)
        for (const record of created) {
          await cfDeleteDnsRecord(env, zoneId, record.id)
        }
      } catch (cleanupErr) {
        console.error("回滚 DNS 记录失败:", sub.fqdn, cleanupErr)
      }
    }
    throw err
  }

  await env.DB.prepare(
    `INSERT INTO storage_prefixes (id, user_id, subdomain_id, fqdn, r2_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      uuid(),
      user.id,
      sub.id,
      sub.fqdn,
      account.prefix,
      new Date().toISOString()
    )
    .run()

  await audit(
    env,
    user.id,
    "storage.domain.bind",
    `绑定直链域名 ${sub.fqdn} -> ${account.prefix}/ (dns ${ensuredDns ? "已存在" : "已创建"}, route ${route ?? "n/a"})`
  )

  return json(
    {
      prefix: {
        fqdn: sub.fqdn,
        r2Prefix: account.prefix,
        // DNS 与证书生效需要一点时间，前端据此提示用户稍候
        dnsCreated: !ensuredDns,
      },
    },
    201
  )
}

// ---- Cloudflare Worker Routes（把自定义域名指向本 Worker）----

async function cfWorkersApi(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  // 与 DNS 记录 / 邮件路由共用同一个令牌（2026-10-01 起全站一份，见 custom-domain.ts）
  if (!hasCfApiToken(env)) {
    throw new ApiError(503, "未配置 Cloudflare API Token", "CUSTOM_DOMAIN_UNAVAILABLE")
  }
  const token = await resolveApiToken(env)
  return fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
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

async function createWorkerRoute(
  env: Env,
  fqdn: string
): Promise<string | null> {
  const script = env.WORKER_NAME ?? "doulor-mail-api"
  const pattern = `${fqdn}/*`
  const zoneId = await zoneIdForFqdn(env, fqdn)

  const existing = (await listWorkerRoutes(env, zoneId)).find(
    (r) => r.pattern.toLowerCase() === pattern.toLowerCase()
  )
  if (existing) return existing.id

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
    throw new ApiError(
      502,
      data.errors?.[0]?.message ?? "创建 Worker Route 失败",
      "CF_ERROR"
    )
  }
  return data.result.id
}

async function removeWorkerRoute(env: Env, fqdn: string): Promise<void> {
  const pattern = `${fqdn}/*`
  let zoneId: string
  try {
    zoneId = await zoneIdForFqdn(env, fqdn)
  } catch (err) {
    console.error("解绑时无法解析 zone:", fqdn, err)
    return
  }
  const existing = (await listWorkerRoutes(env, zoneId)).find(
    (r) => r.pattern.toLowerCase() === pattern.toLowerCase()
  )
  if (!existing) return
  await cfWorkersApi(env, `/zones/${zoneId}/workers/routes/${existing.id}`, {
    method: "DELETE",
  })
}

// ---- 公开直链反代 ----

/**
 * 把 R2 对象流式返回给客户端。
 * 公开直链（public=true）不鉴权，但要求账户处于启用状态 —— 关闭网盘后直链即失效。
 */
/**
 * 允许「内联展示」的内容类型白名单。
 *
 * 为什么要收口（2026-09-23 安全审计，P1）：
 *   直链是**任何用户都能往自己前缀里写文件**的公开出口，而 `proxyObject` 原先把
 *   R2 里存的 `content-type` 原样透传给浏览器。于是攻击者只要上传一个
 *   `evil.html`（`Content-Type: text/html`，预签名 PUT 时 Content-Type 不参与签名，
 *   完全可控）并分享 `https://cloud.doulor.cn/dl/<他>/evil.html`，脚本就会在
 *   **应用主源**上执行：以受害者身份调用 /api/*（同源自动带 cookie），
 *   读取其全部邮件、改 DNS、删子域名……等同于账户接管。
 *   `nosniff` 拦不住 —— 服务端已经明确声明了 text/html。
 *
 * ⚠️ 2026-09-25 审计（P0）：上面那次修复**只堵住了 text/html，漏了 SVG**。
 *   原实现是 `INLINE_PREFIXES = ["image/", ...]`，而 `image/svg+xml` 命中
 *   `image/` 前缀 → 仍然 inline → 同一条利用链换个扩展名就复现了。
 *   现在判定逻辑已抽到 `worker/src/content-type.ts`（全站唯一事实源），
 *   那里先过精确黑名单、再过 `+xml` 后缀闸，最后才套前缀白名单。
 */

async function proxyObject(
  env: Env,
  key: string,
  request: Request,
  publicLink: boolean,
  bucketId?: string | null
): Promise<Response> {
  const range = request.headers.get("Range") ?? undefined
  const method = request.method.toUpperCase()
  const filename = key.split("/").pop() || "file"

  // HEAD：只回元信息（部分客户端/预览会用）
  //
  // ⚠️ 2026-09-25 审计（低）：HEAD 分支原先**完全绕过了类型收口**，
  // 把 R2 里存的原始 Content-Type（可能是 image/svg+xml / text/html）
  // 直接回给任何匿名调用者，与 GET 的行为不一致。HEAD 没有正文所以
  // 不能直接触发 XSS，但会泄露对象的真实存储类型，也会让 CDN/客户端
  // 对同一 URL 做出与 GET 不同的缓存与嗅探判断。现在两条分支共用同一套头部。
  if (method === "HEAD") {
    const head = await headObject(env, key, bucketId)
    if (!head) return new Response(null, { status: 404 })
    const { contentType, contentDisposition } = contentDispositionFor(
      head.contentType,
      filename
    )
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Length": String(head.size),
        "Content-Type": contentType,
        "Content-Disposition": contentDisposition,
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": publicLink ? "public, max-age=300" : "private, no-store",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  const upstream = await getObject(env, key, range, bucketId)
  const headers = new Headers()
  for (const name of [
    "content-type",
    "content-length",
    "etag",
    "last-modified",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }

  // 直链是公开且内容可变的：用较短的缓存时间，兼顾 CDN 与更新及时性
  headers.set("Cache-Control", publicLink ? "public, max-age=300" : "private, no-store")
  headers.set("X-Content-Type-Options", "nosniff")

  // 允许站点内嵌引用（图片/视频），否则浏览器会因同源策略无法展示
  headers.set("Access-Control-Allow-Origin", "*")

  // 类型收口：非白名单类型一律降级为二进制附件，避免用户上传的 HTML/SVG
  // 在本站主源上被执行（存储型 XSS）。直链面向任意外部访客，必须假定内容不可信。
  // 判定逻辑见 worker/src/content-type.ts（含 image/svg+xml 的修复）。
  const { contentType, contentDisposition } = contentDispositionFor(
    headers.get("content-type"),
    filename
  )
  headers.set("Content-Type", contentType)
  headers.set("Content-Disposition", contentDisposition)

  return new Response(upstream.body, { status: upstream.status, headers })
}

/**
 * GET /dl/<前缀>/<文件名> —— 默认直链。
 * 校验账户启用状态后反代 R2。
 */
export async function serveDirectLink(
  env: Env,
  request: Request,
  rest: string
): Promise<Response> {
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "网盘存储未配置", "R2_NOT_CONFIGURED")
  }

  const segments = rest.split("/").filter(Boolean)
  if (segments.length < 2) {
    throw new ApiError(404, "直链格式不正确", "NOT_FOUND")
  }

  // safeDecode：非法百分号编码（`%zz`、孤立 `%`）此前会抛 URIError → 500，
  // 语义上应为 400；顺带在解码后立刻拒绝路径穿越段。
  const prefix = safeDecode(segments[0]).toLowerCase()
  const filename = segments
    .slice(1)
    .map(safeDecode)
    .join("/")

  if (hasDotSegment(filename)) {
    throw new ApiError(404, "文件不存在", "NOT_FOUND")
  }

  const account = await env.DB.prepare(
    "SELECT * FROM storage_accounts WHERE prefix = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(prefix)
    .first<StorageAccountRow>()

  if (!account || account.enabled !== 1) {
    throw new ApiError(404, "文件不存在", "NOT_FOUND")
  }

  return proxyObject(env, `${account.prefix}/${filename}`, request, true, account.bucket_id)
}

/**
 * 自定义域名直链：请求 Host 命中 storage_prefixes 时调用。
 * 路径即文件名（支持子目录）。
 */
export async function serveHostedDirectLink(
  env: Env,
  request: Request,
  fqdn: string
): Promise<Response> {
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "网盘存储未配置", "R2_NOT_CONFIGURED")
  }

  const mapping = await env.DB.prepare(
    "SELECT * FROM storage_prefixes WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first<{ id: string; user_id: string; r2_prefix: string }>()

  if (!mapping) return new Response("Not Found", { status: 404 })

  const account = await env.DB.prepare(
    "SELECT * FROM storage_accounts WHERE user_id = ?"
  )
    .bind(mapping.user_id)
    .first<StorageAccountRow>()

  if (!account || account.enabled !== 1) {
    return new Response("Not Found", { status: 404 })
  }

  const path = new URL(request.url).pathname.replace(/^\/+/, "")
  if (!path) {
    // 根路径给一个极简说明页，避免直接 404 让人困惑
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>${fqdn}</title>
<body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto">
<h1 style="font-size:1.1rem">${fqdn}</h1>
<p style="color:#666">这是 Doulor Cloud 的 R2 直链域名。请直接访问具体文件路径，例如
<code>/${encodeURIComponent(account.prefix)}/example.png</code>。</p>
</body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    )
  }

  return proxyObject(env, `${account.prefix}/${path}`, request, true, account.bucket_id)
}

/** 判断 Host 是否为一个已绑定的自定义直链域名 */
export async function isHostedDirectLinkHost(
  env: Env,
  host: string
): Promise<boolean> {
  if (!(await isStorageConfigured(env))) return false
  const row = await env.DB.prepare(
    "SELECT id FROM storage_prefixes WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(host)
    .first()
  return Boolean(row)
}

/** 清空某用户全部文件（管理员用） */
export async function purgeUserStorage(env: Env, userId: string): Promise<number> {
  const account = await loadAccount(env, userId)
  if (!account) return 0
  const deleted = await deletePrefix(env, `${account.prefix}/`, 50, account.bucket_id)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM storage_objects WHERE user_id = ?").bind(userId),
    env.DB.prepare(
      "UPDATE storage_accounts SET used_bytes = 0, file_count = 0, updated_at = ? WHERE user_id = ?"
    ).bind(new Date().toISOString(), userId),
  ])
  return deleted
}

export { recalculateUsage }