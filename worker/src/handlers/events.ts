/**
 * 活动系统：管理员发布活动 → 用户消息中心「活动推广」看到 → 点「立即参与」
 * → 服务端校验资格并自动发放奖励。
 *
 * 设计要点：
 *   - 奖励 / 条件的具体行为在 event-rewards.ts 的注册表里（加新活动类型只加一项）。
 *   - 领取幂等靠 event_claims 的 (event_id, user_id) 唯一索引 + INSERT OR IGNORE，
 *     不依赖前端、不读后写；并发重复领取在唯一约束处被拦下。
 *   - 资格校验全在服务端；前端按钮状态只是展示。
 *   - 发放失败不能让用户卡在 pending：异常时把 claim 置 failed 并允许重试。
 */
import { ApiError, json, assertContentLengthWithin } from "../http"
import { requireUser } from "../auth"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import { guardRateLimit } from "../ratelimit"
import { audit } from "../settings"
import { checkStarred } from "../github"
import { broadcastMessage } from "../user-messages"
import {
  REWARD_HANDLERS,
  REWARD_PRECONDITIONS,
  CONDITION_HANDLERS,
  CONDITION_HINTS,
  isRewardType,
  isConditionType,
  parseLotteryConfig,
  splitPool,
  validatePointsReward,
  validateGithubStarCondition,
  type RewardType,
  type ConditionType,
} from "../event-rewards"
import { applyPoints } from "../points"
import type { Env } from "../env"

const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * 活动状态。
 *   draft     草稿，用户端不可见
 *   scheduled 定时，到 publish_at 自动转 active 并广播（见 scheduled-publish.ts）
 *   active    已上线，用户端可见、可参与
 *   ended     已结束；archived 已归档（都不可见）
 */
const EVENT_STATUSES = ["draft", "scheduled", "active", "ended", "archived"] as const

interface EventRow {
  id: string
  title: string
  body: string
  status: string
  starts_at: string | null
  ends_at: string | null
  publish_at: string | null
  published_at: string | null
  /** 限量总份数；NULL = 不限量 */
  max_claims: number | null
  reward_label: string | null
  reward_type: string
  reward_params: string | null
  condition_type: string
  condition_params: string | null
  /** 抽奖活动：开奖时间；NULL = 尚未开奖（同时是开奖幂等锁） */
  drawn_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 活动对用户的可见性 / 可领取状态（服务端算，前端只用结果） */
function claimState(row: EventRow, now: number): "not_started" | "open" | "ended" | "offline" {
  if (row.status !== "active") return "offline"
  if (row.starts_at && Date.parse(row.starts_at) > now) return "not_started"
  if (row.ends_at && Date.parse(row.ends_at) < now) return "ended"
  return "open"
}

function toEvent(row: EventRow, now: number, isAdmin = false) {
  // ⚠️ 认证码（condition_params.code）绝不能下发到用户端 —— listEvents 未登录可访问，
  // 原样返回等于把答案印在题目上。用户侧置 null（conditionType 已足够前端渲染输入框），
  // 仅管理端保留完整参数。
  const conditionParams = isAdmin ? parseJson(row.condition_params) : null
  // 抽奖配置不含敏感信息，用户端也要看得到（卡片上要显示奖池与中奖人数）
  const lottery =
    row.condition_type === "lottery" ? parseLotteryConfig(parseJson(row.condition_params)) : null
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    publishAt: row.publish_at,
    publishedAt: row.published_at,
    /** 限量总份数；null = 不限量。抽奖活动下这个字段是「参与人数上限」 */
    maxClaims: row.max_claims ?? null,
    rewardLabel: row.reward_label,
    rewardType: row.reward_type,
    rewardParams: parseJson(row.reward_params),
    conditionType: row.condition_type,
    conditionParams,
    /**
     * 参与条件的**规则说明**（如「需要先把个人名片做完：填好昵称并保存」）。
     *
     * 与 `claimBlockedReason` 的区别：那个说的是「你**现在**还差什么」（奖励前置条件，
     * 与用户状态有关），这个是「这类活动**要什么**」（静态规则，任何人都一样）。
     * 两者一起给，用户领取前就能知道该做什么，而不是点了才被拒。
     */
    conditionHint: CONDITION_HINTS[row.condition_type as ConditionType] || null,
    /** 抽奖：开奖时间；null = 尚未开奖 */
    drawnAt: row.drawn_at ?? null,
    /**
     * 抽奖活动的展示信息（中奖人数 / 奖池积分 / 分配方式 / 是否已开奖）。
     * 非抽奖活动或配置异常为 null —— 前端据此决定要不要渲染抽奖区块。
     */
    lottery: lottery
      ? {
          winners: lottery.winners,
          pool: lottery.pool,
          mode: lottery.mode,
          drawn: !!row.drawn_at,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /** 当前时间下这个活动的可参与状态 */
    claimState: claimState(row, now),
  }
}

async function loadOne(env: Env, id: string): Promise<EventRow> {
  const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(id)
    .first<EventRow>()
  if (!row) throw new ApiError(404, "活动不存在", "NOT_FOUND")
  return row
}

// ---- 用户端 ----

/**
 * GET /api/events —— 当前用户可见的活动（已上线且未结束），附自己的领取状态。
 * 未登录也允许访问（社区页/概览可能展示活动），但不返回领取状态。
 */
export async function listEvents(env: Env, request: Request): Promise<Response> {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  // 未结束：ends_at 为空或 >= now。⚠️ 这里的 ? 必须 bind —— 漏掉会报
  // 「Wrong number of parameter bindings」，接口整体 500。
  const rows = await env.DB.prepare(
    `SELECT * FROM events
      WHERE status = 'active' AND (ends_at IS NULL OR ends_at >= ?)
      ORDER BY created_at DESC LIMIT 50`
  )
    .bind(nowIso)
    .all<EventRow>()

  const events = (rows.results ?? []).map((r) => toEvent(r, now))

  // 附每个活动的已领份数（一次 GROUP BY，避免 N+1）。
  // 用户端据 maxClaims - claimCount 显示「剩余 N 份」——限量活动的先到先得必须可见，
  // 否则用户不知道还剩多少、也无从判断该不该赶紧领。活动数量很小（LIMIT 50），代价可忽略。
  const counts = await env.DB.prepare(
    "SELECT event_id, COUNT(*) AS c FROM event_claims GROUP BY event_id"
  ).all<{ event_id: string; c: number }>()
  const countMap = Object.fromEntries((counts.results ?? []).map((r) => [r.event_id, r.c]))

  // 附当前用户的领取记录（可选登录）
  let claims: Record<string, { rewardStatus: string; rewardDetail: string | null }> = {}
  const user = await optionalUser(env, request)
  if (user && events.length > 0) {
    const claimRows = await env.DB.prepare(
      "SELECT event_id, reward_status, reward_detail FROM event_claims WHERE user_id = ?"
    )
      .bind(user.id)
      .all<{ event_id: string; reward_status: string; reward_detail: string | null }>()
    claims = Object.fromEntries(
      (claimRows.results ?? []).map((c) => [
        c.event_id,
        { rewardStatus: c.reward_status, rewardDetail: c.reward_detail },
      ])
    )
  }

  // 奖励前置条件（如中转站额度需先开通中转站）：登录用户才算，
  // 让前端能把「立即参与」置灰并说明原因，而不是点了才弹错。
  const blocked: Record<string, string> = {}
  if (user && events.length > 0) {
    const pairs = await Promise.all(
      events.map(async (e) => {
        const pre = REWARD_PRECONDITIONS[e.rewardType as RewardType]
        if (!pre) return [e.id, ""] as const
        return [e.id, (await pre(env, user.id)) ?? ""] as const
      })
    )
    for (const [eid, reason] of pairs) {
      if (reason) blocked[eid] = reason
    }
  }

  return json({
    events: events.map((e) => ({
      ...e,
      myClaim: claims[e.id] ?? null,
      claimCount: countMap[e.id] ?? 0,
      /** 不满足奖励前置条件时的原因（空 = 可正常领取）；仅登录用户有值 */
      claimBlockedReason: blocked[e.id] ?? null,
    })),
    now: nowIso,
  })
}

/**
 * GET /api/events/:id —— 单个活动（公开，未登录可读）。
 *
 * 用于活动分享链接 `/activity/:id`：分享出去后别人点开就能看到活动内容并参与。
 * draft / scheduled 一律 404 —— 没发布的草稿不该被链接泄露出去。
 * ended / archived 正常返回（点开看到「已结束」比 404 合理）。
 */
export async function getEvent(env: Env, request: Request, id: string): Promise<Response> {
  const row = await loadOne(env, id)
  if (row.status === "draft" || row.status === "scheduled") {
    throw new ApiError(404, "活动不存在", "NOT_FOUND")
  }
  const now = Date.now()
  const event = toEvent(row, now)

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM event_claims WHERE event_id = ?"
  )
    .bind(id)
    .first<{ c: number }>()

  const user = await optionalUser(env, request)
  let myClaim: { rewardStatus: string; rewardDetail: string | null } | null = null
  let claimBlockedReason: string | null = null
  if (user) {
    const c = await env.DB.prepare(
      "SELECT reward_status, reward_detail FROM event_claims WHERE event_id = ? AND user_id = ?"
    )
      .bind(id, user.id)
      .first<{ reward_status: string; reward_detail: string | null }>()
    myClaim = c ? { rewardStatus: c.reward_status, rewardDetail: c.reward_detail } : null
    if (!myClaim) {
      const pre = REWARD_PRECONDITIONS[row.reward_type as RewardType]
      if (pre) claimBlockedReason = await pre(env, user.id)
    }
  }

  return json({
    event: {
      ...event,
      myClaim,
      claimCount: count?.c ?? 0,
      claimBlockedReason,
    },
  })
}

/**
 * POST /api/events/:id/claim —— 参与活动并领取奖励。
 *
 * 顺序（每一步失败都有明确错误码，前端据此展示）：
 *   1. 活动存在且可参与（上线 / 已开始 / 未结束）
 *   2. 服务端校验参与条件
 *   3. 写领取记录（唯一索引即锁）
 *   4. 自动发放奖励，回写发放结果
 */
/**
 * GitHub star 活动：把用户名**规范化**（去 @、转小写）。
 * GitHub 用户名本身大小写不敏感，不归一化的话 Deity6 / deity6 能绕过唯一键。
 */
function normalizeGithubName(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase()
}

/** 预检结果：`ok` = 可用；`taken` = 名字被别的账号用了；`bound-other` = 本人已绑定过另一个名字 */
type GithubNameCheck = "ok" | "taken" | "bound-other"

/**
 * 领取前的**快速预检**（2026-10-01 修漏洞加；2026-10-04 升级为全局一次性）。
 *
 * 漏洞背景：原先只核验「填的 GitHub 用户名真的 star 过仓库」，没限制一个名字
 * 只能被领一次 —— star 名单是公开的，谁都能抄别人的名字，用多个站内账号反复领
 * （用户 deity6 实测刷成功后报告了这个洞）。
 *
 * ⚠️ 2026-10-04（站长要求）：占用口径从「**按活动**唯一」升级为「**全局唯一**」——
 *    一个 GitHub 用户名在全站只能被提交一次，跨活动也不能再用
 *    （见 migrations/0117 的全局唯一索引）。所以这里按名字查时**不再限定 event_id**。
 *
 * 预检发生在 event_claims 占位**之前**：名字已被占用时直接 403，
 * 不会白白消耗一次性领取机会 / 名额。真正的并发安全靠 lockGithubNameForEvent
 * 的唯一键，这里只是 UX 快路径 + 提示更友好。
 */
async function checkGithubNameForEvent(
  env: Env,
  eventId: string,
  githubInput: string,
  userId: string
): Promise<GithubNameCheck> {
  const who = normalizeGithubName(githubInput)
  // 全局查这个名字：任何一个活动里被谁用过，都算「已占用」
  const byName = await env.DB.prepare(
    "SELECT user_id FROM event_github_claims WHERE github_username = ?"
  )
    .bind(who)
    .first<{ user_id: string }>()
  if (byName && byName.user_id !== userId) return "taken"
  // 同一用户在本活动里已绑过**别的**名字 → 不许中途换名字
  const mine = await env.DB.prepare(
    "SELECT github_username FROM event_github_claims WHERE user_id = ? AND event_id = ?"
  )
    .bind(userId, eventId)
    .first<{ github_username: string }>()
  if (mine && mine.github_username !== who) return "bound-other"
  return "ok"
}

/**
 * 给「GitHub 用户名」上锁（authoritative，防并发的关键）。
 *
 * 返回 `ok` 以外的值时**必须拒绝发放**：
 *   - `taken`：这个名字已被另一个账号占用（全局，跨活动也算）；
 *   - `bound-other`：本人已在本活动里绑过别的名字（换名字重试，不给换）。
 *
 * 全局唯一由 `idx_event_github_username_global`（migrations/0117）保证：
 * 一旦某个 github_username 写过一行，任何活动、任何账号都无法再占用它。
 * `WHERE NOT EXISTS (... event_id = ? AND user_id = ?)` 另加一层「同一活动里
 * 每人只占一个名字」，防止已领过的人把别人的名字全占满。
 *
 * 幂等：同一用户用**同一个**名字重试（上次发放失败）会命中自己的行 → 返回 ok。
 */
async function lockGithubNameForEvent(
  env: Env,
  eventId: string,
  githubInput: string,
  userId: string
): Promise<GithubNameCheck> {
  const who = normalizeGithubName(githubInput)
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO event_github_claims (event_id, github_username, user_id, claimed_at)
     SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM event_github_claims WHERE event_id = ? AND user_id = ?)`
  )
    .bind(eventId, who, userId, new Date().toISOString(), eventId, userId)
    .run()
  if ((res.meta?.changes ?? 0) > 0) return "ok"
  // 没插进去：名字被别人占，或自己已绑过别的名字 —— 查清楚是哪种（按名字全局查）
  const holder = await env.DB.prepare(
    "SELECT user_id FROM event_github_claims WHERE github_username = ?"
  )
    .bind(who)
    .first<{ user_id: string }>()
  if (holder?.user_id === userId) return "ok" // 自己的名字重试（上次发放失败）
  return holder ? "taken" : "bound-other"
}

/** 把占用检查的结果翻译成对用户可操作的报错 */
function githubNameError(check: GithubNameCheck): ApiError | null {
  if (check === "taken") {
    return new ApiError(
      403,
      "这个 GitHub 用户名已被另一个账号用于领取本活动 —— 一个 GitHub 账号只能领一次。",
      "GITHUB_ALREADY_CLAIMED"
    )
  }
  if (check === "bound-other") {
    return new ApiError(
      403,
      "你在本活动已用过另一个 GitHub 用户名，不能更换。如认为有误请联系管理员。",
      "GITHUB_NAME_BOUND"
    )
  }
  return null
}

export async function claimEvent(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  // 防爆破：认证码活动本质是「凭口令领取」，不限流就能脚本穷举。
  // 10 次/分钟对正常用户足够（输错两次就该去看清楚活动说明了）。
  await guardRateLimit(env, `event-claim:${user.id}`, 10, 60, "操作过于频繁，请稍后再试")

  // 领取请求可携带认证码（POST body，可空）
  assertContentLengthWithin(request, 2 * 1024, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown
    github?: unknown
  }
  const codeInput = typeof body.code === "string" ? body.code.trim().slice(0, 64) : ""
  const githubInput = typeof body.github === "string" ? body.github.trim().slice(0, 64) : ""

  const row = await loadOne(env, id)
  const now = Date.now()

  const state = claimState(row, now)
  if (state === "offline") throw new ApiError(400, "活动已下线", "EVENT_OFFLINE")
  if (state === "not_started") throw new ApiError(400, "活动尚未开始", "NOT_STARTED")
  if (state === "ended") throw new ApiError(400, "活动已结束", "ENDED")

  // 抽奖活动已开奖：不能再报名 —— 报了也永远等不到开奖，等于骗用户白参与。
  // （活动本身可能还没到 ends_at，所以 claimState 仍是 open，必须单独拦。）
  if ((row.condition_type as ConditionType) === "lottery" && row.drawn_at) {
    throw new ApiError(400, "本活动已开奖", "LOTTERY_DRAWN")
  }

  // 认证码条件：先验码再走通用条件（不区分大小写，避免用户因大小写白白失败）
  if ((row.condition_type as ConditionType) === "code") {
    const expected = String((parseJson(row.condition_params) ?? {}).code ?? "")
    if (!expected) throw new ApiError(500, "活动认证码配置异常", "BAD_CONDITION")
    if (!codeInput || codeInput.toLowerCase() !== expected.toLowerCase()) {
      throw new ApiError(403, "认证码不正确，请核对后重试", "CODE_MISMATCH")
    }
  }

  // 参与条件（服务端校验，不信前端）
  const conditionType = row.condition_type as ConditionType
  const conditionHandler = CONDITION_HANDLERS[conditionType]
  if (!conditionHandler) throw new ApiError(500, "活动参与条件配置异常", "BAD_CONDITION")
  const conditionParams = (parseJson(row.condition_params) ?? {}) as Record<string, unknown>
  // GitHub star 条件单独核验一次，为的是把「查不了」和「确实没点」分开回报：
  // 笼统的「你还不满足参与条件」会让用户以为自己没点 star，去反复点、反复试。
  if (conditionType === "github_star") {
    const repo = String(conditionParams.repo ?? "").trim()
    if (!githubInput) throw new ApiError(400, "请先填写你的 GitHub 用户名", "GITHUB_REQUIRED")
    const check = await checkStarred(env, repo, githubInput)
    if (check.error) throw new ApiError(503, check.error, "GITHUB_CHECK_FAILED")
    if (!check.ok) {
      throw new ApiError(
        403,
        `没查到 ${githubInput} 给 ${repo} 点过 star。请核对用户名拼写；刚点的 star 最多 5 分钟后才会被识别到。`,
        "GITHUB_NOT_STARRED"
      )
    }
    // 修漏洞（2026-10-01）：star 名单是公开的，谁都可能冒用别人的 GitHub 用户名。
    // 预检放在占位之前 —— 名字已被占用时不会白白消耗一次性领取机会。
    const err = githubNameError(await checkGithubNameForEvent(env, id, githubInput, user.id))
    if (err) throw err
  }
  const ok = await conditionHandler(env, user.id, conditionParams, {
    code: codeInput,
    github: githubInput,
  })
  if (!ok) {
    // 带上「具体差什么」：笼统的「你还不满足参与条件」会让人反复试、
    // 最后跑来提反馈问（见 CONDITION_HINTS 的注释）
    const hint = CONDITION_HINTS[conditionType]
    throw new ApiError(
      403,
      hint ? `还不满足参与条件：${hint}` : "你还不满足参与条件",
      "CONDITION_FAILED"
    )
  }

  // 奖励前置条件（如中转站额度要求「已开通中转站」）：不满足直接拒绝，
  // 且**在占位之前**拦下 —— 否则一次性领取机会会被白白消耗掉。
  const precondition = REWARD_PRECONDITIONS[row.reward_type as RewardType]
  if (precondition) {
    const reason = await precondition(env, user.id)
    if (reason) throw new ApiError(403, reason, "REWARD_PRECONDITION_FAILED")
  }

  // 幂等占位 + 限量：唯一索引拦并发重复领取；max_claims 用 INSERT...SELECT 的
  // WHERE 子句实现「先到先得」—— 计数与插入在**同一条语句**里完成，
  // D1 的写是串行的，不会出现两个人同时判定「还剩最后一份」。
  const nowIso = new Date(now).toISOString()
  const limit = row.max_claims ?? null
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO event_claims
       (id, event_id, user_id, reward_type, reward_status, claimed_at)
     SELECT ?, ?, ?, ?, 'pending', ?
      WHERE ? IS NULL
         OR (SELECT COUNT(*) FROM event_claims WHERE event_id = ?) < ?`
  )
    .bind(uuid(), id, user.id, row.reward_type, nowIso, limit, id, limit)
    .run()

  const isNew = (ins.meta?.changes ?? 0) > 0
  if (!isNew) {
    // 没插进去只有两种可能：自己已经领过（撞唯一索引），或名额已满（WHERE 不成立）。
    // 必须查一次自己的记录来区分 —— 否则会把「已领过」误报成「名额已满」。
    const existing = await env.DB.prepare(
      "SELECT id, reward_status, reward_detail FROM event_claims WHERE event_id = ? AND user_id = ?"
    )
      .bind(id, user.id)
      .first<{ id: string; reward_status: string; reward_detail: string | null }>()
    if (!existing) {
      throw new ApiError(
        409,
        (row.condition_type as ConditionType) === "lottery" ? "参与人数已满" : "活动名额已满",
        "CLAIM_LIMIT_REACHED"
      )
    }
    if (existing.reward_status !== "failed") {
      // 重复领取：统一按**错误**返回（HTTP 409 + 标准错误体 {error, code}）。
      //
      // ⚠️ 2026-10-04 审计修复（#3）：原先是 `json({ status: existing.reward_status,
      //    detail }, 409)` —— 状态码是「冲突/失败」，body 里却带着 `status: "granted"`
      //    （已领取的旧状态），自相矛盾。而前端 `request()` 对任何非 2xx 一律抛
      //    HttpError，只认 body 的 `error` 字段；原 body 没有 `error`，于是前端只能
      //    显示笼统的「请求失败(409)」，真正的 detail（如「已获得 50 积分」）被丢掉。
      //    改用 ApiError 后：body 是 `{error, code}`，前端能显示真实原因。
      throw new ApiError(
        409,
        existing.reward_detail ?? "你已经参与过这个活动了。",
        "ALREADY_CLAIMED"
      )
    }
    // GitHub star 活动：发放前给用户名上锁（防并发窗口里的冒用；见 helper 注释）
    if ((row.condition_type as ConditionType) === "github_star" && githubInput) {
      const err = githubNameError(await lockGithubNameForEvent(env, id, githubInput, user.id))
      if (err) throw err
    }
    return grantAndRecord(env, existing.id, row, user.id, user.username)
  }

  const claimRow = await env.DB.prepare(
    "SELECT id FROM event_claims WHERE event_id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<{ id: string }>()
  if (!claimRow) throw new ApiError(500, "领取记录创建失败", "INTERNAL")

  // GitHub star 活动：发放前给用户名上锁。占用失败时**回滚刚占的领取名额**，
  // 不然用户为了一个被冒用的名字白丢一次机会（活动可能是限量的）。
  if ((row.condition_type as ConditionType) === "github_star" && githubInput) {
    const err = githubNameError(await lockGithubNameForEvent(env, id, githubInput, user.id))
    if (err) {
      await env.DB.prepare("DELETE FROM event_claims WHERE id = ? AND reward_status = 'pending'")
        .bind(claimRow.id)
        .run()
      throw err
    }
  }

  // 抽奖活动：这一步只是**报名**，不发奖 —— 开奖时由 drawEvent 从报名者里随机抽人。
  // 所以不调 grantAndRecord（那是「参与即发放」路径）。
  if ((row.condition_type as ConditionType) === "lottery") {
    await env.DB.prepare("UPDATE event_claims SET reward_detail = ? WHERE id = ?")
      .bind(LOTTERY_PENDING_DETAIL, claimRow.id)
      .run()
    return json({ status: "pending", detail: LOTTERY_PENDING_DETAIL })
  }

  return grantAndRecord(env, claimRow.id, row, user.id, user.username)
}

/** 跑奖励 handler 并把结果写回 claim；异常兜底成 failed（可重试），不让用户卡在 pending */
async function grantAndRecord(
  env: Env,
  claimId: string,
  row: EventRow,
  userId: string,
  username: string
): Promise<Response> {
  const rewardType = row.reward_type as RewardType
  const handler = REWARD_HANDLERS[rewardType]
  let result: { status: string; detail: string }

  if (!handler) {
    result = { status: "failed", detail: "活动奖励配置异常，请联系管理员。" }
  } else {
    try {
      result = await handler({
        env,
        userId,
        username,
        params: parseJson(row.reward_params) ?? {},
        eventId: row.id,
      })
    } catch (err) {
      console.error("活动奖励发放失败:", row.id, userId, err)
      // 把具体原因透传到 reward_detail：failed 可以重试，管理员在领取名单里
      // 也需要知道到底败在哪一步（NewAPI 401 / 网络超时 / 上游报错…），
      // 一句通用的「请稍后重试」查起来全靠猜。
      const msg = err instanceof Error ? err.message.slice(0, 120) : ""
      result = {
        status: "failed",
        detail: `奖励发放失败：${msg || "请稍后重试或联系管理员。"}`,
      }
    }
  }

  const granted = result.status === "granted"
  await env.DB.prepare(
    `UPDATE event_claims
        SET reward_status = ?, reward_detail = ?, granted_at = ?
      WHERE id = ?`
  )
    .bind(result.status, result.detail, granted ? new Date().toISOString() : null, claimId)
    .run()

  return json({ status: result.status, detail: result.detail })
}

// ---- 抽奖 ----

/** 报名成功、等待开奖时的状态文案（开奖前一直显示这句） */
const LOTTERY_PENDING_DETAIL = "已报名，等待开奖"
const LOTTERY_LOST_DETAIL = "很遗憾，本次没有中奖"

/** Fisher-Yates 洗牌（不改原数组） */
function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface DrawOutcome {
  /** 实际中奖人数（参与人数少于配置时按参与人数算） */
  winners: number
  /** 实际发出去的积分总数 */
  distributed: number
  /** 报名总人数 */
  participants: number
  /** 发放失败的份数（管理员可在领取名单里手动补） */
  failed: number
}

/**
 * 开奖：从报名者里随机抽人、按配置分积分。
 *
 * 幂等：靠 `UPDATE events SET drawn_at = ? WHERE id = ? AND drawn_at IS NULL` 的
 * changes 做锁 —— 手动点两次、或「手动开完又到点自动开」都只会真正开一次。
 *
 * 抽不满时按实际人数开（报名的 3 人、配置抽 10 人 ⇒ 3 人全中奖），
 * 而不是报错让管理员白等。
 *
 * 一个人发奖失败不影响其他人：那一条标 failed（可在领取名单手动补发），
 * 其余照发。最后一条 UPDATE 把仍是 pending 的都标成未中奖。
 */
export async function drawEvent(
  env: Env,
  eventId: string,
  operatorId: string | null
): Promise<DrawOutcome> {
  const row = await loadOne(env, eventId)
  if ((row.condition_type as ConditionType) !== "lottery") {
    throw new ApiError(400, "这个活动不是抽奖活动", "NOT_LOTTERY")
  }
  const cfg = parseLotteryConfig(parseJson(row.condition_params))
  if (!cfg) {
    throw new ApiError(500, "抽奖配置异常（中奖人数 / 奖池 / 分配方式）", "BAD_CONDITION")
  }

  // 先占开奖锁：抢不到说明已经开过（或正在开）
  const nowIso = new Date().toISOString()
  const lock = await env.DB.prepare(
    "UPDATE events SET drawn_at = ?, updated_at = ? WHERE id = ? AND drawn_at IS NULL"
  )
    .bind(nowIso, nowIso, eventId)
    .run()
  if (!(lock.meta?.changes ?? 0)) {
    throw new ApiError(409, "这个活动已经开过奖了", "ALREADY_DRAWN")
  }

  const claimRows = await env.DB.prepare(
    "SELECT id, user_id FROM event_claims WHERE event_id = ? ORDER BY claimed_at ASC"
  )
    .bind(eventId)
    .all<{ id: string; user_id: string }>()
  const participants = claimRows.results ?? []
  if (participants.length === 0) {
    // 没人报名就开奖没有意义：把锁退回去，让管理员等人多了再开
    await env.DB.prepare("UPDATE events SET drawn_at = NULL WHERE id = ?").bind(eventId).run()
    throw new ApiError(400, "还没有人参与，不能开奖", "NO_PARTICIPANTS")
  }

  const winnerCount = Math.min(cfg.winners, participants.length)
  const winners = shuffled(participants).slice(0, winnerCount)
  const shares = splitPool(cfg.pool, winnerCount, cfg.mode)

  const grantedAt = new Date().toISOString()
  let distributed = 0
  let failed = 0

  for (let i = 0; i < winners.length; i++) {
    const w = winners[i]
    const amount = shares[i]
    try {
      await applyPoints(env, {
        userId: w.user_id,
        delta: amount,
        reason: "event",
        detail: `活动抽奖中奖：${amount} 积分`,
        dedupKey: `event:${eventId}`,
      })
      await env.DB.prepare(
        `UPDATE event_claims
            SET reward_status = 'granted', reward_detail = ?, granted_at = ?, granted_by = ?
          WHERE id = ?`
      )
        .bind(`恭喜中奖，已获得 ${amount} 积分`, grantedAt, operatorId, w.id)
        .run()
      distributed += amount
    } catch (err) {
      console.error("抽奖发奖失败:", eventId, w.user_id, err)
      failed++
      const msg = err instanceof Error ? err.message.slice(0, 100) : ""
      await env.DB.prepare(
        "UPDATE event_claims SET reward_status = 'failed', reward_detail = ? WHERE id = ?"
      )
        .bind(`抽奖发奖失败（应得 ${amount} 积分）：${msg || "请手动补发"}`, w.id)
        .run()
    }
  }

  // 剩下的 pending = 没被抽中的
  await env.DB.prepare(
    "UPDATE event_claims SET reward_status = 'lost', reward_detail = ? WHERE event_id = ? AND reward_status = 'pending'"
  )
    .bind(LOTTERY_LOST_DETAIL, eventId)
    .run()

  await audit(
    env,
    operatorId,
    "event.draw",
    `活动「${row.title}」开奖：${participants.length} 人报名，抽中 ${winnerCount} 人，共发放 ${distributed} 积分` +
      (failed > 0 ? `（${failed} 份发放失败）` : "") +
      (operatorId ? "" : "（到点自动开奖）")
  )

  return { winners: winnerCount, distributed, participants: participants.length, failed }
}

/**
 * 到点自动开奖（cron 每分钟调）：活动已过 ends_at 但还没开奖的抽奖活动。
 *
 * 为什么要 ends_at IS NOT NULL：没设结束时间的抽奖活动「什么时候开」只有管理员说了算，
 * 不能一发布就自动开。
 *
 * 单次最多开 5 个：每个活动的中奖者要逐个 applyPoints（串行写 D1），一次开太多
 * 会让 cron 跑很久；没开完的下一次 tick 继续。
 */
export async function drawDueLotteries(env: Env): Promise<{ drawn: number; errors: number }> {
  const nowIso = new Date().toISOString()
  const rows = await env.DB.prepare(
    `SELECT id FROM events
      WHERE status = 'active' AND condition_type = 'lottery'
        AND drawn_at IS NULL AND ends_at IS NOT NULL AND ends_at < ?
      ORDER BY ends_at ASC LIMIT 5`
  )
    .bind(nowIso)
    .all<{ id: string }>()

  let drawn = 0
  let errors = 0
  for (const r of rows.results ?? []) {
    try {
      await drawEvent(env, r.id, null)
      drawn++
    } catch (err) {
      // 「还没人参与」是正常情况（到点了但没人报名），不算错误 —— 它会保持未开奖状态，
      // 管理员之后可以手动开或继续等人。其它错误才记。
      const code = err instanceof ApiError ? err.code : ""
      if (code !== "NO_PARTICIPANTS" && code !== "ALREADY_DRAWN") {
        console.error("自动开奖失败:", r.id, err)
        errors++
      }
    }
  }
  return { drawn, errors }
}

/** POST /api/admin/events/:id/draw —— 管理员手动开奖 */
export async function adminDrawEvent(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const outcome = await drawEvent(env, id, admin.id)
  return json({ ok: true, ...outcome })
}

// ---- 管理端 ----

export async function listAllEvents(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const now = Date.now()
  const rows = await env.DB.prepare(
    "SELECT * FROM events ORDER BY created_at DESC LIMIT 200"
  ).all<EventRow>()

  // 附每个活动的领取人数（一次 GROUP BY，避免 N+1）
  const counts = await env.DB.prepare(
    "SELECT event_id, COUNT(*) AS c FROM event_claims GROUP BY event_id"
  ).all<{ event_id: string; c: number }>()
  const countMap = Object.fromEntries((counts.results ?? []).map((r) => [r.event_id, r.c]))

  return json({
    events: (rows.results ?? []).map((r) => ({
      ...toEvent(r, now, true),
      claimCount: countMap[r.id] ?? 0,
    })),
  })
}

interface EventPayloadInput {
  title?: string
  body?: string
  status?: string
  startsAt?: string | null
  endsAt?: string | null
  /** 定时发布时间（ISO）；status = scheduled 时必填 */
  publishAt?: string | null
  /** 限量总份数；null / 空 = 不限量 */
  maxClaims?: number | null
  rewardLabel?: string | null
  rewardType?: string
  rewardParams?: unknown
  conditionType?: string
  conditionParams?: unknown
}

/** 归一化时间：空串 → null；非法 → 抛错（不静默丢弃，否则活动窗口会静默失效） */
function normalizeTime(v: string | null | undefined, field: string): string | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    throw new ApiError(400, `${field}格式不正确`, "INVALID_INPUT")
  }
  return new Date(v).toISOString()
}

/**
 * 归一化「状态 + 发布时间」，服务端说了算（不信前端）。
 *
 *   - scheduled 必须有未来发布时间；时间已到 → 直接算 active（立即上线）
 *   - active 但发布时间在未来 → 降级 scheduled（堵掉「active + 未到点」提前泄露）
 *   - 其它状态（draft / ended / archived）忽略发布时间
 */
function resolveEventStatus(
  rawStatus: string,
  publishAt: string | null
): { status: string; publishAt: string | null } {
  if (rawStatus === "scheduled") {
    if (!publishAt) throw new ApiError(400, "定时发布需要设置发布时间", "INVALID_INPUT")
    if (Date.parse(publishAt) <= Date.now()) return { status: "active", publishAt }
    return { status: "scheduled", publishAt }
  }
  if (rawStatus === "active") {
    if (publishAt && Date.parse(publishAt) > Date.now()) return { status: "scheduled", publishAt }
    return { status: "active", publishAt }
  }
  return { status: rawStatus, publishAt: null }
}

/** 限量总份数：空 → null（不限量）；非正整数 → 拒绝（静默回落会让「限量」形同虚设） */
function parseMaxClaims(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) {
    throw new ApiError(400, "限量份数必须是不小于 1 的整数", "INVALID_INPUT")
  }
  return Math.floor(n)
}

function serializeJson(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== "object") return null
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

export async function createEvent(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json()) as EventPayloadInput

  const title = (body.title ?? "").trim().slice(0, 100)
  const text = (body.body ?? "").trim().slice(0, 4000)
  if (!title || !text) throw new ApiError(400, "标题和正文不能为空", "INVALID_INPUT")

  const rawStatus =
    typeof body.status === "string" && (EVENT_STATUSES as readonly string[]).includes(body.status)
      ? body.status
      : "draft"
  const { status, publishAt } = resolveEventStatus(
    rawStatus,
    normalizeTime(body.publishAt, "发布时间")
  )
  const maxClaims = parseMaxClaims(body.maxClaims)
  const rewardType =
    typeof body.rewardType === "string" && isRewardType(body.rewardType) ? body.rewardType : "none"
  const conditionType =
    typeof body.conditionType === "string" && isConditionType(body.conditionType)
      ? body.conditionType
      : "always"
  // 认证码条件必须配非空码：存了空码 = 任何人都领得到，还多一道假输入框
  if (conditionType === "code") {
    const p = body.conditionParams as { code?: unknown } | null | undefined
    const code = typeof p?.code === "string" ? p.code.trim() : ""
    if (!code) throw new ApiError(400, "认证码条件必须填写认证码", "INVALID_INPUT")
  }
  // 抽奖：参数必须合法（中奖人数 / 奖池 / 分配方式），且奖励类型固定为积分 ——
  // 抽奖发的就是积分，配成别的会让「开奖」行为与配置自相矛盾。
  if (conditionType === "lottery") {
    if (!parseLotteryConfig(body.conditionParams as Record<string, unknown> | null)) {
      throw new ApiError(
        400,
        "抽奖参数不合法：中奖人数至少 1（上限 200）、奖池积分不少于中奖人数、分配方式为平均或随机",
        "INVALID_INPUT"
      )
    }
    if (rewardType !== "points") {
      throw new ApiError(400, "抽奖活动的奖励类型必须是「积分」", "INVALID_INPUT")
    }
  }
  // 积分奖励的数额配置（固定值 / 区间随机）必须**写入时**就校验：
  // 非法配置若留到发放端才暴露，用户只会看到一条「领取失败」且查不出原因。
  if (rewardType === "points") {
    const bad = validatePointsReward(body.rewardParams)
    if (bad) throw new ApiError(400, bad, "INVALID_INPUT")
  }
  // GitHub star 条件的仓库地址必须当场填对：填错了是「全体用户都核验失败」，
  // 而失败提示看起来像用户的错，极难排查。
  if (conditionType === "github_star") {
    const bad = validateGithubStarCondition(body.conditionParams)
    if (bad) throw new ApiError(400, bad, "INVALID_INPUT")
  }

  const startsAt = normalizeTime(body.startsAt, "开始时间")
  const endsAt = normalizeTime(body.endsAt, "结束时间")
  if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
    throw new ApiError(400, "结束时间不能早于开始时间", "INVALID_INPUT")
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO events
       (id, title, body, status, starts_at, ends_at, publish_at, published_at, max_claims,
        reward_label, reward_type, reward_params, condition_type, condition_params,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      title,
      text,
      status,
      startsAt,
      endsAt,
      publishAt,
      status === "active" ? now : null,
      maxClaims,
      (body.rewardLabel ?? "").trim().slice(0, 200) || null,
      rewardType,
      serializeJson(body.rewardParams),
      conditionType,
      serializeJson(body.conditionParams),
      admin.id,
      now,
      now
    )
    .run()

  // 直接以「已上线」创建时广播（dedup 保证重复不翻倍）；
  // scheduled 交给 cron 到点调 activateScheduledEvent。
  let inserted = 0
  if (status === "active") {
    inserted = await broadcastEvent(env, id, title, text)
  }

  await audit(
    env,
    admin.id,
    "event.create",
    `创建活动「${title}」（${status}${status === "scheduled" ? ` · ${publishAt}` : ""}）`
  )
  return json({ event: toEvent(await loadOne(env, id), Date.now(), true), inserted }, 201)
}

export async function updateEvent(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const existing = await loadOne(env, id)
  const body = (await request.json()) as EventPayloadInput

  const title =
    body.title !== undefined ? (body.title as string).trim().slice(0, 100) : existing.title
  const text =
    body.body !== undefined ? (body.body as string).trim().slice(0, 4000) : existing.body
  if (!title || !text) throw new ApiError(400, "标题和正文不能为空", "INVALID_INPUT")

  const rawStatus =
    typeof body.status === "string" && (EVENT_STATUSES as readonly string[]).includes(body.status)
      ? body.status
      : existing.status
  // 状态/发布时间：没传就沿用旧值，一并交给 resolveEventStatus 归一化
  const { status, publishAt } = resolveEventStatus(
    rawStatus,
    body.publishAt !== undefined
      ? normalizeTime(body.publishAt, "发布时间")
      : existing.publish_at
  )
  const maxClaims =
    body.maxClaims !== undefined ? parseMaxClaims(body.maxClaims) : existing.max_claims
  const rewardType =
    typeof body.rewardType === "string" && isRewardType(body.rewardType)
      ? body.rewardType
      : existing.reward_type
  const conditionType =
    typeof body.conditionType === "string" && isConditionType(body.conditionType)
      ? body.conditionType
      : existing.condition_type
  // 认证码条件必须配非空码（update 时若带了新的 conditionParams 就校验新的；
  // 没带则沿用旧值，旧值当初创建时已校验过非空）
  if (conditionType === "code" && body.conditionParams !== undefined) {
    const p = body.conditionParams as { code?: unknown } | null
    const code = typeof p?.code === "string" ? p.code.trim() : ""
    if (!code) throw new ApiError(400, "认证码条件必须填写认证码", "INVALID_INPUT")
  }
  // 抽奖：参数（新的或沿用的）必须合法，奖励类型必须是积分（理由同 createEvent）
  if (conditionType === "lottery") {
    const params =
      body.conditionParams !== undefined
        ? (body.conditionParams as Record<string, unknown> | null)
        : (parseJson(existing.condition_params) as Record<string, unknown> | null)
    if (!parseLotteryConfig(params)) {
      throw new ApiError(
        400,
        "抽奖参数不合法：中奖人数至少 1（上限 200）、奖池积分不少于中奖人数、分配方式为平均或随机",
        "INVALID_INPUT"
      )
    }
    if (rewardType !== "points") {
      throw new ApiError(400, "抽奖活动的奖励类型必须是「积分」", "INVALID_INPUT")
    }
  }
  // 积分奖励的数额配置同样要校验：body 没带 rewardParams 时沿用库里那份
  // （旧配置当初已校验过，这里重校验一遍也无害）。
  if (rewardType === "points") {
    const resolved =
      body.rewardParams !== undefined ? body.rewardParams : parseJson(existing.reward_params)
    const bad = validatePointsReward(resolved)
    if (bad) throw new ApiError(400, bad, "INVALID_INPUT")
  }
  if (conditionType === "github_star") {
    const resolved =
      body.conditionParams !== undefined
        ? body.conditionParams
        : parseJson(existing.condition_params)
    const bad = validateGithubStarCondition(resolved)
    if (bad) throw new ApiError(400, bad, "INVALID_INPUT")
  }

  const startsAt =
    body.startsAt !== undefined ? normalizeTime(body.startsAt, "开始时间") : existing.starts_at
  const endsAt = body.endsAt !== undefined ? normalizeTime(body.endsAt, "结束时间") : existing.ends_at
  if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
    throw new ApiError(400, "结束时间不能早于开始时间", "INVALID_INPUT")
  }

  const nowIso = new Date().toISOString()
  // 保持 active 时沿用原 published_at（避免重复广播）；转到其它状态一律清空，
  // 之后若再被 cron 激活会重新落时间。
  const publishedAt = status === "active" ? existing.published_at ?? nowIso : null

  await env.DB.prepare(
    `UPDATE events
        SET title = ?, body = ?, status = ?, starts_at = ?, ends_at = ?,
            publish_at = ?, published_at = ?, max_claims = ?, reward_label = ?,
            reward_type = ?, reward_params = ?, condition_type = ?, condition_params = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(
      title,
      text,
      status,
      startsAt,
      endsAt,
      publishAt,
      publishedAt,
      maxClaims,
      body.rewardLabel !== undefined
        ? (body.rewardLabel ?? "").toString().trim().slice(0, 200) || null
        : existing.reward_label,
      rewardType,
      body.rewardParams !== undefined
        ? serializeJson(body.rewardParams)
        : existing.reward_params,
      conditionType,
      body.conditionParams !== undefined
        ? serializeJson(body.conditionParams)
        : existing.condition_params,
      nowIso,
      id
    )
    .run()

  // 从「非 active」变成 active 时广播一次；dedup_key 保证不会重复投递
  let inserted = 0
  if (existing.status !== "active" && status === "active") {
    inserted = await broadcastEvent(env, id, title, text)
  }

  await audit(env, admin.id, "event.update", `更新活动「${title}」（${status}）`)
  return json({ event: toEvent(await loadOne(env, id), Date.now(), true), inserted })
}

export async function deleteEvent(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const existing = await loadOne(env, id)
  await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run()
  await audit(env, admin.id, "event.delete", `删除活动「${existing.title}」`)
  return json({ ok: true })
}

/** GET /api/admin/events/:id/claims —— 领取名单（人工发放用） */
export async function listEventClaims(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  await loadOne(env, id)
  const rows = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.reward_type, c.reward_status, c.reward_detail,
            c.claimed_at, c.granted_at, u.username, u.nickname
       FROM event_claims c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.event_id = ?
      ORDER BY c.claimed_at DESC LIMIT 500`
  )
    .bind(id)
    .all<Record<string, unknown>>()

  return json({
    claims: (rows.results ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      nickname: r.nickname,
      rewardType: r.reward_type,
      rewardStatus: r.reward_status,
      rewardDetail: r.reward_detail,
      claimedAt: r.claimed_at,
      grantedAt: r.granted_at,
    })),
  })
}

/** POST /api/admin/events/:id/claims/:claimId/grant —— 标记人工发放完成 */
export async function grantEventClaim(
  env: Env,
  request: Request,
  id: string,
  claimId: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  await loadOne(env, id)
  const body = (await request.json().catch(() => ({}))) as { detail?: string }
  const detail = (body.detail ?? "").trim().slice(0, 300)

  // 抽奖未中奖（lost）不是「待发放」，不能手动标记为已发放
  const claim = await env.DB.prepare(
    "SELECT reward_status FROM event_claims WHERE id = ? AND event_id = ?"
  )
    .bind(claimId, id)
    .first<{ reward_status: string }>()
  if (!claim) throw new ApiError(404, "领取记录不存在", "NOT_FOUND")
  if (claim.reward_status === "lost") {
    throw new ApiError(400, "这条是抽奖未中奖的记录，不能标记为已发放", "LOTTERY_LOST")
  }

  const res = await env.DB.prepare(
    `UPDATE event_claims
        SET reward_status = 'granted', reward_detail = ?, granted_at = ?, granted_by = ?
      WHERE id = ? AND event_id = ?`
  )
    .bind(
      detail || "管理员已手动发放",
      new Date().toISOString(),
      admin.id,
      claimId,
      id
    )
    .run()
  if ((res.meta?.changes ?? 0) === 0) throw new ApiError(404, "领取记录不存在", "NOT_FOUND")

  await audit(env, admin.id, "event.grant", `手动发放活动奖励 claim=${claimId}`)
  return json({ ok: true })
}

/** 活动广播到消息中心（失败不阻断活动本身已落库） */
async function broadcastEvent(
  env: Env,
  id: string,
  title: string,
  body: string
): Promise<number> {
  try {
    return await broadcastMessage(
      env,
      {
        category: "event",
        type: "event",
        title,
        body,
        link: "/dashboard/messages/event",
        payload: { eventId: id },
      },
      { dedupKey: `evt:${id}` }
    )
  } catch (err) {
    console.error("活动消息广播失败:", id, err)
    return 0
  }
}

/**
 * 把一条「定时」活动真正上线：status scheduled → active，并广播到消息中心。
 *
 * 幂等：判定条件写进 UPDATE 的 WHERE（`status = 'scheduled'`），所以 cron 每分钟
 * 重复扫到、或和管理员手动上线撞上，都只有一条路径真正执行（广播另有 evt:<id> dedup）。
 * 由 scheduled-publish.ts 的 processScheduledPublishes 调用。
 */
export async function activateScheduledEvent(env: Env, id: string): Promise<number> {
  const row = await loadOne(env, id)
  if (row.status !== "scheduled") return 0
  const nowIso = new Date().toISOString()
  const res = await env.DB.prepare(
    `UPDATE events SET status = 'active', published_at = ?, updated_at = ?
      WHERE id = ? AND status = 'scheduled'`
  )
    .bind(nowIso, nowIso, id)
    .run()
  if ((res.meta?.changes ?? 0) === 0) return 0 // 已被别的路径上线
  return broadcastEvent(env, id, row.title, row.body)
}

/**
 * 可选登录：有 session 就返回用户，没有就返回 null（不抛 401）。
 * 活动列表允许游客看，但游客拿不到 myClaim。
 */
async function optionalUser(env: Env, request: Request) {
  try {
    return await requireUser(env, request)
  } catch {
    return null
  }
}
