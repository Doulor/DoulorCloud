/**
 * R2 存储客户端（S3 兼容 API + AWS SigV4 签名）。
 *
 * 为什么不用 `[[r2_buckets]]` 绑定：
 *   桶分布在不同 Cloudflare 账户（adoulor / bdoulor），而本 Worker 部署在 Doulor 账户，
 *   跨账户无法绑定，只能走 S3 兼容接口。
 *
 * 多桶支持：
 *   - `bucketId` 为空 → 用 env 里的默认桶（R2_S3_* 四个变量），兼容历史配置
 *   - `bucketId` 指定 → 从 D1 `r2_buckets` 读配置并解密 S3 凭据
 *   免费额度每账户 10 GB，多桶用于横向扩容（详见 migrations/0022）。
 *
 * 因此这里用 WebCrypto 手写 SigV4（不引入 aws4fetch 等依赖）。
 * 签名逻辑与已用 Python 原型验证过的实现一致：
 *   GET  list / PUT 上传 / GET 下载 / DELETE 删除 均返回 200/204。
 *
 * 桶保持私有：所有读取都经 Worker 反代（见 handlers/storage.ts 的 /dl 路由），
 * 不使用 r2.dev 公开地址（R2 自定义域必须与桶同账户，跨账户无法绑定）。
 */
import { ApiError } from "./http"
import { decryptSecret } from "./crypto"
import type { Env } from "./env"

const REGION = "auto"
const SERVICE = "s3"
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"

interface R2Config {
  endpoint: string
  bucket: string
  /** 传输模式：s3 = S3 签名（AK/SK）；token = Cloudflare REST API */
  mode: "s3" | "token"
  accessKeyId: string
  secretAccessKey: string
  /** token 模式下的账户 ID（从 endpoint 或桶记录推导） */
  accountId?: string
}

/**
 * 从 S3 endpoint 推导账户 ID。
 * 形如 https://<account_id>.r2.cloudflarestorage.com
 */
function accountIdFromEndpoint(endpoint: string): string | null {
  const m = /^https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i.exec(endpoint)
  return m ? m[1] : null
}

/**
 * 判断凭据类型。
 * Cloudflare API Token 以 `cfut_` 开头且比 S3 的 Access Key ID（32 位 hex）长得多，
 * 用户在「Access Key ID」字段里填 token 时自动切到 REST API 模式。
 */
function isApiToken(credential: string): boolean {
  return credential.startsWith("cfut_") || credential.startsWith("cfat_")
}

/** 桶配置行（r2_buckets 表） */
export interface R2BucketRow {
  id: string
  name: string
  account_id: string | null
  endpoint: string
  bucket_name: string
  /** 加密的凭据；空字符串表示「用全局 R2_API_TOKEN」 */
  access_key_id_enc: string
  secret_key_enc: string
  analytics_token_enc: string | null
  max_users: number
  quota_per_user: number
  enabled: number
  sort_order: number
  /** 'user' = 用户网盘桶（参与多人分配）；'platform' = 平台数据（名片/分享箱） */
  kind: string
  created_at: string
  updated_at: string
}

/**
 * 平台数据桶 id 缓存。
 * 平台桶只有一个，且每个请求都会用到（名片资源、分享箱），
 * 缓存可避免每次请求都查 D1。Worker isolate 复用时生效。
 */
let platformBucketCache: { id: string | null; at: number } | null = null

/**
 * 取平台数据桶的 id（kind='platform' 且启用）。
 *
 * 未配置平台桶时返回 null —— 调用方回退到 env 默认桶，
 * 保证在管理员配置平台桶之前，名片/分享箱仍能正常工作。
 */
export async function getPlatformBucketId(env: Env): Promise<string | null> {
  // 缓存 60 秒，兼顾性能与「刚配置完就能生效」
  const now = Date.now()
  if (platformBucketCache && now - platformBucketCache.at < 60_000) {
    return platformBucketCache.id
  }
  try {
    const row = await env.DB.prepare(
      "SELECT id FROM r2_buckets WHERE kind = 'platform' AND enabled = 1 ORDER BY sort_order ASC LIMIT 1"
    ).first<{ id: string }>()
    platformBucketCache = { id: row?.id ?? null, at: now }
    return row?.id ?? null
  } catch {
    // 迁移尚未执行（表/列不存在）时不要炸，回退默认桶
    platformBucketCache = { id: null, at: now }
    return null
  }
}

/**
 * 「有没有启用中的桶」缓存。
 *
 * ⚠️ 2026-10-01 性能：`hasManagedBuckets` 被 `isStorageConfigured` 在**每个**
 * 网盘/直链/名片/分享箱请求上调用一次。线上 D1 统计里
 * `SELECT 1 FROM r2_buckets WHERE enabled = 1 LIMIT 1` 一天跑了 **17.5 万次**
 * （全库最频繁的查询），每次都是整整一次 D1 往返（跨境用户 ~170ms）。
 * 而它只是在问「管理员配过桶没有」—— 配置变更极少，缓存 60 秒即可。
 * 与 platformBucketCache 同样靠 `invalidatePlatformBucketCache()` 失效。
 */
let managedBucketsCache: { value: boolean; at: number } | null = null

/** 清除桶相关缓存（管理员改动桶配置后调用）：平台桶 id + 「有没有启用中的桶」 */
export function invalidatePlatformBucketCache(): void {
  platformBucketCache = null
  managedBucketsCache = null
}

/** 从 env 读默认桶（历史配置，bucketId 为空时使用） */
function envConfig(env: Env): R2Config {
  const endpoint = env.R2_S3_ENDPOINT
  const bucket = env.R2_BUCKET
  const accessKeyId = env.R2_S3_ACCESS_KEY_ID
  const secretAccessKey = env.R2_S3_SECRET_ACCESS_KEY

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new ApiError(
      503,
      "网盘存储未配置（缺少 R2 S3 凭据）",
      "R2_NOT_CONFIGURED"
    )
  }

  const cleanEndpoint = endpoint.replace(/\/+$/, "")
  return {
    endpoint: cleanEndpoint,
    bucket,
    mode: isApiToken(accessKeyId) ? "token" : "s3",
    accessKeyId,
    secretAccessKey,
    accountId: accountIdFromEndpoint(cleanEndpoint) ?? undefined,
  }
}

/**
 * 解析桶配置。
 * bucketId 为空 → env 默认桶；否则查 D1 r2_buckets 并解密凭据。
 */
async function resolveBucket(env: Env, bucketId?: string | null): Promise<R2Config> {
  if (!bucketId) return envConfig(env)

  if (!env.SESSION_SECRET) {
    throw new ApiError(503, "未配置 SESSION_SECRET，无法读取桶凭据", "R2_NOT_CONFIGURED")
  }
  const row = await env.DB.prepare("SELECT * FROM r2_buckets WHERE id = ?")
    .bind(bucketId)
    .first<R2BucketRow>()
  if (!row) {
    throw new ApiError(404, `桶 ${bucketId} 不存在`, "R2_BUCKET_NOT_FOUND")
  }

  let accessKeyId = ""
  let secretAccessKey = ""
  // 凭据字段非空才解密；为空表示「用全局 R2_API_TOKEN」
  try {
    if (row.access_key_id_enc) {
      accessKeyId = await decryptSecret(row.access_key_id_enc, env.SESSION_SECRET)
    }
    if (row.secret_key_enc) {
      secretAccessKey = await decryptSecret(row.secret_key_enc, env.SESSION_SECRET)
    }
  } catch {
    throw new ApiError(
      500,
      `桶 ${row.name} 的凭据无法解密（SESSION_SECRET 可能已变更）`,
      "R2_CREDENTIAL_DECRYPT_FAILED"
    )
  }

  const cleanEndpoint = row.endpoint.replace(/\/+$/, "")
  const accountId = row.account_id || accountIdFromEndpoint(cleanEndpoint) || undefined

  // 没有桶级凭据时回退到全局 token（推荐做法：一个 token 覆盖所有账户）
  const globalToken = env.R2_API_TOKEN ?? ""
  const effectiveCredential = accessKeyId || globalToken

  if (!effectiveCredential) {
    throw new ApiError(
      503,
      `桶 ${row.name} 未配置凭据，且未设置全局 R2_API_TOKEN`,
      "R2_NOT_CONFIGURED"
    )
  }

  const mode = isApiToken(effectiveCredential) ? "token" : "s3"

  if (mode === "token" && !accountId) {
    throw new ApiError(
      500,
      `桶 ${row.name} 使用 API Token 模式，但无法确定账户 ID（请填写「账户 ID」字段，或让 endpoint 符合 <account>.r2.cloudflarestorage.com 格式）`,
      "R2_ACCOUNT_ID_MISSING"
    )
  }

  return {
    endpoint: cleanEndpoint,
    bucket: row.bucket_name,
    mode,
    accessKeyId: effectiveCredential,
    secretAccessKey: secretAccessKey || effectiveCredential,
    accountId,
  }
}

/**
 * 是否配了 R2（同步检查，只看 env 默认桶）。
 *
 * ⚠️ 多桶改造后**不应再用于鉴权判断** —— 桶配置在 D1 里，env 可能完全是空的。
 * 请改用异步的 `isStorageConfigured(env)`。保留此函数仅供「env 是否有默认桶」的
 * 局部判断（例如桶列表里是否展示「默认桶」条目）。
 */
export function isR2Configured(env: Env): boolean {
  return Boolean(
    env.R2_S3_ENDPOINT &&
      env.R2_BUCKET &&
      env.R2_S3_ACCESS_KEY_ID &&
      env.R2_S3_SECRET_ACCESS_KEY
  )
}

/**
 * 存储是否可用（异步，正确版本）。
 * env 有默认桶 **或** D1 里有启用中的桶（含全局 R2_API_TOKEN 兜底）即视为可用。
 */
export async function isStorageConfigured(env: Env): Promise<boolean> {
  if (isR2Configured(env)) return true
  return hasManagedBuckets(env)
}

/** 是否配了多桶（r2_buckets 表里有启用中的桶）。结果缓存 60 秒（见 managedBucketsCache） */
export async function hasManagedBuckets(env: Env): Promise<boolean> {
  const now = Date.now()
  if (managedBucketsCache && now - managedBucketsCache.at < 60_000) {
    return managedBucketsCache.value
  }
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS c FROM r2_buckets WHERE enabled = 1 LIMIT 1"
    ).first<{ c: number }>()
    const value = Boolean(row)
    managedBucketsCache = { value, at: now }
    return value
  } catch {
    // 出错（迁移未执行等）时不缓存，下次请求重试
    return false
  }
}

/**
 * 列出所有桶配置（管理端用，含加密凭据，调用方不得直接下发前端）。
 */
export async function listBuckets(env: Env): Promise<R2BucketRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM r2_buckets ORDER BY sort_order ASC, created_at ASC"
  ).all<R2BucketRow>()
  return res.results ?? []
}

/**
 * 取单个桶配置并解密凭据（管理端校验连通性用）。
 */
export async function getBucketCredentials(
  env: Env,
  id: string
): Promise<{ row: R2BucketRow; analyticsToken: string | null }> {
  const row = await env.DB.prepare("SELECT * FROM r2_buckets WHERE id = ?")
    .bind(id)
    .first<R2BucketRow>()
  if (!row) throw new ApiError(404, "桶不存在", "NOT_FOUND")

  let analyticsToken: string | null = null
  if (row.analytics_token_enc && env.SESSION_SECRET) {
    try {
      analyticsToken = await decryptSecret(row.analytics_token_enc, env.SESSION_SECRET)
    } catch {
      analyticsToken = null
    }
  }
  return { row, analyticsToken }
}

/**
 * 自动均衡分配：选一个「已分配人数最少且未达上限」的桶。
 *
 * - 只在启用中的桶里选
 * - 按 (人数 / 上限) 比例升序，优先填相对空闲的桶
 * - 全部满则返回 null，由调用方报错提示管理员加桶
 */
export async function pickBucketForNewUser(
  env: Env
): Promise<{ id: string; quotaPerUser: number } | null> {
  // 只考虑用户网盘桶（kind='user'），平台数据桶不参与分配
  const buckets = await env.DB.prepare(
    "SELECT * FROM r2_buckets WHERE enabled = 1 AND kind = 'user' ORDER BY sort_order ASC, created_at ASC"
  ).all<R2BucketRow>()
  const list = buckets.results ?? []
  if (list.length === 0) return null

  // 一次查清各桶已分配人数，避免 N 次往返
  const counts = await env.DB.prepare(
    `SELECT bucket_id, COUNT(*) AS c FROM storage_accounts
      WHERE bucket_id IS NOT NULL GROUP BY bucket_id`
  ).all<{ bucket_id: string; c: number }>()
  const used = new Map((counts.results ?? []).map((r) => [r.bucket_id, r.c]))

  let best: R2BucketRow | null = null
  let bestRatio = Infinity
  let bestCount = Infinity
  for (const b of list) {
    const n = used.get(b.id) ?? 0
    if (n >= b.max_users) continue
    const ratio = b.max_users > 0 ? n / b.max_users : Infinity
    // 比例相同时取绝对人数少的（避免大桶被优先塞满）
    if (ratio < bestRatio || (ratio === bestRatio && n < bestCount)) {
      best = b
      bestRatio = ratio
      bestCount = n
    }
  }

  return best ? { id: best.id, quotaPerUser: best.quota_per_user } : null
}

// ---- 基础工具 ----

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? encoder.encode(data) : data
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)))
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data))
  return new Uint8Array(sig)
}

function amzDates() {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "") // 20260921T153000Z
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/**
 * S3 的 URI 编码规则：encodeURIComponent 之外还要编码 ! ' ( ) *
 * 且路径中的 "/" 必须保留。
 */
function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join("/")
}

/** 查询串按 key 排序后编码（SigV4 要求） */
function encodeQuery(params: Record<string, string | number | undefined>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join("&")
}

interface SignedRequest {
  url: string
  headers: Record<string, string>
}

/**
 * 生成 SigV4 签名请求。
 * payloadHash 用 UNSIGNED-PAYLOAD（R2 支持，可流式上传大文件不占内存）。
 */
async function signRequest(
  cfg: R2Config,
  method: string,
  path: string,
  query: Record<string, string | number | undefined>,
  extraHeaders: Record<string, string> = {},
  payloadHash: string = UNSIGNED_PAYLOAD
): Promise<SignedRequest> {
  const host = new URL(cfg.endpoint).host
  const { amzDate, dateStamp } = amzDates()
  const canonicalUri = encodeS3Path(path)
  const canonicalQuery = encodeQuery(query)

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  }

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${headers[h] ?? headers[h.toLowerCase()] ?? ""}\n`)
    .join("")
  const signedHeaders = signedHeaderNames.join(";")

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")

  let signingKey = encoder.encode(`AWS4${cfg.secretAccessKey}`)
  for (const msg of [dateStamp, REGION, SERVICE, "aws4_request"]) {
    signingKey = await hmac(signingKey, msg)
  }
  const signature = toHex(await hmac(signingKey, stringToSign))

  return {
    url:
      `${cfg.endpoint}${canonicalUri}` +
      (canonicalQuery ? `?${canonicalQuery}` : ""),
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

// ---- Cloudflare REST API 传输（token 模式）----

/** REST API 的基础路径 */
function cfApiBase(cfg: R2Config): string {
  return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}`
}

/**
 * 用 Cloudflare REST API 操作对象。
 *
 * 与 S3 的关键差异：
 *   - 列表返回 JSON（不是 XML），字段名是下划线风格
 *   - 单个对象的 GET 也带完整的 content-length / etag
 *   - **不支持预签名 URL**（见 presign 的降级逻辑）
 */
async function cfApiFetch(
  cfg: R2Config,
  method: string,
  key: string,
  query: Record<string, string | number | undefined> = {},
  init: RequestInit = {}
): Promise<Response> {
  const base = cfApiBase(cfg)
  const url = key ? `${base}/objects/${encodeS3Path(key)}` : `${base}/objects`
  const qs = encodeQuery(query)
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${cfg.accessKeyId}`)

  return fetch(qs ? `${url}?${qs}` : url, { ...init, method, headers })
}

async function r2Fetch(
  env: Env,
  method: string,
  key: string,
  query: Record<string, string | number | undefined> = {},
  init: RequestInit = {},
  bucketId?: string | null
): Promise<Response> {
  const cfg = await resolveBucket(env, bucketId)

  if (cfg.mode === "token") {
    return cfApiFetch(cfg, method, key, query, init)
  }

  const path = key ? `/${cfg.bucket}/${key}` : `/${cfg.bucket}`
  const headers = new Headers(init.headers)
  const extra: Record<string, string> = {}
  headers.forEach((v, k) => (extra[k.toLowerCase()] = v))

  const signed = await signRequest(cfg, method, path, query, extra)

  return fetch(signed.url, {
    ...init,
    method,
    headers: signed.headers,
  })
}

/**
 * 把上游 R2/CF 的错误转成 ApiError。
 *
 * ⚠️ 2026-09-25 审计（低）：原实现把上游错误正文截 300 字符**拼进客户端可见的
 * message**，而 index.ts 又会把 `err.message` 原样放进 JSON 响应。于是匿名
 * 调用者（`/dl/<前缀>/..%2f..%2fx` 这类会签名失配的请求）能看到 R2 原始错误
 * XML —— 里面含桶名与对象键；S3 兼容端的 `SignatureDoesNotMatch` 还常常回显
 * `AWSAccessKeyId`（凭据标识，不是密钥）。
 *
 * 现在：正文只写进 Worker 日志（`wrangler tail` 可查），响应里只给状态码。
 */
async function r2OrError(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  const body = (await res.text().catch(() => "")).slice(0, 500)
  if (body) {
    console.error(`[r2] ${what}失败 status=${res.status} body=${body}`)
  }
  throw new ApiError(
    502,
    `R2 ${what}失败（上游状态 ${res.status}）`,
    "R2_ERROR"
  )
}

// ---- 对象操作 ----

export interface R2Object {
  key: string
  size: number
  lastModified: string | null
  etag: string | null
  contentType: string | null
}

/** 列出某前缀下的对象（单页，最多 `limit` 个） */
export async function listObjects(
  env: Env,
  prefix: string,
  options: { limit?: number; cursor?: string; delimiter?: string; bucketId?: string | null } = {}
): Promise<{ objects: R2Object[]; cursor: string | null; truncated: boolean }> {
  const cfg = await resolveBucket(env, options.bucketId)

  if (cfg.mode === "token") {
    const res = await cfApiFetch(cfg, "GET", "", {
      per_page: options.limit ?? 100,
      prefix,
      cursor: options.cursor,
    })
    await r2OrError(res, "列目录")
    const body = (await res.json()) as {
      result?: {
        key: string
        size: number
        last_modified?: string
        etag?: string
        http_metadata?: { contentType?: string }
      }[]
      result_info?: { cursor?: string; is_truncated?: boolean }
    }
    return {
      objects: (body.result ?? []).map((o) => ({
        key: o.key,
        size: o.size ?? 0,
        lastModified: o.last_modified ?? null,
        etag: o.etag ?? null,
        contentType: o.http_metadata?.contentType ?? null,
      })),
      cursor: body.result_info?.cursor ?? null,
      truncated: Boolean(body.result_info?.is_truncated),
    }
  }

  // S3 模式：XML 响应
  const res = await r2Fetch(
    env,
    "GET",
    "",
    {
      "list-type": "2",
      prefix,
      "max-keys": options.limit ?? 100,
      "continuation-token": options.cursor,
      delimiter: options.delimiter,
    },
    {},
    options.bucketId
  )
  await r2OrError(res, "列目录")

  const xml = await res.text()
  const objects: R2Object[] = []
  // R2 返回的 XML 结构稳定，用正则抽取足够（不引入 XML 解析依赖）
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g
  let m: RegExpExecArray | null
  while ((m = contentsRe.exec(xml)) !== null) {
    const block = m[1]
    const pick = (tag: string) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)
      return r ? r[1] : null
    }
    const key = pick("Key")
    if (!key) continue
    objects.push({
      key: decodeXmlEntities(key),
      size: Number(pick("Size") ?? 0),
      lastModified: pick("LastModified"),
      etag: (pick("ETag") ?? "").replace(/&quot;|"/g, "") || null,
      contentType: null,
    })
  }

  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
  const cursorMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)

  return {
    objects,
    cursor: cursorMatch ? decodeXmlEntities(cursorMatch[1]) : null,
    truncated,
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
}

/** 下载对象（流式返回，调用方负责转成 Response） */
export async function getObject(
  env: Env,
  key: string,
  range?: string,
  bucketId?: string | null
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (range) headers.Range = range
  const res = await r2Fetch(env, "GET", key, {}, { headers }, bucketId)
  if (res.status === 404) {
    throw new ApiError(404, "文件不存在", "NOT_FOUND")
  }
  return r2OrError(res, "下载")
}

/**
 * 获取对象元信息（不拉正文）。
 *
 * ⚠️ 2026-09-27 线上故障修复：Cloudflare REST API（token 模式）的对象端点**不支持 HEAD**
 * —— 对它发 HEAD 直接返回 `405 Method Not Allowed`，于是所有 HEAD 直链都变成 502
 * 「R2 读取元信息失败（上游状态 405）」。（同一个坑早在本仓库里记过两次：
 * `worker/scripts/migrate-r2.mjs:85` 写着「R2 REST API 没有 HEAD，用 GET 只读头」，
 * 审计报告 P3-4 / 路线图 M11 也预警过 headObject 在 token 模式下会失效。）
 *
 * token 模式因此改用「按精确 key 列一条」替代：
 *   - REST 的 list 直接带 `size`，不像 GET 那样可能以 chunked 返回、拿不到 content-length
 *   - REST 的 list 还带 `http_metadata`，正好就是我们要的 contentType
 * prefix 精确等于 key 时，字典序最小的必然是它自己 ⇒ 取第一条并比对 key 即可。
 */
export async function headObject(
  env: Env,
  key: string,
  bucketId?: string | null
): Promise<{ size: number; contentType: string | null } | null> {
  const cfg = await resolveBucket(env, bucketId)

  if (cfg.mode === "token") {
    const { objects } = await listObjects(env, key, { limit: 1, bucketId })
    const hit = objects[0]?.key === key ? objects[0] : null
    if (!hit) return null
    return { size: hit.size, contentType: hit.contentType }
  }

  const res = await r2Fetch(env, "HEAD", key, {}, {}, bucketId)
  if (res.status === 404) return null
  await r2OrError(res, "读取元信息")
  return {
    size: Number(res.headers.get("content-length") ?? 0),
    contentType: res.headers.get("content-type"),
  }
}

export async function putObject(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  contentType = "application/octet-stream",
  bucketId?: string | null
): Promise<void> {
  const res = await r2Fetch(
    env,
    "PUT",
    key,
    {},
    {
      body: body as BodyInit,
      headers: { "Content-Type": contentType },
    },
    bucketId
  )
  await r2OrError(res, "上传")
}

export async function deleteObject(
  env: Env,
  key: string,
  bucketId?: string | null
): Promise<void> {
  const res = await r2Fetch(env, "DELETE", key, {}, {}, bucketId)
  // S3 语义：删不存在的对象也返回 204
  await r2OrError(res, "删除")
}

/** 删除某个用户名下的全部对象（清空前缀，用于关闭网盘/注销） */
export async function deletePrefix(
  env: Env,
  prefix: string,
  maxRounds = 50,
  bucketId?: string | null
): Promise<number> {
  let deleted = 0
  for (let round = 0; round < maxRounds; round++) {
    const { objects, cursor, truncated } = await listObjects(env, prefix, {
      limit: 1000,
      bucketId,
    })
    if (objects.length === 0) break
    for (const obj of objects) {
      await deleteObject(env, obj.key, bucketId)
      deleted++
    }
    if (!truncated || !cursor) break
  }
  return deleted
}

// ---- 预签名 URL（浏览器直传 / 直链下载）----

/**
 * 该桶是否支持预签名直传。
 * token 模式（Cloudflare REST API）**不支持**生成签名 URL，
 * 此时上传要改由 Worker 转发（见 handlers/storage.ts 的 /api/storage/upload）。
 */
export async function supportsPresign(
  env: Env,
  bucketId?: string | null
): Promise<boolean> {
  try {
    const cfg = await resolveBucket(env, bucketId)
    return cfg.mode === "s3"
  } catch {
    return false
  }
}

/**
 * 生成预签名 URL。
 * 上传用它可绕过 Worker 请求体限制并让浏览器显示真实上传进度。
 *
 * ⚠️ 仅 S3 模式可用。token 模式会抛错，调用方应先检查 supportsPresign()。
 *
 * `contentLength`（2026-09-25 审计 P0-6 修复）：
 *   原实现固定 `X-Amz-SignedHeaders: "host"`，**Content-Length 不参与签名**，
 *   于是调用方按客户端声明的 size 做完配额校验后，客户端可以拿同一个 URL
 *   PUT 任意大小的对象 —— 只要事后不调 /api/storage/commit，used_bytes
 *   永不增长、storage_objects 也没有行，但对象已经在 R2 里且可公开下载。
 *   定时运维只做 D1 侧自检、不枚举 R2，所以这些孤儿对象永远不会被回收。
 *
 *   把 content-length 纳入签名后，R2 会校验请求头与签名一致：
 *   实际字节数与申请时声明的不符 → 403，上传根本落不了盘。
 *   浏览器/XHR 对 File/Blob 请求体总是自动带正确的 Content-Length，
 *   且它是 forbidden header（不受 CORS 预检影响），所以正常上传不受影响。
 */
export async function presign(
  env: Env,
  method: "PUT" | "GET",
  key: string,
  expiresIn = 3600,
  bucketId?: string | null,
  contentLength?: number
): Promise<string> {
  const cfg = await resolveBucket(env, bucketId)
  if (cfg.mode === "token") {
    throw new ApiError(
      501,
      "该桶使用 API Token 凭据，不支持预签名直传（请走 Worker 转发上传）",
      "PRESIGN_UNSUPPORTED"
    )
  }
  const { amzDate, dateStamp } = amzDates()
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`
  const path = `/${cfg.bucket}/${key}`
  const host = new URL(cfg.endpoint).host

  // 参与签名的请求头：host 始终签；PUT 且调用方给了确切字节数时连 content-length 一起签。
  const headersToSign: Record<string, string> = { host }
  if (
    method === "PUT" &&
    typeof contentLength === "number" &&
    Number.isFinite(contentLength) &&
    contentLength >= 0
  ) {
    headersToSign["content-length"] = String(Math.trunc(contentLength))
  }
  const signedHeaderNames = Object.keys(headersToSign).sort()
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${headersToSign[h]}\n`)
    .join("")
  const signedHeaders = signedHeaderNames.join(";")

  const query: Record<string, string | number> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": Math.min(Math.max(expiresIn, 60), 604800),
    "X-Amz-SignedHeaders": signedHeaders,
  }

  const canonicalUri = encodeS3Path(path)
  const canonicalQuery = encodeQuery(query)
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n")

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")

  let signingKey = encoder.encode(`AWS4${cfg.secretAccessKey}`)
  for (const msg of [dateStamp, REGION, SERVICE, "aws4_request"]) {
    signingKey = await hmac(signingKey, msg)
  }
  const signature = toHex(await hmac(signingKey, stringToSign))

  // Content-Type 仍不参与签名：浏览器自由设置，CORS 已放行。
  // 它的安全影响由「下发时的类型收口」兜底（见 worker/src/content-type.ts），
  // 而不是靠签名 —— 否则 charset 之类的细微差异会让正常上传失败。
  return `${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}