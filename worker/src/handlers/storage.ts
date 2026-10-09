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
import { requireFeatureUser, isPrivileged } from "../auth"
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
} from "../r2"
import { audit, formatBytes, getSettingBool, getSettingNumber, getSettings } from "../settings"
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

/**
 * Cloudflare 边缘对「请求体」的大小上限（Free/Pro 套餐 100MB）。
 * token 模式的桶走 Worker 中转上传，超过这个值会在进入 Worker 前被 413，
 * 因此这里留 5MB 余量、以 95MB 作为中转模式的实际可用上限。
 */
const CF_PROXY_BODY_LIMIT = 95 * 1024 * 1024

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
 * 规范化目录路径（相对该账号 prefix）。
 *
 * 目录只是 R2 的 key 前缀，所以「路径」就是若干段的拼接。这里做三件事：
 *   1. 丢掉空段（`a//b` → `a/b`）、去掉首尾斜杠；
 *   2. 逐段过 sanitizeFilename（去控制字符、收敛连续点），
 *   3. **显式拒绝 `.` / `..` 段**（路径穿越）。
 *
 * ⚠️ 必须先判 `.`/`..` 再 sanitize：sanitizeFilename 会把 `..` 收敛成空串、
 * 再兜底成 `file-<时间戳>`，那样「..」会被静默改成一个怪异目录名而不是被拒绝。
 *
 * 空输入（含 `""` / `/`）返回 `""`，表示「根目录」。
 */
export function normalizeFolderPath(input: unknown): string {
  if (typeof input !== "string") return ""
  const raw = input.split("/").map((s) => s.trim()).filter(Boolean)
  if (raw.length === 0) return ""
  if (raw.length > MAX_FOLDER_DEPTH) {
    throw new ApiError(400, `目录层级过深（最多 ${MAX_FOLDER_DEPTH} 层）`, "BAD_REQUEST")
  }
  const segments: string[] = []
  for (const segment of raw) {
    if (segment === "." || segment === "..") {
      throw new ApiError(400, "目录名不合法", "BAD_REQUEST")
    }
    const cleaned = sanitizeFilename(segment)
    if (!cleaned || cleaned === "." || cleaned === "..") {
      throw new ApiError(400, "目录名不合法", "BAD_REQUEST")
    }
    segments.push(cleaned)
  }
  return segments.join("/")
}

/** 目录最大嵌套层数：防止 `a/a/a/...` 造出超长 key（D1 与 URL 都不友好） */
const MAX_FOLDER_DEPTH = 12

/** 按段做 URI 编码：`a b/c.png` → `a%20b/c.png`（不能整串 encode，否则斜杠也被编码） */
export function encodePathSegments(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/")
}

/**
 * 列某一层的目录与文件（全模式通用）。
 *
 * 为什么不问 R2 要 delimiter：`r2.ts::listObjects` 的 token 模式（CF REST API）
 * 与 S3 模式返回结构不同，且当前实现并未解析 `CommonPrefixes`。为了在**两种凭据
 * 模式**下行为一致，这里改成「把该目录子树分页拉完、在前缀层面手工切一层」。
 * 个人网盘的文件量级（几百到几千）完全可以承受，且不会因模式不同而出错。
 *
 * 代价：会读完整棵子树（而不是只读一层）。因此有页数上限，超出时 truncated = true。
 */
interface LevelListing {
  /** `path` 一律相对**账号根目录**（不是相对当前目录），调用方直接拿来拼 R2 key 与直链 */
  folders: { name: string; path: string }[]
  /** `name` 是叶子文件名（用于显示）；`path` 是相对**账号根目录**的完整路径 */
  files: { name: string; path: string; size: number; lastModified: string | null }[]
  truncated: boolean
}

const SCAN_PAGE_SIZE = 1000
const SCAN_MAX_PAGES = 12 // 最多扫 12000 个对象

async function listLevel(
  env: Env,
  account: StorageAccountRow,
  dirPath: string
): Promise<LevelListing> {
  const scanPrefix = dirPath ? `${account.prefix}/${dirPath}/` : `${account.prefix}/`
  const folders = new Set<string>()
  const files: LevelListing["files"] = []
  let cursor: string | undefined
  let round = 0

  for (; round < SCAN_MAX_PAGES; round++) {
    const page = await listObjects(env, scanPrefix, {
      limit: SCAN_PAGE_SIZE,
      cursor,
      bucketId: account.bucket_id,
    })
    for (const obj of page.objects) {
      const rel = obj.key.slice(scanPrefix.length)
      if (!rel) continue // 该目录自身的占位对象（`<prefix>/<dir>/`）
      const slash = rel.indexOf("/")
      if (slash === -1) {
        if (obj.key.endsWith(MARKER_SUFFIX)) continue
        // 🔴 这里必须补回 `dirPath` 前缀：`rel` 只是「当前目录内」的文件名，但下游把它当
        // 「相对账号根目录」用（拼直链 `https://<fqdn>/<path>`、拼 R2 key `<prefix>/<path>`）。
        // 少这一层目录名的后果（2026-10-09 站长实爆）：
        //   ① 目录里的文件，复制出来的直链指向**根目录**的同名文件 ⇒ 404 / 拿到别的文件；
        //   ② 删除、多选删的 key 也是 `<prefix>/<文件名>` ⇒ 删了一个根本不存在的对象，静默成功的假象。
        files.push({
          name: rel,
          path: dirPath ? `${dirPath}/${rel}` : rel,
          size: obj.size,
          lastModified: obj.lastModified,
        })
      } else {
        // 只需第一段：更深的层级归到对应的子目录名下（天然去重）
        folders.add(rel.slice(0, slash))
      }
    }
    if (!page.truncated || !page.cursor) break
    cursor = page.cursor
  }

  return {
    folders: [...folders]
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
      .map((name) => ({ name, path: dirPath ? `${dirPath}/${name}` : name })),
    files: files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    truncated: round >= SCAN_MAX_PAGES,
  }
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
        isPrivileged(user.role)
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
    isPrivileged(user.role)
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

/**
 * GET /api/storage/objects?path=<目录> —— 列出某一层（子目录 + 文件，以 R2 为准）。
 * 不传 path 即根目录。旧版是按 cursor 翻页，现在改成按目录分层返回：
 * 目录本身就是 key 前缀，所以「进目录」= 换一个 prefix 再列一次。
 */
export async function listStorageObjects(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const url = new URL(request.url)
  const path = normalizeFolderPath(url.searchParams.get("path") ?? "")
  const level = await listLevel(env, account, path)

  return json({
    path,
    folders: level.folders,
    objects: level.files.map((f) => ({
      key: `${account.prefix}/${f.path}`,
      filename: f.name,
      path: f.path,
      size: f.size,
      lastModified: f.lastModified,
    })),
    truncated: level.truncated,
    usedBytes: account.used_bytes,
    quotaBytes: account.quota_bytes,
  })
}

/**
 * POST /api/storage/folder —— 新建目录。
 * body: { path: string }（相对账号根目录，可含 `/` 建多级）
 *
 * 目录本身不落 D1（避免「表里有、桶里没有」的两套账）：建目录 = 写一个
 * `<prefix>/<path>/` 的零字节占位对象，这样**空目录**也能被 listLevel 列出来。
 */
export async function createFolder(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  await guardUploadRate(env, user.id)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")
  if (account.enabled !== 1) {
    throw new ApiError(403, "网盘已关闭，请先启用", "STORAGE_DISABLED")
  }

  const body = (await request.json().catch(() => ({}))) as { path?: string }
  const path = normalizeFolderPath(body.path ?? "")
  if (!path) throw new ApiError(400, "请输入目录名", "BAD_REQUEST")

  const key = `${account.prefix}/${path}/`
  // 幂等：同名目录已存在时覆盖写占位对象即可，不该报错
  await putObject(env, key, "", "application/x-directory", account.bucket_id)

  await audit(env, user.id, "storage.folder.create", `新建目录 ${key}`)
  return json({ path }, 201)
}

/**
 * POST /api/storage/folder/delete —— 递归删除目录及其下全部文件。
 * body: { path: string }
 *
 * ⚠️ 这是不可逆操作，且会连带删除目录下的所有文件（前端必须二次确认）。
 */
export async function deleteFolder(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const body = (await request.json().catch(() => ({}))) as { path?: string }
  const path = normalizeFolderPath(body.path ?? "")
  if (!path) throw new ApiError(400, "不能删除根目录", "BAD_REQUEST")

  const target = `${account.prefix}/${path}/`

  // 按 R2 实际内容递归删（含各级占位对象），再按剩余行重算用量，保持账实一致。
  const removed = await deletePrefix(env, target, 60, account.bucket_id)

  const now = new Date().toISOString()
  await env.DB.batch([
    // ⚠️ 用 substr 比前缀而不用 LIKE：D1 的 LIKE 模式最长 50 字符（见 src/sql-like.ts），
    // 长目录名用 LIKE 会直接 500。substr 没有这个限制，且这里是要精确前缀匹配。
    env.DB.prepare(
      "DELETE FROM storage_objects WHERE user_id = ? AND substr(r2_key, 1, ?) = ?"
    ).bind(user.id, target.length, target),
    env.DB.prepare(
      `UPDATE storage_accounts
          SET used_bytes = COALESCE((SELECT SUM(size) FROM storage_objects WHERE user_id = ?), 0),
              file_count = (SELECT COUNT(*) FROM storage_objects WHERE user_id = ?),
              updated_at = ?
        WHERE user_id = ?`
    ).bind(user.id, user.id, now, user.id),
  ])

  await audit(env, user.id, "storage.folder.delete", `删除目录 ${target}（${removed} 个对象）`)
  return json({ removed })
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
    /** 目标目录（相对账号根目录）；不传 = 根目录 */
    folder?: string
  }

  const filename = sanitizeFilename(body.filename ?? "")
  const folder = normalizeFolderPath(body.folder ?? "")
  const size = Math.max(0, Math.trunc(Number(body.size ?? 0)))
  // 管理员不受单文件大小限制（仍受 Worker 请求体上限约束）
  const maxFile =
    isPrivileged(user.role)
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
  const relativePath = folder ? `${folder}/${filename}` : filename
  const key = `${account.prefix}/${relativePath}`
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

  // ⚠️ 用户反馈 4f86f202：132MB 上传报 413。根因不是代码限制，而是**Cloudflare
  // 边缘的请求体上限**（Free/Pro 套餐 100MB）：token 模式的桶走 Worker 中转，
  // 请求体要经过 CF 边缘，超过 100MB 在进入 Worker **之前**就被 413 掉，
  // 我们连返回自定义错误的机会都没有（表现为浏览器里一个光秃秃的 413）。
  // 因此在签发中转上传地址时就**提前拦下**，给出可执行的说明。
  if (uploadUrl.startsWith("/api/storage/proxy-upload") && size > CF_PROXY_BODY_LIMIT) {
    throw new ApiError(
      400,
      `当前存储为「中转模式」，单文件最大约 ${Math.round(CF_PROXY_BODY_LIMIT / 1024 / 1024)} MB` +
        `（Cloudflare 边缘对经过服务器的请求体有 100 MB 上限）。` +
        `如需上传更大的文件，请让管理员把存储桶改为 S3 直传模式（配置 AK/SK），浏览器可直传 R2、不受此限制。`,
      "PROXY_UPLOAD_TOO_LARGE"
    )
  }

  return json({
    uploadUrl,
    key,
    filename,
    path: relativePath,
    directLink: `/dl/${encodeURIComponent(account.prefix)}/${encodePathSegments(relativePath)}`,
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
    isPrivileged(user.role)
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

/** POST /api/storage/objects/delete —— 批量删除文件（body { keys: string[] }） */
export async function deleteStorageObjects(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const body = (await request.json().catch(() => ({}))) as { keys?: unknown }
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((k): k is string => typeof k === "string" && k.length > 0)
    : []
  if (keys.length === 0) throw new ApiError(400, "请选择要删除的文件", "BAD_REQUEST")
  if (keys.length > 200) throw new ApiError(400, "一次最多删除 200 个文件", "BAD_REQUEST")

  // 先校验全部 key 属于该账号（越权直接拒绝，避免「删一半」）
  for (const key of keys) assertKeyOwned(account, key)

  const placeholders = keys.map(() => "?").join(",")
  const rows = await env.DB.prepare(
    `SELECT r2_key, size FROM storage_objects WHERE user_id = ? AND r2_key IN (${placeholders})`
  )
    .bind(user.id, ...keys)
    .all<{ r2_key: string; size: number }>()
  const found = rows.results ?? []
  const removedBytes = found.reduce((s, r) => s + (r.size ?? 0), 0)

  // 逐个删 R2 对象：单个失败不阻断其余（与单删一致的容错口径）
  for (const key of keys) {
    try {
      await deleteObject(env, key, account.bucket_id)
    } catch {
      /* 忽略单个失败，下面按 DB 记录清理并重算用量 */
    }
  }

  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM storage_objects WHERE user_id = ? AND r2_key IN (${placeholders})`
    ).bind(user.id, ...keys),
    env.DB.prepare(
      `UPDATE storage_accounts
          SET used_bytes = MAX(0, used_bytes - ?),
              file_count = (SELECT COUNT(*) FROM storage_objects WHERE user_id = ?),
              updated_at = ?
        WHERE user_id = ?`
    ).bind(removedBytes, user.id, now, user.id),
  ])

  return json({ deleted: keys.length })
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

// ---- 目录分享 ----

interface StorageShareRow {
  id: string
  user_id: string
  token: string
  /** 相对该账号 prefix 的目录路径；'' = 分享整个根目录 */
  path: string
  title: string | null
  enabled: number
  created_at: string
  updated_at: string
}

/** 每个用户最多保留的分享条数（防止无限刷表 / 刷 token） */
const MAX_SHARES_PER_USER = 50

/**
 * 生成分享 token：16 字节随机 → base64url（22 字符）。
 * 比 `generateToken()`（32 字节 hex = 64 字符）短，URL 里可读性好，且熵仍足够
 * （2^128 空间，不可能被猜中）。
 */
function randomShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let raw = ""
  for (const b of bytes) raw += String.fromCharCode(b)
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function shareDisplayName(row: StorageShareRow): string {
  if (row.title) return row.title
  if (row.path) return row.path.split("/").pop() ?? row.path
  return "共享文件"
}

function toPublicShare(row: StorageShareRow, origin: string) {
  return {
    id: row.id,
    token: row.token,
    path: row.path,
    title: shareDisplayName(row),
    enabled: row.enabled === 1,
    url: `${origin}/s/${row.token}`,
    createdAt: row.created_at,
  }
}

/** GET /api/storage/shares —— 列出我创建的目录分享 */
export async function listShares(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")

  const rows = await env.DB.prepare(
    "SELECT * FROM storage_shares WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all<StorageShareRow>()

  const origin = new URL(request.url).origin
  return json({ shares: (rows.results ?? []).map((r) => toPublicShare(r, origin)) })
}

/**
 * POST /api/storage/shares —— 为某个目录创建分享。
 * body: { path?: string; title?: string }
 *
 * 同一个目录已有**启用中**的分享时直接复用它，避免用户点两次生成两条链接。
 */
export async function createShare(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通网盘", "NOT_ENABLED")
  if (account.enabled !== 1) {
    throw new ApiError(403, "网盘直链已关闭，请先启用后再分享", "STORAGE_DISABLED")
  }

  const body = (await request.json().catch(() => ({}))) as { path?: string; title?: string }
  const path = normalizeFolderPath(body.path ?? "")
  const origin = new URL(request.url).origin

  const existing = await env.DB.prepare(
    "SELECT * FROM storage_shares WHERE user_id = ? AND path = ? AND enabled = 1 LIMIT 1"
  )
    .bind(user.id, path)
    .first<StorageShareRow>()
  if (existing) return json({ share: toPublicShare(existing, origin), reused: true })

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM storage_shares WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()
  if ((count?.c ?? 0) >= MAX_SHARES_PER_USER) {
    throw new ApiError(
      400,
      `分享数量已达上限（${MAX_SHARES_PER_USER} 条），请先删除不再需要的`,
      "TOO_MANY_SHARES"
    )
  }

  const id = uuid()
  const token = randomShareToken()
  const now = new Date().toISOString()
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 80)
      : null

  await env.DB.prepare(
    `INSERT INTO storage_shares (id, user_id, token, path, title, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(id, user.id, token, path, title, now, now)
    .run()

  await audit(
    env,
    user.id,
    "storage.share.create",
    `分享目录 ${account.prefix}/${path ? `${path}/` : ""}`
  )

  const row: StorageShareRow = {
    id,
    user_id: user.id,
    token,
    path,
    title,
    enabled: 1,
    created_at: now,
    updated_at: now,
  }
  return json({ share: toPublicShare(row, origin), reused: false }, 201)
}

/** POST /api/storage/shares/delete —— 删除分享（链接立即失效） */
export async function deleteShare(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const body = (await request.json().catch(() => ({}))) as { id?: string }
  const id = typeof body.id === "string" ? body.id : ""
  if (!id) throw new ApiError(400, "缺少分享 ID", "BAD_REQUEST")

  const row = await env.DB.prepare(
    "SELECT id, path FROM storage_shares WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<{ id: string; path: string }>()
  if (!row) throw new ApiError(404, "分享不存在", "NOT_FOUND")

  await env.DB.prepare("DELETE FROM storage_shares WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .run()

  await audit(env, user.id, "storage.share.delete", `删除目录分享 ${row.path || "(根目录)"}`)
  return json({ ok: true })
}

/** POST /api/storage/shares/toggle —— 启用/停用分享（停用后链接 404，配置保留） */
export async function toggleShare(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "r2")
  const body = (await request.json().catch(() => ({}))) as { id?: string; enabled?: unknown }
  const id = typeof body.id === "string" ? body.id : ""
  if (!id) throw new ApiError(400, "缺少分享 ID", "BAD_REQUEST")
  const enabled = body.enabled === true ? 1 : 0

  const res = await env.DB.prepare(
    "UPDATE storage_shares SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?"
  )
    .bind(enabled, new Date().toISOString(), id, user.id)
    .run()
  if ((res.meta?.changes ?? 0) === 0) throw new ApiError(404, "分享不存在", "NOT_FOUND")

  await audit(env, user.id, "storage.share.toggle", `${enabled ? "启用" : "停用"}目录分享 ${id}`)
  return json({ enabled: enabled === 1 })
}

// ---- 公开分享页 ----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** 公开分享的 404：面向浏览器，回 HTML 而不是 JSON */
function shareNotFound(): Response {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>分享不存在</title>
<style>
:root{--bg:#f6f6f7;--fg:#18181b;--muted:#71717a}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--fg:#f4f4f5;--muted:#a1a1aa}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--fg);
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
p{margin:0;font-size:.95rem;color:var(--muted)}
</style></head>
<body><p>该分享链接不存在、已被关闭，或分享者已停止直链。</p></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  )
}

/**
 * GET /s/<token>[/f/<相对路径>] —— 公开的目录分享页。
 *
 *   /s/<token>                目录页（列出分享目录下的内容）
 *   /s/<token>?p=<子目录>      子目录页（相对分享目录）
 *   /s/<token>/f/<路径>?dl=1   读取具体文件（经 Worker 反代，复用直链的类型收口）
 *
 * 失效条件：分享被停用/删除、分享者关闭了网盘直链、分享者账号被封禁。
 */
export async function serveStorageShare(
  env: Env,
  request: Request,
  rest: string
): Promise<Response> {
  if (!(await isStorageConfigured(env))) return shareNotFound()

  const slash = rest.indexOf("/")
  const token = safeDecode(slash === -1 ? rest : rest.slice(0, slash))
  const tail = slash === -1 ? "" : rest.slice(slash + 1)
  if (!token) return shareNotFound()

  const share = await env.DB.prepare(
    "SELECT * FROM storage_shares WHERE token = ? AND enabled = 1 LIMIT 1"
  )
    .bind(token)
    .first<StorageShareRow>()
  if (!share) return shareNotFound()

  const account = await env.DB.prepare("SELECT * FROM storage_accounts WHERE user_id = ?")
    .bind(share.user_id)
    .first<StorageAccountRow>()
  if (!account || account.enabled !== 1) return shareNotFound()

  // 账号被封禁 → 分享一并失效（否则封号后链接仍在往外分发内容）
  const owner = await env.DB.prepare("SELECT status FROM users WHERE id = ?")
    .bind(share.user_id)
    .first<{ status: string }>()
  if (!owner || owner.status !== "active") return shareNotFound()

  if (tail.startsWith("f/")) {
    const rel = safeDecode(tail.slice(2))
    const segments = rel.split("/").filter(Boolean)
    if (segments.length === 0 || hasDotSegment(rel)) return shareNotFound()

    const relative = segments.join("/")
    const key = `${account.prefix}/${share.path ? `${share.path}/` : ""}${relative}`
    const res = await proxyObject(env, key, request, true, account.bucket_id)

    // ?dl=1 → 强制下载（白名单类型默认是 inline，分享页里「下载」按钮要的是附件）
    const url = new URL(request.url)
    if (url.searchParams.get("dl") === "1" && res.status < 400) {
      const name = segments[segments.length - 1].replace(/["\\\r\n]/g, "_").slice(0, 180)
      const headers = new Headers(res.headers)
      headers.set(
        "Content-Disposition",
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`
      )
      return new Response(res.body, { status: res.status, headers })
    }
    return res
  }

  return renderSharePage(env, request, token, share, account)
}

/** 站点 Logo 的云图标（lucide `cloud`，与前端 src/components/logo.tsx 同一枚） */
const SHARE_ICON_CLOUD = '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'
/** GitHub 章鱼猫（官方 octicon mark-github，16×16） */
const GITHUB_MARK_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
/** 公开分享页页脚的仓库入口（与前端 src/lib/site-links.ts 的 REPO_URL 保持一致） */
const SHARE_REPO_URL = "https://github.com/Doulor/DoulorCloud"
const SHARE_ICON_FOLDER =
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
const SHARE_ICON_FILE =
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'
const SHARE_ICON_DOWNLOAD =
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'

/** 渲染分享目录页（黑白灰极简，跟随系统深浅色） */
async function renderSharePage(
  env: Env,
  request: Request,
  token: string,
  share: StorageShareRow,
  account: StorageAccountRow
): Promise<Response> {
  const urlPrefix = `/s/${token}`
  const sub = normalizeFolderPath(new URL(request.url).searchParams.get("p") ?? "")
  const dirPath = [share.path, sub].filter(Boolean).join("/")
  const level = await listLevel(env, account, dirPath)

  // 站点入口：与 handlers/oauth.ts 的 canonicalOrigin 同一口径（`cloud.<ROOT_DOMAIN>`），
  // 不用请求自身的 Host —— 分享页在 `doulor.cn/s/*` 上也能打开，那时 Host 不是站点首页。
  const siteUrl = `https://cloud.${env.ROOT_DOMAIN}`

  const title = shareDisplayName(share)
  const subSegments = sub.split("/").filter(Boolean)

  // 面包屑：分享根 → 各级子目录
  const crumbs: string[] = [`<span class="cur">${escapeHtml(title)}</span>`]
  for (let i = 0; i < subSegments.length; i++) {
    const rel = subSegments.slice(0, i + 1).join("/")
    const isLast = i === subSegments.length - 1
    crumbs.push(
      isLast
        ? `<span class="cur">${escapeHtml(subSegments[i])}</span>`
        : `<a href="${urlPrefix}?p=${encodeURIComponent(rel)}">${escapeHtml(subSegments[i])}</a>`
    )
  }

  const rows: string[] = []
  for (const folder of level.folders) {
    const rel = [sub, folder.name].filter(Boolean).join("/")
    rows.push(
      `<a class="row" href="${urlPrefix}?p=${encodeURIComponent(rel)}">` +
        `<svg viewBox="0 0 24 24">${SHARE_ICON_FOLDER}</svg>` +
        `<span class="name">${escapeHtml(folder.name)}</span>` +
        `<span class="meta">目录</span></a>`
    )
  }
  for (const file of level.files) {
    const rel = [sub, file.name].filter(Boolean).join("/")
    const href = `${urlPrefix}/f/${encodePathSegments(rel)}`
    rows.push(
      `<a class="row" href="${href}?dl=1">` +
        `<svg viewBox="0 0 24 24">${SHARE_ICON_FILE}</svg>` +
        `<span class="name">${escapeHtml(file.name)}</span>` +
        `<span class="meta">${escapeHtml(formatBytes(file.size))}</span>` +
        `<span class="dl"><svg viewBox="0 0 24 24">${SHARE_ICON_DOWNLOAD}</svg></span></a>`
    )
  }

  const total = level.folders.length + level.files.length
  const list = rows.length
    ? rows.join("")
    : `<div class="empty">这个目录还是空的</div>`
  const moreHint = level.truncated
    ? `<p class="hint">内容较多，仅显示部分条目，请进入具体子目录查看。</p>`
    : ""

  const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · 文件分享</title>
<style>
:root{--bg:#f6f6f7;--fg:#18181b;--muted:#71717a;--card:rgba(255,255,255,.72);
--line:rgba(24,24,27,.09);--hover:rgba(24,24,27,.045)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--fg:#f4f4f5;--muted:#a1a1aa;
--card:rgba(24,24,27,.66);--line:rgba(244,244,245,.11);--hover:rgba(244,244,245,.055)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);line-height:1.5;-webkit-font-smoothing:antialiased;
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
padding:clamp(16px,4vw,48px) clamp(12px,4vw,24px)}
.wrap{max-width:52rem;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;
backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.head{display:flex;align-items:center;gap:14px;padding:18px 22px}
.brand{width:38px;height:38px;flex:none;display:flex;align-items:center;justify-content:center;
border-radius:12px;background:var(--fg);color:var(--bg)}
.brand>svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;
stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-size:1.06rem;font-weight:600;letter-spacing:-.01em}
.sub{margin:3px 0 0;font-size:.8rem;color:var(--muted)}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin:16px 2px;font-size:.85rem}
.crumbs a,.crumbs .cur{padding:3px 8px;border-radius:8px;text-decoration:none}
.crumbs a{color:var(--muted)}
.crumbs a:hover{background:var(--hover);color:var(--fg)}
.crumbs .cur{color:var(--fg);font-weight:500}
.crumbs .sep{color:var(--muted);opacity:.45;font-size:.8rem}
.list{overflow:hidden}
.row{display:flex;align-items:center;gap:12px;padding:12px 18px;color:inherit;text-decoration:none;
border-bottom:1px solid var(--line);transition:background .12s}
.row:last-child{border-bottom:0}
.row:hover{background:var(--hover)}
.row>svg{width:19px;height:19px;flex:none;fill:none;stroke:var(--muted);stroke-width:1.6;
stroke-linecap:round;stroke-linejoin:round}
.row .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.92rem}
.row .meta{flex:none;font-size:.78rem;color:var(--muted);font-variant-numeric:tabular-nums}
.row .dl{flex:none;display:flex}
.row .dl>svg{width:17px;height:17px;fill:none;stroke:var(--muted);stroke-width:1.6;
stroke-linecap:round;stroke-linejoin:round}
.empty{padding:40px 18px;text-align:center;color:var(--muted);font-size:.88rem}
.hint{margin:12px 2px 0;font-size:.78rem;color:var(--muted)}
footer{margin:22px 2px 0;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;
gap:8px 18px;font-size:.76rem;color:var(--muted)}
footer a{display:inline-flex;align-items:center;gap:6px;color:inherit;text-decoration:none;
transition:color .12s}
footer a:hover{color:var(--fg)}
footer svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;
stroke-linecap:round;stroke-linejoin:round}
footer a.gh svg{fill:currentColor;stroke:none}
</style></head>
<body><div class="wrap">
<header class="card head">
<span class="brand" aria-hidden="true"><svg viewBox="0 0 24 24">${SHARE_ICON_CLOUD}</svg></span>
<div><h1>${escapeHtml(title)}</h1><p class="sub">共 ${total} 项 · 由 Doulor Cloud 网盘分享</p></div>
</header>
<nav class="crumbs">${crumbs.join('<span class="sep">›</span>')}</nav>
<main class="card list">${list}</main>
${moreHint}
<footer>
<a href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener">
<svg viewBox="0 0 24 24" aria-hidden="true">${SHARE_ICON_CLOUD}</svg>Doulor Cloud · 直链网盘</a>
<a class="gh" href="${SHARE_REPO_URL}" target="_blank" rel="noopener noreferrer">
<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="${GITHUB_MARK_PATH}"/></svg>GitHub</a>
</footer>
</div></body></html>`

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/** 清空某用户全部文件（管理员用） */
export async function purgeUserStorage(env: Env, userId: string): Promise<number> {
  const account = await loadAccount(env, userId)
  if (!account) return 0
  const deleted = await deletePrefix(env, `${account.prefix}/`, 50, account.bucket_id)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM storage_objects WHERE user_id = ?").bind(userId),
    // 目录分享也要一并清掉：文件已经没了，留着空壳分享只会得到一堆 404
    env.DB.prepare("DELETE FROM storage_shares WHERE user_id = ?").bind(userId),
    env.DB.prepare(
      "UPDATE storage_accounts SET used_bytes = 0, file_count = 0, updated_at = ? WHERE user_id = ?"
    ).bind(new Date().toISOString(), userId),
  ])
  return deleted
}

export { recalculateUsage }