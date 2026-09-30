/**
 * 「本站有 ai 权限」与「NewAPI 账号没被禁用」的对齐。
 *
 * 背景（站长 2026-09-30 报的 bug）：
 *   商汤 Key 巡检判定 Key 失效 → 收回 `ai` 权限，并**连带 disable 中转站账号**
 *   （让用户已建的 API Key 立即失效）。但当时只写了「禁用」，没有对称的「重新启用」：
 *   用户后来重新捐到一份有效资源、`ai` 权限回来了，中转站账号却还躺在禁用状态 ——
 *   表现成「明明有 ai 权限，怎么调都失败」。用户 `pillbox` 就是这么踩中的
 *   （第一把 Key 被巡检收回并禁用，23 分钟后重新捐了一把、审批通过，权限恢复但账号仍禁用）。
 *
 * 为什么单独一个模块：**授予 ai 权限的入口不止一个**（捐献审核、权限兑换码、
 * 积分商城买权限…），每个入口各写一遍必然漏。这里只提供一个函数，谁给 ai 权限谁调它。
 *
 * ⚠️ 对**已启用**的账号调 enable 是无害空操作（NewAPI 侧幂等），所以不必先读远端状态
 *    —— 少一次 subrequest（免费版单请求上限 50，这个数一直很紧）。
 * ⚠️ **永不抛错**：调用点都在「权限已经给出去」之后，这里失败只该记日志。
 *    否则会出现「权限给了但接口 500」，用户以为没成功、反复重试。
 */
import { adminSetUserStatus } from "./newapi-client"
import type { Env } from "./env"

/**
 * 若该用户开通了中转站账号，确保它在 NewAPI 侧是**启用**状态。
 *
 * 没开通中转站（没有 newapi_accounts 行）时静默返回 —— 那时没有可启用的对象。
 */
export async function ensureNewApiAccountEnabled(
  env: Env,
  userId: string
): Promise<void> {
  try {
    const acct = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ newapi_user_id: number | null }>()
    if (!acct?.newapi_user_id) return

    await adminSetUserStatus(env, acct.newapi_user_id, "enable")
  } catch (err) {
    console.error(
      `启用中转站账号失败（${userId}）:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}
