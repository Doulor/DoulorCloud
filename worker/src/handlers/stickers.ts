/**
 * 用户自定义表情包（社区 / 私信编辑器里快捷发送）。
 *
 * 产品形态（对齐 QQ）：用户上传自己的图 → 进「我的表情包」栏 →
 * 发帖、评论、回复时点一下就插到光标处，发出去是一张内联小图。
 *
 * 传输用 markdown 图片语法 `![](/s/<id>)` —— 复用社区已有的 markdown 渲染，
 * 不额外发明占位符协议（少一套解析就少一类 bug）。
 *
 * ⚠️ 缓存是这块的重点，三层各管一段、互不依赖：
 *   1. **取图 `/s/<id>`**：id 是 uuid，内容**永不改变** ⇒ 一年 immutable，
 *      浏览器和 CDN 都不回源。删掉表情包也不会「换成别的图」，只会 404，
 *      所以长缓存是安全的。
 *   2. **列表接口**：用「条数 + 最新一条时间」当 ETag；没变直接 304，
 *      省流量也省 DB。
 *   3. **前端 localStorage**（见 components/sticker-panel.tsx）：打开面板先渲染
 *      本地缓存、后台再刷新，来回切页面是瞬开的。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { SAFE_JSON_HEADERS } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { getSettingNumber } from "../settings"
import { isStorageConfigured, putObject, deleteObject, getObject, getPlatformBucketId } from "../r2"
import { hardenUserContentResponse } from "../content-type"
import { guardRateLimit } from "../ratelimit"
import { hasValidImageSignature } from "./community"
import type { Env } from "../env"

/** MIME → 扩展名（与社区、反馈一致，只收这四种） */
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

/**
 * 取图的缓存策略：一年 + immutable。
 *
 * 为什么敢这么长：URL 里是 uuid，内容与 URL 一一对应、**永远不会变**。
 * 换图 = 换 id = 换 URL，不存在「缓存了旧内容」的问题。
 */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

interface StickerRow {
  id: string
  r2_key: string
  content_type: string
  bytes: number
  created_at: string
}

/**
 * 取图地址。
 *
 * ⚠️ 为什么是 `/api/stickers/<id>/image` 而不是更短的 `/s/<id>`：
 * 本项目的 API Worker Route **不在 wrangler 配置里维护**（声明了会在 deploy 时
 * 覆盖掉用户动态绑定的自定义域名，见 worker/wrangler.toml 顶部的说明），
 * 线上固定 Route 只有 `/api/*`、`/dl/*`、`/profile/*`、`/p/*` 这几条。
 * 自造新前缀 `/s/*` 的请求根本进不了 Worker（会落到前端静态资源上，
 * 表现为返回一坨 HTML、图片全是裂图 —— 2026-10-02 实测踩到）。
 * 挂在已有的 `/api/*` 下面就不必去 CF 后台加 Route。
 */
function imageUrl(id: string): string {
  return `/api/stickers/${id}/image`
}

function toDto(r: Pick<StickerRow, "id" | "content_type" | "bytes" | "created_at">) {
  return {
    id: r.id,
    url: imageUrl(r.id),
    contentType: r.content_type,
    bytes: r.bytes,
    createdAt: r.created_at,
  }
}

/**
 * 列表版本号。
 *
 * 用「条数 + 最新一条时间」而不是哈希整表：上传和删除是唯一能让列表变化的
 * 两件事，而这两件事都会改变这个字符串。够用，且不用扫全表。
 */
function versionOf(items: { createdAt: string }[]): string {
  return `${items.length}-${items[items.length - 1]?.createdAt ?? "0"}`
}

/** GET /api/stickers —— 我的表情包（带 ETag，没变就 304） */
export async function listStickers(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT id, r2_key, content_type, bytes, created_at FROM user_stickers " +
      "WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all<StickerRow>()

  const items = (rows.results ?? []).map(toDto)
  const version = versionOf(items)
  const etag = `W/"stk-${user.id.slice(0, 8)}-${version}"`

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }

  const limit = await getSettingNumber(env, "sticker_max_count")
  // ⚠️ 不能用 json()：它写死了 no-store，这里要带 ETag 做协商缓存
  return new Response(JSON.stringify({ stickers: items, version, limit }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // private：每人一份，别进共享缓存；no-cache = 可以存，但每次要回源验 ETag
      "Cache-Control": "private, no-cache",
      ETag: etag,
      ...SAFE_JSON_HEADERS,
    },
  })
}

/** POST /api/stickers —— 上传一个表情包（raw body + Content-Type） */
export async function uploadSticker(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 每次上传都写 R2（计费操作）。20 次/分钟够正常一张张传，拦得住脚本刷
  await guardRateLimit(env, `sticker-upload:${user.id}`, 20, 60, "上传过于频繁，请稍后再试")
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  }

  const ct = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase()
  const ext = IMAGE_TYPES[ct]
  if (!ext) throw new ApiError(400, "仅支持 JPG / PNG / WebP / GIF", "INVALID_TYPE")

  const maxBytes = await getSettingNumber(env, "sticker_max_bytes")
  // 先看 Content-Length 再读，别把超大请求体读进内存才判
  const buf = await readBodyCapped(
    request,
    maxBytes,
    `表情包需在 ${Math.round(maxBytes / 1024)} KB 以内`,
    400,
    "TOO_LARGE"
  )
  if (buf.byteLength === 0) {
    throw new ApiError(400, "图片内容为空", "TOO_LARGE")
  }
  // 校验真实图片魔数，不信客户端声明的 Content-Type（与社区上传同一条规矩）
  if (!hasValidImageSignature(buf, ct)) {
    throw new ApiError(400, "图片内容与声明的类型不匹配", "INVALID_IMAGE")
  }

  // 数量配额：先查再传，避免传完才发现超限（R2 写入是计费的）
  const maxCount = await getSettingNumber(env, "sticker_max_count")
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM user_stickers WHERE user_id = ?")
    .bind(user.id)
    .first<{ c: number }>()
  if ((cnt?.c ?? 0) >= maxCount) {
    throw new ApiError(400, `最多保存 ${maxCount} 个表情包，先删掉一些再传`, "TOO_MANY_STICKERS")
  }

  const id = uuid()
  const bucketId = await getPlatformBucketId(env)
  const key = `stickers/${user.id}/${id}.${ext}`
  await putObject(env, key, buf, ct, bucketId)

  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO user_stickers (id, user_id, r2_key, content_type, bytes, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, key, ct, buf.byteLength, now)
    .run()

  return json({
    sticker: { id, url: imageUrl(id), contentType: ct, bytes: buf.byteLength, createdAt: now },
  })
}

/** POST /api/stickers/save —— 把别人发出来的表情包存进自己的表情包（复制一份 R2 对象，幂等） */
export async function saveSticker(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 每次保存都要写 R2（计费），跟上传同一档限流
  await guardRateLimit(env, `sticker-save:${user.id}`, 20, 60, "保存过于频繁，请稍后再试")
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  }

  let id = ""
  try {
    const body = (await request.json()) as { id?: unknown }
    id = typeof body?.id === "string" ? body.id.trim() : ""
  } catch {
    throw new ApiError(400, "请求内容不是合法 JSON", "INVALID_JSON")
  }
  if (!id) throw new ApiError(400, "缺少表情包 id", "INVALID_INPUT")

  const src = await env.DB.prepare(
    "SELECT r2_key, content_type, bytes, source_id FROM user_stickers WHERE id = ?"
  )
    .bind(id)
    .first<{ r2_key: string; content_type: string; bytes: number; source_id: string | null }>()
  if (!src) throw new ApiError(404, "表情包不存在", "NOT_FOUND")

  // 幂等：自己已经存过这个来源（source_id 相同）就直接返回已有的，不重复写 R2。
  //
  // ⚠️ 2026-10-04 用户 onevergiveupa 反馈：同一张表情包从**不同人**那里保存会
  // 存出两份 —— 因为「别人存来的副本」是一个新行、新 id，source_id 只指向它的
  // 直接来源，而那条来源自己又指向同一个原作者。所以去重要同时比对两级：
  //   a) 我存过这张的直接来源（source_id = id）；
  //   b) 我存过「这张的来源」—— 即我此前存过同一个原作者的那张（source_id = src.source_id）。
  // 两级都命中不了才真正复制，链式转发（A 的图被 B 存、B 的又被 C 存）也随之收敛。
  const dup = await env.DB.prepare(
    `SELECT id, content_type, bytes, created_at FROM user_stickers
      WHERE user_id = ? AND (source_id = ? ${src.source_id ? "OR source_id = ?" : ""}) LIMIT 1`
  )
    .bind(user.id, id, ...(src.source_id ? [src.source_id] : []))
    .first<StickerRow>()
  if (dup) {
    return json({ sticker: toDto(dup), alreadySaved: true })
  }

  const maxCount = await getSettingNumber(env, "sticker_max_count")
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM user_stickers WHERE user_id = ?")
    .bind(user.id)
    .first<{ c: number }>()
  if ((cnt?.c ?? 0) >= maxCount) {
    throw new ApiError(400, `最多保存 ${maxCount} 个表情包，先删掉一些再传`, "TOO_MANY_STICKERS")
  }

  // 复制对象（GET 回来再 PUT 成自己的新 key，不能引用同一 key —— 删除会连带删对象）
  // ⚠️ 必须先取到 bucketId 再 getObject/putObject —— getObject 不传 bucketId 会回落
  // resolveBucket(null) → envConfig，env 没 R2 S3 凭据时直接 503「网盘存储未配置」
  const bucketId = await getPlatformBucketId(env)
  const obj = await getObject(env, src.r2_key, undefined, bucketId)
  const buf = await obj.arrayBuffer()
  const newId = uuid()
  const key = `stickers/${user.id}/${newId}.${IMAGE_TYPES[src.content_type] ?? "png"}`
  await putObject(env, key, buf, src.content_type, bucketId)

  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO user_stickers (id, user_id, r2_key, content_type, bytes, created_at, source_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(newId, user.id, key, src.content_type, src.bytes, now, id)
    .run()

  return json({
    sticker: {
      id: newId,
      url: imageUrl(newId),
      contentType: src.content_type,
      bytes: src.bytes,
      createdAt: now,
    },
    alreadySaved: false,
  })
}

/** DELETE /api/stickers/:id —— 删掉一个表情包 */
export async function deleteSticker(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare(
    "SELECT r2_key FROM user_stickers WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<{ r2_key: string }>()
  if (!row) throw new ApiError(404, "表情包不存在", "NOT_FOUND")

  // 先删行、再删对象：行没了用户立刻看不到；万一 R2 删失败，只是留个孤儿对象，
  // 不影响用户，也不影响列表（清理由存储侧兜底）。反过来先删对象的话，
  // 删对象成功而删行失败，用户会看到一个永远加载不出来的破图。
  await env.DB.prepare("DELETE FROM user_stickers WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .run()
  try {
    const bucketId = await getPlatformBucketId(env)
    await deleteObject(env, row.r2_key, bucketId)
  } catch (err) {
    console.error("表情包对象删除失败（已从列表移除）:", id, err)
  }

  return new Response(null, { status: 204 })
}

/**
 * GET /s/:id —— 取表情包图片。
 *
 * ⚠️ **不要求登录**：表情包会出现在公开的社区帖子里，要求登录才能看图，
 * 未登录访客看到的就全是裂图。id 是 uuid，猜不到别人的图。
 */
export async function serveSticker(env: Env, request: Request, id: string): Promise<Response> {
  if (!(await isStorageConfigured(env))) return new Response("Not Found", { status: 404 })
  const row = await env.DB.prepare(
    "SELECT r2_key, content_type FROM user_stickers WHERE id = ?"
  )
    .bind(id)
    .first<{ r2_key: string; content_type: string }>()
  if (!row) return new Response("Not Found", { status: 404 })

  try {
    const bucketId = await getPlatformBucketId(env)
    const res = await getObject(env, row.r2_key, request.headers.get("Range") ?? undefined, bucketId)
    // 先把长缓存塞进响应头 —— hardenUserContentResponse 只在缺失时才补 no-store，
    // 不先设的话这里会被降级成完全不缓存（每次看图都回源 R2）
    const headers = new Headers(res.headers)
    headers.set("Cache-Control", IMMUTABLE_CACHE)
    const filename = `${id}.${IMAGE_TYPES[row.content_type] ?? "png"}`
    return hardenUserContentResponse(
      new Response(res.body, { status: res.status, headers }),
      filename
    )
  } catch {
    return new Response("Not Found", { status: 404 })
  }
}
