import { ApiError, json } from "../http"
import { requireFeatureUser } from "../auth"

import { isR2Configured, putObject, deleteObject, getObject } from "../r2"
import { attachCustomDomain, detachCustomDomain } from "../custom-domain"
import type { Env } from "../env"

/**
 * 个人名片。
 *
 * 两种入口：
 *   1. 默认路径 https://cloud.doulor.cn/profile/<slug>  → 由 index.ts 渲染 HTML
 *   2. 自定义域名（用户把自己某个子域名绑到名片，与网盘直链互斥）
 *
 * 资源存 R2：profiles/<用户名>/avatar|background|music.<ext>
 * 用户名做目录名，便于归档与清理（改用户名不会自动迁移，与网盘行为一致）。
 */

const MAX_AVATAR_BYTES = 5 * 1024 * 1024 // 5 MiB
const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024 // 10 MiB
const MAX_MUSIC_BYTES = 20 * 1024 * 1024 // 20 MiB

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}
const AUDIO_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
}

export const THEMES = [
  "void",
  "neon",
  "glass",
  "aurora",
  "cyber",
  "blossom",
] as const

/**
 * 独立勾选的常驻动效。与主题不绑定，用户自由混搭组合。
 * particles 与 rain 互斥（共用 canvas 层），渲染层会保留 particles。
 */
export const EFFECTS = [
  "particles",
  "tilt",
  "glitch",
  "glow",
  "rain",
  "sparkle",
] as const

/**
 * 开屏动画。enter/portal 为交互式（点击进入主界面），fade/slide 为非交互式（自动进入）。
 * 与主题、动效独立混搭。
 */
export const INTROS = ["none", "enter", "portal", "fade", "slide"] as const

/**
 * 自托管字体。仅英文/拉丁字符集，中文回退系统字体栈。
 * 字体文件在静态站点 /fonts/<id>.woff2，名片页用绝对 URL 引用。
 */
export const FONTS = [
  "system",
  "space",
  "orbitron",
  "jetbrains",
  "audiowide",
  "playfair",
  "cinzel",
  "poppins",
  "bebas",
] as const

/** 带标签/描述的选项列表，供前端选择器渲染。与服务端白名单同源，避免前后端不一致。 */
export const THEME_OPTIONS = [
  { id: "void", label: "虚空", desc: "纯黑虚空，accent 辉光勾勒" },
  { id: "neon", label: "霓虹", desc: "合成波霓虹辉光" },
  { id: "glass", label: "玻璃", desc: "毛玻璃拟态" },
  { id: "aurora", label: "极光", desc: "流动多色渐变" },
  { id: "cyber", label: "赛博", desc: "HUD 网格切角" },
  { id: "blossom", label: "绽放", desc: "浅色优雅粉色" },
] as const

export const EFFECT_OPTIONS = [
  { id: "particles", label: "粒子连线", desc: "浮动粒子与连线背景" },
  { id: "tilt", label: "3D 倾斜", desc: "鼠标移动时卡片倾斜" },
  { id: "glitch", label: "文字故障", desc: "名称文字故障跳动" },
  { id: "glow", label: "脉冲发光", desc: "按钮呼吸发光" },
  { id: "rain", label: "代码雨", desc: "Matrix 风格下落字符" },
  { id: "sparkle", label: "星光闪烁", desc: "随机闪烁亮点" },
] as const

export const INTRO_OPTIONS = [
  { id: "none", label: "无", desc: "直接显示内容" },
  { id: "enter", label: "点击进入", desc: "点击后展示内容（交互式）" },
  { id: "portal", label: "传送门", desc: "旋转传送门，点击进入（交互式）" },
  { id: "fade", label: "渐入", desc: "内容自动淡入（非交互式）" },
  { id: "slide", label: "上滑", desc: "内容自动上滑（非交互式）" },
] as const

export const FONT_OPTIONS = [
  { id: "system", label: "系统默认", desc: "不引入外部字体" },
  { id: "space", label: "Space Grotesk", desc: "现代几何无衬线" },
  { id: "orbitron", label: "Orbitron", desc: "未来科技感" },
  { id: "jetbrains", label: "JetBrains Mono", desc: "等宽开发者" },
  { id: "audiowide", label: "Audiowide", desc: "赛博霓虹" },
  { id: "playfair", label: "Playfair Display", desc: "优雅高对比衬线" },
  { id: "cinzel", label: "Cinzel", desc: "古典标题" },
  { id: "poppins", label: "Poppins", desc: "几何圆润" },
  { id: "bebas", label: "Bebas Neue", desc: "窄高标题" },
] as const

/**
 * 排版预设。与主题/动效/字体/开屏独立混搭，只改变 .wrap 的布局方式。
 *   center = 居中卡片（传统纵向居中）
 *   side   = 侧栏型（头像在左，信息在右）
 *   split  = 分屏型（背景大图 + 浮层信息）
 *   plain  = 极简列（无容器，纯文字）
 */
export const LAYOUTS = ["center", "side", "split", "plain"] as const

export const LAYOUT_OPTIONS = [
  { id: "center", label: "居中卡片", desc: "传统纵向居中 link-in-bio" },
  { id: "side", label: "侧栏型", desc: "头像在左，信息在右，像个人主页" },
  { id: "split", label: "分屏型", desc: "背景大图 + 浮层信息" },
  { id: "plain", label: "极简列", desc: "无容器，纯文字排版" },
] as const

/** 支持的联系方式类型。服务端据此把用户输入拼成可点击链接。 */
export const CONTACT_TYPES = [
  "email",
  "qq",
  "wechat",
  "bilibili",
  "discord",
  "telegram",
  "youtube",
  "github",
  "x",
  "custom",
] as const

type ContactType = (typeof CONTACT_TYPES)[number]

interface Contact {
  type: ContactType
  value: string
  label?: string
  visible?: boolean
}

interface ProfileRow {
  user_id: string
  slug: string
  published: number
  display_name: string | null
  bio: string | null
  avatar_key: string | null
  avatar_url: string | null
  background_key: string | null
  background_url: string | null
  music_key: string | null
  music_url: string | null
  music_title: string | null
  music_autoplay: number
  music_cover_key: string | null
  music_cover_url: string | null
  theme: string
  accent: string | null
  effects: string
  intro: string
  font: string
  layout: string
  contacts: string
  subdomain_id: string | null
  fqdn: string | null
  created_at: string
  updated_at: string
}

export function parseContacts(raw: string): Contact[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c): c is Contact => {
      if (!c || typeof c !== "object") return false
      const o = c as Record<string, unknown>
      return (
        typeof o.type === "string" &&
        (CONTACT_TYPES as readonly string[]).includes(o.type) &&
        typeof o.value === "string"
      )
    })
  } catch {
    return []
  }
}

/**
 * 解析 effects JSON 数组，只保留白名单内的 id。
 * 渲染层（profile-page.ts）负责处理 particles/rain 互斥。
 */
export function parseEffects(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is string => typeof e === "string")
      .filter((e) => (EFFECTS as readonly string[]).includes(e))
  } catch {
    return []
  }
}

/**
 * 读取用户的 profile 行；不存在返回 null。
 * 「是否已开通名片」以此判断，与 storage_accounts / newapi_accounts 一致。
 */
async function findProfile(env: Env, userId: string): Promise<ProfileRow | null> {
  return await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ?")
    .bind(userId)
    .first<ProfileRow>()
}

async function loadProfile(env: Env, userId: string): Promise<ProfileRow> {
  const row = await findProfile(env, userId)
  if (!row) {
    throw new ApiError(404, "尚未开通名片", "NOT_ENABLED")
  }
  return row
}

/**
 * 开通名片。
 * 照 storage_accounts 的做法：点开通时才建记录。
 */
export async function enableProfile(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")

  const existing = await findProfile(env, user.id)
  if (existing) {
    return json({ enabled: true })
  }

  // slug 默认取用户名；若被占用（例如他人先用了这个 slug）则追加后缀
  let slug = user.username.toLowerCase()
  const taken = await env.DB.prepare(
    "SELECT user_id FROM profiles WHERE slug = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(slug)
    .first()
  if (taken) {
    slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO profiles (user_id, slug, published, contacts, theme, effects, intro, font, layout, created_at, updated_at)
     VALUES (?, ?, 0, '[]', 'void', '[]', 'none', 'system', 'center', ?, ?)`
  )
    .bind(user.id, slug, now, now)
    .run()

  return json({ enabled: true, slug }, 201)
}

function toPublicProfile(row: ProfileRow, slugOrFqdn: { profilePath: string }) {
  return {
    slug: row.slug,
    published: row.published === 1,
    displayName: row.display_name,
    bio: row.bio,
    // 前端预览时用；公开页由服务端直接拼实际 URL
    avatarKey: row.avatar_key,
    avatarUrl: row.avatar_url,
    backgroundKey: row.background_key,
    backgroundUrl: row.background_url,
    musicKey: row.music_key,
    musicUrl: row.music_url,
    musicTitle: row.music_title,
    musicAutoplay: row.music_autoplay === 1,
    musicCoverKey: row.music_cover_key,
    musicCoverUrl: row.music_cover_url,
    theme: row.theme,
    accent: row.accent,
    effects: parseEffects(row.effects),
    intro: row.intro,
    font: row.font,
    layout: row.layout,
    contacts: parseContacts(row.contacts),
    subdomainId: row.subdomain_id,
    fqdn: row.fqdn,
    profilePath: slugOrFqdn.profilePath,
    updatedAt: row.updated_at,
  }
}

// ---- 编辑接口（需登录） ----

// GET /api/profile —— 读取自己的名片（未开通时 enabled=false，前端据此显示开通引导页）
export async function getProfile(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")
  const row = await findProfile(env, user.id)

  const meta = {
    themes: THEMES,
    effects: EFFECTS,
    intros: INTROS,
    fonts: FONTS,
    layouts: LAYOUTS,
    themeOptions: THEME_OPTIONS,
    effectOptions: EFFECT_OPTIONS,
    introOptions: INTRO_OPTIONS,
    fontOptions: FONT_OPTIONS,
    layoutOptions: LAYOUT_OPTIONS,
    contactTypes: CONTACT_TYPES,
    r2Configured: isR2Configured(env),
    limits: {
      avatar: MAX_AVATAR_BYTES,
      background: MAX_BACKGROUND_BYTES,
      music: MAX_MUSIC_BYTES,
    },
  }

  if (!row) {
    return json({ enabled: false, profile: null, availableSubdomains: [], ...meta })
  }

  // 可绑定的子域名（排除已被网盘直链占用的）
  const subs = await env.DB.prepare(
    `SELECT s.id, s.name, s.fqdn FROM subdomains s
      WHERE s.user_id = ?
        AND NOT EXISTS (SELECT 1 FROM storage_prefixes sp WHERE sp.subdomain_id = s.id)
      ORDER BY s.created_at ASC`
  )
    .bind(user.id)
    .all<{ id: string; name: string; fqdn: string }>()

  return json({
    enabled: true,
    profile: toPublicProfile(row, { profilePath: `/profile/${row.slug}` }),
    availableSubdomains: subs.results ?? [],
    ...meta,
  })
}

// PUT /api/profile —— 更新资料
export async function updateProfile(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")
  const row = await loadProfile(env, user.id)
  const body = (await request.json()) as Record<string, unknown>

  // 名片地址固定等于用户名，不提供修改入口。
  // 理由：分享出去的链接必须长期有效；用户改名走「设置 → 修改用户名」，
  // 那时会同步更新此处的 slug（见 changeUsername）。
  const slug = row.slug

  const str = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null
    const t = v.trim()
    return t === "" ? null : t.slice(0, max)
  }

  // 联系方式：只接受白名单类型，值做长度限制
  let contactsJson = row.contacts
  if (Array.isArray(body.contacts)) {
    const cleaned: Contact[] = []
    for (const c of body.contacts) {
      if (!c || typeof c !== "object") continue
      const o = c as Record<string, unknown>
      const type = String(o.type ?? "")
      if (!(CONTACT_TYPES as readonly string[]).includes(type)) continue
      const value = String(o.value ?? "").trim().slice(0, 500)
      if (!value) continue
      cleaned.push({
        type: type as ContactType,
        value,
        label: typeof o.label === "string" ? o.label.trim().slice(0, 40) : undefined,
        visible: o.visible !== false,
      })
      if (cleaned.length >= 20) break
    }
    contactsJson = JSON.stringify(cleaned)
  }

  const theme =
    typeof body.theme === "string" && (THEMES as readonly string[]).includes(body.theme)
      ? body.theme
      : row.theme

  // 动效：只接受白名单内的 id；渲染层处理 particles/rain 互斥
  let effectsJson = row.effects
  if (Array.isArray(body.effects)) {
    const cleaned = body.effects
      .filter((e): e is string => typeof e === "string")
      .filter((e) => (EFFECTS as readonly string[]).includes(e))
    // 去重，保留顺序
    const dedup = Array.from(new Set(cleaned))
    effectsJson = JSON.stringify(dedup)
  }

  const intro =
    typeof body.intro === "string" && (INTROS as readonly string[]).includes(body.intro)
      ? body.intro
      : row.intro

  const font =
    typeof body.font === "string" && (FONTS as readonly string[]).includes(body.font)
      ? body.font
      : row.font

  const layout =
    typeof body.layout === "string" && (LAYOUTS as readonly string[]).includes(body.layout)
      ? body.layout
      : row.layout

  await env.DB.prepare(
    `UPDATE profiles SET
       slug = ?, display_name = ?, bio = ?,
       avatar_url = ?, background_url = ?, music_url = ?, music_title = ?,
       music_autoplay = ?, music_cover_url = ?, theme = ?, accent = ?, effects = ?,
       intro = ?, font = ?, layout = ?, contacts = ?, updated_at = ?
     WHERE user_id = ?`
  )
    .bind(
      slug,
      body.displayName === undefined ? row.display_name : str(body.displayName, 40),
      body.bio === undefined ? row.bio : str(body.bio, 200),
      body.avatarUrl === undefined ? row.avatar_url : str(body.avatarUrl, 1000),
      body.backgroundUrl === undefined ? row.background_url : str(body.backgroundUrl, 1000),
      body.musicUrl === undefined ? row.music_url : str(body.musicUrl, 1000),
      body.musicTitle === undefined ? row.music_title : str(body.musicTitle, 80),
      body.musicAutoplay === undefined ? row.music_autoplay : body.musicAutoplay ? 1 : 0,
      body.musicCoverUrl === undefined ? row.music_cover_url : str(body.musicCoverUrl, 1000),
      theme,
      body.accent === undefined ? row.accent : str(body.accent, 20),
      effectsJson,
      intro,
      font,
      layout,
      contactsJson,
      new Date().toISOString(),
      user.id
    )
    .run()

  const updated = await loadProfile(env, user.id)
  return json({ profile: toPublicProfile(updated, { profilePath: `/profile/${updated.slug}` }) })
}

// POST /api/profile/publish —— 启用/停用对外可见
export async function setPublished(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")
  const row = await loadProfile(env, user.id)
  const body = (await request.json()) as { published?: boolean }
  const published = body.published ? 1 : 0

  if (published && !row.display_name) {
    throw new ApiError(400, "启用前请先填写昵称", "DISPLAY_NAME_REQUIRED")
  }

  await env.DB.prepare(
    "UPDATE profiles SET published = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(published, new Date().toISOString(), user.id)
    .run()

  return json({ published: published === 1 })
}

// ---- 资源上传 ----

/**
 * POST /api/profile/asset?kind=avatar|background|music|music-cover
 * 原始字节直传（Content-Type 决定扩展名），存入 profiles/<用户名>/<kind>.<ext>
 */
export async function uploadAsset(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")
  if (!isR2Configured(env)) {
    throw new ApiError(503, "存储未配置，无法上传", "R2_NOT_CONFIGURED")
  }

  const url = new URL(request.url)
  const kind = url.searchParams.get("kind") ?? ""
  if (!["avatar", "background", "music", "music-cover"].includes(kind)) {
    throw new ApiError(400, "不支持的类型", "INVALID_KIND")
  }

  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
  const isImage = kind !== "music"
  const table = isImage ? IMAGE_TYPES : AUDIO_TYPES
  const ext = table[contentType]
  if (!ext) {
    throw new ApiError(
      400,
      isImage ? "仅支持 JPG / PNG / WebP / GIF 图片" : "仅支持 MP3 / M4A / OGG / WAV 音频",
      "INVALID_TYPE"
    )
  }

  // 音乐封面与头像同上限（5 MiB）
  const limit =
    kind === "avatar" || kind === "music-cover"
      ? MAX_AVATAR_BYTES
      : kind === "background"
        ? MAX_BACKGROUND_BYTES
        : MAX_MUSIC_BYTES

  const buf = await request.arrayBuffer()
  if (buf.byteLength === 0) {
    throw new ApiError(400, "文件为空", "INVALID_INPUT")
  }
  if (buf.byteLength > limit) {
    throw new ApiError(
      400,
      `文件过大，上限 ${Math.round(limit / 1024 / 1024)} MB`,
      "TOO_LARGE"
    )
  }

  const key = `profiles/${user.username}/${kind}.${ext}`
  await putObject(env, key, buf, contentType)

  // 换扩展名时清掉旧的（如 png → jpg）
  for (const oldExt of Object.values(table)) {
    if (oldExt === ext) continue
    const oldKey = `profiles/${user.username}/${kind}.${oldExt}`
    try {
      await deleteObject(env, oldKey)
    } catch {
      // 不存在则忽略
    }
  }

  const column =
    kind === "avatar"
      ? "avatar_key"
      : kind === "background"
        ? "background_key"
        : kind === "music-cover"
          ? "music_cover_key"
          : "music_key"
  await env.DB.prepare(
    `UPDATE profiles SET ${column} = ?, updated_at = ? WHERE user_id = ?`
  )
    .bind(key, new Date().toISOString(), user.id)
    .run()

  return json({ key, kind })
}

/** DELETE /api/profile/asset?kind=... —— 移除已上传的资源 */
export async function deleteAsset(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")
  const url = new URL(request.url)
  const kind = url.searchParams.get("kind") ?? ""
  if (!["avatar", "background", "music", "music-cover"].includes(kind)) {
    throw new ApiError(400, "不支持的类型", "INVALID_KIND")
  }

  const column =
    kind === "avatar"
      ? "avatar_key"
      : kind === "background"
        ? "background_key"
        : kind === "music-cover"
          ? "music_cover_key"
          : "music_key"

  if (isR2Configured(env)) {
    for (const ext of ["jpg", "png", "webp", "gif", "mp3", "m4a", "ogg", "wav"]) {
      try {
        await deleteObject(env, `profiles/${user.username}/${kind}.${ext}`)
      } catch {
        // 忽略
      }
    }
  }

  await env.DB.prepare(
    `UPDATE profiles SET ${column} = NULL, updated_at = ? WHERE user_id = ?`
  )
    .bind(new Date().toISOString(), user.id)
    .run()

  return json({ ok: true })
}

/**
 * GET /api/profile/asset?kind=... —— 读取自己的资源（仅用于编辑器预览）
 * 公开页面的资源由 /p/<用户名>/<kind> 提供，见 serveProfileAsset。
 */
export async function readOwnAsset(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")
  return serveAssetByUsername(env, user.username, new URL(request.url).searchParams.get("kind") ?? "")
}

/** 按用户名 + 类型返回 R2 对象（公开可读，用于名片页展示） */
export async function serveAssetByUsername(
  env: Env,
  username: string,
  kind: string
): Promise<Response> {
  if (!["avatar", "background", "music", "music-cover"].includes(kind)) {
    return new Response("Not Found", { status: 404 })
  }
  if (!isR2Configured(env)) {
    return new Response("Not Found", { status: 404 })
  }
  for (const ext of ["jpg", "png", "webp", "gif", "mp3", "m4a", "ogg", "wav"]) {
    try {
      return await getObject(env, `profiles/${username}/${kind}.${ext}`)
    } catch {
      continue
    }
  }
  return new Response("Not Found", { status: 404 })
}

// ---- 自定义域名绑定 ----

// POST /api/profile/domain —— { subdomainId } 绑定；{ action: "unbind" } 解绑
export async function bindProfileDomain(
  env: Env,
  request: Request,
  subdomainIdFromPath?: string
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "profile")
  const row = await loadProfile(env, user.id)
  const body = (await request.json().catch(() => ({}))) as {
    subdomainId?: string
    action?: string
  }
  const action = body.action ?? (subdomainIdFromPath ? "bind" : "")

  if (action === "unbind") {
    if (row.fqdn) {
      await detachCustomDomain(env, row.fqdn)
    }
    await env.DB.prepare(
      "UPDATE profiles SET subdomain_id = NULL, fqdn = NULL, updated_at = ? WHERE user_id = ?"
    )
      .bind(new Date().toISOString(), user.id)
      .run()
    return json({ ok: true })
  }

  const subdomainId = body.subdomainId ?? subdomainIdFromPath
  if (!subdomainId) {
    throw new ApiError(400, "缺少子域名", "INVALID_INPUT")
  }

  const sub = await env.DB.prepare(
    "SELECT id, fqdn, name FROM subdomains WHERE id = ? AND user_id = ?"
  )
    .bind(subdomainId, user.id)
    .first<{ id: string; fqdn: string; name: string }>()
  if (!sub) throw new ApiError(404, "子域名不存在", "NOT_FOUND")

  // 禁止绑定根域：doulor.cn 是整站入口（静态站点自定义域 + 多条邮件/API 路由），
  // 绑给名片会让整个站点无法访问。绑定根域的请求会被 CF 路由层面拦不住，
  // 必须在这里拒绝。
  if (sub.fqdn.toLowerCase() === env.ROOT_DOMAIN.toLowerCase()) {
    throw new ApiError(
      400,
      "根域名是平台入口，不能绑定给名片。请使用子域名（如 card.doulor.cn）",
      "ROOT_DOMAIN_FORBIDDEN"
    )
  }

  // 与网盘直链互斥：同一子域名只能指向一种服务
  const usedByStorage = await env.DB.prepare(
    "SELECT id FROM storage_prefixes WHERE subdomain_id = ? OR fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(sub.id, sub.fqdn)
    .first()
  if (usedByStorage) {
    throw new ApiError(
      409,
      "该子域名已绑定网盘直链，请先在「网盘」中解绑",
      "CONFLICT"
    )
  }

  const usedByOtherProfile = await env.DB.prepare(
    "SELECT user_id FROM profiles WHERE fqdn = ? COLLATE NOCASE AND user_id != ? LIMIT 1"
  )
    .bind(sub.fqdn, user.id)
    .first()
  if (usedByOtherProfile) {
    throw new ApiError(409, "该域名已被其他名片使用", "CONFLICT")
  }

  // 该域名上不能已有用户自建的 DNS 记录（避免抢走他的站点）
  const dns = await env.DB.prepare(
    "SELECT id FROM dns_records WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(sub.fqdn)
    .first()
  if (dns) {
    throw new ApiError(
      409,
      "该子域名已存在 DNS 记录，请先删除后再绑定",
      "CONFLICT"
    )
  }

  const { dnsCreated } = await attachCustomDomain(env, sub.fqdn)

  await env.DB.prepare(
    "UPDATE profiles SET subdomain_id = ?, fqdn = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(sub.id, sub.fqdn, new Date().toISOString(), user.id)
    .run()

  return json({ fqdn: sub.fqdn, dnsCreated }, 201)
}

// ---- 公开数据（无需登录，供公开页/预览使用） ----

export interface PublicProfile {
  slug: string
  username: string
  displayName: string | null
  bio: string | null
  theme: string
  accent: string | null
  effects: string[]
  intro: string
  font: string
  layout: string
  avatar: string | null
  background: string | null
  music: string | null
  musicCover: string | null
  musicTitle: string | null
  musicAutoplay: boolean
  contacts: Contact[]
}

/**
 * 按 slug 或自定义域名取出公开名片数据。
 * 未发布、或用户被停用一律返回 null（调用方转 404，不泄露存在性）。
 */
export async function loadPublicProfile(
  env: Env,
  key: { slug?: string; fqdn?: string }
): Promise<PublicProfile | null> {
  const where = key.fqdn ? "p.fqdn = ? COLLATE NOCASE" : "p.slug = ? COLLATE NOCASE"
  const value = key.fqdn ?? key.slug ?? ""

  const row = await env.DB.prepare(
    `SELECT p.*, u.username, u.status AS user_status
       FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE ${where} LIMIT 1`
  )
    .bind(value)
    .first<ProfileRow & { username: string; user_status: string }>()

  if (!row) return null
  if (row.published !== 1 || row.user_status !== "active") return null

  // 资源优先用上传的 R2 对象，其次外链
  const assetUrl = (kind: string, key: string | null, url: string | null) => {
    if (key) return `/p/${row.username}/${kind}`
    return url ?? null
  }

  return {
    slug: row.slug,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    theme: row.theme,
    accent: row.accent,
    effects: parseEffects(row.effects),
    intro: row.intro,
    font: row.font,
    layout: row.layout,
    avatar: assetUrl("avatar", row.avatar_key, row.avatar_url),
    background: assetUrl("background", row.background_key, row.background_url),
    music: assetUrl("music", row.music_key, row.music_url),
    musicCover: assetUrl("music-cover", row.music_cover_key, row.music_cover_url),
    musicTitle: row.music_title,
    musicAutoplay: row.music_autoplay === 1,
    contacts: parseContacts(row.contacts).filter((c) => c.visible !== false),
  }
}

export type { Contact }