/**
 * 临时分享箱（tempbox）。
 *
 * 与网盘的区别：内容临时、匿名可看、接收码解锁。
 *   - 存储：R2 桶 `network` 下的 `temporary/<接收码>/<文件名>`（与网盘/名片目录隔离）
 *   - 元信息：D1 `tempbox_batches`（code、过期时间、创建者、文件数/字节）
 *   - 过期：采用「惰性清理」——访问/下载时若发现已过期，删除该批次 R2 对象并返回 404
 *     （另有每小时一次的定时任务主动清理，见 maintenance.ts）
 *   - 接收码：6 位数字（`crypto` 随机，90 万种）；任何旧码仍兼容
 *   - 分享：前端生成 `/t?code=xxxxxx` 链接（`/t` 是无需登录的公开页），
 *     对方点开自动填入并解锁
 *
 * 权限：
 *   - 查看 / 下载：**无需登录**（访客输入接收码即可解锁），但按 IP 限流
 *   - 上传 / 提交：默认需登录（`tempbox_upload_requires_login`，管理员可关闭）
 *   - 删除：仅创建者本人或管理员
 *
 * 单次上传上限与默认保存时长都由管理员在「设置」里调整。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { uuid } from "../crypto"
import { requireUser, type UserRow, isPrivileged, isAnyAdmin } from "../auth"
import { guardRateLimit, clientIp } from "../ratelimit"
import { getObject, headObject, isStorageConfigured, listObjects, presign, deleteObject, deletePrefix, getPlatformBucketId, putObject, supportsPresign } from "../r2"
import { sanitizeFilename } from "./storage"
import { contentDispositionFor } from "../content-type"
import { getSettings, getSettingBool, getSettingNumber } from "../settings"
import type { Env } from "../env"

const R2_PREFIX = "temporary"

/**
 * 上传侧限流额度（2026-09-25 审计 H1 修复）。
 *
 * 原状况：`create` / `upload-url` / `proxy-upload` / `commit` 四个写接口
 * **一个限流都没有**（对比网盘 storage.ts 有 `guardUploadRate`、
 * 名片 identity.ts 也有）。而分享箱的默认额度是 256MiB × 20 文件/批次，
 * 批次数量不限、也没有「已用字节」概念 —— 任一登录用户都能把平台桶刷满
 * （R2 免费额度只有 10GB，且与网盘、社区图片共享）。
 *
 * 额度取值依据「一个批次最多 20 个文件」：
 *   - upload-url / commit：60 次 / 10 分钟 = 够传满 3 个整批，正常使用碰不到；
 *   - create：20 次 / 小时（建批次比传文件稀疏得多）。
 * 再叠加下面的「同时存活批次数」与「存活总字节数」两道硬闸。
 */
const TEMPBOX_UPLOAD_URL_LIMIT = 60
const TEMPBOX_COMMIT_LIMIT = 60
const TEMPBOX_UPLOAD_WINDOW_SECONDS = 600
const TEMPBOX_CREATE_LIMIT = 20
const TEMPBOX_CREATE_WINDOW_SECONDS = 3600

/**
 * 单个登录用户同时存活的批次数上限。
 * 默认 256MiB × 20 文件/批次 = 5GiB/批次，所以必须限制批次数，
 * 否则「批次数量不限」本身就等于「存储不限」。
 */
const TEMPBOX_MAX_LIVE_BATCHES = 10

/**
 * 单个登录用户同时存活的总字节上限（2 GiB）。
 *
 * 为什么按用户而不是按批次：批次可以无限建，按批次限制没有意义。
 * 为什么取 2 GiB：远小于 R2 免费额度 10GB，保证「一个人刷满」不会
 * 把整个平台的网盘/社区图片一起挤爆；同时正常互传小文件根本到不了。
 * 管理员不受此限制（避免自己测试时被挡住）。
 */
const TEMPBOX_MAX_LIVE_BYTES = 2 * 1024 ** 3

/** 上传侧限流：登录用户按 userId，未登录（开放上传时）按 IP */
async function guardTempboxUpload(
  env: Env,
  request: Request,
  user: UserRow | null,
  kind: "url" | "commit" | "create"
): Promise<void> {
  const who = user ? `user:${user.id}` : `ip:${clientIp(request)}`
  const [limit, window] =
    kind === "create"
      ? [TEMPBOX_CREATE_LIMIT, TEMPBOX_CREATE_WINDOW_SECONDS]
      : kind === "commit"
        ? [TEMPBOX_COMMIT_LIMIT, TEMPBOX_UPLOAD_WINDOW_SECONDS]
        : [TEMPBOX_UPLOAD_URL_LIMIT, TEMPBOX_UPLOAD_WINDOW_SECONDS]
  await guardRateLimit(
    env,
    `tempbox:${kind}:${who}`,
    limit,
    window,
    "上传过于频繁，请稍后再试"
  )
}

/** 该用户当前存活（未过期）批次的文件数与字节数合计 */
async function liveUsage(
  env: Env,
  userId: string
): Promise<{ batches: number; bytes: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS batches, COALESCE(SUM(total_bytes), 0) AS bytes
       FROM tempbox_batches
      WHERE creator_user_id = ? AND expire_at > ?`
  )
    .bind(userId, new Date().toISOString())
    .first<{ batches: number; bytes: number }>()
  return { batches: row?.batches ?? 0, bytes: row?.bytes ?? 0 }
}

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

/**
 * 公开读取接口的 404 文案 —— **所有路径必须用同一句**。
 *
 * ⚠️ 2026-09-25 审计（L3）：原先「码不存在」回「接收码不存在或已失效」，
 * 而「码对但文件名不对」回「文件不存在」。两者状态码与 code 都是 404 / NOT_FOUND，
 * 只有 message 不同 —— 于是攻击者猜中一个真实存在的码时，会因为文案变化而**确知**它存在，
 * 枚举从「猜码」退化成「确认码」。
 *
 * 共用限流桶（CODE_LOOKUP_LIMIT）只能把枚举速度压下来，**掩盖不了文案差异**，
 * 所以文案也必须统一。代价是「码对、文件名错」时提示不够精确 ——
 * 但该接口是匿名可访问的，宁可牺牲一点文案精确度。
 */
const TEMPBOX_NOT_FOUND = "接收码不存在或已失效"

/** 已过期的批次：清理后一律视为不存在 */
async function assertBatchAlive(env: Env, code: string): Promise<TempboxBatchRow> {
  const batch = await loadBatch(env, code)
  if (!batch) throw new ApiError(404, TEMPBOX_NOT_FOUND, "NOT_FOUND")
  if (isExpired(batch)) {
    await purgeExpiredBatch(env, batch.code)
    throw new ApiError(404, TEMPBOX_NOT_FOUND, "NOT_FOUND")
  }
  return batch
}

/**
 * 接收码取值范围：100000–999999，共 90 万种。
 *
 * 不用 000000–999999 是**故意**的：省掉前导零这一整类问题
 * （口头转述时容易漏、数字输入框可能吞掉、从 Excel 复制会丢）。
 * 代价是少 10% 的取值空间，对枚举难度没有实质影响。
 */
const CODE_MIN = 100000
const CODE_SPAN = 900000

/**
 * 公开读取接口限流：同一 IP 10 分钟 60 次。
 *
 * ⚠️ 这个桶由「解锁」和「下载」**共用**，是有意为之：
 *   - 下载接口也接受接收码，如果给它单独放宽额度，它就成了更松的枚举探针。
 *     而且两条路径的报错文案不同（「接收码不存在或已失效」vs「文件不存在」），
 *     攻击者据此可以判断猜中的码是否真实存在。所以必须共桶。
 *   - 60 这个数值是按「一个箱子最多 20 个文件」定的：取一次列表 + 下载满 20 个文件
 *     约 21 次请求，60 留了约 3 倍余量。**再往下压会误伤正常下载。**
 *
 * 因此缩短接收码时，安全余量靠的是取值空间而不是限流：
 * 6 位数字（90 万）比原 4 位数字（9 千）多 100 倍。
 */
const CODE_LOOKUP_LIMIT = 60
const CODE_LOOKUP_WINDOW_SECONDS = 600

/**
 * 生成接收码。
 *
 * ⚠️ 2026-09-23 安全审计（P1）：原实现是 `String(Math.floor(1000 + Math.random() * 9000))`
 * —— **只有 9000 种可能，且用的是非密码学的 Math.random()**。而查看/下载接口无需登录、
 * 当时也没有任何限流，所以把 9000 个码跑一遍就能拿走所有人正在互传的文件与纯文本
 * （用户会自然地把它当密码用）。审计后先改成 8 位字母数字（约 1.1 万亿种）。
 *
 * ⚠️ 2026-09-24 调整：8 位字母数字虽然安全，但用户反馈「太长太难记」。
 * 改为 **6 位数字（`crypto` 随机，90 万种）**，并配一条分享链接
 * （见前端 tempbox 页：`/t?code=xxxxxx`），让对方点开即用、根本不用手输。
 * 安全余量：比 4 位数字多 100 倍取值空间；配合 30 分钟有效期与 60 次/10 分钟限流，
 * 单个 IP 在一个箱子的生命周期内只能试约 180 个码（命中率 0.02%），
 * 1 万个 IP 的僵尸网络也只有约 27% —— 相对 4 位数字（必然被撞开）是决定性的改善。
 *
 * 兼容性：**任何旧接收码仍然可以正常解锁**（查库是字符串匹配，与长度/字符集无关），
 * 存量批次会在到期后被惰性清理掉，不需要数据迁移。
 */
async function generateCode(env: Env): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomNumericCode()
    const exists = await env.DB.prepare(
      "SELECT id FROM tempbox_batches WHERE code = ? LIMIT 1"
    )
      .bind(code)
      .first()
    if (!exists) return code
  }
  throw new ApiError(500, "生成接收码失败，请重试", "INTERNAL")
}

/**
 * 用密码学随机数取一个 6 位码。
 *
 * 用**拒绝采样**而不是直接 `uint32 % CODE_SPAN`：2^32 不是 900000 的整数倍，
 * 直接取模会让数值最小的那几个码概率略高。偏差本身极小，但没必要留这个尾巴。
 * 拒绝概率约 0.004%，实际上几乎不会重试。
 */
function randomNumericCode(): string {
  const MAX_EXCLUSIVE = 0x100000000
  const LIMIT = Math.floor(MAX_EXCLUSIVE / CODE_SPAN) * CODE_SPAN
  const buf = new Uint32Array(1)
  let v: number
  do {
    crypto.getRandomValues(buf)
    v = buf[0]
  } while (v >= LIMIT)
  return String(CODE_MIN + (v % CODE_SPAN))
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

/**
 * 能否**覆盖**该批次里已有的同名文件。
 *
 * ⚠️ 这里的判定**故意比删除宽松**，别照抄 deleteTempbox / deleteTempboxFile 的属主校验：
 *   · 删除：只有创建者本人（或管理员）能删 —— 否则别人能把你的箱子清空；
 *   · 写入：**知道接收码就能传**是 tempbox 的产品语义 —— 接收码本身就是凭证，
 *     典型用法是「把文件传进我的接收码」（接收方通常**不是**创建者）。
 *     若强行要求上传者必须是创建者，这个功能就没用了。
 *
 * 所以要防的不是「非属主上传」，而是**非属主覆盖**：
 * 2026-10-09 渗透测试 finding#3 实测，非属主 B 能用同名文件把 A 箱子里已有的
 * `victim.txt` 替换掉（内容被篡改、A 看到的 size 也变了）。归属只用来决定
 * 「能不能盖掉**已存在**的对象」，不用来决定「能不能新增」。
 */
function canOverwrite(user: UserRow | null, batch: TempboxBatchRow): boolean {
  if (isAnyAdmin(user?.role)) return true
  if (!user || !batch.creator_user_id) return false
  return batch.creator_user_id === user.id
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
    // 「同时存活的分享箱数量上限」是常量，之前没下发给前端，导致用户把
    // 「最多文件数(每箱)」误解成「最多 20 个分享箱」。这里一并下发，前端分开展示。
    maxLiveBatches: TEMPBOX_MAX_LIVE_BATCHES,
    uploadRequiresLogin: settings.tempbox_upload_requires_login === "1",
  })
}

// ---- 上传（需登录，或按设置对外开放）----

/**
 * POST /api/tempbox/create —— 创建一个批次，返回接收码。
 * 若 body 带 text 则同时存为纯文本（文字不占 R2）。
 */
export async function createTempbox(env: Env, request: Request): Promise<Response> {
  // ⚠️ 2026-09-25 审计（F1）：原实现是 `if (!(await getSettings(env)).tempbox_enabled)`。
  // settings 里的值**全是字符串**，所以 `"0"` 是 truthy → `!"0"` === false →
  // 管理员在设置页把分享箱关掉（存成 "0"）后，这个开关**根本关不掉**。
  // 全仓只有这一处用真值判断，其余都走 getSettingBool（它按 "1" 判定）。
  if (!(await getSettingBool(env, "tempbox_enabled"))) {
    throw new ApiError(403, "临时分享箱已关闭", "FEATURE_DISABLED")
  }
  const user = await requireUploader(env, request)
  await guardTempboxUpload(env, request, user, "create")

  // 同时存活的批次数上限（见 TEMPBOX_MAX_LIVE_BATCHES 的说明）
  if (user && !isAnyAdmin(user.role)) {
    const usage = await liveUsage(env, user.id)
    if (usage.batches >= TEMPBOX_MAX_LIVE_BATCHES) {
      throw new ApiError(
        429,
        `同时最多保留 ${TEMPBOX_MAX_LIVE_BATCHES} 个未过期的分享箱，请先等旧的分箱过期或手动删除`,
        "TOO_MANY_BATCHES"
      )
    }
  }

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

  // 累计创建数 +1（成就「分享即达」按累计算；批次过期会被清理，不能依赖 tempbox_batches 行数）
  if (user) {
    await env.DB.prepare(
      "UPDATE user_stats SET tempbox_created = tempbox_created + 1 WHERE user_id = ?"
    )
      .bind(user.id)
      .run()
  }

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
  await guardTempboxUpload(env, request, uploader, "url")
  // 兼作「批次存在且未过期」的校验；返回值顺便复用（原来这里查了两次库）
  const batch = await assertBatchAlive(env, code)

  // 管理员/站长不受分享箱配额限制
  const isAdmin = isPrivileged(uploader?.role)
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

  if (batch.file_count >= maxFiles) {
    throw new ApiError(400, `每个接收码最多 ${maxFiles} 个文件`, "TOO_MANY_FILES")
  }

  const key = `${R2_PREFIX}/${code}/${filename}`
  const platformBucket = await getPlatformBucketId(env)

  // 非属主不得**覆盖**箱子里已有的文件（新增不受限 —— 见 canOverwrite 的说明）
  if (!canOverwrite(uploader, batch)) {
    const existing = await headObject(env, key, platformBucket)
    if (existing) {
      throw new ApiError(409, "该文件名已被占用，请换一个文件名", "FILE_EXISTS")
    }
  }

  const presigned = await supportsPresign(env, platformBucket)
  const uploadUrl = presigned
    ? // 把 content-length 纳入签名（见 r2.ts 的 presign 与 P0-6）：
      // 否则可以声明 size=1 过校验，再用同一个 URL PUT 任意大小的对象。
      await presign(env, "PUT", key, 3600, platformBucket, size)
    : `/api/tempbox/${encodeURIComponent(code)}/proxy-upload?key=${encodeURIComponent(key)}`

  /**
   * 记账（2026-10-09 渗透测试 finding#7）。配额守卫 `liveUsage` 读的是
   * `tempbox_batches.total_bytes`，而原先**只有 commit** 才写它 ⇒
   * 「PUT 完不 commit」等于零记账，2 GiB「存活字节」上限形同虚设
   * （对象却已经落桶、可被公开列出与下载）。
   *
   * 这里只给**预签名直传**路径记：直传不经 Worker，拿不到真实字节，只能按声明大小记
   * （presign 已把 content-length 纳入签名 ⇒ 声明值可信、实际 PUT 必须等于它）。
   * proxy 回退路径留给 `proxyTempboxUpload` 按**真实字节**记 —— 两条路径互斥
   * （presign 为真时返回的是直传 URL，不会再走 proxy），所以不会重复计数。
   *
   * ⚠️ 增量记账会因「同名重复上传」偏大，但 commit / 文件删除都会用 R2 实算**覆写**
   * 这两个字段，误差在下次 commit 时自愈，且偏保守（更早触发上限）。
   */
  if (presigned) {
    await env.DB.prepare(
      "UPDATE tempbox_batches SET total_bytes = total_bytes + ?, file_count = file_count + 1 WHERE code = ?"
    )
      .bind(size, code)
      .run()
  }

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
  // 原先这里连调了 3 次 requireUploader（等于 3 次会话查询），合并成一次
  const uploader = await requireUploader(env, request)
  await guardTempboxUpload(env, request, uploader, "url")
  // 兼作「批次存在且未过期」校验，返回值复用
  const batch = await assertBatchAlive(env, code)

  const key = new URL(request.url).searchParams.get("key") ?? ""
  if (!key.startsWith(`${R2_PREFIX}/${code}/`)) {
    throw new ApiError(403, "非法的文件路径", "FORBIDDEN")
  }

  const platformBucket = await getPlatformBucketId(env)

  // 非属主不得**覆盖**已有文件（新增不受限 —— 见 canOverwrite 的说明）。
  // ⚠️ 这条必须在这里**再做一遍**：proxy-upload 可以跳过 upload-url 直接被 PUT
  // （渗透测试的 PoC 就是这么打的），只在上游拦一道等于没拦。
  if (!canOverwrite(uploader, batch)) {
    const existing = await headObject(env, key, platformBucket)
    if (existing) {
      throw new ApiError(409, "该文件名已被占用，请换一个文件名", "FILE_EXISTS")
    }
  }

  // 管理员/站长不受大小限制
  const maxFileBytes =
    isPrivileged(uploader?.role)
      ? ADMIN_UNLIMITED
      : await getSettingNumber(env, "tempbox_max_file_bytes")
  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream"
  // ⚠️ 2026-09-26 审计：原先「先整体读进内存再判大小」。tempbox 在
  // `tempbox_upload_requires_login` 关闭时匿名可传，打满内存更划算。
  // `readBodyCapped` 先看 Content-Length 快速拒绝，读完再复核真实长度。
  const buf = await readBodyCapped(
    request,
    maxFileBytes,
    `单个文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB`,
    400,
    "FILE_TOO_LARGE"
  )
  if (buf.byteLength === 0) {
    throw new ApiError(400, "文件为空", "INVALID_INPUT")
  }

  // 落盘前先判存活总字节（token 模式下字节已在内存里，能提前拦掉）
  if (uploader && !isAnyAdmin(uploader.role)) {
    const usage = await liveUsage(env, uploader.id)
    if (usage.bytes + buf.byteLength > TEMPBOX_MAX_LIVE_BYTES) {
      throw new ApiError(
        413,
        "临时分享箱的暂存总量已满，请等旧的分箱过期后再传",
        "TEMPBOX_QUOTA_EXCEEDED"
      )
    }
  }

  await putObject(env, key, buf, contentType, platformBucket)

  // 记账：见 createTempboxUploadUrl 里同一段说明（proxy 路径按**真实字节**记）。
  // 不记的话「PUT 完不 commit」就完全不进配额账（渗透测试 finding#7）。
  await env.DB.prepare(
    "UPDATE tempbox_batches SET total_bytes = total_bytes + ?, file_count = file_count + 1 WHERE code = ?"
  )
    .bind(buf.byteLength, code)
    .run()

  return json({ ok: true, key, size: buf.byteLength })
}

/** POST /api/tempbox/:code/commit —— 上传完成后登记（校验真实大小） */
export async function commitTempboxUpload(
  env: Env,
  request: Request,
  code: string
): Promise<Response> {
  const uploader = await requireUploader(env, request)
  await guardTempboxUpload(env, request, uploader, "commit")
  const batch = await assertBatchAlive(env, code)

  const body = (await request.json().catch(() => ({}))) as { key?: string }
  const key = body.key ?? ""
  if (!key.startsWith(`${R2_PREFIX}/${code}/`)) {
    throw new ApiError(403, "非法的文件路径", "FORBIDDEN")
  }

  const platformBucket = await getPlatformBucketId(env)
  const head = await headObject(env, key, platformBucket)
  if (!head) throw new ApiError(404, "上传未完成或文件不存在", "NOT_FOUND")

  const isAdmin = isPrivileged(uploader?.role)
  const maxFileBytes = isAdmin
    ? ADMIN_UNLIMITED
    : await getSettingNumber(env, "tempbox_max_file_bytes")
  const maxFiles = isAdmin
    ? ADMIN_UNLIMITED
    : await getSettingNumber(env, "tempbox_max_files")
  if (head.size > maxFileBytes) {
    // 超额：删掉刚上传的对象，保持账实一致
    await deleteObject(env, key, platformBucket)
    throw new ApiError(400, "文件超过大小限制，已取消", "FILE_TOO_LARGE")
  }

  // ⚠️ 2026-09-25 审计（L4）：原实现是 `file_count = file_count + 1`，**不幂等**。
  // 同一个 key 重复调 commit 就能把计数刷高，同时让 upload-url 里的
  // `file_count >= maxFiles` 判断失效（该判断与实际写入之间是 TOCTOU）。
  // 改成以 R2 实际内容为准重算 —— 幂等、自愈，顺带把 maxFiles 真正执行到位。
  const page = await listObjects(env, `${R2_PREFIX}/${code}/`, {
    limit: 1000,
    bucketId: platformBucket,
  })
  const objects = page.objects.filter((o) => !o.key.endsWith("/"))
  const fileCount = objects.length
  const totalBytes = objects.reduce((s, o) => s + o.size, 0)

  if (fileCount > maxFiles) {
    await deleteObject(env, key, platformBucket)
    throw new ApiError(400, `每个接收码最多 ${maxFiles} 个文件，已取消`, "TOO_MANY_FILES")
  }

  // 存活总字节上限：只算本批次新增的部分，避免重复 commit 时被重复计入
  if (uploader && !isAdmin) {
    const usage = await liveUsage(env, uploader.id)
    const delta = Math.max(0, totalBytes - (batch.total_bytes ?? 0))
    if (usage.bytes + delta > TEMPBOX_MAX_LIVE_BYTES) {
      await deleteObject(env, key, platformBucket)
      throw new ApiError(
        413,
        "临时分享箱的暂存总量已满，请等旧的分箱过期后再传",
        "TEMPBOX_QUOTA_EXCEEDED"
      )
    }
  }

  await env.DB.prepare(
    "UPDATE tempbox_batches SET file_count = ?, total_bytes = ? WHERE code = ?"
  )
    .bind(fileCount, totalBytes, code)
    .run()

  return json({
    filename: key.slice(`${R2_PREFIX}/${code}/`.length),
    size: head.size,
    fileCount,
    totalBytes,
  })
}

// ---- 查看 / 下载（无需登录）----

/** GET /api/tempbox/:code —— 批次信息 + 文件列表（纯文本批次还带 textContent） */
export async function getTempbox(
  env: Env,
  request: Request,
  code: string
): Promise<Response> {
  // 限流：这是"拿接收码猜内容"的主要入口。fail-open（表未建时放行）。
  await guardRateLimit(
    env,
    `tempbox:lookup:ip:${clientIp(request)}`,
    CODE_LOOKUP_LIMIT,
    CODE_LOOKUP_WINDOW_SECONDS,
    "接收码尝试过于频繁"
  )

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
  // 与 getTempbox 共用同一个限流桶：否则可以绕开列表接口直接猜「码 + 文件名」下载
  await guardRateLimit(
    env,
    `tempbox:lookup:ip:${clientIp(request)}`,
    CODE_LOOKUP_LIMIT,
    CODE_LOOKUP_WINDOW_SECONDS,
    "接收码尝试过于频繁"
  )

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

  // ⚠️ 2026-09-25 审计（P0-1）：原 HEAD 分支把 R2 里存的原始 Content-Type
  // 直接回给匿名调用者（绕过类型收口），GET 分支则用
  // `contentType.startsWith("image/")` 判内联 —— 而 `image/svg+xml` 命中该前缀。
  // 分享箱的接收码是**创建者自己生成的**（不需要猜），所以「上传 evil.svg →
  // 分享 /api/tempbox/<自己的码>/evil.svg」是一条完整的同源 XSS 利用链。
  // 现在两条分支都走 content-type.ts 的统一判定（已排除 SVG 与 +xml）。
  if (method === "HEAD") {
    const head = await headObject(env, key, platformBucket)
    if (!head) throw new ApiError(404, TEMPBOX_NOT_FOUND, "NOT_FOUND")
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
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  const range = request.headers.get("Range") ?? undefined
  // ⚠️ 2026-09-25 审计（L3）：`getObject` 对缺失对象抛的是「文件不存在」，
  // 而「码不存在」抛的是「接收码不存在或已失效」—— 文案不同就等于告诉攻击者
  // 「这个码是真实存在的，只是文件名猜错了」。GET 是更常被用来枚举的路径，
  // 所以这里必须把 404 文案也统一掉。
  let upstream: Response
  try {
    upstream = await getObject(env, key, range, platformBucket)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(404, TEMPBOX_NOT_FOUND, "NOT_FOUND")
    }
    throw err
  }
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

  // 白名单内的类型（图片/音视频/纯文本/PDF）内联预览；其余强制下载。
  // 判定见 worker/src/content-type.ts —— 已排除 SVG / HTML / 一切 +xml。
  const { contentType, contentDisposition } = contentDispositionFor(
    headers.get("content-type"),
    filename
  )
  headers.set("Content-Type", contentType)
  headers.set("Content-Disposition", contentDisposition)

  return new Response(upstream.body, { status: upstream.status, headers })
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

  if (!isAnyAdmin(user.role) && (!batch.creator_user_id || batch.creator_user_id !== user.id)) {
    throw new ApiError(403, "只能删除自己创建的临时分享", "FORBIDDEN")
  }

  await deletePrefix(env, `${R2_PREFIX}/${code}/`, 50, await getPlatformBucketId(env))
  await env.DB.prepare("DELETE FROM tempbox_batches WHERE code = ? COLLATE NOCASE")
    .bind(code)
    .run()

  return new Response(null, { status: 204 })
}

/** DELETE /api/tempbox/:code/:filename —— 删除批次内的单个文件（创建者本人或管理员） */
export async function deleteTempboxFile(
  env: Env,
  request: Request,
  code: string,
  filename: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const batch = await loadBatch(env, code)
  if (!batch) throw new ApiError(404, TEMPBOX_NOT_FOUND, "NOT_FOUND")

  if (
    !isAnyAdmin(user.role) &&
    (!batch.creator_user_id || batch.creator_user_id !== user.id)
  ) {
    throw new ApiError(403, "只能删除自己创建的临时分享", "FORBIDDEN")
  }

  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  }
  // 防目录穿越：与下载侧同一套收口
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new ApiError(403, "非法的文件名", "FORBIDDEN")
  }

  const platformBucket = await getPlatformBucketId(env)
  await deleteObject(env, `${R2_PREFIX}/${code}/${filename}`, platformBucket)

  // 与 commit 一致：以 R2 实际内容为准重算 file_count / total_bytes，保持账实一致
  const page = await listObjects(env, `${R2_PREFIX}/${code}/`, {
    limit: 1000,
    bucketId: platformBucket,
  })
  const objects = page.objects.filter((o) => !o.key.endsWith("/"))
  const fileCount = objects.length
  const totalBytes = objects.reduce((s, o) => s + o.size, 0)
  await env.DB.prepare(
    "UPDATE tempbox_batches SET file_count = ?, total_bytes = ? WHERE code = ?"
  )
    .bind(fileCount, totalBytes, code)
    .run()

  return json({ fileCount, totalBytes })
}