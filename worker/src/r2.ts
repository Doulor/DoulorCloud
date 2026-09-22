/**
 * R2 存储客户端（S3 兼容 API + AWS SigV4 签名）。
 *
 * 为什么不用 `[[r2_buckets]]` 绑定：
 *   R2 桶 `network` 位于 adoulor 账户，而本 Worker 部署在 Doulor 账户，
 *   Cloudflare 不支持跨账户绑定，只能走 S3 兼容接口。
 *
 * 因此这里用 WebCrypto 手写 SigV4（不引入 aws4fetch 等依赖）。
 * 签名逻辑与已用 Python 原型验证过的实现一致：
 *   GET  list / PUT 上传 / GET 下载 / DELETE 删除 均返回 200/204。
 *
 * 桶保持私有：所有读取都经 Worker 反代（见 handlers/storage.ts 的 /dl 路由），
 * 不使用 r2.dev 公开地址（R2 自定义域必须与桶同账户，跨账户无法绑定）。
 */
import { ApiError } from "./http"
import type { Env } from "./env"

const REGION = "auto"
const SERVICE = "s3"
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"

interface R2Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

function r2Config(env: Env): R2Config {
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

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
  }
}

export function isR2Configured(env: Env): boolean {
  return Boolean(
    env.R2_S3_ENDPOINT &&
      env.R2_BUCKET &&
      env.R2_S3_ACCESS_KEY_ID &&
      env.R2_S3_SECRET_ACCESS_KEY
  )
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

async function r2Fetch(
  env: Env,
  method: string,
  key: string,
  query: Record<string, string | number | undefined> = {},
  init: RequestInit = {}
): Promise<Response> {
  const cfg = r2Config(env)
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

async function r2OrError(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  const body = (await res.text().catch(() => "")).slice(0, 300)
  throw new ApiError(
    502,
    `R2 ${what}失败: ${res.status}${body ? ` ${body}` : ""}`,
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
  options: { limit?: number; cursor?: string; delimiter?: string } = {}
): Promise<{ objects: R2Object[]; cursor: string | null; truncated: boolean }> {
  const res = await r2Fetch(env, "GET", "", {
    "list-type": "2",
    prefix,
    "max-keys": options.limit ?? 100,
    "continuation-token": options.cursor,
    delimiter: options.delimiter,
  })
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
  range?: string
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (range) headers.Range = range
  const res = await r2Fetch(env, "GET", key, {}, { headers })
  if (res.status === 404) {
    throw new ApiError(404, "文件不存在", "NOT_FOUND")
  }
  return r2OrError(res, "下载")
}

/** 获取对象元信息（HEAD，不拉正文） */
export async function headObject(
  env: Env,
  key: string
): Promise<{ size: number; contentType: string | null } | null> {
  const res = await r2Fetch(env, "HEAD", key)
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
  contentType = "application/octet-stream"
): Promise<void> {
  const res = await r2Fetch(env, "PUT", key, {}, {
    body: body as BodyInit,
    headers: { "Content-Type": contentType },
  })
  await r2OrError(res, "上传")
}

export async function deleteObject(env: Env, key: string): Promise<void> {
  const res = await r2Fetch(env, "DELETE", key)
  // S3 语义：删不存在的对象也返回 204
  await r2OrError(res, "删除")
}

/** 删除某个用户名下的全部对象（清空前缀，用于关闭网盘/注销） */
export async function deletePrefix(
  env: Env,
  prefix: string,
  maxRounds = 50
): Promise<number> {
  let deleted = 0
  for (let round = 0; round < maxRounds; round++) {
    const { objects, cursor, truncated } = await listObjects(env, prefix, {
      limit: 1000,
    })
    if (objects.length === 0) break
    for (const obj of objects) {
      await deleteObject(env, obj.key)
      deleted++
    }
    if (!truncated || !cursor) break
  }
  return deleted
}

// ---- 预签名 URL（浏览器直传 / 直链下载）----

/**
 * 生成预签名 URL。
 * 上传用它可绕过 Worker 请求体限制并让浏览器显示真实上传进度。
 */
export async function presign(
  env: Env,
  method: "PUT" | "GET",
  key: string,
  expiresIn = 3600
): Promise<string> {
  const cfg = r2Config(env)
  const { amzDate, dateStamp } = amzDates()
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`
  const path = `/${cfg.bucket}/${key}`
  const host = new URL(cfg.endpoint).host

  const query: Record<string, string | number> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": Math.min(Math.max(expiresIn, 60), 604800),
    "X-Amz-SignedHeaders": "host",
  }

  const canonicalUri = encodeS3Path(path)
  const canonicalQuery = encodeQuery(query)
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
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

  // 预签名只签 host；其余请求头（如 Content-Type）由浏览器自由设置，CORS 已放行
  return `${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}