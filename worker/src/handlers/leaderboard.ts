/**
 * 排行榜。
 *
 * 四个榜（`board`）：
 *   · `newapi`      —— 中转站调用次数（**只有累计**：本地没有按天的调用日志，
 *                      按天的数据在 NewAPI 那台服务器的 logs 表里）
 *   · `community`   —— 社区广场互动量，按 `metric` 分 发帖数 / 点赞数 / 回复数
 *   · `feedback`    —— 反馈数量
 *   · `achievement` —— 成就点（**只有累计**：它是「已解锁等级」的荣誉值，天然是累计的）
 *
 * 时间范围（`range`）：`all`（历史累计）/ `today`（今日）/ `week`（本周）/ `month`（本月）。
 *   · 社区与反馈的每条记录都有 `created_at`，四个范围都能实时算；
 *   · newapi 与 achievement 没有「当日增量」这个口径，只支持 `all`，
 *     请求别的范围会回落到 `all` 并在响应里如实标注 `ranges`。
 *   · 边界按**中国时区（UTC+8）**算 —— 不然「今日」会按 UTC 零点切，对国内用户错开 8 小时。
 *
 * ---------------------------------------------------------------------------
 * 两个容易做错的地方
 * ---------------------------------------------------------------------------
 * 1. **成就点是不落库的**（见 handlers/achievements.ts）：每次实时算。
 *    绝不能读 `user_achievements` 的行数 —— 那张表只在用户打开过成就页时才写，
 *    1151 个用户里只有 179 个有行，拿它排行会让绝大多数人的点数显示成 0。
 *    正解是 `loadAllUserCounts()` + 同一个 `computeAchievements()`。
 *
 * 2. **口径写死在一处**。社区榜的计数与成就页用同一批表同一列，别另立口径。
 *
 * 所有榜都只统计 `users.status = 'active'`。
 */
import { json, ApiError } from "../http"
import { requireUser } from "../auth"
import { achievementPointsOf, loadAllUserCounts } from "./achievements"
import { siteOffsetHours } from "../settings"
import type { Env } from "../env"

/** 榜单长度。50 足够，再长没人翻；也避免把响应做大。 */
const TOP_N = 50

export type LeaderboardBoard =
  | "newapi"
  | "community"
  | "feedback"
  | "achievement"
  /** 当前积分余额（只有「全部」一种口径 —— 余额是个当前状态，按时间切没有意义） */
  | "points_balance"
  /** 累计获得的积分（按时间可切；只累计正数流水，扣减/兑换不算） */
  | "points_earned"
export type CommunityMetric = "posts" | "likes" | "comments"
export type LeaderboardRange = "all" | "today" | "week" | "month"

const BOARDS: readonly LeaderboardBoard[] = [
  "newapi",
  "community",
  "feedback",
  "achievement",
  "points_balance",
  "points_earned",
]
const COMMUNITY_METRICS: readonly CommunityMetric[] = ["posts", "likes", "comments"]
const RANGES: readonly LeaderboardRange[] = ["all", "today", "week", "month"]

/** 每个榜支持哪些时间范围（newapi/achievement 只有累计） */
function supportedRanges(board: LeaderboardBoard): readonly LeaderboardRange[] {
  switch (board) {
    case "community":
    case "feedback":
    // 累计获得：按时间切才有意义（「本月谁赚得最多」）
    case "points_earned":
      return RANGES
    default:
      // 其余（含 points_balance）只有累计口径 —— 余额是个当前状态，按时间切没意义
      return ["all"]
  }
}

/**
 * 时间范围的**起始时刻**（ISO 字符串，UTC），`null` = 不设下限（历史累计）。
 *
 * ⚠️ 必须按中国时区（UTC+8）切：Worker 跑在 UTC，直接 `date('now')` 会把「今日」
 * 按 UTC 零点切，对国内用户错开 8 小时。做法：把当前时刻 +8h 当「中国墙钟」，
 * 在墙上取日/周/月的零点，再 -8h 还原成 UTC 时间戳。
 */
function rangeStart(range: LeaderboardRange, offsetHours: number): string | null {
  if (range === "all") return null
  const c = new Date(Date.now() + offsetHours * 3600_000)
  if (range === "today") {
    c.setHours(0, 0, 0, 0)
  } else if (range === "week") {
    // 周一为一周之始
    const daysSinceMonday = (c.getDay() + 6) % 7
    c.setDate(c.getDate() - daysSinceMonday)
    c.setHours(0, 0, 0, 0)
  } else {
    // month
    c.setDate(1)
    c.setHours(0, 0, 0, 0)
  }
  return new Date(c.getTime() - offsetHours * 3600_000).toISOString()
}

/** 榜上的一行 */
interface LeaderRow {
  uid: string
  username: string
  nickname: string | null
  avatar_key: string | null
  score: number
}

/** 打分子查询 + 它的绑定参数 */
interface ScoreSource {
  sql: string
  params: unknown[]
}

/**
 * 「打分子查询」：产出 `(user_id, score)` 两列的 SQL 片段与参数。
 * 统一成同一个形状，上层的取 TOP N 与「我排第几」就能共用同一段 SQL。
 */
function scoreSource(
  board: LeaderboardBoard,
  metric: CommunityMetric,
  range: LeaderboardRange,
  offsetHours: number
): ScoreSource {
  const since = rangeStart(range, offsetHours)

  switch (board) {
    case "newapi":
      // `request_count` 是**累计**值，且由站点在用户打开中转站页面 / 同步时回写，
      // 不是每次调用实时更新 —— 本地没有按天的调用记录，所以只有累计这一种口径。
      return {
        sql: `SELECT na.user_id AS user_id, na.request_count AS score
                FROM newapi_accounts na
                JOIN users u ON u.id = na.user_id
               WHERE u.status = 'active' AND na.request_count > 0`,
        params: [],
      }

    case "community": {
      const t = since ? [since] : []
      if (metric === "posts") {
        return {
          sql: `SELECT p.user_id AS user_id, COUNT(*) AS score
                  FROM posts p
                  JOIN users u ON u.id = p.user_id
                 WHERE u.status = 'active' AND p.deleted_at IS NULL ${
                   since ? "AND p.created_at >= ?" : ""
                 }
                 GROUP BY p.user_id`,
          params: t,
        }
      }
      if (metric === "comments") {
        return {
          sql: `SELECT c.user_id AS user_id, COUNT(*) AS score
                  FROM post_comments c
                  JOIN users u ON u.id = c.user_id
                 WHERE u.status = 'active' AND c.deleted_at IS NULL ${
                   since ? "AND c.created_at >= ?" : ""
                 }
                 GROUP BY c.user_id`,
          params: t,
        }
      }
      // 「点赞数」= 用户在广场**点出去**的赞，而不是收到的赞 ——
      // 榜名叫「互动量」，发帖/回复/点赞三项都该是「你自己的行为」才自洽。
      return {
        sql: `SELECT l.user_id AS user_id, COUNT(*) AS score
                FROM post_likes l
                JOIN users u ON u.id = l.user_id
               WHERE u.status = 'active' ${since ? "AND l.created_at >= ?" : ""}
               GROUP BY l.user_id`,
        params: t,
      }
    }

    case "feedback": {
      const time = since ? "AND f.created_at >= ?" : ""
      return {
        sql: `SELECT f.user_id AS user_id, COUNT(*) AS score
                FROM feedback f
                JOIN users u ON u.id = f.user_id
               WHERE u.status = 'active' ${time}
               GROUP BY f.user_id`,
        params: since ? [since] : [],
      }
    }

    case "achievement":
      // 不走 SQL 聚合：成就点由 JS 实时算（见文件头说明）
      return { sql: "", params: [] }

    case "points_balance":
      /**
       * 当前积分余额。
       *
       * 只算 `balance > 0` 的人：余额为 0 或负数的（理论上不该有负数）排上去没意义，
       * 还会把榜撑长。注意余额是**状态**不是**成就**，所以这个榜只有「全部」一种口径
       * —— 见 supportedRanges。
       */
      return {
        sql: `SELECT up.user_id AS user_id, up.balance AS score
                FROM user_points up
                JOIN users u ON u.id = up.user_id
               WHERE u.status = 'active' AND up.balance > 0`,
        params: [],
      }

    case "points_earned": {
      /**
       * 累计**获得**的积分（按所选时间范围）。
       *
       * ⚠️ 只累加 `delta > 0`：这是「赚了多少」的榜，扣减与兑换（delta < 0）
       * 不该把人的历史成绩抹掉。所以它与「当前余额」榜会明显不同 ——
       * 有人赚得多但花光了，余额榜上看不见，累计榜上仍然靠前，这正是两个榜并存的意义。
       */
      const t = since ? [since] : []
      return {
        sql: `SELECT pt.user_id AS user_id, SUM(pt.delta) AS score
                FROM point_transactions pt
                JOIN users u ON u.id = pt.user_id
               WHERE u.status = 'active' AND pt.delta > 0 ${
                 since ? "AND pt.created_at >= ?" : ""
               }
               GROUP BY pt.user_id`,
        params: t,
      }
    }
  }
}

/** 按 SQL 打分源取 TOP N + 我的名次 */
async function rankBySql(
  env: Env,
  source: ScoreSource,
  meId: string
): Promise<{ rows: LeaderRow[]; me: { score: number; rank: number } | null }> {
  const top = await env.DB.prepare(
    `WITH s AS (${source.sql})
     SELECT u.id AS uid, u.username AS username, u.nickname AS nickname,
            u.avatar_key AS avatar_key, s.score AS score
       FROM s JOIN users u ON u.id = s.user_id
      ORDER BY s.score DESC, u.username ASC
      LIMIT ${TOP_N}`
  )
    .bind(...source.params)
    .all<LeaderRow>()

  const mine = await env.DB.prepare(
    `WITH s AS (${source.sql})
     SELECT COALESCE((SELECT score FROM s WHERE user_id = ?), 0) AS score,
            (SELECT COUNT(*) FROM s WHERE score > COALESCE((SELECT score FROM s WHERE user_id = ?), 0)) AS ahead`
  )
    .bind(...source.params, meId, meId)
    .first<{ score: number; ahead: number }>()

  const meScore = Number(mine?.score ?? 0)
  return {
    rows: top.results ?? [],
    me: meScore > 0 ? { score: meScore, rank: Number(mine?.ahead ?? 0) + 1 } : null,
  }
}

/**
 * 标准竞赛排名（1,2,2,4）：同分并列，下一名跳号。
 */
function withRanks(rows: { score: number }[]): number[] {
  const ranks: number[] = []
  let prevScore: number | null = null
  let prevRank = 0
  rows.forEach((r, i) => {
    const rank = prevScore !== null && r.score === prevScore ? prevRank : i + 1
    ranks.push(rank)
    prevScore = r.score
    prevRank = rank
  })
  return ranks
}

/**
 * GET /api/leaderboard?board=xxx&metric=yyy&range=zzz
 */
export async function getLeaderboard(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)

  const board = (url.searchParams.get("board") ?? "newapi") as LeaderboardBoard
  if (!BOARDS.includes(board)) {
    throw new ApiError(400, "未知的榜单", "INVALID_INPUT")
  }
  const rawMetric = (url.searchParams.get("metric") ?? "posts") as CommunityMetric
  const metric: CommunityMetric = COMMUNITY_METRICS.includes(rawMetric) ? rawMetric : "posts"

  const supports = supportedRanges(board)
  const rawRange = (url.searchParams.get("range") ?? "all") as LeaderboardRange
  const range: LeaderboardRange = supports.includes(rawRange) ? rawRange : "all"

  let rows: LeaderRow[] = []
  let me: { score: number; rank: number } | null = null

  if (board === "achievement") {
    const counts = await loadAllUserCounts(env)
    /**
     * 历史最高等级（成就「只升不降」）—— 必须与成就页同口径，
     * 否则同一用户在两个页面看到的点数不一样。
     *
     * 一次全表 GROUP BY 读出来即可：`user_achievements` 只在用户**打开过成就页**
     * 时才写，1151 个用户里只有一百多行用户有记录，量很小。
     * ⚠️ 但绝不能拿它的**行数**当分数（原因见文件顶部第 1 条说明）。
     */
    const histRows = await env.DB.prepare(
      "SELECT user_id, achievement_id, MAX(level) AS lv FROM user_achievements GROUP BY user_id, achievement_id"
    ).all<{ user_id: string; achievement_id: string; lv: number }>()
    const histByUser = new Map<string, Map<string, number>>()
    for (const r of histRows.results ?? []) {
      if (!histByUser.has(r.user_id)) histByUser.set(r.user_id, new Map())
      histByUser.get(r.user_id)!.set(r.achievement_id, r.lv)
    }

    const scored = counts
      .map((c) => ({
        uid: c.uid,
        username: c.username,
        nickname: c.nickname,
        avatar_key: c.avatar_key,
        score: achievementPointsOf(c, histByUser.get(c.uid) ?? new Map()),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))

    rows = scored.slice(0, TOP_N)
    const ranks = withRanks(scored)
    const myIdx = scored.findIndex((r) => r.uid === user.id)
    if (myIdx >= 0) me = { score: scored[myIdx].score, rank: ranks[myIdx] }
  } else {
    const r = await rankBySql(env, scoreSource(board, metric, range, await siteOffsetHours(env)), user.id)
    rows = r.rows
    me = r.me
  }

  const ranks = withRanks(rows)
  return json({
    board,
    metric: board === "community" ? metric : null,
    /** 实际生效的时间范围（请求了不支持的会回落到 all） */
    range,
    /** 这个榜支持哪些范围，前端据此禁用不支持的按钮 */
    ranges: supports,
    items: rows.map((r, i) => ({
      rank: ranks[i],
      username: r.username,
      nickname: r.nickname,
      hasAvatar: Boolean(r.avatar_key),
      score: Number(r.score ?? 0),
      isMe: r.uid === user.id,
    })),
    me,
    topN: TOP_N,
  })
}
