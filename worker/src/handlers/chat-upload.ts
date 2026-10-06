/**
 * 聊天图片上传与读取 —— 私聊 / 聊天室 / 广场帖子与评论共用。
 *
 * ── 为什么单独开一套，不复用反馈或社区的 ──
 * · 反馈图片是**私有工单附件**，读取时校验「只有上传者本人与管理员能看」；
 * · 社区图片挂在帖子 id 下（`community/posts/<postId>/...`），必须**先有帖子**才能传；
 * · 聊天场景两者都不合适：私聊/聊天室在发消息前就要能传图，而且图要能被**会话双方**
 *   看到。所以这里用「上传即返回可引用 URL」的形态。
 *
 * ── 鉴权取舍（重要）──
 * 读取**只要求登录**，不校验「你是不是这条会话的参与者」。
 * 理由是 key 里带随机 uuid，URL 不可枚举 —— 拿不到链接就看不到图，
 * 与「未列出即私有」的通行做法一致。要按会话精确鉴权就得让图片知道它属于哪个会话，
 * 而消息是可以转发/引用的，那个映射只会越来越难维护。
 * 代价要清楚：**任何登录用户拿到完整 URL 都能看到这张图**。
 *
 * key 形如 `chat/<userId>/<uuid>.<ext>`，userId 编码进 key，
 * 读取时按 O(1) 定位，不用查表。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { guardRateLimit } from "../ratelimit"
import { isStorageConfigured, putObject, getObject, getPlatformBucketId } from "../r2"
import { hardenUserContentResponse } from "../content-type"
import type { Env } from "../env"

/** 单张上限。与反馈图片一致：聊天图主要是截图，5MB 够用 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 只放行这四种，且以**服务端判定**的 Content-Type 为准（前端说的不算） */
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}
/**
 * key → URL 的解析规则。**用户 id 有两种长度，必须都收**：
 *   · 36 位标准 UUID（`crypto.randomUUID()`，绝大多数账号，1370 个）
 *   · 32 位无横线 hex（早期建的账号，线上只有站长 `Doulor`）
 *
 * ⚠️ 2026-10-06 修：原先写死 `{36}` 只认标准 UUID ⇒ 站长的图上传后
 * `chatImageKeyToUrl` 匹配失败返回**空串**，前端往输入框插的是 `![]()`，
 * 表现为「粘贴图片变成空占位符」。同一天 `serveChatImage` 的只读校验也有同样问题
 * （即使 URL 对了也会 404）。
 */
const USER_ID_PATTERN = "[0-9a-f-]{32,36}"
const CHAT_IMG_KEY_RE = new RegExp(
  `^chat/(${USER_ID_PATTERN})/([A-Za-z0-9-]+\\.(?:jpg|png|webp|gif))$`,
  "i"
)

/** 由 key 还原出可引用的 URL（前端把它塞进 markdown 的 `![]()` 里） */
export function chatImageKeyToUrl(key: string): string {
  const m = CHAT_IMG_KEY_RE.exec(key)
  return m ? `/api/chat/image/${m[1]}/${m[2]}` : ""
}

/**
 * POST /api/chat/upload-image —— 上传一张聊天图片，返回 `{ key, url }`。
 *
 * 请求体是**裸二进制**（与社区/反馈一致），Content-Type 即图片类型。
 * 前端拿到 `url` 后直接插进输入框的 markdown 即可，不需要再换一次。
 */
export async function uploadChatImage(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 每次上传都写 R2，与社区/反馈同为 40 次/分钟
  await guardRateLimit(env, `chat-image:${user.id}`, 40, 60, "图片上传过于频繁")
  if (!(await isStorageConfigured(env))) throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")

  const ct = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase()
  const ext = IMAGE_TYPES[ct]
  if (!ext) throw new ApiError(400, "仅支持 JPG/PNG/WebP/GIF", "INVALID_TYPE")

  const buf = await readBodyCapped(
    request,
    MAX_IMAGE_BYTES,
    `图片需在 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB 以内`,
    400,
    "TOO_LARGE"
  )
  if (buf.byteLength === 0) {
    throw new ApiError(400, `图片需在 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB 以内`, "TOO_LARGE")
  }

  const bucketId = await getPlatformBucketId(env)
  const filename = `${uuid()}.${ext}`
  const key = `chat/${user.id}/${filename}`
  await putObject(env, key, buf, ct, bucketId)

  return json({ key, url: chatImageKeyToUrl(key) }, 201)
}

/**
 * GET /api/chat/image/<userId>/<filename> —— 读取聊天图片。
 *
 * 只校验「已登录」+ 文件名格式（防路径穿越），不校验会话归属，理由见文件头。
 */
export async function serveChatImage(
  env: Env,
  request: Request,
  userId: string,
  filename: string
): Promise<Response> {
  await requireUser(env, request)
  // 文件名只允许 <uuid>.<ext>，杜绝 `../` 之类的路径穿越
  if (!/^[A-Za-z0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(filename)) {
    return new Response("Not Found", { status: 404 })
  }
  // ⚠️ userId 必须与 CHAT_IMG_KEY_RE 用同一套规则（32 或 36 位），否则
  // 早期建的 32 位 id 账号传的图「能上传但读不出来」，一律 404。
  if (!new RegExp(`^${USER_ID_PATTERN}$`, "i").test(userId)) {
    return new Response("Not Found", { status: 404 })
  }
  if (!(await isStorageConfigured(env))) return new Response("Not Found", { status: 404 })

  const bucketId = await getPlatformBucketId(env)
  const key = `chat/${userId}/${filename}`
  try {
    const res = await getObject(env, key, undefined, bucketId)
    // 类型收口 + nosniff，与社区/反馈图片读取一致（纵深防御）
    return hardenUserContentResponse(res, filename)
  } catch {
    return new Response("Not Found", { status: 404 })
  }
}
