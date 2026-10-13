/**
 * 造物典藏 —— **插件清单**（服务端权威源）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是「插件」
 * ---------------------------------------------------------------------------
 * 造物典藏不是「一个游戏的页面」，而是一个**插件宿主**：大厅里的每张卡片、
 * 每个入口、每个全屏界面，都由 `collection_plugins` 表里的一行描述。
 * 「在线投资」只是第一行 `kind='builtin'` 的记录。
 *
 * 内置插件与将来的用户插件走**同一套契约**：
 *   · 同一张清单表、同一套字段；
 *   · 同一个人口路由 `/dashboard/gallery/collection/<slug>`；
 *   · 同一个宿主组件、同一套管理面板分类。
 * 差别只有两处，且都由 `runtime` 字段表达：
 *   · `runtime='react'`（内置）—— 前端是本站写的 React 组件，服务端能力不限；
 *   · `runtime='sandbox'`（用户）—— 前端是用户写的 HTML，跑在与造物集作品
 *     **同一套** sandbox iframe 里（拿不到会话 cookie），服务端只能通过站内
 *     提供的受限能力（存档 / 排行榜 / 计数器 / 服务端随机数）读写数据。
 *
 *   ⇒ 将来开放用户做游戏时，这个文件、宿主组件、大厅、管理面板**一行都不用改**，
 *     只是多出 `kind='user'` 的行、并启用沙盒宿主。
 *
 * ---------------------------------------------------------------------------
 * 为什么内置插件的权威源在代码里（而不是直接写库）
 * ---------------------------------------------------------------------------
 * 代码是权威源、库是缓存：服务读到清单时会做一次「差异同步」，只有字段真的变了才写库。
 * 好处是插件定义能进 git、能 review、能跟着版本走；反过来（以库为权威）
 * 就会出现「改个图标要登服务器手改 SQL」，多环境一比对全是漂移。
 */
import type { Env } from "./env"

/** 内置插件定义（代码权威源） */
export interface BuiltinPlugin {
  slug: string
  name: string
  /** 卡片图标（emoji）。与造物集作品的口径一致：没有封面图就用 emoji */
  icon: string
  /** 卡片副标题（一句话卖点） */
  tagline: string
  /** 详情页/设置页里更长的说明 */
  description: string
  /** 卡片强调色（hex）。造物典藏是「高级游戏厅」，视觉比造物集更放开 */
  accent: string
  runtime: "react" | "sandbox"
  /**
   * 需要的服务端能力。
   * `native` = 自带数据表与 handler（只有本站自己写的插件能有），
   * 其余键是将来用户插件可用的白名单能力（state / board / counter / rng）。
   */
  capabilities: string[]
  /** 大厅排序（小的在前） */
  sortOrder: number
}

/**
 * 内置插件登记表。
 *
 * 加新游戏的步骤：在这里加一条 + 在 `src/lib/collection-plugins.tsx` 注册同 slug 的
 * 前端组件 + 在 `worker/src/index.ts` 里登记它的路由（如果有服务端逻辑）。
 * 三处都对上，卡片、入口、全屏界面、设置分类就都自动有了。
 */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    slug: "invest",
    name: "在线投资",
    icon: "📈",
    tagline: "多人 K 线合约 · 做多做空 Doulor 币",
    description:
      "用站内积分做保证金，看涨开多、看跌开空，1~20 倍杠杆。" +
      "K 线由**全体玩家的下单**共同推动：买的人多就涨，卖的人多就跌，" +
      "再加上一点随机波动与均值回复。你的对手盘是站内做市池 —— " +
      "池子里的钱全部来自别的玩家亏掉的部分，所以你赚的每一分都是别人亏的，" +
      "站内积分总量不会因为玩这个游戏而增加。爆仓、手续费、逐仓保证金一应俱全。",
    accent: "#f59e0b",
    runtime: "react",
    capabilities: ["native"],
    sortOrder: 10,
  },
]

/** 清单行（与 D1 列一一对应） */
export interface PluginRow {
  slug: string
  name: string
  icon: string
  tagline: string
  description: string
  accent: string
  kind: string
  owner_id: string | null
  runtime: string
  status: string
  sort_order: number
  capabilities: string
  config: string
  created_at: string
  updated_at: string
}

/**
 * 把内置插件同步进库（**只在字段真的变了时才写**）。
 *
 * 每次读清单都调用它，但因为做了差异比对，稳态下是一次 SELECT、零写入 ——
 * 不做比对的话每开一次大厅就写一行，白白消耗 D1 的每日写额度。
 *
 * 刻意**不覆盖** `status`：站长可以在典藏设置里把某个游戏下架（`disabled`），
 * 那是运营状态，不该被下一次同步重置回 `published`。
 */
async function syncBuiltin(env: Env, existing: Map<string, PluginRow>): Promise<void> {
  const now = new Date().toISOString()
  for (const p of BUILTIN_PLUGINS) {
    const cur = existing.get(p.slug)
    const capabilities = JSON.stringify(p.capabilities)
    const same =
      cur &&
      cur.name === p.name &&
      cur.icon === p.icon &&
      cur.tagline === p.tagline &&
      cur.description === p.description &&
      cur.accent === p.accent &&
      cur.runtime === p.runtime &&
      cur.sort_order === p.sortOrder &&
      cur.capabilities === capabilities &&
      cur.kind === "builtin"
    if (same) continue

    await env.DB.prepare(
      `INSERT INTO collection_plugins
         (slug, name, icon, tagline, description, accent, kind, owner_id, runtime, status,
          sort_order, capabilities, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'builtin', NULL, ?, 'published', ?, ?, '{}', ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name, icon = excluded.icon, tagline = excluded.tagline,
         description = excluded.description, accent = excluded.accent,
         runtime = excluded.runtime, sort_order = excluded.sort_order,
         capabilities = excluded.capabilities, kind = 'builtin', updated_at = excluded.updated_at`
    )
      .bind(
        p.slug, p.name, p.icon, p.tagline, p.description, p.accent,
        p.runtime, p.sortOrder, capabilities, now, now
      )
      .run()
  }
}

/** 全部插件（含未上架的）—— 管理端用 */
export async function listAllPlugins(env: Env): Promise<PluginRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM collection_plugins ORDER BY sort_order ASC, slug ASC"
  ).all<PluginRow>()
  const list = rows.results ?? []
  await syncBuiltin(env, new Map(list.map((r) => [r.slug, r])))
  if (BUILTIN_PLUGINS.some((p) => !list.find((r) => r.slug === p.slug))) {
    // 同步补了新行，重读一次保证返回的是最新集合
    const again = await env.DB.prepare(
      "SELECT * FROM collection_plugins ORDER BY sort_order ASC, slug ASC"
    ).all<PluginRow>()
    return again.results ?? []
  }
  return list
}

/** 大厅用：只返回已上架的 */
export async function listPublishedPlugins(env: Env): Promise<PluginRow[]> {
  const all = await listAllPlugins(env)
  return all.filter((p) => p.status === "published")
}

export async function getPlugin(env: Env, slug: string): Promise<PluginRow | null> {
  const all = await listAllPlugins(env)
  return all.find((p) => p.slug === slug) ?? null
}

/**
 * 把清单行转成下发给前端的形状（camelCase，不暴露 owner_id 之外的内部字段）。
 *
 * `runtime` 与 `kind` 都下发：宿主据此决定渲染 React 组件还是沙盒 iframe，
 * 卡片据此决定要不要打「官方」标记。
 */
export function toPublicPlugin(row: PluginRow, canManage = false) {
  return {
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    tagline: row.tagline,
    description: row.description,
    accent: row.accent,
    kind: row.kind,
    runtime: row.runtime,
    status: row.status,
    entry: `/dashboard/gallery/collection/${row.slug}`,
    capabilities: safeParseArray(row.capabilities),
    ...(canManage ? { config: safeParseObject(row.config) } : {}),
  }
}

function safeParseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 供管理端改某一行配置时用（v1 只有内置插件，但接口形状与将来用户插件一致） */
export async function updatePluginRow(
  env: Env,
  slug: string,
  patch: { status?: string; accent?: string; name?: string; tagline?: string; description?: string }
): Promise<void> {
  const sets: string[] = []
  const binds: unknown[] = []
  if (patch.status !== undefined) {
    sets.push("status = ?")
    binds.push(patch.status)
  }
  if (patch.accent !== undefined) {
    sets.push("accent = ?")
    binds.push(patch.accent)
  }
  if (patch.name !== undefined) {
    sets.push("name = ?")
    binds.push(patch.name)
  }
  if (patch.tagline !== undefined) {
    sets.push("tagline = ?")
    binds.push(patch.tagline)
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    binds.push(patch.description)
  }
  if (sets.length === 0) return
  sets.push("updated_at = ?")
  binds.push(new Date().toISOString(), slug)
  await env.DB.prepare(`UPDATE collection_plugins SET ${sets.join(", ")} WHERE slug = ?`)
    .bind(...binds)
    .run()
}
