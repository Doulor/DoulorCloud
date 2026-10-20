/**
 * 「分组同步服务」专用的内部接口。
 *
 * ## 为什么要这个东西
 *
 * 2026-10-10 做的「捐献 → NewAPI 分组」联动，本来想走 NewAPI 的管理 API，但实测下来：
 * **`PUT /api/user/` 与 `POST /api/user/manage` 都要求 `X-Security-Proof`**，
 * 而这个签名只认「**dashboard 登录会话**」——
 * 站点持有的那把具名访问令牌（全权限、永不过期、含 `user:write`）**同样被拒**
 * （连只读的 `GET /api/verify/methods` 都返回 `SECURITY_ACTION_FORBIDDEN`）。
 * ⇒ **任何 API 令牌都做不到「改用户」**。这是一条硬的架构结论，别再重复试了。
 *
 * 所以同步只能落到 NewAPI 的数据库上，由一个**独立的小服务**去 UPDATE `users."group"`
 * （跑在有数据库访问权的机器上，靠环境变量拿连接串 ⇒ 换 VPS 只改配置）。
 *
 * 这个接口的作用：让那个服务**不必懂站点的业务规则**（谁捐了 wb、谁捐了自定义渠道、
 * 有效绑定算不算……），只做「拿目标分组 → 比对 → 更新」这一件事。
 * 业务规则**只在这里**维护一份，两边不会分家。
 *
 * ## 认证
 * 请求头 `X-Sync-Key` 必须等于 Worker secret `GROUP_SYNC_KEY`。
 * ⚠️ 未配置该 secret 时接口**直接 503**（绝不放行空 key）。
 */
import { ApiError, json } from "../http"
import type { Env } from "../env"

/** 与站点「捐献」相关的口径：哪些捐献类型算「自定义 AI 渠道」 */
const DONATION_TYPES = ["ai", "proxy", "sensenova"]

/**
 * 「多捐多得」：**每个有效账号每天带来的额度**（单位：元）。
 *
 * 依据（2026-10-11 实测上游网关）：上游每个账号每天签到约得 100 积分，
 * 分出 80% 给捐献者 ⇒ 80 积分/账号/天。
 *
 * ⚠️ 定价基准调整后（最便宜的 glm-5.3-flash = ¥1/次，dsv4.1f = ¥4.92/次），
 * 「1 积分 ≈ 1 元」的旧汇率随之上浮约 5 倍 ⇒ 这里同步取 **¥400**，
 * 保证**「该用户能调用的次数」与调价前一致**（站长明确要求：价格涨几倍、额度也涨几倍）。
 *
 * 🔴 **只算「真实有效」的账号**：`wb2api_bindings.status = 'active'`
 * （被上游判失效 11140 / 被禁用 / 待审核的一律不计）。
 */
const DAILY_YUAN_PER_ACCOUNT = 400

/** quota 与元的换算基准（本站 QuotaPerUnit = 500000） */
const QUOTA_PER_YUAN = 500000

/**
 * **没有任何有效贡献**的用户每天保底额度（元）—— 给个试用/兜底，不至于完全不能用。
 * 与 `DAILY_YUAN_PER_ACCOUNT` 同口径（已是 ×5 之后的数值）。
 */
const BASE_YUAN_NO_CONTRIB = 50

/**
 * 组合分组的名字规则 —— **必须与 NewAPI 侧 `group_special_usable_group` 的键一致**
 * （顺序固定 donation → workbuddy → qoder → 付费，短横线连接；无贡献 = `default`）。
 *
 * ⚠️ 「付费」为什么放在**最后**：它是**附加维度**（站长 2026-10-11 要求给白名单用户
 * 白开付费分组），不是并列的捐献类型 —— 放末尾便于 NewAPI 侧按前缀复用规则。
 *
 * ⚠️ 一个用户**只被授权付费、没捐过任何渠道**时，组合名就是 `付费` 本身
 * （不是 `default-付费`）：NewAPI 的 `GetUserUsableGroups` 对任何 userGroup 都会
 * 兜底把标签自身加进可用集合，所以 `付费` 这个标签天然让该用户能用「付费」分组，
 * NewAPI 侧**不需要**为它单独配 special 规则。
 *
 * ---
 * 「付费」这一维的两条来源（2026-10-20 起）见下方 `PREMIUM_TITLE_NAME`。
 */
function composeGroup(
  hasDonation: boolean,
  hasWb: boolean,
  hasQoder: boolean,
  hasPremium: boolean
): string {
  const parts: string[] = []
  if (hasDonation) parts.push("donation")
  if (hasWb) parts.push("workbuddy")
  if (hasQoder) parts.push("qoder")
  if (hasPremium) parts.push("付费")
  return parts.length === 0 ? "default" : parts.join("-")
}

/**
 * 「赞助伙伴」自定义称号的名字 —— 拥有它的用户**自动**获得付费分组。
 *
 * 2026-10-20 站长要求。付费分组原先只有一条来源：管理面板手动输用户名往
 * `premium_group_grants` 里加。但同一批人往往也带着「赞助伙伴」称号，两边靠手工
 * 同步必然漏 —— 改动前实测：21 人有称号、22 人在白名单，只有 15 人两边都有，
 * 于是 6 个「有称号却没付费」的人（yuan 就在其中）被漏掉了。
 *
 * 现在两条来源取**并集**：
 *   · `premium_group_grants` —— 手动白名单，永久有效（可给没有称号的人）
 *   · 「赞助伙伴」称号        —— 自动生效，撤销称号即失效
 * 互不覆盖：白名单里的人即使没称号也仍然有效。
 *
 * ⚠️ 称号名是**数据**（管理员可在「称号」面板改名），改名后要同步改这里。
 *
 * 导出给 `newapi.ts` 的管理端名单复用 —— 那边要按同一口径列出「谁有付费权限」，
 * 口径分家会变成「面板显示没权限、实际已经生效」，比不显示更糟。
 */
export const PREMIUM_TITLE_NAME = "赞助伙伴"

/**
 * GET /api/internal/group-map
 *
 * 返回 `{ users: { "<newapi_user_id>": "<目标分组>" }, generatedAt }`。
 * ⚠️ 只含**数字 id → 分组名**，不含用户名/邮箱等任何个人资料（最小披露）。
 */
export async function groupMap(env: Env, request: Request): Promise<Response> {
  const expected = (env as unknown as { GROUP_SYNC_KEY?: string }).GROUP_SYNC_KEY
  if (!expected) {
    throw new ApiError(
      503,
      "未配置 GROUP_SYNC_KEY，分组同步接口已禁用",
      "SYNC_KEY_NOT_CONFIGURED"
    )
  }
  const provided = request.headers.get("X-Sync-Key") ?? ""
  // 定长比较，避免用长度差逐字节试探
  if (provided.length !== expected.length || provided !== expected) {
    throw new ApiError(401, "同步密钥不正确", "SYNC_KEY_INVALID")
  }

  const typeList = DONATION_TYPES.map(() => "?").join(",")
  const rows = await env.DB.prepare(
    `SELECT na.newapi_user_id AS nid, na.user_id AS uid,
            (SELECT COUNT(*) FROM donations d
              WHERE d.user_id = na.user_id AND d.status = 'approved'
                AND d.type IN (${typeList})) AS don,
            (SELECT COUNT(*) FROM wb2api_bindings b
              WHERE b.user_id = na.user_id AND b.status = 'active') AS wb,
            (SELECT COUNT(*) FROM qoder2api_bindings q
              WHERE q.user_id = na.user_id AND q.status = 'active') AS qd
       FROM newapi_accounts na
      WHERE na.newapi_user_id > 0`
  )
    .bind(...DONATION_TYPES)
    .all<{ nid: number; uid: string; don: number; wb: number; qd: number }>()

  /**
   * 「付费分组」白名单（2026-10-11）。**永久有效** ⇒ 没有时效条件。
   *
   * 单独查而不是塞进上面那条大 SQL：迁移 0152 万一没应用（换机器/新环境漏跑），
   * 表不存在会让**整条**查询失败 ⇒ 分组同步全停、所有人的分组都不再更新。
   * 单独查 + 兜底，最坏只是「这轮谁都没有付费权限」，既有同步不受影响。
   */
  const premiumSet = new Set<string>()
  try {
    const g = await env.DB.prepare("SELECT user_id FROM premium_group_grants").all<{
      user_id: string
    }>()
    for (const r of g.results ?? []) premiumSet.add(r.user_id)
  } catch (err) {
    console.error("读取付费分组白名单失败（迁移 0152 未应用？本轮按无人有权限处理）:", err)
  }

  /**
   * 「赞助伙伴」称号 → 自动付费（2026-10-20）。
   *
   * 与白名单**取并集**（不是替换）：手动授予仍然保留，称号只是多一条来源。
   * 同样单独查 + 兜底 —— 迁移 0086/0093（custom_titles / user_titles）没应用时，
   * 不能因为这一条把整个分组同步带挂。
   */
  try {
    const t = await env.DB.prepare(
      `SELECT ut.user_id AS user_id
         FROM user_titles ut
         JOIN custom_titles ct ON ct.id = ut.title_id
        WHERE ct.name = ?`
    )
      .bind(PREMIUM_TITLE_NAME)
      .all<{ user_id: string }>()
    for (const r of t.results ?? []) premiumSet.add(r.user_id)
  } catch (err) {
    console.error(
      "读取「赞助伙伴」称号失败（迁移 0086/0093 未应用？本轮只按手动白名单处理）:",
      err
    )
  }

  const users: Record<string, string> = {}
  /** 「多捐多得」：每人每日应得额度（quota）。按**有效** wb 账号数 × ¥80 折算 */
  const quotas: Record<string, number> = {}
  for (const r of rows.results ?? []) {
    const hasDon = Number(r.don) > 0
    const hasWb = Number(r.wb) > 0
    const hasQd = Number(r.qd) > 0
    const hasPrem = premiumSet.has(r.uid)
    users[String(r.nid)] = composeGroup(hasDon, hasWb, hasQd, hasPrem)
    // ⚠️ 只算有效账号（SQL 里已用 status='active' 过滤）——被禁用的账号不产生额度
    // 没有任何有效账号 ⇒ 给保底额度（¥50/天），保证还能试用
    const yuan = Math.max(BASE_YUAN_NO_CONTRIB, Number(r.wb) * DAILY_YUAN_PER_ACCOUNT)
    quotas[String(r.nid)] = yuan * QUOTA_PER_YUAN
  }

  return json({
    users,
    quotas,
    count: Object.keys(users).length,
    /** 每账号每日额度（元），供同步服务/前端展示口径 */
    yuanPerAccount: DAILY_YUAN_PER_ACCOUNT,
    generatedAt: new Date().toISOString(),
  })
}
