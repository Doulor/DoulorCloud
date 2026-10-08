import { Check, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { EventItem, EventVoteOption, EventVoteRewardRule } from "@/types"
import { useT } from "@/i18n"

/**
 * 投票获奖规则 → i18n key。
 *
 * 抽出来放这里，是因为管理端（配置表单、活动列表徽章）与用户端（活动详情、
 * 消息中心卡片）一共四个地方要显示同一句话 —— 各写一份映射迟早会出现
 * 「后台标题是多数得奖、用户端显示少数得奖」这种自相矛盾。
 */
export const VOTE_RULE_LABEL_KEY: Record<EventVoteRewardRule, string> = {
  all: "vote.rule.all",
  instant_fixed: "vote.rule.instantFixed",
  instant_majority: "vote.rule.instantMajority",
  instant_minority: "vote.rule.instantMinority",
  fixed: "vote.rule.fixed",
  majority: "vote.rule.majority",
  minority: "vote.rule.minority",
}

/** 是不是「投票后立刻按当前状态结算」那一档（要在界面上特别提示，否则用户不懂为什么没中） */
export function isInstantVoteRule(r: EventVoteRewardRule): boolean {
  return r === "instant_fixed" || r === "instant_majority" || r === "instant_minority"
}

/**
 * 是不是「截止后开奖」那一档（到点 / 手动由服务端计票结算）。
 *
 * ⚠️ 必须与 worker/src/event-rewards.ts 的 `isDrawVoteRule` 一致（改一处要改两处）——
 * 历史投票用它区分「已开奖 / 还在等开奖」，档位认错会把用户的预期带偏
 * （明明是等开奖的活动，用户看到「已结束」却没有任何结果，只会以为吞了他的票）。
 */
export function isDrawVoteRule(r: EventVoteRewardRule): boolean {
  return r === "fixed" || r === "majority" || r === "minority"
}

/**
 * 每种获奖规则给用户看一眼的说明。
 *
 * 为什么要逐档写而不是一句通用话：七档的「什么时候出结果、凭什么赢」都不一样，
 * 通用文案必然有一半是错的 —— 用户会拿错的预期去判断，然后把「投了没中」
 * 当成 bug 来提反馈。带 `instant` 的几档用醒目色（它们会出现「投完立刻没中」）。
 */
export const VOTE_RULE_HINT_KEY: Record<EventVoteRewardRule, string> = {
  all: "vote.hint.all",
  instant_fixed: "vote.hint.instantFixed",
  instant_majority: "vote.hint.instantMajority",
  instant_minority: "vote.hint.instantMinority",
  fixed: "vote.hint.fixed",
  majority: "vote.hint.majority",
  minority: "vote.hint.minority",
}

/**
 * 活动投票区（活动详情页 `/activity/:id` 与消息中心活动卡片共用）。
 *
 * 为什么抽成组件：同一次投票会在两个地方出现（消息中心的卡片、分享出去的详情页），
 * 而「已投票 → 显示票数与结果」这套状态展示很容易两处写歪（一处算了百分比、
 * 另一处忘了平票提示）。统一在这里算一次。
 *
 * 纯展示 + 回调：票数 / 我投了谁由父组件的接口数据给（`ev.voteCounts` / `ev.myVote`），
 * 点击只把选项 id 交给父组件去调接口 —— 组件内不发请求，避免两处各写一套错误处理。
 */
export interface EventVoteProps {
  ev: EventItem
  /** 当前选中的选项 id（父组件持有，未投票时为 null） */
  selected: string | null
  onSelect: (optionId: string) => void
  /** 提交投票 */
  onSubmit: () => void
  busy: boolean
  /** 是否可提交（未登录 / 已结束 / 已投票等由父组件判断） */
  disabled: boolean
}

export function EventVote({ ev, selected, onSelect, onSubmit, busy, disabled }: EventVoteProps) {
  const { t } = useT()
  const vote = ev.vote
  if (!vote) return null

  const counts = ev.voteCounts ?? {}
  const myVote = ev.myVote ?? null
  /**
   * 活动是否已结束（投票窗口关闭）。
   *
   * 判定必须与服务端 `isEventOver` 一致：管理员提前结束 / 归档，或仍是 active
   * 但已过 endsAt —— 三种都算。⚠️ 不能只看 claimState：状态不是 active 的活动
   * 服务端一律给 `offline`，把它当「还在进行」就会出现「活动早结束了却还让人投」。
   */
  const ended = ev.claimState === "ended" || ev.status === "ended" || ev.status === "archived"
  /**
   * 票数是否公开 —— 口径与后端 `voteCountsVisible` 严格一致（改一处必须改另一处）：
   * 已投过票 / 已开奖 / 活动已结束（窗口关了，「照着票数投」已无从下手）。
   * 服务端只在这些情况下才把票数放进响应，这里只决定「渲染不渲染」。
   */
  const revealed = !!myVote || vote.drawn || ended
  const total = vote.options.reduce((sum, o) => sum + (counts[o.id] ?? 0), 0)
  /**
   * 获奖选项：
   *  · 已开奖 ⇒ 票数在开奖那一刻定死，按最终票数还原即可；
   *  · 「指定选项」这类**不看票数**的规则，活动结束后也能直接给出 —— 它是配置里的
   *    常量，投票窗口都关了，继续藏着没有意义（历史投票要能看出是哪个选项获奖）。
   * 「立刻结算的多数 / 少数」永远不标：它的结果取决于每个人投票**那一刻**的票数，
   * 拿最终票数去标一定会标出一个当时并不成立的「赢家」。
   */
  const canResolveWinner =
    vote.drawn ||
    (ended &&
      (vote.rewardRule === "fixed" || vote.rewardRule === "instant_fixed") &&
      !!vote.fixedOptionId)
  const winning = canResolveWinner
    ? winningIds(vote.options, counts, vote.rewardRule, vote.fixedOptionId)
    : null

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {vote.options.map((o) => (
          <VoteOptionRow
            key={o.id}
            option={o}
            count={counts[o.id] ?? 0}
            total={total}
            /** 已投票 / 已开奖后票数公开；未投之前不显示，避免「看票数再决定投谁」 */
            showCount={revealed}
            /** 我投的那个（投完一直标着，包括开奖之后） */
            mine={myVote === o.id}
            selected={selected === o.id}
            winner={!!winning?.has(o.id)}
            selectable={!revealed && !disabled}
            onSelect={() => onSelect(o.id)}
          />
        ))}
      </div>

      {!revealed && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void onSubmit()}
            disabled={disabled || busy || !selected}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("vote.submit")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("vote.oneShot")}</span>
        </div>
      )}

      {revealed && (
        <p className="text-xs text-muted-foreground">
          {total > 0
            ? t("vote.totalVotes", { n: total })
            : t("vote.noVotesYet")}
        </p>
      )}

      {revealed && winning && (
        <p className="text-xs text-muted-foreground">
          {winning.size > 1
            ? t("vote.result.tie", {
                labels: [...winning]
                  .map((id) => vote.options.find((o) => o.id === id)?.label ?? id)
                  .join(" / "),
              })
            : t("vote.result.winner", {
                label: vote.options.find((o) => o.id === [...winning][0])?.label ?? "",
              })}
        </p>
      )}
    </div>
  )
}

/**
 * 已开奖时，按票数还原出获奖选项（用于给选项打「获奖」标记）。
 *
 * ⚠️ 与服务端 pickWinningOptions 的口径**必须一致**（平票并列全算、
 * 少数只在有票选项里取最小、固定选项不看得票）。这里只是展示，真正发奖是服务端算的 ——
 * 两边不一致会表现成「标了获奖但没拿到奖励」，那是最难解释的一类 bug。
 *
 * `fixedOptionId` 只有「固定选项获奖」且**已开奖**时服务端才会下发；拿不到就不标获奖，
 * 不猜（猜错比不标更糟）。
 */
function winningIds(
  options: EventVoteOption[],
  counts: Record<string, number>,
  rule: EventVoteRewardRule,
  fixedOptionId?: string | null
): Set<string> {
  if (rule === "fixed" || rule === "instant_fixed") {
    // 固定选项：完全不看得票，只认配置里那个（且必须在现存选项里）
    return fixedOptionId && options.some((o) => o.id === fixedOptionId)
      ? new Set([fixedOptionId])
      : new Set()
  }
  const scope =
    rule === "majority" || rule === "instant_majority"
      ? "majority"
      : rule === "minority" || rule === "instant_minority"
        ? "minority"
        : null
  if (!scope) return new Set()
  const entries = options
    .map((o) => [o.id, counts[o.id] ?? 0] as const)
    .filter(([, c]) => c > 0)
  if (entries.length === 0) return new Set()
  const target =
    scope === "majority"
      ? Math.max(...entries.map(([, c]) => c))
      : Math.min(...entries.map(([, c]) => c))
  return new Set(entries.filter(([, c]) => c === target).map(([id]) => id))
}

function VoteOptionRow({
  option,
  count,
  total,
  showCount,
  mine,
  selected,
  winner,
  selectable,
  onSelect,
}: {
  option: EventVoteOption
  count: number
  total: number
  showCount: boolean
  mine: boolean
  selected: boolean
  winner: boolean
  selectable: boolean
  onSelect: () => void
}) {
  const { t } = useT()
  const pct = showCount && total > 0 ? Math.round((count / total) * 100) : 0

  return (
    <button
      type="button"
      onClick={selectable ? onSelect : undefined}
      disabled={!selectable}
      aria-pressed={selected}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border p-3 text-left transition-colors",
        selectable && "hover:border-primary/60 hover:bg-accent/40 cursor-pointer",
        selected && "border-primary bg-primary/5",
        winner && "border-emerald-500/60",
        !selectable && "cursor-default"
      )}
    >
      {/* 票数条：已公开票数时才画，垫在内容下面 */}
      {showCount && (
        <span
          className={cn(
            "absolute inset-y-0 left-0 -z-0 transition-[width] duration-500",
            winner ? "bg-emerald-500/15" : "bg-primary/10"
          )}
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      )}

      <span className="relative flex items-start gap-3">
        {option.image && (
          // 选项配图：固定小方块 + object-cover，避免不同尺寸的图把行高撑得参差不齐
          <img
            src={option.image}
            alt=""
            loading="lazy"
            className="h-14 w-14 shrink-0 rounded-md border object-cover"
          />
        )}
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{option.label}</span>
            {mine && (
              <span className="inline-flex items-center gap-0.5 text-xs text-primary">
                <Check className="h-3 w-3" />
                {t("vote.mine")}
              </span>
            )}
            {winner && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                {t("vote.winner")}
              </span>
            )}
          </span>
          {option.desc && (
            <span className="block text-xs text-muted-foreground">{option.desc}</span>
          )}
        </span>
        {showCount && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("vote.countAndPct", { n: count, pct })}
          </span>
        )}
      </span>
    </button>
  )
}
