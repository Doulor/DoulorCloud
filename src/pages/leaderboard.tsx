import * as React from "react"
import { Link } from "react-router-dom"
import {
  ArrowLeft,
  Award,
  Heart,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Sparkles,
  TrendingUp,
  Trophy,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { NavItem, NavGroup } from "@/components/sub-nav"
import { UserAvatar } from "@/components/user-avatar"
import { Card, CardContent } from "@/components/ui/card"
import { useT } from "@/i18n"
import { leaderboardApi, HttpError } from "@/services/api"
import { cn } from "@/lib/utils"
import type { CommunityMetric, LeaderboardBoard, LeaderboardRange, LeaderboardResponse } from "@/types"

/** 社区榜的三个子项（顺序即展示顺序） */
const COMMUNITY_METRICS: CommunityMetric[] = ["posts", "likes", "comments"]

/** 时间范围（顺序即展示顺序） */
const RANGES: LeaderboardRange[] = ["all", "today", "week", "month"]

/**
 * 每个榜的「成绩单位」文案。
 *
 * 单独拎出来是因为数字旁边必须说清楚「42 是什么」——光给数字，
 * 「42 次调用」和「42 个赞」看起来一样，榜就没有意义了。
 */
const UNIT_KEY: Record<LeaderboardBoard, string> = {
  newapi: "lb.unit.newapi",
  community: "lb.unit.community",
  feedback: "lb.unit.feedback",
  achievement: "lb.unit.achievement",
  points_balance: "lb.unit.points_balance",
  points_earned: "lb.unit.points_earned",
}

/**
 * 排行榜。
 *
 * 四个榜 + 社区榜下的三个子项。左侧是二级导航（与「管理」「捐献」同一套交互：
 * 受控 state，不改 URL 路由 —— 刷新回到默认项是可接受的）。
 *
 * ⚠️ 数据都是**实时**统计的，没有缓存表。成就点由全站计数现场推算
 * （见 worker/src/handlers/leaderboard.ts 的说明），所以这里不需要「刷新」按钮 ——
 * 切栏目就会重新拉一次。
 */
export default function LeaderboardPage() {
  const { t } = useT()

  const [board, setBoard] = React.useState<LeaderboardBoard>("newapi")
  const [metric, setMetric] = React.useState<CommunityMetric>("posts")
  const [range, setRange] = React.useState<LeaderboardRange>("all")
  const [data, setData] = React.useState<LeaderboardResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  /** 切榜：newapi / 成就点只有累计，切过去必须把范围重置回「历史」 */
  const switchBoard = (b: LeaderboardBoard) => {
    setBoard(b)
    setRange("all")
  }

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    leaderboardApi
      .get(board, board === "community" ? metric : undefined, range)
      .then((res) => {
        if (alive) {
          setData(res)
          // 请求了后端不支持的范围会回落 all，前端跟随后端，别显示一个没生效的按钮
          setRange(res.range)
        }
      })
      .catch((err) => {
        if (!alive) return
        toast.error(err instanceof HttpError ? err.message : t("lb.err.load"))
        setData(null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // t 是稳定引用，不放进依赖以免每次渲染都重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, metric, range])

  /** 成绩单位：社区榜三项单位不同，其余按榜取 */
  const unitKey = board === "community" ? `lb.unit.${metric}` : UNIT_KEY[board]
  // 社区榜自己带一个「子项」说明，别用通用的那句
  const noteKey = board === "community" ? `lb.note.community.${metric}` : `lb.note.${board}`

  const items = data?.items ?? []

  return (
    <div>
      <PageHeader title={t("lb.title")} description={t("lb.subtitle")} />

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* 左侧二级导航 */}
        <aside className="w-full shrink-0 lg:w-48">
          <Link
            to="/dashboard"
            className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("space.backToConsole")}
          </Link>
          <nav className="flex flex-col gap-0.5">
            <NavItem
              active={board === "newapi"}
              icon={Sparkles}
              label={t("lb.board.newapi")}
              onClick={() => switchBoard("newapi")}
            />
            <NavItem
              active={board === "achievement"}
              icon={Trophy}
              label={t("lb.board.achievement")}
              onClick={() => switchBoard("achievement")}
            />
            <NavItem
              active={board === "feedback"}
              icon={MessageSquare}
              label={t("lb.board.feedback")}
              onClick={() => switchBoard("feedback")}
            />
            {/* 积分榜：两个口径收在一组 —— 「余额」看现在有多少，「累计获得」看一共赚过多少。
                两者会明显不同（有人赚得多但花光了），分开列才不至于互相误解 */}
            <NavGroup label={t("lb.board.points")}>
              <NavItem
                active={board === "points_balance"}
                icon={Wallet}
                label={t("lb.metric.balance")}
                onClick={() => switchBoard("points_balance")}
              />
              <NavItem
                active={board === "points_earned"}
                icon={TrendingUp}
                label={t("lb.metric.earned")}
                onClick={() => switchBoard("points_earned")}
              />
            </NavGroup>
            {/* 社区广场互动量：三个子项收在同一组里，避免四个榜平铺 + 三个子项一起铺开 */}
            <NavGroup label={t("lb.board.community")}>
              {COMMUNITY_METRICS.map((m) => (
                <NavItem
                  key={m}
                  active={board === "community" && metric === m}
                  icon={m === "posts" ? MessagesSquare : m === "likes" ? Heart : MessageSquare}
                  label={t(`lb.metric.${m}`)}
                  onClick={() => {
                    setBoard("community")
                    setMetric(m)
                  }}
                />
              ))}
            </NavGroup>
          </nav>
        </aside>

        {/* 右侧内容 */}
        <div className="min-w-0 flex-1">
          {/* 时间范围切换：只有当前榜支持的按钮才可用（newapi/成就点只有「历史」） */}
          <div className="mb-3 flex flex-wrap items-center gap-1">
            {RANGES.map((r) => {
              const supported = data?.ranges?.includes(r)
              const active = range === r
              return (
                <button
                  key={r}
                  type="button"
                  disabled={!supported}
                  onClick={() => setRange(r)}
                  className={
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors " +
                    (active
                      ? "border-transparent bg-primary text-primary-foreground"
                      : supported
                        ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                        : "cursor-not-allowed text-muted-foreground/40")
                  }
                >
                  {t(`lb.range.${r}`)}
                </button>
              )
            })}
            {data?.ranges && data.ranges.length === 1 && (
              <span className="ml-2 text-xs text-muted-foreground/70">
                {t("lb.range.onlyAll")}
              </span>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              {/* 我自己的成绩：不在榜上也能看到名次，否则「我排第几」只能靠眼找 */}
              {data?.me && (
                <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-3">
                  <Award className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t("lb.me")}</span>
                  <span className="font-mono text-sm tabular-nums">
                    #{data.me.rank}
                  </span>
                  <span className="ml-auto font-mono text-sm tabular-nums">
                    {data.me.score}
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t(unitKey)}
                    </span>
                  </span>
                </div>
              )}

              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : items.length === 0 ? (
                <div className="py-6">
                  <EmptyState title={t("lb.empty")} description={t("lb.emptyDesc")} />
                </div>
              ) : (
                <ol className="divide-y">
                  {items.map((e) => (
                    <li
                      key={e.username}
                      className={cn(
                        "flex items-center gap-3 px-4 py-2.5",
                        // 自己那一行高亮：一眼能在长榜里找到自己
                        e.isMe && "bg-accent/60"
                      )}
                    >
                      <span
                        className={cn(
                          "w-8 shrink-0 text-center font-mono text-sm tabular-nums",
                          // 前三名加粗；其余用弱化色，避免整列都很抢眼
                          e.rank <= 3
                            ? "font-semibold text-foreground"
                            : "text-muted-foreground"
                        )}
                      >
                        {e.rank}
                      </span>
                      <UserAvatar
                        username={e.username}
                        nickname={e.nickname}
                        hasAvatar={e.hasAvatar}
                        className="h-7 w-7 shrink-0"
                      />
                      <Link
                        to={`/space/${encodeURIComponent(e.username)}`}
                        className="min-w-0 truncate text-sm hover:underline"
                      >
                        {e.nickname || e.username}
                      </Link>
                      {e.isMe && (
                        <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                          {t("lb.you")}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-sm tabular-nums">
                        {e.score}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {t(unitKey)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          {/* 口径说明：榜单最容易引起「为什么我不是第一」的争议，把口径摆在明面上 */}
          <p className="mt-3 text-xs text-muted-foreground">{t(noteKey)}</p>
        </div>
      </div>
    </div>
  )
}
