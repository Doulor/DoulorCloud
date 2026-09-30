/**
 * 管理审计时间线（管理员）。
 *
 * audit_logs 本来就在记（register / admin.settings.update / donation.review…五十多种
 * action），这里只是把它们按「管理员视角」查出来展示 —— 不新增写入点。
 *
 * 关于「回退」为什么不在本文件实现（见管理面板该页的说明文案）：
 *   回退的前提是**能从记录里恢复出当时的状态**。audit_logs 只有 `action + detail` 两列
 *   人类可读文本，没有 before/after 快照 —— 删掉的子域名、改掉的设置旧值都拿不回来。
 *   所以真正可回退的操作需要先让写入点记录结构化的变更前后值，那是另一个工程。
 */
import { json } from "../http"
import { requireAdmin } from "./admin"
import { likeStartsWith } from "../sql-like"
import type { Env } from "../env"

/**
 * 「管理面板操作」的口径：admin.* 前缀（面板各页的核心写操作）+ 活动管理 +
 * 捐献审核/发放/撤销 + frp 审批。不带 admin. 前缀是因为这些写入点散落在
 * 各业务 handler 里，action 命名跟着业务走，没有统一的管理前缀。
 */
const MGMT_ACTION_SQL =
  "(a.action LIKE 'admin.%' OR a.action LIKE 'event.%' OR a.action IN ('donation.review','donation.provision','donation.revoke','frp.approve'))"

/**
 * GET /api/admin/audit?scope=admins|all&mgmt=1&action=&page=1&pageSize=50
 *
 * scope：
 *   - `admins`（默认）：只看**管理员/站长作为操作者**的记录，即「管理员都做了什么」；
 *   - `all`：全站审计（含普通用户的敏感操作，如改密码、绑 NewAPI）。
 * mgmt=1：只看「管理面板操作」（见 MGMT_ACTION_SQL），与 action 精确筛选可叠加。
 * action：按动作**前缀**筛选（如 `donation.` 匹配 donation.review / donation.provision）。
 */
export async function listAudit(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const url = new URL(request.url)
  const scope = url.searchParams.get("scope") === "all" ? "all" : "admins"
  const mgmt = url.searchParams.get("mgmt") === "1"
  // 上限 40 而不是 60：这个值会进 `LIKE '<action>%'`，而 D1 的 LIKE 模式上限只有
  // 50 字符（见 sql-like.ts）—— 原来允许 60 ⇒ 传一个长 action 查询会直接 500。
  const action = (url.searchParams.get("action") ?? "").trim().slice(0, 40)
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1)
  const pageSize = Math.min(
    Math.max(Number(url.searchParams.get("pageSize") ?? 50) || 50, 10),
    100
  )
  const offset = (page - 1) * pageSize

  // 基础条件（scope + mgmt）：列表与「类型分布」共用；
  // action 精确筛选只作用于列表 —— 分布下拉不能因为自己被选中而塌缩成一项。
  const baseConds: string[] = []
  if (scope === "admins") baseConds.push("u.role IN ('admin','root')")
  if (mgmt) baseConds.push(MGMT_ACTION_SQL)
  const baseWhere = baseConds.length ? `WHERE ${baseConds.join(" AND ")}` : ""

  const conds = [...baseConds]
  const binds: (string | number)[] = []
  if (action) {
    conds.push("a.action LIKE ?")
    binds.push(likeStartsWith(action))
  }
  const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : ""

  const [rows, totalRow, actionRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT a.id, a.action, a.detail, a.ip, a.created_at,
              u.username, u.nickname, u.role
         FROM audit_logs a JOIN users u ON u.id = a.user_id
         ${whereSql}
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS c
         FROM audit_logs a JOIN users u ON u.id = a.user_id
         ${whereSql}`
    ).bind(...binds),
    // 操作类型分布（跟随 scope + mgmt，不含 action 自身筛选），给筛选下拉用
    env.DB.prepare(
      `SELECT a.action, COUNT(*) AS c
         FROM audit_logs a JOIN users u ON u.id = a.user_id
        ${baseWhere}
        GROUP BY a.action ORDER BY c DESC`
    ),
  ])

  return json({
    items: rows.results ?? [],
    total: (totalRow as { results?: { c: number }[] }).results?.[0]?.c ?? 0,
    page,
    pageSize,
    actions: actionRows.results ?? [],
  })
}
