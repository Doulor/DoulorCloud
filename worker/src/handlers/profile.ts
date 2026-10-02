import { ApiError, json, readBodyCapped } from "../http"
// 个人名片不消耗资源，已从权限体系移出（全量开放）：这里只需登录，不再校验功能权限
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"

import { isStorageConfigured, putObject, deleteObject, getObject, getPlatformBucketId } from "../r2"
import { hardenUserContentResponse } from "../content-type"
import { attachCustomDomain, detachCustomDomain } from "../custom-domain"
import { isRootDomainItself } from "../root-domains"
import { renderProfileHtml } from "../profile-page"
import { isValidSource, resolveAudioUrl, searchMusic, fetchLyrics } from "../music-api"
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
  "paper",
  "ink",
  "terminal",
  "solar",
  "royal",
] as const

/**
 * 独立勾选的常驻动效。与主题不绑定，用户自由混搭组合。
 * particles / rain / sakura / snow 共用 canvas 层，互斥（保留最先出现的一个）。
 */
export const EFFECTS = [
  "particles",
  "tilt",
  "glitch",
  "glow",
  "rain",
  "sparkle",
  "sakura",
  "snow",
  "float",
] as const

/** 共用 canvas 层的动效，组内互斥 */
export const CANVAS_EFFECTS = ["particles", "rain", "sakura", "snow"] as const

/**
 * 开屏动画。enter/portal 为交互式（点击进入主界面），fade/slide/typewriter 为非交互式（自动进入）。
 * 与主题、动效独立混搭。
 */
export const INTROS = ["none", "enter", "portal", "fade", "slide", "typewriter"] as const

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
  { id: "void", label: "虚空", desc: "纯黑留白，辉光点睛" },
  { id: "neon", label: "霓虹", desc: "合成波夜色，霓虹描边" },
  { id: "glass", label: "玻璃", desc: "毛玻璃拟态，轻盈通透" },
  { id: "aurora", label: "极光", desc: "流动渐变光带" },
  { id: "cyber", label: "赛博", desc: "HUD 网格切角" },
  { id: "blossom", label: "绽放", desc: "浅色樱粉，柔和细腻" },
  { id: "paper", label: "纸刊", desc: "米色纸面，杂志衬线排版" },
  { id: "ink", label: "水墨", desc: "宣纸墨字，朱印落款" },
  { id: "terminal", label: "终端", desc: "荧光绿屏，等宽扫描线" },
  { id: "solar", label: "暖阳", desc: "奶油暖调，圆润亲和" },
  { id: "royal", label: "紫金", desc: "深紫描金，典雅华丽" },
] as const

export const EFFECT_OPTIONS = [
  { id: "particles", label: "粒子连线", desc: "浮动粒子与连线背景" },
  { id: "tilt", label: "3D 倾斜", desc: "鼠标移动时卡片倾斜" },
  { id: "glitch", label: "文字故障", desc: "名称文字故障跳动" },
  { id: "glow", label: "脉冲发光", desc: "按钮呼吸发光" },
  { id: "rain", label: "代码雨", desc: "Matrix 风格下落字符" },
  { id: "sparkle", label: "星光闪烁", desc: "随机闪烁亮点" },
  { id: "sakura", label: "樱花飘落", desc: "粉色花瓣随风飘落" },
  { id: "snow", label: "落雪", desc: "雪花缓缓飘落堆积" },
  { id: "float", label: "元素漂浮", desc: "卡片与头像轻轻浮动" },
] as const

export const INTRO_OPTIONS = [
  { id: "none", label: "无", desc: "直接显示内容" },
  { id: "enter", label: "点击进入", desc: "点击后展示内容（交互式）" },
  { id: "portal", label: "传送门", desc: "旋转传送门，点击进入（交互式）" },
  { id: "fade", label: "渐入", desc: "内容自动淡入（非交互式）" },
  { id: "slide", label: "上滑", desc: "内容自动上滑（非交互式）" },
  { id: "typewriter", label: "打字机", desc: "逐字打出昵称后进入（非交互式）" },
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
 * 排版预设。与主题/动效/字体/开屏独立混搭，改变页面结构而不只是配色。
 *   center = 居中卡片（传统纵向居中）
 *   side   = 侧栏型（身份在左，模块在右）
 *   split  = 分屏型（背景大图 + 浮层信息）
 *   plain  = 极简列（无容器，纯文字排版）
 *   bento  = 网格拼贴（模块以磁贴平铺）
 *   banner = 横幅头图（顶部大图 + 下挂头像，杂志封面感）
 */
export const LAYOUTS = ["center", "side", "split", "plain", "bento", "banner"] as const

export const LAYOUT_OPTIONS = [
  { id: "center", label: "居中卡片", desc: "传统纵向居中 link-in-bio" },
  { id: "side", label: "侧栏型", desc: "身份在左，模块在右，像个人主页" },
  { id: "split", label: "分屏型", desc: "背景大图 + 浮层信息" },
  { id: "plain", label: "极简列", desc: "无容器，纯文字排版" },
  { id: "bento", label: "网格拼贴", desc: "模块以磁贴平铺，信息密度高" },
  { id: "banner", label: "横幅头图", desc: "顶部大图横幅，杂志封面感" },
] as const

/**
 * 缩放模式。
 *   off  = 固定比例，始终用 scale_manual
 *   auto = 内容超出视口时在 scale_manual 基础上继续缩小，下限 scale_min
 *
 * 「超出才缩」是刻意的：内容不长的名片算出来就是 scale_manual（默认 100%），
 * 观感与不做缩放完全一致，不会出现「短名片被放大到失真」。
 */
export const SCALE_MODES = ["off", "auto"] as const

export const SCALE_MODE_OPTIONS = [
  { id: "auto", label: "自动适配", desc: "内容超出屏幕时自动缩小，一屏放下" },
  { id: "off", label: "固定比例", desc: "始终按下面设定的比例显示" },
] as const

/** 缩放比例的取值范围（百分比）。与前端滑杆的 min/max 同源。 */
export const SCALE_MIN_RANGE = { min: 30, max: 100 } as const
export const SCALE_MANUAL_RANGE = { min: 50, max: 150 } as const

/** 认不出的缩放模式一律按 auto（对用户最有利：内容放不下时会自动缩） */
function normalizeScaleMode(raw: string | null | undefined): string {
  return (SCALE_MODES as readonly string[]).includes(raw ?? "") ? (raw as string) : "auto"
}

/** 把百分比夹到合法区间；非数字用兜底值（不信任历史数据） */
function clampScale(
  raw: number | null | undefined,
  range: { min: number; max: number },
  fallback: number
): number {
  // ⚠️ 必须先挡掉 null：Number(null) === 0 是有限数，会一路夹到下限，
  // 表现为「表单传了 null 就被悄悄改成 50%」而不是保持默认。
  if (raw === null || raw === undefined || typeof raw === "boolean") return fallback
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(range.max, Math.max(range.min, n))
}

/**
 * 中文正文字体栈（英文标题字由 font 选项控制，二者独立）。
 * 只用系统字体栈，不引入 CJK webfont（体积太大）。
 */
export const CJK_FONTS = ["system", "song", "kai", "yuan"] as const

export const CJK_FONT_OPTIONS = [
  { id: "system", label: "默认黑体", desc: "跟随系统，现代清爽" },
  { id: "song", label: "宋体", desc: "衬线书卷气，适合长文" },
  { id: "kai", label: "楷体", desc: "手写温润，适配国风" },
  { id: "yuan", label: "圆体", desc: "圆润亲和（缺字体时自动回退）" },
] as const

/**
 * 名片模块。页面由模块组装而成：可开关、可排序。
 *   identity / stats 位置固定（头部 / 页脚），status 跟随身份区，
 *   其余模块在编辑器和公开页中按 modules 数组顺序排列。
 */
export const MODULE_TYPES = [
  "identity",
  "status",
  "tags",
  "quote",
  "links",
  "timeline",
  "gallery",
  "music",
  "stats",
] as const

/**
 * 模块宽度（桌面端两列网格里的占位）。
 *
 *   half = 半宽（占一列，两个相邻的 half 自动并排）
 *   full = 整宽（跨满整行）
 *
 * ⚠️ 只在**桌面端**（≥641px）生效；移动端一律单列，宽度设置被忽略。
 *
 * ⚠️ 而且**只在有人显式设过宽度时** `.mods` 才切成两列网格（CSS 用 `:has()` 做开关）——
 * 老数据没人设过 size，布局与改动前逐像素一致，不存在「上线后所有人名片都变样」。
 *
 * ⚠️ 默认值（不写 size）由**骨架的 CSS** 决定，服务端不重复定义，避免两处默认规则跑偏：
 *   - 网格拼贴（bento）：标签/名言默认半宽，其余模块整宽（与改动前写死的名单一致）；
 *   - 其余骨架：默认全部整宽（单列流式，与改动前一致）。
 */
export const MODULE_SIZES = ["half", "full"] as const

/**
 * 宽度选项（编辑器下拉用）。
 * `auto` 不是合法 size（不在 MODULE_SIZES 里）⇒ sanitizeModules 会直接忽略它，
 * 等价于「不写 size 字段」，正是「跟随骨架默认」该有的效果。
 */
export const MODULE_SIZE_OPTIONS = [
  { id: "auto", label: "自动", desc: "跟随骨架默认" },
  { id: "half", label: "半宽", desc: "占一列" },
  { id: "full", label: "整宽", desc: "跨满整行" },
] as const

export const MODULE_OPTIONS = [
  { id: "identity", label: "身份信息", desc: "头像、昵称与签名，固定在头部" },
  { id: "status", label: "当前状态", desc: "昵称下方的小状态签" },
  { id: "tags", label: "兴趣标签", desc: "一组关键词标签" },
  { id: "quote", label: "名言", desc: "一句喜欢的话与出处" },
  { id: "links", label: "联系方式", desc: "社交链接按钮" },
  { id: "timeline", label: "大事记", desc: "按时间排列的经历" },
  { id: "gallery", label: "图片墙", desc: "外链图片组成的网格" },
  { id: "music", label: "音乐播放器", desc: "设置背景音乐后自动出现" },
  { id: "stats", label: "访问统计", desc: "页脚的加入时间与访问量" },
] as const

/** 大事记条目 */
export interface TimelineItem {
  date: string
  title: string
  desc: string
}

/** 图片墙条目 */
export interface GalleryItem {
  url: string
  caption: string
}

/**
 * 名片模块配置。存 D1 modules 列（JSON 数组），数组顺序即展示顺序。
 * items 的具体形态由 id 决定：tags=string[]、timeline=TimelineItem[]、gallery=GalleryItem[]。
 */
export interface ProfileModule {
  id: string
  enabled: boolean
  items?: (string | TimelineItem | GalleryItem)[]
  text?: string
  author?: string
  emoji?: string
  /** 桌面端宽度。缺省 = 跟随骨架默认（见 MODULE_SIZES 注释） */
  size?: "half" | "full"
}

/**
 * 校验并清洗 modules 数组。保存（updateProfile）与渲染（parseModules）共用，
 * 保证写入与读出走同一套白名单与长度限制。
 */
export function sanitizeModules(input: unknown): ProfileModule[] {
  if (!Array.isArray(input)) return []
  const out: ProfileModule[] = []
  const seen = new Set<string>()
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return undefined
    const t = v.trim()
    return t === "" ? undefined : t.slice(0, max)
  }
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue
    const o = raw as Record<string, unknown>
    const id = String(o.id ?? "")
    if (!(MODULE_TYPES as readonly string[]).includes(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const mod: ProfileModule = { id, enabled: o.enabled !== false }

    // 宽度：只认白名单。**空串/缺省一律不写字段** —— 前端「自动」选项会传 ""，
    // 这里必须把它当成「跟随骨架默认」，而不是存成一个非法值。
    if (typeof o.size === "string" && (MODULE_SIZES as readonly string[]).includes(o.size)) {
      mod.size = o.size as "half" | "full"
    }

    if (id === "tags" && Array.isArray(o.items)) {
      const items = o.items
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().slice(0, 12))
        .filter(Boolean)
        .slice(0, 12)
      if (items.length > 0) mod.items = items
    }
    if (id === "timeline" && Array.isArray(o.items)) {
      const items: TimelineItem[] = []
      for (const it of o.items) {
        if (!it || typeof it !== "object") continue
        const t = it as Record<string, unknown>
        const title = str(t.title, 30)
        if (!title) continue
        items.push({
          date: str(t.date, 20) ?? "",
          title,
          desc: str(t.desc, 80) ?? "",
        })
        if (items.length >= 8) break
      }
      if (items.length > 0) mod.items = items
    }
    if (id === "gallery" && Array.isArray(o.items)) {
      const items: GalleryItem[] = []
      for (const it of o.items) {
        if (!it || typeof it !== "object") continue
        const g = it as Record<string, unknown>
        const url = str(g.url, 1000)
        // 允许本站在线上传的相对地址（/p/<用户名>/gallery/<id>）与 https 外链，
        // 其余协议（javascript:、data: 等）一律拒绝。
        if (!url || !(/^https:\/\//i.test(url) || /^\/p\/[^/]+\/gallery\/[a-z0-9-]+$/i.test(url))) {
          continue
        }
        items.push({ url, caption: str(g.caption, 20) ?? "" })
        if (items.length >= 9) break
      }
      if (items.length > 0) mod.items = items
    }
    if (id === "quote") {
      // 允许换行（渲染时转 <br>），因此长度上限放宽到 200、最多 5 行
      const text = str(o.text, 200)
      if (text) {
        mod.text = text.split(/\r\n|\r|\n/).slice(0, 5).join("\n")
        const author = str(o.author, 20)
        if (author) mod.author = author
      }
    }
    if (id === "status") {
      const text = str(o.text, 30)
      if (text) {
        mod.text = text
        const emoji = str(o.emoji, 8)
        if (emoji) mod.emoji = emoji
      }
    }
    out.push(mod)
  }
  return out
}

/** 解析 modules JSON 列，只保留白名单内的合法数据。 */
export function parseModules(raw: string | null | undefined): ProfileModule[] {
  if (!raw) return []
  try {
    return sanitizeModules(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 清洗联系方式数组（updateProfile / previewProfile 共用）。 */
export function sanitizeContacts(input: unknown): Contact[] {
  if (!Array.isArray(input)) return []
  const cleaned: Contact[] = []
  for (const c of input) {
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
  return cleaned
}

/** 清洗动效 id 数组（updateProfile / previewProfile 共用），去重保序。 */
export function sanitizeEffects(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const cleaned = input
    .filter((e): e is string => typeof e === "string")
    .filter((e) => (EFFECTS as readonly string[]).includes(e))
  return Array.from(new Set(cleaned))
}

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
  /** 搜索来源标记，形如 'netease:1330348068'；NULL = 用户自定义（上传或外链） */
  music_source: string | null
  /** 歌词全文（LRC，含时间轴） */
  music_lyrics: string | null
  theme: string
  accent: string | null
  effects: string
  intro: string
  font: string
  layout: string
  contacts: string
  modules: string
  cjk_font: string
  subdomain_id: string | null
  fqdn: string | null
  view_count: number
  /** 自动缩放模式：'off' 固定用 scale_manual，'auto' 超出视口时按比例缩小 */
  scale_mode: string
  /** 自动缩放的下限（百分比），避免内容过多时文字小到不可读 */
  scale_min: number
  /** 基准缩放比例（百分比），两种模式下都是起点 */
  scale_manual: number
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
 *
 * ⚠️ `published` 直接给 1 —— 开通即对外显示，不再要求用户再手动点一次「启用」。
 * 没有昵称也能显示（公开页用用户名兜底），所以这里不再拦。
 *
 * 但**「开通了」不等于「真的做了名片」**：这条空行会让 `has_profile` 活动条件
 * 变得人人可过。所以 event-rewards.ts 的 `has_profile` 判据同步升级为
 * 「已发布 **且** 填了昵称」，别只改这里。
 */
export async function enableProfile(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

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
     VALUES (?, ?, 1, '[]', 'void', '[]', 'none', 'system', 'center', ?, ?)`
  )
    .bind(user.id, slug, now, now)
    .run()

  return json({ enabled: true, published: true, slug }, 201)
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
    // 搜索来的音乐：编辑器要靠它回显「已选中某首歌」，并据此判断
    // 播放地址该走 /p/<用户名>/music 实时解析、而不是用 musicUrl
    musicSource: row.music_source,
    musicLyrics: row.music_lyrics,
    theme: row.theme,
    accent: row.accent,
    effects: parseEffects(row.effects),
    intro: row.intro,
    font: row.font,
    layout: row.layout,
    cjkFont: row.cjk_font ?? "system",
    scaleMode: normalizeScaleMode(row.scale_mode),
    scaleMin: clampScale(row.scale_min, SCALE_MIN_RANGE, 50),
    scaleManual: clampScale(row.scale_manual, SCALE_MANUAL_RANGE, 100),
    contacts: parseContacts(row.contacts),
    modules: parseModules(row.modules),
    subdomainId: row.subdomain_id,
    fqdn: row.fqdn,
    profilePath: slugOrFqdn.profilePath,
    updatedAt: row.updated_at,
  }
}

// ---- 编辑接口（需登录） ----

// GET /api/profile —— 读取自己的名片（未开通时 enabled=false，前端据此显示开通引导页）
export async function getProfile(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await findProfile(env, user.id)

  const meta = {
    themes: THEMES,
    effects: EFFECTS,
    intros: INTROS,
    fonts: FONTS,
    layouts: LAYOUTS,
    cjkFonts: CJK_FONTS,
    themeOptions: THEME_OPTIONS,
    effectOptions: EFFECT_OPTIONS,
    introOptions: INTRO_OPTIONS,
    fontOptions: FONT_OPTIONS,
    layoutOptions: LAYOUT_OPTIONS,
    cjkFontOptions: CJK_FONT_OPTIONS,
    moduleOptions: MODULE_OPTIONS,
    moduleSizeOptions: MODULE_SIZE_OPTIONS,
    contactTypes: CONTACT_TYPES,
    scaleModes: SCALE_MODES,
    scaleModeOptions: SCALE_MODE_OPTIONS,
    scaleMinRange: SCALE_MIN_RANGE,
    scaleManualRange: SCALE_MANUAL_RANGE,
    r2Configured: await isStorageConfigured(env),
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
  const user = await requireUser(env, request)
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
    contactsJson = JSON.stringify(sanitizeContacts(body.contacts))
  }

  const theme =
    typeof body.theme === "string" && (THEMES as readonly string[]).includes(body.theme)
      ? body.theme
      : row.theme

  // 动效：只接受白名单内的 id；渲染层处理 canvas 类动效互斥
  let effectsJson = row.effects
  if (Array.isArray(body.effects)) {
    effectsJson = JSON.stringify(sanitizeEffects(body.effects))
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

  const cjkFont =
    typeof body.cjkFont === "string" &&
    (CJK_FONTS as readonly string[]).includes(body.cjkFont)
      ? body.cjkFont
      : (row.cjk_font ?? "system")

  // 缩放：模式走白名单，两个比例做区间夹取（不信任前端）
  const scaleMode =
    typeof body.scaleMode === "string" &&
    (SCALE_MODES as readonly string[]).includes(body.scaleMode)
      ? body.scaleMode
      : normalizeScaleMode(row.scale_mode)
  const scaleMin =
    body.scaleMin === undefined
      ? clampScale(row.scale_min, SCALE_MIN_RANGE, 50)
      : clampScale(body.scaleMin as number, SCALE_MIN_RANGE, 50)
  const scaleManual =
    body.scaleManual === undefined
      ? clampScale(row.scale_manual, SCALE_MANUAL_RANGE, 100)
      : clampScale(body.scaleManual as number, SCALE_MANUAL_RANGE, 100)

  // 模块：数组顺序即展示顺序，逐项白名单清洗
  let modulesJson = row.modules ?? "[]"
  if (Array.isArray(body.modules)) {
    modulesJson = JSON.stringify(sanitizeModules(body.modules))
  }

  /**
   * 音乐来源：搜索来的歌存 `music_source`（形如 'netease:1330348068'）。
   *
   * 入库前严格校验 —— 这个值之后会被拼进对第三方接口的请求，
   * 「白名单平台 + 纯数字 id」是唯一防线。
   *
   * 非法值按「清空」处理而不是抛错：用户手改了表单里那段文本但没重新选歌时，
   * 静默回到「自定义」比弹一个他看不懂的错误更合理。
   *
   * 刻意**不**去动 music_url / music_key —— 换来源必须可逆：
   * 清掉来源后，用户自己上传或粘贴的音频自动恢复生效（优先级见 loadPublicProfile）。
   */
  const musicSource =
    body.musicSource === undefined
      ? row.music_source
      : (() => {
          const raw = str(body.musicSource, 80)
          return raw && isValidSource(raw) ? raw : null
        })()

  // 歌词：LRC 文本。上限 20 KB —— 再长的「歌词」一定是异常数据。
  const musicLyrics =
    body.musicLyrics === undefined ? row.music_lyrics : str(body.musicLyrics, 20000)

  await env.DB.prepare(
    `UPDATE profiles SET
       slug = ?, display_name = ?, bio = ?,
       avatar_url = ?, background_url = ?, music_url = ?, music_title = ?,
       music_autoplay = ?, music_cover_url = ?, music_source = ?, music_lyrics = ?,
       theme = ?, accent = ?, effects = ?,
       intro = ?, font = ?, layout = ?, cjk_font = ?, contacts = ?, modules = ?,
       scale_mode = ?, scale_min = ?, scale_manual = ?, updated_at = ?
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
      musicSource,
      musicLyrics,
      theme,
      body.accent === undefined ? row.accent : str(body.accent, 20),
      effectsJson,
      intro,
      font,
      layout,
      cjkFont,
      contactsJson,
      modulesJson,
      scaleMode,
      scaleMin,
      scaleManual,
      new Date().toISOString(),
      user.id
    )
    .run()

  const updated = await loadProfile(env, user.id)
  return json({ profile: toPublicProfile(updated, { profilePath: `/profile/${updated.slug}` }) })
}

/**
 * POST /api/profile/preview —— 编辑器实时预览。
 *
 * 把「尚未保存的表单」按与 updateProfile 完全相同的规则清洗后，直接用
 * renderProfileHtml 渲染成公开页 HTML 返回；不落库、不计访客数。
 * 编辑器用 <iframe srcdoc> 展示，做到真正的所见即所得。
 *
 * baseHref：srcdoc iframe 是 opaque origin，相对路径（/p/…、/fonts/…）
 * 无法解析，因此渲染时注入 <base href="<站点源>"> 让资源走绝对地址。
 */
export async function previewProfile(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProfile(env, user.id)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  const str = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null
    const t = v.trim()
    return t === "" ? null : t.slice(0, max)
  }
  const inList = (v: unknown, list: readonly string[], fallback: string) =>
    typeof v === "string" && list.includes(v) ? v : fallback

  // 资源：已上传的优先（/p/<用户名>/<kind>），否则用表单里的外链（未传该字段时回退已存外链）
  const asset = (kind: string, key: string | null, urlField: unknown, urlCol: string | null) => {
    if (key) return `/p/${user.username}/${kind}`
    return urlField === undefined ? urlCol : str(urlField, 1000)
  }

  // 预览时的音乐来源（与 updateProfile 完全同一套校验）
  const previewSource =
    body.musicSource === undefined
      ? isValidSource(row.music_source ?? "")
        ? row.music_source
        : null
      : (() => {
          const raw = str(body.musicSource, 80)
          return raw && isValidSource(raw) ? raw : null
        })()

  /**
   * 预览用的音频地址。
   *
   * 这里**可以**把带时效签名的真实地址直接内联进 HTML —— 预览是「一次性」的：
   * 不落库、不计访客数、响应不缓存，地址过期时用户早就关掉预览了。
   *
   * 公开页则绝不能这么做：那个 HTML 带 `Cache-Control: max-age=60`，
   * 而且一份 HTML 会长期存在于各层缓存里，内联一个 20 分钟就失效的地址
   * 等于给访客埋雷。公开页一律走 `/p/<用户名>/music` 实时解析。
   */
  const previewMusic = previewSource
    ? ((await resolveAudioUrl(previewSource)) ??
      asset("music", row.music_key, body.musicUrl, row.music_url))
    : asset("music", row.music_key, body.musicUrl, row.music_url)

  const profile: PublicProfile = {
    slug: row.slug,
    username: user.username,
    displayName:
      body.displayName === undefined ? row.display_name : str(body.displayName, 40),
    bio: body.bio === undefined ? row.bio : str(body.bio, 200),
    theme: inList(body.theme, THEMES, row.theme),
    accent: body.accent === undefined ? row.accent : str(body.accent, 20),
    effects: Array.isArray(body.effects)
      ? sanitizeEffects(body.effects)
      : parseEffects(row.effects),
    intro: inList(body.intro, INTROS, row.intro),
    font: inList(body.font, FONTS, row.font),
    cjkFont: inList(body.cjkFont, CJK_FONTS, row.cjk_font ?? "system"),
    layout: inList(body.layout, LAYOUTS, row.layout),
    scaleMode: inList(body.scaleMode, SCALE_MODES, normalizeScaleMode(row.scale_mode)),
    scaleMin:
      body.scaleMin === undefined
        ? clampScale(row.scale_min, SCALE_MIN_RANGE, 50)
        : clampScale(body.scaleMin as number, SCALE_MIN_RANGE, 50),
    scaleManual:
      body.scaleManual === undefined
        ? clampScale(row.scale_manual, SCALE_MANUAL_RANGE, 100)
        : clampScale(body.scaleManual as number, SCALE_MANUAL_RANGE, 100),
    avatar: user.avatar_key ? `/u/${user.username}/avatar` : null,
    background: asset("background", row.background_key, body.backgroundUrl, row.background_url),
    music: previewMusic,
    musicCover: asset("music-cover", row.music_cover_key, body.musicCoverUrl, row.music_cover_url),
    musicTitle: body.musicTitle === undefined ? row.music_title : str(body.musicTitle, 80),
    musicAutoplay:
      body.musicAutoplay === undefined ? row.music_autoplay === 1 : Boolean(body.musicAutoplay),
    musicSource: previewSource,
    musicLyrics:
      body.musicLyrics === undefined ? row.music_lyrics : str(body.musicLyrics, 20000),
    contacts: (Array.isArray(body.contacts)
      ? sanitizeContacts(body.contacts)
      : parseContacts(row.contacts)
    ).filter((c) => c.visible !== false),
    modules: Array.isArray(body.modules)
      ? sanitizeModules(body.modules)
      : parseModules(row.modules),
    registeredAt: user.created_at ?? null,
    uid: user.uid ?? null,
    viewCount: row.view_count ?? 0,
  }

  const origin = new URL(request.url).origin
  const html = renderProfileHtml(profile, { baseHref: origin })
  return json({ html })
}

// POST /api/profile/publish —— 启用/停用对外可见
//
// 不再要求「先填昵称」：开通时就已经是对外可见状态（enableProfile 直接 published=1），
// 这里再拦一道自相矛盾 —— 用户会发现「明明是开着的，关掉再打开却打不开了」。
// 没有昵称时公开页用用户名兜底，页面不会开天窗。
// 真正需要「必须填了东西」的地方是活动领奖条件（has_profile），已在那边单独把关。
export async function setPublished(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await loadProfile(env, user.id)
  const body = (await request.json()) as { published?: boolean }
  const published = body.published ? 1 : 0

  await env.DB.prepare(
    "UPDATE profiles SET published = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(published, new Date().toISOString(), user.id)
    .run()

  return json({ published: published === 1 })
}

// ---- 资源上传 ----

/**
 * GET /api/profile/music/search?q=<歌名> —— 按歌名搜索歌曲（需登录）。
 *
 * 三个刻意的约束：
 *   1. **必须登录**：这是对第三方服务的代理调用。不登录就能用的话，
 *      本站会变成别人白嫖的搜索接口，还可能让对方按 IP 把我们封掉。
 *   2. **必须限流**：同上；第三方接口自己也有配额，被刷爆等于功能永久失效。
 *   3. 失败返回 502 而不是 500，并把原因带上：搜索服务挂掉和「真的没这首歌」
 *      是两件事，前端要能给出不同提示（前者引导用户改用上传/外链）。
 *
 * 注意这里只做搜索，**不返回任何播放地址** —— 播放地址是带时效签名的，
 * 交给 `/p/<用户名>/music` 在播放时实时解析。搜索响应里给出去的地址
 * 一定会被前端存起来，那正是我们要避免的。
 */
export async function searchMusicTracks(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(
    env,
    `profile-music-search:${user.id}`,
    30,
    60,
    "搜索过于频繁，请稍后再试"
  )

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim()
  if (!q) return json({ tracks: [] })
  if (q.length > 80) {
    throw new ApiError(400, "搜索关键词过长")
  }

  try {
    return json({ tracks: await searchMusic(q) })
  } catch (err) {
    const detail = err instanceof Error ? err.message : "未知错误"
    throw new ApiError(502, `音乐搜索暂时不可用：${detail}`)
  }
}

/**
 * GET /api/profile/music/lyrics?title=<歌名>&artist=<歌手> —— 取歌词（需登录）。
 *
 * 为什么按「歌名+歌手」而不是按歌曲 id 取：歌词库（LRCLIB）与音频源（网易云）
 * 是两套完全独立的曲库，没有共同的 id 可以对应。搜索结果里本来就有歌名和歌手，
 * 直接拿来查是最稳的。
 *
 * 取不到一律返回 `{lyrics: null}` 而不是报错：歌词是可选增强，
 * 不该因为它取不到就让「选歌」这个主流程中断。
 */
export async function fetchMusicLyrics(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(
    env,
    `profile-music-lyrics:${user.id}`,
    30,
    60,
    "操作过于频繁，请稍后再试"
  )

  const params = new URL(request.url).searchParams
  const title = (params.get("title") ?? "").trim()
  const artist = (params.get("artist") ?? "").trim()
  if (!title) return json({ lyrics: null })
  if (title.length > 120 || artist.length > 120) {
    throw new ApiError(400, "参数过长")
  }

  return json({ lyrics: await fetchLyrics(title, artist) })
}

/**
 * POST /api/profile/asset?kind=avatar|background|music|music-cover|gallery
 * 原始字节直传（Content-Type 决定扩展名）。
 * 前四种存 profiles/<用户名>/<kind>.<ext>（单例，覆盖旧值）；
 * gallery 存 profiles/<用户名>/gallery/<id>.<ext>（多张，id 随机，返回公开 URL）。
 */
export async function uploadAsset(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 上传会真实写入 R2（计费操作），加限流防止被高频调用刷操作数
  await guardRateLimit(env, `profile-upload:${user.id}`, 60, 60, "上传过于频繁")
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置，无法上传", "R2_NOT_CONFIGURED")
  }

  const url = new URL(request.url)
  const kind = url.searchParams.get("kind") ?? ""
  if (!["avatar", "background", "music", "music-cover", "gallery"].includes(kind)) {
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
        : kind === "gallery"
          ? MAX_AVATAR_BYTES
          : MAX_MUSIC_BYTES

  // ⚠️ 2026-09-25 审计（L29）：原先是「先 `await request.arrayBuffer()`
  // 把整个请求体读进内存，再比对大小」—— 校验发生在内存已经花掉之后。
  // `readBodyCapped` 先看 Content-Length 快速拒绝，读完再复核真实长度。
  const buf = await readBodyCapped(
    request,
    limit,
    `文件过大，上限 ${Math.round(limit / 1024 / 1024)} MB`,
    400,
    "TOO_LARGE"
  )
  if (buf.byteLength === 0) {
    throw new ApiError(400, "文件为空", "INVALID_INPUT")
  }

  // 图片墙：一次一张，随机 id 命名，避免覆盖；不入 D1，URL 由前端存进模块配置
  if (kind === "gallery") {
    // 图墙可连传多张，给个宽松上限挡住刷盘（正常用户连传 9 张不会触发）
    await guardRateLimit(env, `profile:gallery:${user.id}`, 30, 300, "上传太频繁")
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    const gKey = `profiles/${user.username}/gallery/${id}.${ext}`
    const platformBucket = await getPlatformBucketId(env)
    await putObject(env, gKey, buf, contentType, platformBucket)
    return json({ key: gKey, kind, id, url: `/p/${user.username}/gallery/${id}` })
  }

  const key = `profiles/${user.username}/${kind}.${ext}`
  const platformBucket = await getPlatformBucketId(env)
  await putObject(env, key, buf, contentType, platformBucket)

  // 换扩展名时清掉旧的（如 png → jpg）
  for (const oldExt of Object.values(table)) {
    if (oldExt === ext) continue
    const oldKey = `profiles/${user.username}/${kind}.${oldExt}`
    try {
      await deleteObject(env, oldKey, platformBucket)
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
  const user = await requireUser(env, request)
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

  if (await isStorageConfigured(env)) {
    const platformBucket = await getPlatformBucketId(env)
    for (const ext of ["jpg", "png", "webp", "gif", "mp3", "m4a", "ogg", "wav"]) {
      try {
        await deleteObject(env, `profiles/${user.username}/${kind}.${ext}`, platformBucket)
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
 * 名片资源是否可对外提供（2026-09-25 审计 L10）。
 *
 * 原状况：`loadPublicProfile` 已经用 `published !== 1 || user_status !== "active"`
 * 把**页面**挡住了，但 `/p/<用户名>/<kind>` 与 `/p/<用户名>/gallery/<id>`
 * 这两个资源接口**完全没有检查** —— 只要知道用户名，未发布名片的头像、
 * 背景图、背景音乐、图片墙全都照常返回。用户「先传图、暂不发布」的草稿
 * 内容其实是公开可读的。
 *
 * 现在：未发布（或用户已停用）时，除**本人**以外一律 404。
 */
async function isProfilePubliclyReadable(
  env: Env,
  username: string,
  viewerId: string | null
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT p.user_id, p.published, u.status AS user_status
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.username = ? COLLATE NOCASE LIMIT 1`
  )
    .bind(username)
    .first<{ user_id: string | null; published: number | null; user_status: string }>()

  if (!row) return false
  // 本人始终可以看自己的资源（编辑器预览）
  if (viewerId && row.user_id === viewerId) return true
  return row.published === 1 && row.user_status === "active"
}

/**
 * GET /api/profile/asset?kind=... —— 读取自己的资源（仅用于编辑器预览）
 * 公开页面的资源由 /p/<用户名>/<kind> 提供，见 serveProfileAsset。
 *
 * `kind=gallery&id=<id>`：图片墙单张的**本人预览**通道。
 * 为什么需要它：`/p/<用户名>/gallery/<id>` 现在对未发布名片只放行本人，
 * 而那个路由拿不到请求（无法鉴权），所以编辑器预览必须走这条带会话的接口。
 */
export async function readOwnAsset(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const params = new URL(request.url).searchParams
  const kind = params.get("kind") ?? ""
  if (kind === "gallery") {
    return serveGalleryObject(env, user.username, params.get("id") ?? "")
  }
  return serveAssetByUsername(env, user.username, kind, user.id)
}

/**
 * 取某人名片上「搜索来的音乐」的来源标记；没有或格式非法返回 null。
 *
 * 只取这一个字段而不是整行：这个函数只在公开资源路径上被调用，
 * 少读一点用户数据、少一层把它带进响应体的机会。
 */
async function loadMusicSourceByUsername(
  env: Env,
  username: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT p.music_source AS music_source
       FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE u.username = ? COLLATE NOCASE LIMIT 1`
  )
    .bind(username)
    .first<{ music_source: string | null }>()
  const src = row?.music_source ?? ""
  return isValidSource(src) ? src : null
}

/** 按用户名 + 类型返回 R2 对象（公开可读，用于名片页展示；未发布仅本人可见） */
export async function serveAssetByUsername(
  env: Env,
  username: string,
  kind: string,
  viewerId: string | null = null
): Promise<Response> {
  if (!["avatar", "background", "music", "music-cover"].includes(kind)) {
    return new Response("Not Found", { status: 404 })
  }
  // 未发布的名片不对外提供资源（2026-09-25 审计 L10）
  if (!(await isProfilePubliclyReadable(env, username, viewerId))) {
    return new Response("Not Found", { status: 404 })
  }

  /**
   * 搜索来的音乐：库里只有 `netease:<id>`，既没有 R2 对象也没有外链。
   * 这里实时解析成带时效签名的真实地址，用 302 把浏览器送过去。
   *
   * ⚠️ 这一段必须排在 `isStorageConfigured` 判断**之前**：这条路径完全不需要 R2，
   * 没配存储的站点、以及从没上传过文件的用户，同样应该能听到搜索来的歌。
   *
   * 解析失败时不直接 404 —— 继续往下走，尝试用户自己上传的 R2 文件。
   * 这样第三方服务挂掉时，那些「既上传过又选过歌」的用户不至于彻底静音。
   */
  if (kind === "music") {
    const source = await loadMusicSourceByUsername(env, username)
    if (source) {
      const url = await resolveAudioUrl(source)
      if (url) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            // 地址带时效签名（约 20 分钟失效），绝不能让浏览器或中间层缓存这次跳转。
            // 若哪天误改成可缓存，回放就会命中一个已失效的签名地址，
            // 表现为「第一次能播、过一会儿就播不了」这种极难排查的故障。
            "Cache-Control": "no-store, must-revalidate",
          },
        })
      }
    }
  }

  if (!(await isStorageConfigured(env))) {
    return new Response("Not Found", { status: 404 })
  }
  const platformBucket = await getPlatformBucketId(env)
  for (const ext of ["jpg", "png", "webp", "gif", "mp3", "m4a", "ogg", "wav"]) {
    try {
      return await getObject(env, `profiles/${username}/${kind}.${ext}`, undefined, platformBucket)
    } catch {
      continue
    }
  }
  return new Response("Not Found", { status: 404 })
}

/**
 * 读取 `profiles/<用户名>/gallery/<id>.<ext>` 的 R2 对象。
 * id 由上传时生成（16 位十六进制），此处做白名单字符校验防路径穿越。
 * **不含任何鉴权** —— 调用方负责判断「这个人有没有权限看」。
 */
async function serveGalleryObject(
  env: Env,
  username: string,
  id: string
): Promise<Response> {
  if (!/^[a-f0-9]{8,32}$/.test(id)) {
    return new Response("Not Found", { status: 404 })
  }
  if (!(await isStorageConfigured(env))) {
    return new Response("Not Found", { status: 404 })
  }
  const platformBucket = await getPlatformBucketId(env)
  for (const ext of ["jpg", "png", "webp", "gif"]) {
    try {
      const res = await getObject(
        env,
        `profiles/${username}/gallery/${id}.${ext}`,
        undefined,
        platformBucket
      )
      // 类型收口 + nosniff：公开读取接口不依赖写入侧校验（纵深防御）
      return hardenUserContentResponse(res, `${id}.${ext}`)
    } catch {
      continue
    }
  }
  return new Response("Not Found", { status: 404 })
}

/**
 * 图片墙单张：/p/<用户名>/gallery/<id>（公开可读，未发布名片仅本人可见）。
 */
export async function serveGalleryImage(
  env: Env,
  username: string,
  id: string
): Promise<Response> {
  // 未发布的名片不对外提供图片墙（2026-09-25 审计 L10）
  if (!(await isProfilePubliclyReadable(env, username, null))) {
    return new Response("Not Found", { status: 404 })
  }
  return serveGalleryObject(env, username, id)
}

// ---- 自定义域名绑定 ----

// POST /api/profile/domain —— { subdomainId } 绑定；{ action: "unbind" } 解绑
export async function bindProfileDomain(
  env: Env,
  request: Request,
  subdomainIdFromPath?: string
): Promise<Response> {
  const user = await requireUser(env, request)
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

  // 禁止绑定根域：doulor.cn / tyu.me 都是平台入口（静态站点自定义域 +
  // 多条邮件/API 路由），绑给名片会让整个站点无法访问。CF 路由层拦不住，
  // 必须在这里拒绝。判据是「任一已登记的根域」，不只是 env.ROOT_DOMAIN。
  if (await isRootDomainItself(env, sub.fqdn)) {
    throw new ApiError(
      400,
      `根域名是平台入口，不能绑定给名片。请使用子域名（如 card.${sub.fqdn}）`,
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
  cjkFont: string
  layout: string
  /** 缩放模式：'off' | 'auto'（见 SCALE_MODES） */
  scaleMode: string
  /** 自动缩放下限（百分比） */
  scaleMin: number
  /** 基准缩放比例（百分比） */
  scaleManual: number
  avatar: string | null
  background: string | null
  /**
   * 播放器该用的音频地址。三种来源，语义各不相同：
   *   - 上传到 R2 → `/p/<用户名>/music`（静态文件）
   *   - 用户外链   → 直接就是那个 URL
   *   - 搜索来的   → 同样是 `/p/<用户名>/music`，但该路径在服务端会
   *                  **实时解析**成带时效签名的第三方地址（解析结果绝不入库）。
   * 前两者与第三方无关，只有第三种会在解析失败时静默 404（播放器不响）。
   */
  music: string | null
  musicCover: string | null
  musicTitle: string | null
  musicAutoplay: boolean
  /** 搜索来源标记（'netease:<id>'）；用户自定义时为 null */
  musicSource: string | null
  /** 歌词（LRC 文本）；可为空 */
  musicLyrics: string | null
  contacts: Contact[]
  /** 组装页面的模块（开关 + 顺序 + 各自数据） */
  modules: ProfileModule[]
  /** 用户注册时间（ISO）—— 名片页小字展示 */
  registeredAt: string | null
  /** 用户 UID（按注册顺序从 1 开始，展示层补零成 001）；名片页小字展示 */
  uid: number | null
  /** 名片被访问的累计次数 */
  viewCount: number
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
    `SELECT p.*, u.username, u.avatar_key AS user_avatar_key, u.status AS user_status, u.created_at AS user_created_at, u.uid AS user_uid
       FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE ${where} LIMIT 1`
  )
    .bind(value)
    .first<ProfileRow & { username: string; user_avatar_key: string | null; user_status: string; user_created_at: string; user_uid: number | null }>()

  if (!row) return null
  if (row.published !== 1 || row.user_status !== "active") return null

  // 资源优先用上传的 R2 对象，其次外链
  const assetUrl = (kind: string, key: string | null, url: string | null) => {
    if (key) return `/p/${row.username}/${kind}`
    return url ?? null
  }

  /**
   * 音频地址单独处理：搜索来的歌没有 key 也没有 url，但**复用与上传音频同一个
   * 路径** `/p/<用户名>/music`，由 serveAssetByUsername 实时解析。
   *
   * 为什么不新开一个带 source 参数的公开端点：
   *   1. 自定义名片域名下的加载规则与其它资源完全一致，不必额外配路由；
   *   2. 别人没法拿它当「任意歌曲解析代理」刷 —— 只有名片真实在用的那首歌
   *      才解析得出来，参数里根本没有 id 可以换。
   *
   * 优先级 **搜索歌曲 > 上传文件 > 外链**：
   *   选了搜索歌曲就以它为准；把选择清掉，自动回到用户自己上传的音频。
   *   这样「换来源」永远是可逆的 —— 反过来（上传优先）就必须删掉 R2 里的文件
   *   才能听到新选的歌，用户想换回去就没了。
   */
  const musicSource = isValidSource(row.music_source ?? "") ? row.music_source : null
  const music = musicSource || row.music_key
    ? `/p/${row.username}/music`
    : row.music_url

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
    cjkFont: row.cjk_font ?? "system",
    layout: row.layout,
    scaleMode: normalizeScaleMode(row.scale_mode),
    scaleMin: clampScale(row.scale_min, SCALE_MIN_RANGE, 50),
    scaleManual: clampScale(row.scale_manual, SCALE_MANUAL_RANGE, 100),
    // 头像已统一为「账户头像」一个来源：有就 /u/<用户名>/avatar，没有就 null（前端首字符兜底）。
    // 不再回退名片头像/外链 —— 2026-10-02 站长拍板「两个头像完完全全同一个东西」。
    avatar: row.user_avatar_key ? `/u/${row.username}/avatar` : null,
    background: assetUrl("background", row.background_key, row.background_url),
    music,
    musicCover: assetUrl("music-cover", row.music_cover_key, row.music_cover_url),
    musicTitle: row.music_title,
    musicAutoplay: row.music_autoplay === 1,
    musicSource,
    musicLyrics: row.music_lyrics,
    contacts: parseContacts(row.contacts).filter((c) => c.visible !== false),
    modules: parseModules(row.modules),
    registeredAt: row.user_created_at ?? null,
    uid: row.user_uid ?? null,
    viewCount: row.view_count ?? 0,
  }
}

/**
 * 名片被访问时累计访客量（公开页每次渲染 +1）。
 * 失败静默——计数不应影响名片正常展示。
 */
export async function bumpProfileView(env: Env, slug: string): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE profiles SET view_count = view_count + 1 WHERE slug = ? COLLATE NOCASE"
    )
      .bind(slug)
      .run()
  } catch {
    // 忽略：计数失败不影响页面
  }
}

export type { Contact }