/**
 * 历史投票弹窗（挂在消息中心「活动推广」页的入口）。
 *
 * 为什么需要：服务端 `/api/events`（活动推广列表）按 `ends_at >= now` 过滤，
 * 活动一过截止时间就从推广页消失。而「截止后开奖」那一档的**结果恰恰是在截止之后
 * 才出来的** —— 用户回头想看看「最后谁获奖、我那一票中没中」时，活动已经找不到了，
 * 只剩一句「活动怎么不见了」。
 *
 * 这里把已结束的投票列出来：最终票数、获奖选项、我投了谁、我的结算结果，
 * 以及这一档的结算规则（什么时候出结果）。
 *
 * 取数：打开弹窗时才请求 `GET /events/vote-history`（没点进来的人不用付这次往返），
 * 一次拉完，列表内不再逐个请求。
 */
import * as React from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { ArrowUpRight, History } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EventVote, VOTE_RULE_LABEL_KEY, isDrawVoteRule, isInstantVoteRule } from "@/components/event-vote"
import { LoadingBlock } from "@/components/loading-block"
import { eventApi, errMsg } from "@/services/api"
import type { EventItem } from "@/types"
import { useT } from "@/i18n"

/**
 * 活动推广页顶部的入口条（自带弹窗状态）。
 *
 * 做成「入口条 + 弹窗」一个整体：历史列表只在点开时才拉数据，
 * 而入口本身要常驻（活动列表为空时也得进得去 —— 那正是「活动都结束了」的常见情况）。
 */
export function VoteHistoryEntry() {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          {t("vote.hist.entryHint")}
        </span>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <History className="h-4 w-4" />
          {t("vote.hist.entry")}
        </Button>
      </div>
      <VoteHistoryDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function VoteHistoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { t } = useT()
  /** null = 还没拉到过（与「拉到了但是空的」区分开，否则空态会闪一下） */
  const [items, setItems] = React.useState<EventItem[] | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    // 每次打开都重拉：开奖可能在两次打开之间完成，缓存住会让用户看到过期的
    // 「等待开奖」——那正是这个功能要解决的问题，不能自己再造一个。
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await eventApi.voteHistory()
        if (!cancelled) setItems(res.events)
      } catch (err) {
        if (!cancelled) toast.error(errMsg(err, t("vote.hist.loadFailed")))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t("vote.hist.title")}
          </DialogTitle>
          <DialogDescription>{t("vote.hist.desc")}</DialogDescription>
        </DialogHeader>

        {loading && items === null ? (
          <LoadingBlock variant="list" />
        ) : !items || items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("vote.hist.empty")}</p>
        ) : (
          <div className="space-y-3">
            {items.map((ev) => (
              <HistoryCard key={ev.id} ev={ev} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 我的结算状态 → 徽章文案。`none` = 这场投票我没参加。 */
const MY_RESULT_KEY: Record<string, string> = {
  granted: "vote.hist.mine.granted",
  lost: "vote.hist.mine.lost",
  pending: "vote.hist.mine.pending",
  failed: "vote.hist.mine.failed",
  none: "vote.hist.mine.none",
}

function HistoryCard({ ev }: { ev: EventItem }) {
  const { t } = useT()
  const vote = ev.vote
  const claim = ev.myClaim ?? null
  const locale = t("msg.dateLocale")
  const endedAt = ev.endsAt ? new Date(ev.endsAt).toLocaleString(locale) : ""
  const myResult = claim?.rewardStatus ?? "none"
  /**
   * 要不要显示「N 人中奖」：
   *   · `all`（参与即可获奖）不显示 —— 中奖人数就等于参与人数，是句废话；
   *   · 已开奖 或 立刻结算那一档显示 —— 这时「拿到奖的人数」是确定的事实；
   *   · 还在等开奖（截止后开奖、尚未开奖）不显示 —— 此时是 0，写出来像「没人中奖」。
   */
  const showWinners =
    !!vote && vote.rewardRule !== "all" && (vote.drawn || isInstantVoteRule(vote.rewardRule))

  /**
   * 这一档的结算规则 —— 用户最想知道的就是「结果出了没、什么时候出」：
   *   参与即可获奖   投票时就发完了，没有「开奖」这回事；
   *   立刻结算       每个人投票那一刻按当时票数各自结算，没有统一结果；
   *   截止后开奖     已开奖 → 给出开奖时间；还没开奖 → 说清「等开奖」而不是让人干瞪眼。
   */
  const settlement = (() => {
    if (!vote) return { text: "", warn: false }
    if (vote.rewardRule === "all") return { text: t("vote.hist.settle.all"), warn: false }
    if (isInstantVoteRule(vote.rewardRule)) {
      return { text: t("vote.hist.settle.instant"), warn: false }
    }
    if (!isDrawVoteRule(vote.rewardRule)) return { text: "", warn: false }
    if (vote.drawn) {
      return {
        text: t("vote.hist.settle.drawn", {
          at: ev.drawnAt ? new Date(ev.drawnAt).toLocaleString(locale) : "",
        }),
        warn: false,
      }
    }
    return { text: t("vote.hist.settle.pending"), warn: true }
  })()

  return (
    <div className="space-y-2.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{ev.title}</span>
        {vote && <Badge variant="secondary">{t(VOTE_RULE_LABEL_KEY[vote.rewardRule])}</Badge>}
        {vote?.drawn && <Badge variant="success">{t("vote.hist.badge.drawn")}</Badge>}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {endedAt && <span>{t("vote.hist.endedAt", { at: endedAt })}</span>}
        <span>{t("vote.hist.participants", { n: ev.claimCount ?? 0 })}</span>
        {showWinners && <span>{t("vote.hist.winners", { n: ev.grantedCount ?? 0 })}</span>}
        <Badge variant={myResult === "granted" ? "success" : "outline"}>
          {t(MY_RESULT_KEY[myResult] ?? MY_RESULT_KEY.none)}
        </Badge>
      </div>

      {settlement.text && (
        <p
          className={
            settlement.warn
              ? "text-xs text-amber-600 dark:text-amber-400"
              : "text-xs text-muted-foreground"
          }
        >
          {settlement.text}
        </p>
      )}

      {/* 我的结算原文（如「你投的「A」获奖：已获得 10 积分」）—— 比徽章更具体 */}
      {claim?.rewardDetail && (
        <p className="text-xs text-muted-foreground">{claim.rewardDetail}</p>
      )}

      {/* 选项与最终票数：复用投票区组件（已结束 ⇒ 自动切成只读的票数展示） */}
      {vote ? (
        <EventVote
          ev={ev}
          selected={null}
          onSelect={() => {}}
          onSubmit={() => {}}
          busy={false}
          disabled
        />
      ) : (
        <p className="text-xs text-muted-foreground">{t("vote.hist.badConfig")}</p>
      )}

      <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
        <Link to={`/activity/${ev.id}`}>
          {t("vote.hist.view")}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  )
}
