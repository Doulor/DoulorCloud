import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { guardRateLimit } from "../ratelimit"
import type { Env } from "../env"

/**
 * 捐献页底部「赞助」二维码（2026-11-02）
 *
 * ?? 为什么不用 R2：
 *    线上平台桶 cloud1 的凭据读不到（GET 时抛 R2_NOT_CONFIGURED：缺少 R2 S3 凭据），
 *    上传能过、读取必炸。与其去动全站的 R2 配置，不如把这张图放 D1 —— 单张二维码
 *    压到 500KB 以内完全够用，而且不依赖任何外部存储。
 *
 * 存储：新增 site_assets 表（key / content(base64) / content_type / updated_at），
 *       只在 GET /api/tip-qr 这一个接口里读，不进 getSettings()，不会拖慢其它请求。
 *
 * 安全：GET 公开（未设置返回 404），上传/删除仅管理员（settings 权限节点）。
 */

/** 原始图片上限：600KB（base64 后约 800KB，单行仍在 D1 限制内） */
const MAX_BYTES = 600 * 1024

const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
}

/** 按文件头猜真实类型（微信/安卓截图常带 application/octet-stream） */
function sniffType(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf.slice(0, 12))
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp"
  }
  const head = new TextDecoder().decode(buf.slice(0, 256)).trimStart().toLowerCase()
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml"
  }
  return null
}

/** ArrayBuffer → base64（Workers 运行时没有 Buffer，只能手写） */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** base64 → Uint8Array */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** GET /api/tip-qr —— 公开读取二维码（未设置返回 404，前端据此显示占位） */
export async function getTipQr(env: Env, _request: Request): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT content, content_type FROM site_assets WHERE key = 'tip-qr' LIMIT 1"
  ).first<{ content: string; content_type: string }>()

  if (!row?.content) throw new ApiError(404, "未设置赞赏码", "NOT_FOUND")

  const bytes = fromBase64(row.content)
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": row.content_type || "image/png",
      // 换图后最多 5 分钟生效；后台预览会带 ?v=时间戳 立即刷新
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  })
}

/** POST /api/admin/tip-qr —— 上传/替换（管理员） */
export async function uploadTipQr(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "settings")
  await guardRateLimit(env, `admin:tip-qr:${admin.id}`, 10, 60, "换图太频繁，请稍后再试")

  const declared = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()

  const buf = await request.arrayBuffer()
  if (buf.byteLength === 0) throw new ApiError(400, "图片内容是空的", "INVALID_INPUT")
  if (buf.byteLength > MAX_BYTES) {
    throw new ApiError(400, "图片需在 600 KB 以内（二维码建议 300 KB 以下）", "TOO_LARGE")
  }

  const ct = TYPES[declared] ? declared : (sniffType(buf) ?? "")
  if (!TYPES[ct]) throw new ApiError(400, "仅支持 JPG / PNG / WebP / GIF / SVG", "INVALID_TYPE")

  await env.DB.prepare(
    `INSERT INTO site_assets (key, content, content_type, updated_at)
     VALUES ('tip-qr', ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET content = excluded.content,
                                    content_type = excluded.content_type,
                                    updated_at = excluded.updated_at`
  )
    .bind(toBase64(buf), ct)
    .run()

  return json({ ok: true, type: ct, size: buf.byteLength }, 201)
}

/** DELETE /api/admin/tip-qr —— 移除（管理员） */
export async function deleteTipQr(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "settings")
  await env.DB.prepare("DELETE FROM site_assets WHERE key = 'tip-qr'").run()
  return json({ ok: true, removedBy: admin.id })
}
