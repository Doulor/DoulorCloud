/**
 * 管理员权限树 —— 全站管理端权限的**唯一权威源**。
 *
 * 结构：分组 → 大类（category）→ 子项（leaf）。单级大类的 key 即叶子 key；
 * 二级大类带 children，叶子 key 为 `大类.子项`（如 `points.review`）。
 *
 * 白名单原则（站长 2026-10-04 定）：只定义「拥有哪些权限」，没有「禁止哪些」。
 * 管理员（新角色）的 `admin_scope` 是一个叶子 key 数组，数组里有才有，没有一律无。
 * root / superadmin 不看白名单，全放行。
 *
 * ⚠️ 本文件被**后端守卫**和**前端勾选界面**共同依赖，改权限节点要两处一起生效
 * （前端通过 `GET /api/admin/permissions/tree` 拉这份定义，不硬编码）。
 */
export interface AdminPermLeaf {
  key: string
  label: string
  /** 仅站长可用（如切换角色、重置 2FA）—— 前端置灰，后端硬拦 */
  rootOnly?: boolean
}

export interface AdminPermCategory {
  key: string
  label: string
  group: string
  /** 无 children = 单级大类（叶子 key = 大类 key） */
  children?: AdminPermLeaf[]
}

export interface AdminPermGroup {
  key: string
  label: string
}

export const ADMIN_GROUPS: AdminPermGroup[] = [
  { key: "account", label: "用户与账号" },
  { key: "resource", label: "服务与资源" },
  { key: "operation", label: "内容与运营" },
  { key: "system", label: "系统" },
]

export const ADMIN_PERMISSIONS: AdminPermCategory[] = [
  // ======================= 用户与账号 =======================
  {
    key: "users",
    label: "用户管理",
    group: "account",
    children: [
      { key: "users.view", label: "查看用户" },
      { key: "users.suspend", label: "封禁 / 解封" },
      { key: "users.delete", label: "删除用户" },
      { key: "users.permissions", label: "调整功能权限" },
      { key: "users.quota", label: "调整配额 / 额度" },
      { key: "users.role", label: "切换角色", rootOnly: true },
      { key: "users.2fa", label: "重置二次认证", rootOnly: true },
    ],
  },
  { key: "invites", label: "邀请码", group: "account" },
  { key: "inviteQuotas", label: "邀请额度", group: "account" },
  { key: "reserved", label: "保留词 / 域名", group: "account" },
  { key: "titles", label: "称号", group: "account" },
  {
    key: "moderation",
    label: "监管",
    group: "account",
    children: [
      { key: "moderation.risk", label: "风险账户处置" },
      { key: "moderation.appeals", label: "申诉处理" },
      { key: "moderation.whitelist", label: "白名单管理" },
      { key: "moderation.blacklist", label: "IP 黑名单" },
    ],
  },
  { key: "notices", label: "通知", group: "account" },

  // ======================= 服务与资源 =======================
  {
    key: "newapi",
    label: "AI 中转站",
    group: "resource",
    children: [
      { key: "newapi.channels", label: "渠道管理" },
      { key: "newapi.subscriptions", label: "额度与订阅" },
      { key: "newapi.keys", label: "用户 Key" },
    ],
  },
  {
    key: "wb2api",
    label: "捐献通道",
    group: "resource",
    children: [
      { key: "wb2api.bindings", label: "绑定管理" },
      { key: "wb2api.config", label: "通道配置" },
    ],
  },
  {
    key: "r2",
    label: "网盘",
    group: "resource",
    children: [
      { key: "r2.buckets", label: "桶管理" },
      { key: "r2.quota", label: "配额管理" },
    ],
  },
  {
    key: "frp",
    label: "内网穿透",
    group: "resource",
    children: [
      { key: "frp.approve", label: "申请审核" },
      { key: "frp.nodes", label: "节点管理" },
      { key: "frp.ports", label: "端口管理" },
    ],
  },
  {
    key: "proxy",
    label: "代理节点",
    group: "resource",
    children: [
      { key: "proxy.subscriptions", label: "订阅管理" },
      { key: "proxy.latency", label: "节点测速" },
    ],
  },
  { key: "dns", label: "DNS 管理", group: "resource" },

  // ======================= 内容与运营 =======================
  { key: "announcements", label: "公告", group: "operation" },
  { key: "funLinks", label: "趣站链接", group: "operation" },
  {
    key: "events",
    label: "活动",
    group: "operation",
    children: [
      { key: "events.manage", label: "活动管理" },
      { key: "events.grant", label: "奖励发放" },
    ],
  },
  {
    key: "points",
    label: "积分",
    group: "operation",
    children: [
      { key: "points.review", label: "审核商品" },
      { key: "points.official", label: "上架官方商品" },
      { key: "points.userProducts", label: "管理用户商品" },
      { key: "points.adjust", label: "编辑用户积分" },
      { key: "points.aftersale", label: "售后处理" },
    ],
  },
  {
    key: "community",
    label: "社区",
    group: "operation",
    children: [
      { key: "community.posts", label: "帖子管理" },
      { key: "community.comments", label: "评论管理" },
    ],
  },
  {
    key: "donations",
    label: "捐献",
    group: "operation",
    children: [
      { key: "donations.ai", label: "审核 AI" },
      { key: "donations.proxy", label: "审核代理" },
      { key: "donations.frp", label: "审核内网穿透" },
    ],
  },
  { key: "feedback", label: "反馈", group: "operation" },

  // ======================= 系统 =======================
  { key: "oauth", label: "OAuth 应用", group: "system" },
  { key: "analytics", label: "数据分析", group: "system" },
  { key: "cfQuota", label: "CF 配额", group: "system" },
  { key: "audit", label: "审计日志", group: "system" },
  { key: "mail", label: "邮件", group: "system" },
  { key: "settings", label: "全局设置", group: "system" },
  { key: "api", label: "开放 API", group: "system" },
]

/** 权限节点 key 扁平表（含叶子与 root 专属标记），用于守卫快速查找 */
const LEAF_MAP: Map<string, { label: string; rootOnly: boolean }> = new Map()
for (const cat of ADMIN_PERMISSIONS) {
  if (!cat.children || cat.children.length === 0) {
    LEAF_MAP.set(cat.key, { label: cat.label, rootOnly: false })
  } else {
    for (const leaf of cat.children) {
      LEAF_MAP.set(leaf.key, { label: leaf.label, rootOnly: leaf.rootOnly === true })
    }
  }
}

export function isKnownPermissionKey(key: string): boolean {
  return LEAF_MAP.has(key)
}

export function isRootOnlyPermission(key: string): boolean {
  return LEAF_MAP.get(key)?.rootOnly === true
}

export function permissionLabel(key: string): string {
  return LEAF_MAP.get(key)?.label ?? key
}

/**
 * 解析 `admin_scope`（JSON 数组）。只保留合法 key、丢弃不认识 / 重复的。
 * 白名单语义：不在数组里 = 没有该权限，所以过滤掉脏数据是安全的（只会收紧不会放开）。
 */
export function parseAdminScope(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return new Set()
  }
  if (!Array.isArray(arr)) return new Set()
  const out = new Set<string>()
  for (const item of arr) {
    if (typeof item === "string" && isKnownPermissionKey(item)) out.add(item)
  }
  return out
}
