/**
 * 积分流水来源（point_transactions.reason）→ i18n 键。
 *
 * ⚠️ 必须与后端**实际写进流水**的取值保持一致，来源散在这些文件里：
 *   worker/src/handlers/checkin.ts            → checkin
 *   worker/src/handlers/dns-rental.ts         → dns_rental
 *   worker/src/handlers/frp-rental.ts         → frp_rental / frp_rental_share
 *   worker/src/game-market.ts                 → game_open / game_pool / game_settle
 *   worker/src/handlers/lab-search.ts         → lab_search
 *   worker/src/points.ts / points-shop.ts     → donation / invite / invite_commission
 *                                               / transfer_out / transfer_in / redeem
 *                                               / shop / shop_sell / admin
 *   worker/src/event-rewards.ts               → event
 *
 * 为什么单独成一个模块：此前 points.tsx 与 admin-points.tsx **各存一份一模一样的 10 项映射**，
 * 之后后端陆续加了 8 种新来源（签到、DNS 租用、内网穿透租用/分成、造物典藏三项、联网搜索），
 * 两份映射都没跟 ⇒ 用户在「积分明细」里看到的是英文原始键（t() 查不到时原样返回键名）。
 * 合并成一份之后，加新来源只需改这里一处。
 */
export const POINT_REASON_LABEL: Record<string, string> = {
  event: "pt.reason.event",
  admin: "pt.reason.admin",
  redeem: "pt.reason.redeem",
  shop: "pt.reason.shop",
  shop_sell: "pt.reason.shopSell",
  donation: "pt.reason.donation",
  invite: "pt.reason.invite",
  invite_commission: "pt.reason.inviteCommission",
  transfer_out: "pt.reason.transferOut",
  transfer_in: "pt.reason.transferIn",
  checkin: "pt.reason.checkin",
  dns_rental: "pt.reason.dnsRental",
  frp_rental: "pt.reason.frpRental",
  frp_rental_share: "pt.reason.frpRentalShare",
  game_open: "pt.reason.gameOpen",
  game_pool: "pt.reason.gamePool",
  game_settle: "pt.reason.gameSettle",
  lab_search: "pt.reason.labSearch",
  // 历史来源：2026-10 那次「造物典藏·投资」整体回滚时由一次性脚本写入
  // （worker/scripts/_rollback-invest-v1.sql）。线上还有 8 条，用户看明细时
  // 若不映射就会看到英文原键。这里保留条目只为把历史记录显示成中文。
  game_rollback: "pt.reason.gameRollback",
}

/**
 * 取某一笔流水的展示文案：优先用后端给的 detail（通常更具体），
 * 没有 detail 时回落到来源标签，再回落到原始 reason。
 *
 * 注释里写清楚这一点，是因为 points.tsx 的「主行」用 detail、「副行」只用来源标签 ——
 * 两条路径都要能兜住未知来源，否则又会漏成英文。
 */
export function pointReasonLabel(reason: string): string {
  return POINT_REASON_LABEL[reason] ?? reason
}
