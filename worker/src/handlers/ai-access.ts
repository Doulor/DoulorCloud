import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { getSetting } from "../settings"
import { guardRateLimit } from "../ratelimit"
import type { Env } from "../env"

/**
 * 「付费直连地址」的可见性控制（2026-11-02）
 *
 * 为什么放在服务端：
 *   地址本身虽然不算密钥，但既然要让用户「输码才能看」，就不能把明文发给前端再做
 *   CSS 遮挡 —— 那样随便 F12 就能拿到，等于没做。所以未解锁时接口**不返回 url**。
 *
 * 解锁途径两条：
 *   1. 持有自定义称号「赞助伙伴」→ 直接返回（免输码）
 *   2. 输入全局认证码 → 校验通过后返回
 */

/** 持有该称号的用户免认证码 */
const BYPASS_TITLE = "赞助伙伴"

/** 用户在 user_titles 里是否持有指定名称的称号 */
async function holdsTitle(env: Env, userId: string, name: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok
       FROM user_titles ut
       JOIN custom_titles ct ON ct.id = ut.title_id
      WHERE ut.user_id = ? AND ct.name = ?
      LIMIT 1`
  )
    .bind(userId, name)
    .first<{ ok: number }>()
  return Boolean(row?.ok)
}

/**
 * GET /ai/direct-endpoint —— 当前用户「有没有资格看」
 *
 * 注意：**就算有资格也不返回地址**。持有人必须再点一次（POST /ai/direct-reveal）
 * 才下发，这样页面一加载时地址不会出现在任何响应里。
 */
export async function getAiDirectEndpoint(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  // 地址未配置（D1 里没有值）= 入口关闭，对所有人一律「不可查看」
  const url = (await getSetting(env, "ai_direct_base_url")).trim()
  if (!url) return json({ unlocked: false, title: BYPASS_TITLE })

  if (await holdsTitle(env, user.id, BYPASS_TITLE)) {
    return json({ unlocked: true, reason: "title", title: BYPASS_TITLE })
  }

  // 无资格：只告诉前端「有这个入口」，不泄露任何信息
  return json({ unlocked: false, title: BYPASS_TITLE })
}

/**
 * POST /ai/direct-reveal —— 称号持有人「手动点击查看」
 * 只有这一步才真正把地址下发出去。
 */
export async function revealAiDirectEndpoint(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = (await getSetting(env, "ai_direct_base_url")).trim()
  if (!url) throw new ApiError(503, "该入口暂未开放", "NOT_CONFIGURED")
  if (!(await holdsTitle(env, user.id, BYPASS_TITLE))) {
    throw new ApiError(403, "你没有该称号", "FORBIDDEN")
  }
  return json({ url })
}

/** POST /ai/direct-unlock —— 用全局认证码解锁 */
export async function unlockAiDirectEndpoint(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  // 防爆破：每用户每分钟最多 5 次
  await guardRateLimit(env, `ai:direct:unlock:${user.id}`, 5, 60, "认证码尝试过于频繁")

  const body = (await request.json().catch(() => null)) as { code?: unknown } | null
  const code = typeof body?.code === "string" ? body.code.trim() : ""
  if (!code) throw new ApiError(400, "请输入认证码", "INVALID_INPUT")

  const expected = (await getSetting(env, "ai_direct_code")).trim()
  const url = (await getSetting(env, "ai_direct_base_url")).trim()
  if (!expected || !url) throw new ApiError(503, "该入口暂未开放", "NOT_CONFIGURED")
  if (code !== expected) throw new ApiError(401, "认证码不正确", "INVALID_CODE")

  return json({ unlocked: true, url, reason: "code" })
}
