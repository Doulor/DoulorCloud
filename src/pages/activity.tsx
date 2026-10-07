import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Gift,
  Info,
  Loader2,
  PartyPopper,
  Share2,
  Users,
  Vote,
} from "lucide-react"
import { toast } from "sonner"

import { LoadingBlock } from "@/components/loading-block"
import { Markdown } from "@/components/markdown"
import { EventVote, VOTE_RULE_LABEL_KEY, VOTE_RULE_HINT_KEY, isInstantVoteRule } from "@/components/event-vote"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/hooks/use-auth"
import { eventApi, errMsg } from "@/services/api"
import { notifyMessagesChanged } from "@/lib/message-events"
import type { EventItem } from "@/types"
import { useT } from "@/i18n"

/**
 * 活动详情 / 分享页（`/activity/:id`）—— 公开页，无需登录。
 *
 * 为什么单独一页：活动卡片在消息中心里，那个地址（/dashboard/messages/event）
 * 分享给别人是打不开的（要登录、而且是「所有活动」的列表，不是某一场）。
 * 这里给每场活动一个自己的地址，点「分享」复制它，别人点开直接看到内容并参与。
 *
 * 未登录也能看内容（只展示、不参与），点「参与」时引导登录并回跳本页。
 */
export default function ActivityPage() {
  const { t } = useT()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [ev, setEv] = React.useState<EventItem | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [code, setCode] = React.useState("")
  /** 「点了 GitHub star」活动里用户自己填的 GitHub 用户名 */
  const [github, setGithub] = React.useState("")
  /** 投票活动里当前选中的选项 id（未选为 null） */
  const [optionId, setOptionId] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!id) return
    try {
      const res = await eventApi.get(id)
      setEv(res.event)
      // 已投过票 / 已开奖时，把「我投的那个」同步进选中态 —— 否则投票区会显示成
      // 一张还没投票的表（票数条已在展示，却没有任何一项被选中）。
      setOptionId(res.event.myVote ?? null)
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleClaim = async () => {
    if (!ev) return
    // 未登录：先去登录，登录后回到本页（活动不丢）
    if (!user) {
      navigate("/login", { state: { from: { pathname: `/activity/${ev.id}` } } })
      return
    }
    setBusy(true)
    try {
      const res = await eventApi.claim(ev.id, code.trim(), github.trim(), optionId ?? "")
      /**
       * 「立刻结算」那一档可能返回 `lost`（没中奖）—— 那是**正常结果**不是错误，
       * 走 toast.success 会让人以为中了奖，走 error 又像出故障了。
       * 用中性提示，具体原因在卡片上的状态里也能看到（myClaim.rewardDetail）。
       */
      if (res.status === "lost") toast.message(res.detail)
      else toast.success(res.detail)
      notifyMessagesChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("act.err.join")))
      await load()
    } finally {
      setBusy(false)
    }
  }

  const handleShare = async () => {
    const url = `${window.location.origin}/activity/${ev?.id ?? ""}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      toast.success(t("msg.shareCopied"))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用（http / 权限）时把链接显示出来让用户手动复制
      toast.message(t("msg.shareCopyFailed"), { description: url })
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <LoadingBlock />
      </div>
    )
  }

  if (notFound || !ev) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-16 text-center">
        <PartyPopper className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("act.notFound")}</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" />
            {t("space.backToConsole")}
          </Link>
        </Button>
      </div>
    )
  }

  const claim = ev.myClaim
  const claimed = !!claim && claim.rewardStatus !== "failed"
  const isLottery = ev.conditionType === "lottery"
  const isVote = ev.conditionType === "vote"
  const lotteryClosed = isLottery && !!ev.lottery?.drawn
  /** 投票已开奖：不能再投（后端 VOTE_DRAWN 会拦，这里只是别让按钮看着能点） */
  const voteClosed = isVote && !!ev.vote?.drawn
  const needsCode = ev.conditionType === "code" && !claimed
  /** 「点 GitHub star / 提交 GitHub PR」活动：领取前必须让用户填 GitHub 用户名，服务端据此核验 */
  const needsGithub =
    (ev.conditionType === "github_star" || ev.conditionType === "github_pr") && !claimed
  const blockedReason = claimed ? "" : ev.claimBlockedReason ?? ""
  /** 参与条件的规则说明（静态规则，与用户当前状态无关） */
  const conditionHint = claimed ? "" : ev.conditionHint ?? ""
  /**
   * 投票区是否只读：未登录、不在进行中、配置有前置条件没满足、已开奖 —— 任一成立就不能投。
   * 「已投过票」不在这里管 —— EventVote 内部按 myVote 自己会切成只读展示。
   */
  const voteLocked = !user || ev.claimState !== "open" || !!blockedReason || voteClosed

  const timeText = (() => {
    const locale = t("msg.dateLocale")
    if (ev.startsAt && ev.endsAt) {
      return t("msg.time.range", {
        from: new Date(ev.startsAt).toLocaleString(locale),
        to: new Date(ev.endsAt).toLocaleString(locale),
      })
    }
    if (ev.endsAt) return t("msg.time.until", { at: new Date(ev.endsAt).toLocaleString(locale) })
    if (ev.startsAt) return t("msg.time.from", { at: new Date(ev.startsAt).toLocaleString(locale) })
    return t("msg.time.always")
  })()

  const buttonLabel = (() => {
    if (ev.claimState === "not_started") return t("msg.btn.notStarted")
    if (ev.claimState === "ended") return t("msg.btn.ended")
    if (blockedReason) return t("msg.btn.blocked")
    if (claim?.rewardStatus === "failed") return t("msg.btn.retry")
    if (lotteryClosed) return t("msg.btn.drawn")
    if (!user) return isLottery ? t("act.btn.loginLottery") : t("act.btn.loginJoin")
    return isLottery ? t("msg.btn.joinLottery") : t("msg.btn.join")
  })()

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="flex items-center justify-between">
        <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 inline h-3.5 w-3.5" />
          {t("space.console")}
        </Link>
        <span className="text-xs text-muted-foreground">{t("act.brandLine")}</span>
      </div>

      <Card className="border-primary/30">
        <CardContent className="space-y-4 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <PartyPopper className="h-4 w-4 text-primary" />
            <h1 className="text-lg font-semibold">{ev.title}</h1>
            {ev.claimState === "ended" && <Badge variant="secondary">{t("msg.ended")}</Badge>}
            {ev.claimState === "not_started" && <Badge variant="outline">{t("msg.notStarted")}</Badge>}
          </div>

          <div className="text-muted-foreground">
            <Markdown>{ev.body}</Markdown>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {timeText}
            </span>
            {ev.maxClaims != null && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {isLottery
                  ? t("act.limitPeople", { n: ev.maxClaims })
                  : t("act.limitClaims", { n: ev.maxClaims })}
                {t("act.joinedCount", { n: ev.claimCount ?? 0 })}
              </span>
            )}
            {ev.maxClaims == null && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {t("act.joinedPeople", { n: ev.claimCount ?? 0 })}
              </span>
            )}
            {ev.lottery && (
              <span className="inline-flex items-center gap-1">
                <Gift className="h-3.5 w-3.5" />
                {ev.lottery.drawn ? t("msg.lottery.drawnPrefix") : ""}
                {t("msg.lottery.summary", {
                  winners: ev.lottery.winners,
                  pool: ev.lottery.pool,
                  mode: ev.lottery.mode === "even" ? t("msg.mode.even") : t("msg.mode.random"),
                })}
              </span>
            )}
            {ev.vote && (
              <span className="inline-flex items-center gap-1">
                <Vote className="h-3.5 w-3.5" />
                {t("vote.summary", {
                  n: ev.vote.options.length,
                  rule: t(VOTE_RULE_LABEL_KEY[ev.vote.rewardRule]),
                })}
              </span>
            )}
            {ev.rewardLabel && (
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <Gift className="h-3.5 w-3.5" />
                {t("msg.rewardLabel", { label: ev.rewardLabel })}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {claimed ? (
              <Badge
                variant={
                  claim?.rewardStatus === "granted"
                    ? "success"
                    : // lost = 参与但没中奖（投票的少数/多数、立刻结算都可能是它）。
                      // 用 secondary（不是 success）—— 免得没中奖的人也看到一片绿。
                      "secondary"
                }
              >
                {claim?.rewardDetail ?? t("act.joined")}
              </Badge>
            ) : isVote ? (
              // 投票活动的主操作在下面的投票区里（用户得先选一个选项），
              // 这里只在未登录时给一个登录入口 —— 未登录选不了选项（见 voteLocked）。
              !user && (
                <Button
                  size="sm"
                  onClick={() =>
                    navigate("/login", { state: { from: { pathname: `/activity/${ev.id}` } } })
                  }
                >
                  {t("act.btn.loginJoin")}
                </Button>
              )
            ) : (
              <>
                {needsCode && (
                  <Input
                    className="h-9 w-48"
                    placeholder={t("msg.enterCode")}
                    maxLength={64}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                )}
                {needsGithub && (
                  <Input
                    className="h-9 w-48"
                    placeholder={t("msg.enterGithub")}
                    maxLength={64}
                    value={github}
                    onChange={(e) => setGithub(e.target.value)}
                  />
                )}
                <Button
                  size="sm"
                  onClick={() => void handleClaim()}
                  disabled={
                    busy ||
                    ev.claimState !== "open" ||
                    (needsCode && !code.trim()) ||
                    (needsGithub && !github.trim()) ||
                    !!blockedReason ||
                    lotteryClosed
                  }
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {buttonLabel}
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => void handleShare()}>
              {copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
              {copied ? t("common.copied") : t("msg.share")}
            </Button>
          </div>

          {/* 投票区：选项 + 票数 + 自己的选择。已投票 / 已开奖后自动切成只读展示 */}
          {isVote && (
            <EventVote
              ev={ev}
              selected={optionId}
              onSelect={setOptionId}
              onSubmit={handleClaim}
              busy={busy}
              disabled={voteLocked}
            />
          )}

          {!claimed && claim?.rewardStatus === "failed" && claim.rewardDetail && (
            <p className="inline-flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              {claim.rewardDetail}
            </p>
          )}
          {blockedReason && (
            <p className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5" />
              {blockedReason}
            </p>
          )}
          {/* 参与条件的规则说明：**领取前**就告诉用户这类活动要什么。
              以前只在点了之后才回一句「你还不满足参与条件」，用户不知道差哪一步
              （2026-10-02 有人因为「开通了名片但没填昵称」卡住并来提反馈）。 */}
          {!claimed && !blockedReason && conditionHint && (
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              {conditionHint}
            </p>
          )}
          {needsGithub && (
            <p className="text-xs text-muted-foreground">{t("msg.github.hint")}</p>
          )}
          {isLottery && !claimed && (
            <p className="text-xs text-muted-foreground">
              {t("msg.lottery.hint", {
                mode: ev.lottery?.mode === "even" ? t("msg.mode.even") : t("msg.mode.random"),
              })}
            </p>
          )}
          {/* 投票规则说明：每档不一样（什么时候出结果、凭什么赢），必须逐档讲清楚，
              否则用户会拿错的预期来判断，然后把「投了没中」当成 bug */}
          {isVote && !claimed && ev.vote && (
            <p
              className={
                isInstantVoteRule(ev.vote.rewardRule)
                  ? "text-xs text-amber-600 dark:text-amber-400"
                  : "text-xs text-muted-foreground"
              }
            >
              {t(VOTE_RULE_HINT_KEY[ev.vote.rewardRule])}
            </p>
          )}
          {!user && (
            <p className="text-xs text-muted-foreground">
              {t("act.shareHint")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
