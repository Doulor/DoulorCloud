/**
 * GET /donations/channels —— 当前用户四个捐献渠道的开通状态（2026-10-27）。
 *
 * 只回答一个问题：「这个人有没有在某个渠道捐过有效账号」。
 * 用于捐献页顶部那张长条状态卡（已开通=绿 / 未开通=红）。
 * 口径与 group-sync 的分组口径一致（active + invalid 都算"捐过"，因为分组不因失效而取消）。
 */
import type { Env } from "../env"
import { json } from "../http"
import { requireUser } from "../auth"

export type ChannelKey = "workbuddy" | "qoder" | "raccoon" | "autoclaw"

export type ChannelStatusRow = {
  key: ChannelKey
  label: string
  /** 该渠道捐过的账号数（含已失效，分组口径） */
  count: number
  /** 其中仍然有效的账号数（额度口径） */
  activeCount: number
  /** 已开通（至少捐过一个账号，含已失效但仍在分组的） */
  open: boolean
  /** 额度单价（元/天/账号），来自设置项 */
  yuanPerDay: number
}

export async function listDonationChannels(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const q = async (sql: string): Promise<number> => {
    try {
      const row = await env.DB.prepare(sql).bind(user.id).first<{ n: number }>()
      return Number(row?.n ?? 0)
    } catch {
      return 0
    }
  }

  // ⚠️ WorkBuddy(wb2api) 与 Qoder2API 两条通道 2026-11 已停用（AI 捐献统一走 agent2api 网关），
  // 这里不再查询它们的绑定数 —— 用户已经没法再捐了，列出来只会让人以为还能开。
  const rc = await q(
    `SELECT COUNT(*) AS n FROM raccoon_donations
      WHERE user_id = ? AND (token_expires_at IS NULL OR token_expires_at > ${Date.now()})`
  )
  const ac = await q("SELECT COUNT(*) AS n FROM autoclaw_donations WHERE user_id = ?")

  const num = async (
    key: "quota_yuan_per_wb" | "quota_yuan_per_qoder" | "quota_yuan_per_raccoon" | "quota_yuan_per_autoclaw",
    dflt: number
  ): Promise<number> => {
    try {
      const { getSettingNumber } = await import("../settings")
      return Number(await getSettingNumber(env, key)) || dflt
    } catch {
      return dflt
    }
  }

  // 仍有效的账号数（额度口径：只有 active 才给额度）
  const rcLive = await q(
    `SELECT COUNT(*) AS n FROM raccoon_donations WHERE user_id = ? AND status = 'active'
        AND (token_expires_at IS NULL OR token_expires_at > ${Date.now()})`
  )
  const acLive = await q("SELECT COUNT(*) AS n FROM autoclaw_donations WHERE user_id = ? AND status = 'active'")

  const rows: ChannelStatusRow[] = [
    { key: "raccoon", label: "小浣熊", count: rc, activeCount: rcLive, open: rc > 0, yuanPerDay: await num("quota_yuan_per_raccoon", 200) },
    { key: "autoclaw", label: "AutoClaw", count: ac, activeCount: acLive, open: ac > 0, yuanPerDay: await num("quota_yuan_per_autoclaw", 200) },
  ]

  return json({ channels: rows })
}
