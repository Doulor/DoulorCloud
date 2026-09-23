/**
 * 临时分享箱（tempbox）。
 *
 * 与网盘的区别：内容临时、匿名可看、4 位接收码解锁。
 *   - 存储：R2 桶 `network` 下的 `temporary/<接收码>/<文件名>`（与网盘/名片目录隔离）
 *   - 元信息：D1 `tempbox_batches`（code、过期时间、创建者、文件数/字节）
 *   - 过期：采用「惰性清理」——访问/下载时若发现已过期，删除该批次 R2 对象并返回 404
 *
 * 权限：
 *   - 查看 / 下载：**无需登录**（访客输入接收码即可解锁）
 *   - 上传 / 提交：默认需登录（`tempbox_upload_requires_login`，管理员可关闭）
 *   - 删除：仅创建者本人或管理员
 *
 * 单次上传上限与默认保存时长都由管理员在「设置」里调整。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser, type UserRow } from "../auth"
import { getObject, headObject, isStorageConfigured, listObjects, presign, deleteObject, deletePrefix, getPlatformBucketId, putObject, supportsPresign } from "../r2"
import { sanitizeFilename } from "./storage"
import { getSettings, getSettingNumber } from "../settings"
import type { Env } from "../env"

const R2_PREFIX = "temporary"

/** 纯文本的最大长度（约 64 KB，适合互传小文字） */
const MAX_TEXT_BYTES = 64 * 1024

/** 管理员「不限」哨兵值（分享箱的文件数/单文件大小对所有人生效，
 *  但管理员不受限——避免自己测试时被自己设的规则挡住） */
const ADMIN_UNLIMITED = 1024 ** 5

interface TempboxBatchRow {
  id: string
  code: string
  creator_user_id: string | null
  expire_at: string
  file_count: number
  total_bytes: number
  created_at: string
  text_content: string | null
}

// ---- 基础工具 ----

function isExpired(row: TempboxBatchRow): boolean {
  return new Date(row.expire_at).getTime() < Date.now()
}

async function loadBatch(env: Env, code: string): Promise<TempboxBatchRow | null> {
  return env.DB.prepare("SELECT * FROM tempbox_batches WHERE code = ? COLLATE NOCASE LIMIT 1")
    .bind(code)
    .first<TempboxBatchRow>()
}

/** 惰性清理：删除已过期批次的所有 R2 对象与记录 */
async function purgeExpiredBatch(env: Env, code: string): Promise<void> {
  try {
    await deletePrefix(env, `${R2_PREFIX}/${code}/`, 50, await getPlatformBucketId(env))
  } catch (err) {
    console.error("清理过期临时箱失败:", code, err)
  }
  await env.DB.prepare("DELETE FROM tempbox_batches WHERE code = ? COLLATE NOCASE")
    .bind(code)
    .run()
}

/** 已过期的批次：清理后一律视为不存在 */
async function assertBatchAlive(env: Env, code: string): Promise<TempboxBatchRow> {
  const batch = await loadBatch(env, code)
  if (!batch) throw new ApiError(404, "接收码不存在或已失效", "NOT_FOUND")
  if (isExpired(batch)) {
    await purgeExpiredBatch(env, batch.code)
    throw new ApiError(404, "接收码不存在或已失效", "NOT_FOUND")
  }
  return batch
}

/** 生成唯一 4 位数字接收码 */
async function generateCode(env: Env): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000))
    const exists = await env.DB.prepare(
      "SELECT id FROM tempbox_batches WHERE code = ? LIMIT 1"
    )
      .bind(code)
      .first()
    if (!exists) return code
  }
  throw new ApiError(500, "生成接收码失败，请重试", "INTERNAL")
}

/** 校验上传是否被允许；需要登录时返回 user，否则返回 null */
async function requireUploader(env: Env, request: Request): Promise<UserRow | null> {
  const settings = await getSettings(env)
  if (settings.tempbox_upload_requires_login === "1") {
    return requireUser(env, request)
  }
  // 不需要登录时仍尽力解析用户（登录则记录创建者，未登录则 null）
  try {
    return await requireUser(env, request)
  } catch {
    return null
  }
}

/** R2 对象 → 对外文件信息 */
function toFileInfo(obj: { key: string; size: number; lastModified: string | null }) {
  const name = obj.key.slice(`${R2_PREFIX}/`.length).split("/").slice(1).join("/")
  return { name, size: obj.size, lastModified: obj.lastModified }
}

// ---- 公共配置 ----

/** GET /api/tempbox/config —— 页面配置（无需登录） */
export async function getTempboxConfig(env: Env, _request: Request): Promise<Response> {
  const settings = await getSettings(env)
  return json({
    enabled: settings.tempbox_enabled === "1",
    defaultMinutes: Number(settings.tempbox_default_minutes),
    maxFileBytes: Number(settings.tempbox_max_file_bytes),
    maxFiles: Number(settings.tempbox_max_files),
    uploadRequiresLogin: settings.tempbox_upload_requires_login === "1",
  })
}

// ---- 上传（需登录，或按设置对外开放）----

/**
 * POST /api/tempbox/create —— 创建一个批次，返回接收码。
 * 若 body 带 text 则同时存为纯文本（文字不占 R2）。
 */
export async function createTempbox(env: Env, request: Request): Promise<Response> {
  if (!(await getSettings(env)).tempbox_enabled) {
    throw new ApiError(403, "临时分享箱已关闭", "FEATURE_DISABLED")
  }
  const user = await requireUploader(env, request)

  const body = (await request.json().catch(() => ({}))) as { text?: unknown }
  const text = typeof body.text === "string" ? body.text.trim() : ""

  if (text) {
    if (text.length > MAX_TEXT_BYTES) {
      throw new ApiError(400, "文字内容过长", "TEXT_TOO_LONG")
    }
  } else if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  }

  const minutes = await getSettingNumber(env, "tempbox_default_minutes")
  const code = await generateCode(env)
  const now = new Date()
  const expireAt = new Date(now.getTime() + Math.max(1, minutes) * 60 * 1000)

  await env.DB.prepare(
    `INSERT INTO tempbox_batches (id, code, creator_user_id, expire_at, file_count, total_bytes, created_at, text_content)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(uuid(), code, user?.id ?? null, expireAt.toISOString(), now.toISOString(), text || null)
    .run()

  return json({ code, expireAt: expireAt.toISOString(), minutes, isText: Boolean(text) }, 201)
}

// ---- 上传预签名 ----

/** POST /api/tempbox/:code/upload-url —— 申请预签名上传地址 */
export async function createTempboxUploadUrl(
  env: Env,
  request: Request,
  code: string
): Promise<Response> {
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  }
  const uploader = await requireUploader(env, request)
  await assertBatchAlive(env, code)

  // 管理员不受分享箱配额限制
  const isAdmin = uploader?.role === "admin"
  const maxFileBytes = isAdmin
    ? ADMIN_UNLIMITED
    : await getSettingNumber(env, "tempbox_max_file_bytes")
  const maxFiles = isAdmin
    ? ADMIN_UNLIMITED
    : await getSettingNumber(env, "tempbox_max_files")

  const body = (await request.json()) as { filename?: string; size?: number }
  const filename = sanitizeFilename(body.filename ?? "")
  const size = Math.trunc(Number(body.size ?? 0))
  if (size <= 0) throw new ApiError(400, "文件大小无效", "INVALID_INPUT")
  if (size > maxFileBytes) {
    throw new ApiError(
      400,
      `单个文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB`,
      "FILE_TOO_LARGE"
    )
  }

  const batch = await loadBatch(env, code)
  if (!batch || batch.file_count >= maxFiles) {
    throw new ApiError(400, `每个接收码最多 ${maxFiles} 个文件`, "TOO_MANY_FILES")
  }

  const key = `${R2_PREFIX}/${code}/${filename}`
  const platformBucket = await getPlatformBucketId(env)
  const uploadUrl = (await supportsPresign(env, platformBucket))
    ? await presign(env, "PUT", key, 3600, platformBucket)
    : `/api/tempbox/${encodeURIComponent(code)}/proxy-upload?key=${encodeURIComponent(key)}`
  return json({ uploadUrl, key, filename, code })
}

/**
 * PUT /api/tempbox/:code/proxy-upload?key=xxx —— Worker 中转上传。
 * token 模式（无预签名）时的降级路径，见 storage.ts 的同名实现。
 */
export async function proxyTempboxUpload(
  env: Env,
  request: Request,
  code: string
): Promise<Response> {
  await requireUploader(env, request)
  await assertBatchAlive(env, code)

  const key = new URL(request.url).searchParams.get("key") ?? ""
  if (!key.startsWith(`${R2_PREFIX}/${code}/`)) {
    throw new ApiError(403, "非法的文件路径", "FORBIDDEN")
  }

  // 管理员不受大小限制
  const maxFileBytes =
    (await requireUploader(env, request))?.role === "admin"
      ? ADMIN_UNLIMITED
      : await getSettingNumber(env, "tempbox_max_file_bytes")
  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream"
  const buf = await request.arrayBuffer()
  if (buf.byteLength === 0) {
    throw new ApiError(400, "文件为空", "INVALID_INPUT")
  }
  if (buf.byteLength > maxFileBytes) {
    throw new ApiError(
      400,
      `单个文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB`,
      "FILE_TOO_LARGE"
    )
  }

  await putObject(env, key, buf, contentType, await getPlatformBucketId(env))
  return json({ ok: true, key, size: buf.byteLength })
}

/** POST /api/tempbox/:code/commit —— 上传完成后登记（校验真实大小） */
export async function commitTempboxUpload(
  env: Env,
  request: Request,
  code: string
): Promise<Response> {
  await requireUploader(env, request)
  await assertBatchAlive(env, code)

  const body = (await request.json().catch(() => ({}))) as { key?: string }
  const key = body.key ?? ""
  if (!key.startsWith(`${R2_PREFIX}/${code}/`)) {
    throw new ApiError(403, "非法的文件路径", "FORBIDDEN")
  }

  const platformBucket = await getPlatformBucketId(env)
  const head = await headObject(env, key, platformBucket)
  if (!head) throw new ApiError(404, "上传未完成或文件不存在", "NOT_FOUND")

  const maxFileBytes =
    (await requireUploader(env, request))?.role === "admin"
      ? ADMIN_UNLIMITED
      : await getSettingNumber(env, "tempbox_max_file_bytes")
  if (head.size > maxFileBytes) {
    // 超额：删掉刚上传的对象，保持账实一致
    await deleteObject(env, key, platformBucket)
    throw new ApiError(400, "文件超过大小限制，已取消", "FILE_TOO_LARGE")
  }

  await env.DB.prepare(
    "UPDATE tempbox_batches SET file_count = file_count + 1, total_bytes = total_bytes + ? WHERE code = ?"
  )
    .bind(head.size, code)
    .run()

  const updated = await loadBatch(env, code)
  return json({
    filename: key.slice(`${R2_PREFIX}/${code}/`.length),
    size: head.size,
    fileCount: updated?.file_count ?? 0,
    totalBytes: updated?.total_bytes ?? 0,
  })
}

// ---- 查看 / 下载（无需登录）----

/** GET /api/tempbox/:code —— 批次信息 + 文件列表（纯文本批次还带 textContent） */
export async function getTempbox(
  env: Env,
  _request: Request,
  code: string
): Promise<Response> {
  const batch = await assertBatchAlive(env, code)

  // 纯文本批次：不需要 R2
  if (batch.text_content) {
    return json({
      code: batch.code,
      expireAt: batch.expire_at,
      remainingMinutes: Math.max(
        0,
        Math.floor((new Date(batch.expire_at).getTime() - Date.now()) / 60000)
      ),
      fileCount: 0,
      totalBytes: batch.text_content.length,
      files: [],
      isText: true,
      textContent: batch.text_content,
    })
  }

  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  }

  const page = await listObjects(env, `${R2_PREFIX}/${code}/`, {
    limit: 1000,
    bucketId: await getPlatformBucketId(env),
  })
  const files = page.objects.filter((o) => !o.key.endsWith("/")).map(toFileInfo)

  return json({
    code: batch.code,
    expireAt: batch.expire_at,
    remainingMinutes: Math.max(
      0,
      Math.floor((new Date(batch.expire_at).getTime() - Date.now()) / 60000)
    ),
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    files,
    isText: false,
    textContent: null,
  })
}

/** GET /api/tempbox/:code/:filename —— 下载 / 预览（无需登录，支持 Range） */
export async function downloadTempboxFile(
  env: Env,
  request: Request,
  code: string,
  filename: string
): Promise<Response> {
  await assertBatchAlive(env, code)
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  }
  // 防目录穿越：filename 不允许包含路径分隔符 / \
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new ApiError(403, "非法的文件名", "FORBIDDEN")
  }

  const key = `${R2_PREFIX}/${code}/${filename}`
  const method = request.method.toUpperCase()
  const platformBucket = await getPlatformBucketId(env)

  if (method === "HEAD") {
    const head = await headObject(env, key, platformBucket)
    if (!head) throw new ApiError(404, "文件不存在", "NOT_FOUND")
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Length": String(head.size),
        "Content-Type": head.contentType ?? "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  const range = request.headers.get("Range") ?? undefined
  const upstream = await getObject(env, key, range, platformBucket)
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
  headers.set("Cache-Control", "public, max-age=30")
  headers.set("Access-Control-Allow-Origin", "*")
  headers.set("X-Content-Type-Options", "nosniff")

  // 图片与纯文本内联预览；其余强制下载
  const contentType = headOfType(upstream.headers.get("content-type") ?? "")
  if (contentType.startsWith("image/") || contentType === "text/plain") {
    headers.set("Content-Disposition", "inline")
  } else {
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  }

  return new Response(upstream.body, { status: upstream.status, headers })
}

function headOfType(ct: string): string {
  return ct.split(";")[0].trim().toLowerCase()
}

// ---- 删除（创建者本人或管理员）----

/** DELETE /api/tempbox/:code —— 删除整个批次 */
export async function deleteTempbox(
  env: Env,
  request: Request,
  code: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const batch = await loadBatch(env, code)
  if (!batch) throw new ApiError(404, "接收码不存在或已失效", "NOT_FOUND")

  if (user.role !== "admin" && (!batch.creator_user_id || batch.creator_user_id !== user.id)) {
    throw new ApiError(403, "只能删除自己创建的临时分享", "FORBIDDEN")
  }

  await deletePrefix(env, `${R2_PREFIX}/${code}/`, 50, await getPlatformBucketId(env))
  await env.DB.prepare("DELETE FROM tempbox_batches WHERE code = ? COLLATE NOCASE")
    .bind(code)
    .run()

  return new Response(null, { status: 204 })
}