/**
 * 「需要注意」的计数汇总。
 *
 * 一个端点同时喂两处 UI，避免前端为角标发一串小请求：
 *   · 侧边栏 —— 社区广场 / 聊天室 / 反馈 的角标，以及「管理」入口的总角标
 *   · 管理面板 —— 各栏目自己的角标（反馈、捐献、积分）
 *
 * 口径约定（与各处已有实现保持一致，改动前先看对应文件）：
 *   · community —— 「我看过之后」的新帖数，见 community.ts 的 newPostsCount（迁移 0043）
 *   · chat      —— 「我看过之后」的新消息数，见 chat.ts 的 unreadCount（迁移 0081）
 *   · feedback  —— 管理员回复过、但我还没读的反馈条数（用户侧）
 *   · admin.*   —— 管理员**待处理**的队列长度，只有 privileged 才返回：
 *                 feedback（待处理反馈）、donations（待审核捐献）、
 *                 pointProducts（用户商品待审核）、
 *                 eventClaims（活动奖励待人工发放）、
 *                 frpApplications（内网穿透申请待审核）、appeals（封禁申诉待处理）
 *
 * 2026-10-02 调整（站长要求）：**DNS 解析与「风险账户」不再挂角标** ——
 * 前者是扫描出来的体检报告、后者是自动观察名单，都不是「等你逐条动手」的队列，
 * 挂角标只会让侧边栏「管理」总数长期虚高、真待办被淹。故二者的字段/计数已从
 * 本接口移除（DNS 待处理数仍由管理页自己拉，见 admin-dns.ts 的 openFindings）。
 *
 * 2026-10-03 调整（站长要求）：**待处理订单（pointOrders）不再挂角标** ——
 * 订单多是「等买家确认收货 / 等自动结算」的正常流程态，不是非要管理员动手的待办，
 * 挂角标会长期虚高。字段与计数一并移除（订单列表本身照常显示状态标签）。
 *
 * ⚠️ `admin` 字段对普通用户是 `null`，不是 `{}` —— 前端据此决定要不要渲染管理角标。
 * ⚠️ 这里只做「数数」，不返回任何明细，避免把管理端数据泄露给普通用户。
 */
import { json } from "../http"
import { requireUser, isPrivileged } from "../auth"
import { countPendingAppeals } from "./moderation"
import type { Env } from "../env"

/** 从没打开过时回落的窗口（与社区角标一致） */
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000

type CountRow = { c?: number }

/** GET /api/attention —— 当前用户需要关注的计数汇总 */
export async function getAttention(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)

  const seen = await env.DB.prepare(
    "SELECT community_seen_at, chat_seen_at FROM users WHERE id = ?"
  )
    .bind(me.id)
    .first<{ community_seen_at: string | null; chat_seen_at: string | null }>()

  const fallback = new Date(Date.now() - FALLBACK_WINDOW_MS).toISOString()
  const communitySince = seen?.community_seen_at ?? fallback
  const chatSince = seen?.chat_seen_at ?? fallback

  const privileged = isPrivileged(me.role)

  const stmts = [
    // 0) 社区：我看过之后、别人发的、未删除的帖子
    env.DB.prepare(
      "SELECT COUNT(*) c FROM posts WHERE created_at > ? AND deleted_at IS NULL AND user_id <> ?"
    ).bind(communitySince, me.id),
    // 1) 聊天室：我看过之后、别人发的消息
    env.DB.prepare(
      "SELECT COUNT(*) c FROM chat_messages WHERE created_at > ? AND user_id <> ?"
    ).bind(chatSince, me.id),
    // 2) 反馈：管理员回复过、但我还没读
    env.DB.prepare(
      "SELECT COUNT(*) c FROM feedback WHERE user_id = ? AND admin_reply IS NOT NULL AND user_read = 0"
    ).bind(me.id),
  ]

  if (privileged) {
    stmts.push(
      // 3) 待处理反馈
      env.DB.prepare("SELECT COUNT(*) c FROM feedback WHERE status = 'pending'"),
      // 4) 待审核捐献
      env.DB.prepare("SELECT COUNT(*) c FROM donations WHERE status = 'pending'"),
      // 5) 用户上传的商品待审核（官方商品建的时候就是 approved，不会进这个数）
      env.DB.prepare("SELECT COUNT(*) c FROM point_products WHERE review_status = 'pending'"),
      // 6) 活动奖励里「自动发放失败、要人工发」的（如用户还没绑中转站）
      env.DB.prepare("SELECT COUNT(*) c FROM event_claims WHERE reward_status = 'manual'"),
      // 7) 内网穿透申请待审核（frp_applications 是迁移 0009 的老表，进 batch 安全）
      env.DB.prepare("SELECT COUNT(*) c FROM frp_applications WHERE status = 'pending'")
    )
  }

  const rows = await env.DB.batch(stmts)
  const at = (i: number) => Number((rows[i]?.results?.[0] as CountRow | undefined)?.c ?? 0)

  let admin: {
    total: number
    feedback: number
    donations: number
    pointProducts: number
    eventClaims: number
    frpApplications: number
    appeals: number
  } | null = null

  if (privileged) {
    const feedback = at(3)
    const donations = at(4)
    const pointProducts = at(5)
    const eventClaims = at(6)
    const frpApplications = at(7)
    // ⚠️ 封禁申诉那张表是 2026-10-02 才加的（迁移 0096），**不进上面的 batch**：
    //    一旦线上漏执行迁移，batch 里带上它会让**整个** `/api/attention` 500 ——
    //    侧边栏角标与后台管理入口一起挂掉。countPendingAppeals 内部吞异常返回 0，
    //    表没建好时退化成「没有待办」。
    const appeals = await countPendingAppeals(env)
    admin = {
      total:
        feedback + donations + pointProducts + eventClaims + frpApplications + appeals,
      feedback,
      donations,
      pointProducts,
      eventClaims,
      frpApplications,
      appeals,
    }
  }

  return json({
    community: at(0),
    chat: at(1),
    feedback: at(2),
    admin,
  })
}
