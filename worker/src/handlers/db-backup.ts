import { ApiError, json } from "../http"
import { deleteObject, listObjects, presign, putObject, supportsPresign } from "../r2"
import type { Env } from "../env"

/**
 * 数据库备份上传到 R2（2026-10-06 站长要求）
 *
 * 用途：家里云每天把 new-api 主库的 pg_dump 传一份到站点 R2，
 * 留一份**离开家里云**的异地副本（家里云本地已经有一份，这是第二份）。
 *
 * ⚠️ 为什么是「分片转发」而不是「预签名直传」：
 *   线上三个桶的凭据都是 **API Token 模式**（桶级 S3 键留空、回退全局 R2_API_TOKEN），
 *   而预签名只支持 S3 键模式 —— 所以拿不到直传 URL。退而求其次用 Worker 转发，
 *   但一份备份约 60 MB，一次塞进 Worker 会顶到 128 MB 内存限制，
 *   于是**切成 7MB 的分片**逐个传，每个分片单独存成 `<名字>.partNNN`。
 *
 *   恢复时按 part 序号下载后 `cat` 拼回单个文件即可：
 *     for i in $(seq -w 0 N); do 下载 <id>.dump.part$i; done; cat 它们 > restore.dump
 *
 *   如果以后给某个桶补上 S3 密钥，`/url` 那个接口会自动可用（直传，免转发）。
 *
 * 鉴权：请求头 `X-Backup-Token` 必须等于 Worker secret `BACKUP_UPLOAD_TOKEN`。
 * ⚠️ **没配这个 secret 时整个功能关闭（503）** —— 否则会变成谁都能用的公开上传口。
 */

/**
 * ⚠️ 用独立子目录 `db-backups/newapi/`，不要用 `db-backups/` 本身：
 *   prune 是「按名字倒序保留最新 N 个」，如果同层还有别的杂项对象
 *   （名字排序恰好比正式备份新），它们会永远占着名额、把正式备份挤掉。
 *   而目前**删不掉它们** —— `r2.ts` 的 `r2OrError()` 只看 HTTP 状态码、
 *   不看 Cloudflare API 返回体里的 `success` 字段，于是删除失败时返回的
 *   HTTP 200 被当成了成功（同一个问题也会让头像清理静默失败）。
 *   隔离到子目录是最省事且不影响共享文件的解法。
 */
const PREFIX = "db-backups/newapi/"
/** 文件名白名单：字母数字开头 + [A-Za-z0-9._-]，最长 121 字符。防路径穿越。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
/** 单份完整备份上限 200MB（实际约 60MB，留足余量） */
const MAX_BYTES = 200 * 1024 * 1024
/** 单个分片上限 8MB（家里云按 7MB 切，留一点余量） */
const MAX_CHUNK = 8 * 1024 * 1024

/** 定长比较，避免「逐字符提前返回」被用来猜令牌内容 */
function tokenMatches(got: string, expect: string): boolean {
  if (got.length !== expect.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expect.charCodeAt(i)
  return diff === 0
}

function assertBackupToken(env: Env, request: Request): void {
  const expect = env.BACKUP_UPLOAD_TOKEN?.trim()
  if (!expect) {
    throw new ApiError(503, "备份上传未启用（Worker 未配置 BACKUP_UPLOAD_TOKEN）", "BACKUP_DISABLED")
  }
  const got = request.headers.get("X-Backup-Token")?.trim() ?? ""
  if (!tokenMatches(got, expect)) {
    throw new ApiError(401, "备份令牌不正确", "FORBIDDEN")
  }
}

/** 备选桶按「平台桶优先」排序 —— 平台数据放平台桶最合适 */
async function enabledBucketIds(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM r2_buckets WHERE enabled = 1 ORDER BY (kind = 'platform') DESC, sort_order ASC"
  ).all<{ id: string }>()
  return (rows.results ?? []).map((r) => r.id)
}

/** 写分片随便哪个启用桶都行（token 模式也能写）；平台桶优先 */
async function pickWriteBucket(env: Env): Promise<string> {
  const ids = await enabledBucketIds(env)
  if (ids.length === 0) {
    throw new ApiError(503, "没有启用中的存储桶", "R2_NOT_CONFIGURED")
  }
  return ids[0]
}

/** GET /internal/db-backup/url?name=&size= —— 申领预签名直传地址（需 S3 键模式的桶） */
export async function dbBackupUrlHandler(env: Env, request: Request): Promise<Response> {
  assertBackupToken(env, request)
  const url = new URL(request.url)
  const name = (url.searchParams.get("name") ?? "").trim()
  if (!NAME_RE.test(name)) {
    throw new ApiError(400, "文件名不合法（只允许字母数字 . _ -）", "INVALID_INPUT")
  }
  const size = Math.trunc(Number(url.searchParams.get("size")))
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    throw new ApiError(400, "文件大小不合法（需 0 ~ 200MB）", "INVALID_INPUT")
  }
  for (const id of await enabledBucketIds(env)) {
    if (!(await supportsPresign(env, id))) continue
    const key = `${PREFIX}${name}`
    const signed = await presign(env, "PUT", key, 3600, id, size)
    return json({ mode: "presign", key, url: signed, expiresIn: 3600, bucket: id })
  }
  throw new ApiError(
    409,
    "没有「支持预签名直传」的存储桶（桶凭据需为 S3 键模式，而非 API Token 模式），请改用 /chunk 分片上传",
    "NO_PRESIGN_BUCKET"
  )
}

/**
 * POST /internal/db-backup/chunk?name=<完整文件名>&part=<分片序号>
 *
 * 请求体 = 该分片的原始字节（≤8MB）。存成 `db-backups/<name>.part000` 之类。
 * 之所以不拼成单个对象：拼装要走 S3 multipart，代码量与风险都更大；
 * 分片各自成对象对备份场景完全够用（恢复时按序 cat 即可）。
 */
export async function dbBackupChunkHandler(env: Env, request: Request): Promise<Response> {
  assertBackupToken(env, request)
  const url = new URL(request.url)
  const name = (url.searchParams.get("name") ?? "").trim()
  if (!NAME_RE.test(name)) {
    throw new ApiError(400, "文件名不合法（只允许字母数字 . _ -）", "INVALID_INPUT")
  }
  const part = Math.trunc(Number(url.searchParams.get("part")))
  if (!Number.isFinite(part) || part < 0 || part > 9999) {
    throw new ApiError(400, "分片序号不合法", "INVALID_INPUT")
  }
  // 先看声明的长度，能提前拒掉超大请求（避免白读一遍 body）
  const declared = Math.trunc(Number(request.headers.get("content-length") ?? "0"))
  if (declared > MAX_CHUNK) {
    throw new ApiError(413, `单个分片不能超过 ${MAX_CHUNK / 1048576}MB`, "PAYLOAD_TOO_LARGE")
  }
  const buf = await request.arrayBuffer()
  if (buf.byteLength === 0) {
    throw new ApiError(400, "分片内容为空", "INVALID_INPUT")
  }
  if (buf.byteLength > MAX_CHUNK) {
    throw new ApiError(413, `单个分片不能超过 ${MAX_CHUNK / 1048576}MB`, "PAYLOAD_TOO_LARGE")
  }

  const bucketId = await pickWriteBucket(env)
  const key = `${PREFIX}${name}.part${String(part).padStart(3, "0")}`
  await putObject(env, key, buf, "application/octet-stream", bucketId)
  return json({ ok: true, key, size: buf.byteLength, bucket: bucketId })
}

/**
 * POST /internal/db-backup/delete?key=<对象键> —— 删掉一个备份对象（或它的分片）
 *
 * 只允许删 `db-backups/` 下的键。主要给「清理误传/测试对象」用 ——
 * prune 是按名字倒序保留最新的，名字排序靠前的杂项会**永远**排在正式备份前面
 * 从而挤掉正式备份，所以手工删除的能力是必要的。
 */
export async function dbBackupDeleteHandler(env: Env, request: Request): Promise<Response> {
  assertBackupToken(env, request)
  const url = new URL(request.url)
  const key = (url.searchParams.get("key") ?? "").trim()
  if (!key.startsWith(PREFIX) || key.includes("..") || key.length > 200) {
    throw new ApiError(400, "只能删 db-backups/ 下的对象键", "INVALID_INPUT")
  }
  const rest = key.slice(PREFIX.length)
  if (!NAME_RE.test(rest.replace(/\.part[0-9]{3}$/, ""))) {
    throw new ApiError(400, "对象键不合法", "INVALID_INPUT")
  }
  const deleted: string[] = []
  for (const bucketId of await enabledBucketIds(env)) {
    try {
      await deleteObject(env, key, bucketId)
      deleted.push(bucketId)
    } catch {
      /* 该桶里没有这个键 / 删不掉，继续试下一个桶 */
    }
  }
  return json({ key, deletedIn: deleted })
}

/** 把一个对象键归并成「一次备份」的标识：`xxx.dump.part003` → `xxx.dump` */
function backupIdOf(key: string): string {
  const m = key.match(/\.part[0-9]{3}$/)
  return m ? key.slice(0, m.index) : key
}

/**
 * POST /internal/db-backup/prune?keep=14 —— 只保留最近 N 次备份
 *
 * 一次备份可能由多个分片对象组成，所以按 `backupIdOf()` 归并后再按名字倒序
 * （文件名带时间戳，字典序即时间序），超出的整组删掉。
 * 扫**所有**启用桶：桶配置换过（例如平台桶后来补了 S3 键 → 直传落到别的桶）时，
 * 旧桶里的历史备份也要能被清理。
 */
export async function dbBackupPruneHandler(env: Env, request: Request): Promise<Response> {
  assertBackupToken(env, request)
  const url = new URL(request.url)
  const rawKeep = Math.trunc(Number(url.searchParams.get("keep") ?? "14"))
  const keep = Number.isFinite(rawKeep) ? Math.min(90, Math.max(1, rawKeep)) : 14

  const items: { bucketId: string; key: string; id: string }[] = []
  for (const bucketId of await enabledBucketIds(env)) {
    try {
      const { objects } = await listObjects(env, PREFIX, { limit: 1000, bucketId })
      for (const o of objects) {
        if (!o.key.startsWith(PREFIX)) continue
        if (!o.key.endsWith(".dump") && !/\.part[0-9]{3}$/.test(o.key)) continue
        items.push({ bucketId, key: o.key, id: backupIdOf(o.key) })
      }
    } catch {
      // 单个桶读不了（凭据/网络问题）不该让整次清理失败
    }
  }

  const ids = [...new Set(items.map((i) => i.id))].sort().reverse() // 最新在前
  const keepSet = new Set(ids.slice(0, keep))
  const doomed = items.filter((i) => !keepSet.has(i.id))
  for (const d of doomed) {
    try {
      await deleteObject(env, d.key, d.bucketId)
    } catch {
      /* 删不掉就留着，下次再试 */
    }
  }
  return json({
    backups: ids.length,
    kept: ids.slice(0, keep),
    deleted: [...new Set(doomed.map((d) => d.id))],
    deletedObjects: doomed.length,
  })
}
