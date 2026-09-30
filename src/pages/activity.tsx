import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Gift,
  Loader2,
  PartyPopper,
  Share2,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import { LoadingBlock } from "@/components/loading-block"
import { Markdown } from "@/components/markdown"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/hooks/use-auth"
import { eventApi, errMsg } from "@/services/api"
import { notifyMessagesChanged } from "@/lib/message-events"
import type { EventItem } from "@/types"

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
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [ev, setEv] = React.useState<EventItem | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [code, setCode] = React.useState("")
  const [copied, setCopied] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!id) return
    try {
      const res = await eventApi.get(id)
      setEv(res.event)
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
      const res = await eventApi.claim(ev.id, code.trim())
      toast.success(res.detail)
      notifyMessagesChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, "参与失败"))
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
      toast.success("链接已复制，发给别人即可参与")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用（http / 权限）时把链接显示出来让用户手动复制
      toast.message("复制失败，请手动复制", { description: url })
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
        <p className="text-sm text-muted-foreground">这个活动不存在，或者还没发布</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" />
            回到控制台
          </Link>
        </Button>
      </div>
    )
  }

  const claim = ev.myClaim
  const claimed = !!claim && claim.rewardStatus !== "failed"
  const isLottery = ev.conditionType === "lottery"
  const lotteryClosed = isLottery && !!ev.lottery?.drawn
  const needsCode = ev.conditionType === "code" && !claimed
  const blockedReason = claimed ? "" : ev.claimBlockedReason ?? ""

  const timeText = (() => {
    if (ev.startsAt && ev.endsAt) {
      return `${new Date(ev.startsAt).toLocaleString("zh-CN")} 至 ${new Date(ev.endsAt).toLocaleString("zh-CN")}`
    }
    if (ev.endsAt) return `截止 ${new Date(ev.endsAt).toLocaleString("zh-CN")}`
    if (ev.startsAt) return `从 ${new Date(ev.startsAt).toLocaleString("zh-CN")} 开始`
    return "长期有效"
  })()

  const buttonLabel = (() => {
    if (ev.claimState === "not_started") return "未开始"
    if (ev.claimState === "ended") return "已结束"
    if (blockedReason) return "暂不可领取"
    if (claim?.rewardStatus === "failed") return "重新尝试领取"
    if (lotteryClosed) return "已开奖"
    if (!user) return isLottery ? "登录后参与抽奖" : "登录后参与"
    return isLottery ? "参与抽奖" : "立即参与"
  })()

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="flex items-center justify-between">
        <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 inline h-3.5 w-3.5" />
          控制台
        </Link>
        <span className="text-xs text-muted-foreground">Doulor Cloud · 活动</span>
      </div>

      <Card className="border-primary/30">
        <CardContent className="space-y-4 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <PartyPopper className="h-4 w-4 text-primary" />
            <h1 className="text-lg font-semibold">{ev.title}</h1>
            {ev.claimState === "ended" && <Badge variant="secondary">已结束</Badge>}
            {ev.claimState === "not_started" && <Badge variant="outline">未开始</Badge>}
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
                  ? `限 ${ev.maxClaims} 人参与`
                  : `限量 ${ev.maxClaims} 份`}
                ，已参与 {ev.claimCount ?? 0}
              </span>
            )}
            {ev.maxClaims == null && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                已参与 {ev.claimCount ?? 0} 人
              </span>
            )}
            {ev.lottery && (
              <span className="inline-flex items-center gap-1">
                <Gift className="h-3.5 w-3.5" />
                {ev.lottery.drawn ? "已开奖 · " : ""}
                抽 {ev.lottery.winners} 人，奖池 {ev.lottery.pool} 积分（
                {ev.lottery.mode === "even" ? "平均分" : "随机分"}）
              </span>
            )}
            {ev.rewardLabel && (
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <Gift className="h-3.5 w-3.5" />
                奖励：{ev.rewardLabel}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {claimed ? (
              <Badge variant={claim?.rewardStatus === "granted" ? "success" : "secondary"}>
                {claim?.rewardDetail ?? "已参与"}
              </Badge>
            ) : (
              <>
                {needsCode && (
                  <Input
                    className="h-9 w-48"
                    placeholder="输入认证码"
                    maxLength={64}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                )}
                <Button
                  size="sm"
                  onClick={() => void handleClaim()}
                  disabled={
                    busy ||
                    ev.claimState !== "open" ||
                    (needsCode && !code.trim()) ||
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
              {copied ? "已复制" : "分享"}
            </Button>
          </div>

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
          {isLottery && !claimed && (
            <p className="text-xs text-muted-foreground">
              抽奖活动：点「参与抽奖」只是报名，当时不发奖。活动结束后由系统从报名者里随机抽取中奖者，
              按「{ev.lottery?.mode === "even" ? "平均分" : "随机分"}」发放奖池积分。
            </p>
          )}
          {!user && (
            <p className="text-xs text-muted-foreground">
              这个链接可以分享给别人 —— 未登录也能看到活动内容，参与时需要先登录。
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
