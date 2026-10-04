import { ApiError, json } from "../http"
import { requireUser, type UserRow, isPrivileged } from "../auth"
import { getSettingBool } from "../settings"
import { FEATURE_LABELS, parsePermissions, type Feature } from "../permissions"
import {
  ACHIEVEMENT_GROUPS,
  computeAchievements,
  loadUserCounts,
} from "./achievements"
import { getTitleForUser } from "./titles"
import { DONATION_TYPE_LABELS } from "./donations"
import type { Env } from "../env"

/**
 * 个人空间（公开主页）。
 *
 * 为什么要有它：社区广场里到处是头像和用户名，但点进去什么都没有 ——
 * 不知道这个人是谁、发过什么、做过什么贡献。这个接口把**账号级**的数据汇总
 * 出来给「空间页」用：称号、成就墙、统计、历史帖子、历史贡献。
 *
 * 与「个人名片」（profiles）的分工：
 *   · 名片是**手工编排**的展示页（主题/模块/背景音乐），未发布只有自己看；
 *   · 空间是**数据驱动**的自动首页，每个账号都有，无需开通。
 *
 * ⚠️ 隐私是这个模块的第一约束，两条规则不能破：
 *   1. **捐献 payload 永不外传**。里面有 API Key、订阅链接等凭据。
 *      对外只给「类型 + 时间 + 计数」这类非敏感字段。
 *   2. **打码必须在服务端做**。查看者缺少对应模块权限时，服务端根本不返回内容
 *      （只回 `masked: true` + 提示），而不是「返回了再让前端用 CSS 糊住」——
 *      后者在浏览器里一看网络请求就全露了。
 *
 * 数据全部实时计算（不冗余落库）：空间与成就页共用 `loadUserCounts` /
 * `computeAchievements`，避免两处各写一份统计口径。
 */

/** 一个空间的分区开关（user_spaces 行；无行时用这里的默认值） */
interface SpaceSettings {
  show_achievements: number
  show_stats: number
  show_posts: number
  show_contributions: number
  show_profile_link: number
  motto: string | null
}

const DEFAULT_SETTINGS: SpaceSettings = {
  show_achievements: 1,
  show_stats: 1,
  show_posts: 1,
  show_contributions: 1,
  show_profile_link: 1,
  motto: null,
}

interface SpaceUserRow {
  id: string
  username: string
  nickname: string | null
  avatar_key: string | null
  role: string
  status: string
  created_at: string
  permissions: string | null
  /** 用户 UID（按注册顺序，迁移 0070）；极老数据可能为 NULL */
  uid: number | null
}

/** 匿名可读：requireUser 抛 401 时吞掉当作访客 */
async function optionalViewer(env: Env, request: Request): Promise<UserRow | null> {
  try {
    return await requireUser(env, request)
  } catch {
    return null
  }
}

async function loadUserByName(env: Env, username: string): Promise<SpaceUserRow> {
  const row = await env.DB.prepare(
    `SELECT id, username, nickname, avatar_key, role, status, created_at, permissions, uid
       FROM users WHERE username = ? COLLATE NOCASE`
  )
    .bind(username)
    .first<SpaceUserRow>()
  if (!row) throw new ApiError(404, "用户不存在", "NOT_FOUND")
  return row
}

async function loadSpaceSettings(env: Env, userId: string): Promise<SpaceSettings> {
  const row = await env.DB.prepare(
    `SELECT show_achievements, show_stats, show_posts, show_contributions, show_profile_link, motto
       FROM user_spaces WHERE user_id = ?`
  )
    .bind(userId)
    .first<SpaceSettings>()
  return row ?? DEFAULT_SETTINGS
}

/** 捐献类型 → 需要的功能权限（决定访客能不能看细节） */
function donationFeature(type: string): Feature {
  if (type === "proxy") return "proxy"
  if (type === "frp") return "frp"
  // ai 与 sensenova 都属于「AI 中转站」这一个权限模块
  return "ai"
}

/** 从 payload 里数出「有多少东西」，顺带得到一句不敏感的描述 */
function summarizeDonation(type: string, payloadRaw: string): string {
  try {
    const p = JSON.parse(payloadRaw) as Record<string, unknown>
    if (type === "ai") {
      const models = Array.isArray(p.models) ? p.models.length : 0
      return models > 0 ? `${models} 个模型` : "AI 渠道"
    }
    if (type === "proxy") {
      const urls = Array.isArray(p.subUrls) ? p.subUrls.length : 0
      return urls > 0 ? `${urls} 条订阅` : "代理订阅"
    }
    if (type === "frp") {
      const ch = Array.isArray(p.channels) ? p.channels.length : 0
      return ch > 0 ? `${ch} 条隧道` : "内网穿透"
    }
    if (type === "sensenova") return "商汤 Key"
  } catch {
    // payload 坏了也不影响列表展示
  }
  return DONATION_TYPE_LABELS[type] ?? "资源"
}

export interface SpaceContributionItem {
  id: string
  type: string
  label: string
  at: string
  /** 非敏感的一句话描述；被打码时为 null */
  summary: string | null
  /** true = 服务端没有下发内容（查看者缺少对应权限） */
  masked: boolean
  /** 被打码时告诉访客「缺哪个模块的权限」（已翻译成模块名） */
  needLabel: string | null
}

/**
 * GET /api/space/:username —— 个人空间详情（公开）。
 *
 * 访客（未登录）能看，但：帖子按「允许访客访问社区」的开关决定是否可见，
 * 贡献一律打码（访客没有任何模块权限）。
 */
export async function getSpace(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  const viewer = await optionalViewer(env, request)
  const target = await loadUserByName(env, username)
  const isOwner = viewer?.id === target.id

  const [settings, counts] = await Promise.all([
    loadSpaceSettings(env, target.id),
    loadUserCounts(env, target.id),
  ])

  const joinedAt = counts.created_at ?? target.created_at
  const days = joinedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(joinedAt).getTime()) / 86400000))
    : 0

  // ---- 成就 / 称号 ----
  const snapshot = computeAchievements(counts)
  const achievements = settings.show_achievements
    ? {
        unlocked: snapshot.summary.unlocked,
        total: snapshot.summary.total,
        points: snapshot.summary.points,
        maxPoints: snapshot.summary.maxPoints,
        title: snapshot.title,
        // 只回「徽章墙」需要的字段：级别 + 图标 + 名字，不回 how/进度等一堆文案
        badges: snapshot.achievements
          .map((a) => ({
            id: a.id,
            name: a.name,
            icon: a.icon,
            group: a.group,
            level: a.level,
            maxLevel: a.single ? 1 : (a.tiers?.length ?? 1),
          }))
          .filter((b) => b.level > 0),
        groups: ACHIEVEMENT_GROUPS,
      }
    : null

  // ---- 统计 ----
  const stats = settings.show_stats
    ? {
        days,
        subdomains: counts.subdomain,
        mailboxes: counts.mailbox,
        posts: counts.posts,
        comments: counts.comments,
        likesReceived: counts.likes_received,
        invited: counts.invited,
        donations: counts.donations,
      }
    : null

  // ---- 历史帖子 ----
  let posts: {
    items: {
      id: string
      excerpt: string
      createdAt: string
      likeCount: number
      commentCount: number
    }[]
    hiddenReason: string | null
  } | null = null
  if (settings.show_posts) {
    let hiddenReason: string | null = null
    if (!(await getSettingBool(env, "community_enabled")) && !isPrivileged(viewer?.role)) {
      hiddenReason = "社区广场暂时关闭"
    } else if (!viewer && !(await getSettingBool(env, "community_guest_access"))) {
      hiddenReason = "登录后可查看 TA 的帖子"
    }
    if (hiddenReason) {
      posts = { items: [], hiddenReason }
    } else {
      const rows = await env.DB.prepare(
        `SELECT id, body, like_count, comment_count, created_at
           FROM posts
          WHERE user_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 10`
      )
        .bind(target.id)
        .all<{
          id: string
          body: string
          like_count: number
          comment_count: number
          created_at: string
        }>()
      posts = {
        items: (rows.results ?? []).map((r) => ({
          id: r.id,
          // 只给摘要：空间是「一眼看过往」，全文在帖子页
          excerpt: r.body.length > 200 ? `${r.body.slice(0, 200)}…` : r.body,
          createdAt: r.created_at,
          likeCount: r.like_count,
          commentCount: r.comment_count,
        })),
        hiddenReason: null,
      }
    }
  }

  // ---- 历史贡献 ----
  let contributions: {
    items: SpaceContributionItem[]
    hiddenReason: string | null
  } | null = null
  if (settings.show_contributions) {
    const rows = await env.DB.prepare(
      `SELECT id, type, payload, reviewed_at, created_at
         FROM donations
        WHERE user_id = ? AND status = 'approved'
        ORDER BY COALESCE(reviewed_at, created_at) DESC
        LIMIT 12`
    )
      .bind(target.id)
      .all<{
        id: string
        type: string
        payload: string
        reviewed_at: string | null
        created_at: string
      }>()

    const viewerPerms = viewer ? parsePermissions(viewer.permissions) : null
    contributions = {
      items: (rows.results ?? []).map((r) => {
        const need = donationFeature(r.type)
        const allowed = isOwner || (viewerPerms ? viewerPerms[need] === true : false)
        return {
          id: r.id,
          type: r.type,
          label: DONATION_TYPE_LABELS[r.type] ?? r.type,
          at: r.reviewed_at ?? r.created_at,
          // 打码时 summary 直接是 null：内容根本没离开服务端
          summary: allowed ? summarizeDonation(r.type, r.payload) : null,
          masked: !allowed,
          needLabel: allowed ? null : FEATURE_LABELS[need],
        }
      }),
      hiddenReason: null,
    }
  }

  // 名片链接（跳转按钮用）：已发布的名片才返回；自定义域名优先，否则 /profile/<slug>。
  // 未发布返回 null，前端不显示跳转按钮。
  let profileUrl: string | null = null
  try {
    const row = await env.DB.prepare(
      `SELECT p.slug, p.fqdn, p.published, u.status AS user_status
         FROM profiles p JOIN users u ON u.id = p.user_id
        WHERE u.username = ? COLLATE NOCASE LIMIT 1`
    )
      .bind(target.username)
      .first<{
        slug: string
        fqdn: string | null
        published: number
        user_status: string
      }>()
    if (row && row.published === 1 && row.user_status === "active") {
      profileUrl = row.fqdn ? `https://${row.fqdn}` : `/profile/${row.slug}`
    }
  } catch (err) {
    console.error("读取名片链接失败（不影响空间页）:", target.username, err)
  }

  return json({
    user: {
      username: target.username,
      nickname: target.nickname,
      hasAvatar: Boolean(target.avatar_key),
      isAdmin: isPrivileged(target.role),
      isRoot: target.role === "root",
      /** 自定义称号（徽章式，管理面板授予；没有为 null） */
      customTitle: await getTitleForUser(env, target.id),
      /** 用户 UID（按注册顺序，001 起）；展示层补零 */
      uid: target.uid ?? null,
      joinedAt,
      days,
    },
    space: {
      isOwner,
      motto: settings.motto,
      showAchievements: settings.show_achievements === 1,
      showStats: settings.show_stats === 1,
      showPosts: settings.show_posts === 1,
      showContributions: settings.show_contributions === 1,
      showProfileLink: settings.show_profile_link === 1,
    },
    /** 名片链接（跳转按钮）；null = 未发布名片 */
    profileUrl,
    /**
     * 打码条目的统一说明。具体缺哪个模块由每条自己的 `needLabel` 给出 ——
     * 这里写死某个模块名会误导（proxy 的条目也会显示「需要 AI 权限」）。
     */
    maskHint: "被打码的条目本身真实存在，只是你的账号还没有对应模块的权限，看得到条目、看不到内容。",
    achievements,
    stats,
    posts,
    contributions,
  })
}

/**
 * GET /api/space/:username/card —— 头像悬浮卡片的轻量数据（公开）。
 *
 * 单独做一个接口（而不是复用 getSpace）的理由：这个接口**每次鼠标划过都调**，
 * 而 getSpace 要查帖子、贡献、成就三套数据。卡片只需要身份 + 称号 + 几个数字。
 */
export async function getSpaceCard(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  const viewer = await optionalViewer(env, request)
  const target = await loadUserByName(env, username)
  const isOwner = viewer?.id === target.id

  const [settings, counts] = await Promise.all([
    loadSpaceSettings(env, target.id),
    loadUserCounts(env, target.id),
  ])
  const snapshot = computeAchievements(counts)
  const joinedAt = counts.created_at ?? target.created_at

  return json({
    username: target.username,
    nickname: target.nickname,
    hasAvatar: Boolean(target.avatar_key),
    isAdmin: isPrivileged(target.role),
    isRoot: target.role === "root",
    /** 自定义称号（徽章式，管理面板授予；没有为 null）。注意与下面的成就等级 title 不是一回事 */
    customTitle: await getTitleForUser(env, target.id),
    /** 用户 UID（按注册顺序，001 起）；展示层补零 */
    uid: target.uid ?? null,
    isMe: isOwner,
    joinedAt,
    days: joinedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(joinedAt).getTime()) / 86400000))
      : 0,
    motto: settings.motto,
    title: snapshot.title.name,
    unlocked: snapshot.summary.unlocked,
    total: snapshot.summary.total,
    points: snapshot.summary.points,
    posts: counts.posts,
  })
}

/**
 * GET /api/my-space —— 我自己的展示设置。
 *
 * 与 getSpace 分开：这个只回设置，供空间页的「展示设置」弹窗用；
 * 而且它必须带 `showXxx` 的**未裁切原值**（主人要能改），
 * 这与 getSpace 里「按开关裁切过的内容」是两件事。
 */
export async function getMySpace(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const settings = await loadSpaceSettings(env, user.id)
  return json({
    settings: {
      showAchievements: settings.show_achievements === 1,
      showStats: settings.show_stats === 1,
      showPosts: settings.show_posts === 1,
      showContributions: settings.show_contributions === 1,
      showProfileLink: settings.show_profile_link === 1,
      motto: settings.motto ?? "",
    },
  })
}

/** PUT /api/my-space —— 保存展示设置 */
export async function updateMySpace(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  const bool = (v: unknown, fallback: boolean): number => {
    if (typeof v === "boolean") return v ? 1 : 0
    return fallback ? 1 : 0
  }
  const current = await loadSpaceSettings(env, user.id)
  const mottoRaw = typeof body.motto === "string" ? body.motto.trim() : null

  await env.DB.prepare(
    `INSERT INTO user_spaces
       (user_id, show_achievements, show_stats, show_posts, show_contributions, show_profile_link, motto, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       show_achievements = excluded.show_achievements,
       show_stats = excluded.show_stats,
       show_posts = excluded.show_posts,
       show_contributions = excluded.show_contributions,
       show_profile_link = excluded.show_profile_link,
       motto = excluded.motto,
       updated_at = excluded.updated_at`
  )
    .bind(
      user.id,
      bool(body.showAchievements, current.show_achievements === 1),
      bool(body.showStats, current.show_stats === 1),
      bool(body.showPosts, current.show_posts === 1),
      bool(body.showContributions, current.show_contributions === 1),
      bool(body.showProfileLink, current.show_profile_link === 1),
      // 空串 = 清掉签名（显式写 NULL，不要留空串）
      mottoRaw ? mottoRaw.slice(0, 40) : null,
      new Date().toISOString()
    )
    .run()

  return json({ ok: true })
}
