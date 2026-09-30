import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  Bell,
  Check,
  CheckCheck,
  Loader2,
  Megaphone,
  MessagesSquare,
  Package,
  PartyPopper,
  Gift,
  Info,
  Clock,
  AlertCircle,
  Users,
  Share2,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/hooks/use-auth"
import { notificationApi, pointsApi, eventApi, errMsg } from "@/services/api"
import { notifyMessagesChanged } from "@/lib/message-events"
import { notifyPointsChanged } from "@/components/points-badge"
import type {
  EventItem,
  MessageCategory,
  Notification,
} from "@/types"

const CATEGORY_META: Record<
  MessageCategory,
  { label: string; icon: typeof Bell; empty: string; emptyDesc: string }
> = {
  system: {
    label: "系统消息",
    icon: Info,
    empty: "没有系统消息",
    emptyDesc: "账号状态、捐献审核结果等会出现在这里。",
  },
  site: {
    label: "网站动态",
    icon: Megaphone,
    empty: "还没有网站动态",
    emptyDesc: "管理员发布的公告会出现在这里。",
  },
  social: {
    label: "社交消息",
    icon: MessagesSquare,
    empty: "没有社交消息",
    emptyDesc: "社区里的回复与点赞会出现在这里。",
  },
  event: {
    label: "活动推广",
    icon: PartyPopper,
    empty: "暂时没有活动",
    emptyDesc: "管理员发布新活动时会推送到这里。",
  },
}

const TABS: MessageCategory[] = ["system", "site", "social", "event"]

export default function MessagesPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { category } = useParams<{ category?: string }>()
  /**
   * 当前分类**以 URL 为准**（/dashboard/messages/<category>）——
   * 这样每个 tab 都有自己的可分享 / 可收藏 URL，刷新、前进后退都停在原 tab。
   * 非法值或缺失（老的 /dashboard/messages）回落 system。
   */
  const tab: MessageCategory = TABS.includes(category as MessageCategory)
    ? (category as MessageCategory)
    : "system"
  const [loading, setLoading] = React.useState(true)
  /** 各分类的消息缓存（按需加载，切 tab 不重复请求） */
  const [messages, setMessages] = React.useState<Partial<Record<MessageCategory, Notification[]>>>({})
  /** 已经请求过的分类（避免来回切 tab 重复请求） */
  const loadedRef = React.useRef<Set<MessageCategory>>(new Set())
  const [byCategory, setByCategory] = React.useState<Record<MessageCategory, number>>({
    system: 0,
    site: 0,
    social: 0,
    event: 0,
  })
  const [events, setEvents] = React.useState<EventItem[]>([])
  const [claiming, setClaiming] = React.useState<string | null>(null)

  const loadCategory = React.useCallback(async (c: MessageCategory) => {
    try {
      const res = await notificationApi.list({ category: c })
      setMessages((prev) => ({ ...prev, [c]: res.notifications }))
    } catch (err) {
      toast.error(errMsg(err, "消息加载失败"))
      setMessages((prev) => ({ ...prev, [c]: [] }))
    }
  }, [])

  const loadCounts = React.useCallback(async () => {
    try {
      setByCategory((await notificationApi.unreadCount()).byCategory)
    } catch {
      /* 未读数失败不阻断阅读 */
    }
  }, [])

  const loadEvents = React.useCallback(async () => {
    try {
      setEvents((await eventApi.list()).events)
    } catch (err) {
      toast.error(errMsg(err, "活动加载失败"))
      setEvents([])
    }
  }, [])

  // 首屏：未读数 + 活动（消息列表由下面的 tab effect 按当前 URL 加载，
  // 这样「深链直达某个分类」和「正常进页面」走的是同一条路径）
  React.useEffect(() => {
    void (async () => {
      setLoading(true)
      await Promise.all([loadCounts(), loadEvents()])
      setLoading(false)
    })()
  }, [loadCounts, loadEvents])

  /** 按分类整批标记已读（活动 tab 用：卡片不是可逐条点开的通知） */
  const markCategoryRead = React.useCallback(
    async (c: MessageCategory) => {
      if (byCategory[c] === 0) return
      try {
        await notificationApi.markRead(undefined, false, c)
        setByCategory((prev) => ({ ...prev, [c]: 0 }))
        setMessages((prev) => ({
          ...prev,
          [c]: (prev[c] ?? []).map((n) => ({ ...n, read: true })),
        }))
        notifyMessagesChanged()
      } catch {
        /* 静默：下次轮询会纠正 */
      }
    },
    [byCategory]
  )

  /**
   * 当前分类（URL）变化 → 加载对应数据。
   * 活动 tab 的数据源是 /events（活动实体 + 我的领取状态），不是消息列表；
   * 同时把对应通知整批置已读，否则铃铛红点会一直挂着。
   */
  React.useEffect(() => {
    if (tab === "event") {
      void loadEvents()
      void markCategoryRead("event")
      return
    }
    if (!loadedRef.current.has(tab)) {
      loadedRef.current.add(tab)
      void loadCategory(tab)
    }
  }, [tab, loadEvents, markCategoryRead, loadCategory])

  /**
   * 切 tab：只改 URL，加载交给上面的 effect。
   * 用 **push**（不是 replace）—— 这样浏览器前进/后退能在切过的 tab 之间来回走，
   * 这正是「每个 tab 有自己的 URL」想要的效果。
   *
   * ⚠️ 必须用 ref 挡重复调用：Radix Tabs 在受控模式下点一次会连发两次
   * onValueChange（此刻 URL 还没变，所以 `c === tab` 判断挡不住），
   * 结果是历史里塞进两条一模一样的记录、点一次要退两次。
   */
  const lastNavRef = React.useRef<MessageCategory | null>(null)
  React.useEffect(() => {
    lastNavRef.current = tab
  }, [tab])

  const handleTabChange = (v: string) => {
    const c = v as MessageCategory
    if (!TABS.includes(c) || c === tab || lastNavRef.current === c) return
    lastNavRef.current = c
    navigate(`/dashboard/messages/${c}`)
  }

  /**
   * 在消息里直接执行了订单操作（发货 / 确认收货）之后。
   *
   * 服务端那条消息的 payload 不会变，所以**不能重拉列表** —— 重拉会把按钮又装回来。
   * 做法：本地把这条的 action 摘掉并置为已读，同时把已读同步到服务端、刷新未读数。
   */
  const handleOrderActionDone = React.useCallback(
    async (c: MessageCategory, messageId: string) => {
      if (!messageId.startsWith("sys:")) {
        try {
          await notificationApi.markRead([messageId])
        } catch {
          /* 静默：置已读失败不影响操作本身 */
        }
      }
      setMessages((prev) => ({
        ...prev,
        [c]: (prev[c] ?? []).map((x) =>
          x.id === messageId
            ? { ...x, read: true, payload: { ...(x.payload ?? {}), action: null } }
            : x
        ),
      }))
      await loadCounts()
      notifyMessagesChanged()
    },
    [loadCounts]
  )

  /** 点击一条消息：标记已读 + 跳转 */
  const openMessage = async (n: Notification) => {
    if (!n.read && !n.id.startsWith("sys:")) {
      try {
        await notificationApi.markRead([n.id])
        setMessages((prev) => ({
          ...prev,
          [n.category]: (prev[n.category] ?? []).map((x) =>
            x.id === n.id ? { ...x, read: true } : x
          ),
        }))
        setByCategory((prev) => ({ ...prev, [n.category]: Math.max(0, prev[n.category] - 1) }))
        notifyMessagesChanged()
      } catch {
        /* 静默 */
      }
    }
    // 反馈回复关联的是反馈单，不是帖子 —— 单独跳反馈页
    if (n.type === "feedback_reply") {
      navigate("/dashboard/feedback")
      return
    }
    // 社交消息（回复/点赞）没有 link 字段，用 postId 拼社区详情地址。
    // 帖子已删则无处可跳，给个提示而不是静默无反应。
    if (!n.link && n.postId) {
      if (n.postDeleted) {
        toast.error("该帖子已被删除")
        return
      }
      navigate(`/dashboard/community/${n.postId}`)
      return
    }
    if (n.link) navigate(n.link)
  }

  /**
   * 「本页全部已读」只作用于**当前分页**（分类），不动其它三个分页。
   *
   * 后端按 category 整批更新（POST /notifications/read {category}）；event 分页
   * 展示的是活动卡片而非通知行，但对应通知同样按 category 清掉，走同一条分支即可。
   */
  const markAllRead = async () => {
    const c = tab
    if (byCategory[c] === 0) return
    try {
      await notificationApi.markRead(undefined, false, c)
      setMessages((prev) =>
        prev[c] ? { ...prev, [c]: (prev[c] ?? []).map((n) => ({ ...n, read: true })) } : prev
      )
      setByCategory((prev) => ({ ...prev, [c]: 0 }))
      notifyMessagesChanged()
      toast.success(`已将「${CATEGORY_META[c].label}」全部标记为已读`)
    } catch (err) {
      toast.error(errMsg(err, "操作失败"))
    }
  }

  /** 每个活动的认证码输入：{ eventId: code }，认证码活动才需要 */
  const [codeDrafts, setCodeDrafts] = React.useState<Record<string, string>>({})

  const claim = async (ev: EventItem) => {
    setClaiming(ev.id)
    try {
      const res = await eventApi.claim(ev.id, codeDrafts[ev.id] ?? "")
      toast.success(res.detail || "领取成功")
      setCodeDrafts((d) => {
        const next = { ...d }
        delete next[ev.id]
        return next
      })
      await loadEvents()
    } catch (err) {
      toast.error(errMsg(err, "领取失败"))
      // 条件不满足 / 已结束时刷新一下，让按钮状态与服务端一致
      await loadEvents()
    } finally {
      setClaiming(null)
    }
  }

  if (!user) return null

  return (
    <div>
      <PageHeader
        title="消息中心"
        description="系统消息、网站动态、社区互动与活动推广都汇总在这里。"
      />

      <Tabs value={tab} onValueChange={handleTabChange}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            {TABS.map((c) => {
              const meta = CATEGORY_META[c]
              const Icon = meta.icon
              const n = byCategory[c]
              return (
                <TabsTrigger key={c} value={c} className="gap-1.5">
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                  {n > 0 && (
                    <Badge variant="destructive" className="h-4 px-1 text-[10px] tabular-nums">
                      {n > 99 ? "99+" : n}
                    </Badge>
                  )}
                </TabsTrigger>
              )
            })}
          </TabsList>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void markAllRead()}
            disabled={byCategory[tab] === 0}
          >
            <CheckCheck className="h-4 w-4" />
            本页全部已读
          </Button>
        </div>

        {TABS.map((c) => (
          <TabsContent key={c} value={c}>
            {c === "event" ? (
              <EventList
                events={events}
                loading={loading}
                claiming={claiming}
                codeDrafts={codeDrafts}
                onCodeChange={(id, v) =>
                  setCodeDrafts((d) => ({ ...d, [id]: v }))
                }
                onClaim={(ev) => void claim(ev)}
              />
            ) : !messages[c] ? (
              // 该分类还没加载过（首次进入 / 深链直达）→ 骨架
              <LoadingBlock />
            ) : (messages[c] ?? []).length === 0 ? (
              <EmptyState
                icon={CATEGORY_META[c].icon}
                title={CATEGORY_META[c].empty}
                description={CATEGORY_META[c].emptyDesc}
              />
            ) : (
              <div className="space-y-2">
                {(messages[c] ?? []).map((n) => (
                  <MessageRow
                    key={n.id}
                    n={n}
                    onOpen={() => void openMessage(n)}
                    onOrderChanged={(id) => void handleOrderActionDone(c, id)}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

/**
 * 订单消息的「快捷操作」。
 *
 * 后端在订单流转时写 `payload = { kind:"order", orderId, action }`（见
 * worker/src/points-shop.ts 的 notifyOrder）。这里据此把操作直接放到消息里 ——
 * 卖家收到「有人买下了」就能当场点「标记已交付」，买家收到「卖家已交付」就能
 * 当场点「确认收货」，不用再去积分页翻订单。
 *
 * 约定变更要两边一起改：`action` 只认 "deliver" / "confirm"。
 */
function OrderMessageActions({
  n,
  onChanged,
}: {
  n: Notification
  /** 操作成功后回调（带上消息 id，父级把这条的按钮摘掉并置已读） */
  onChanged: (messageId: string) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const p = (n.payload ?? {}) as { kind?: string; orderId?: string; action?: string | null }
  const isDeliver = p.action === "deliver"
  const isConfirm = p.action === "confirm"
  if (p.kind !== "order" || !p.orderId || (!isDeliver && !isConfirm)) return null

  const orderId = p.orderId
  const run = async (e: React.MouseEvent) => {
    // 别冒泡到卡片：点卡片是「打开消息并跳转」，点按钮只该执行操作
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      if (isDeliver) await pointsApi.sellerDeliver(orderId)
      else await pointsApi.confirmReceipt(orderId)
      toast.success(isDeliver ? "已标记交付，等买家确认收货" : "已确认收货，积分已转给卖家")
      notifyPointsChanged()
      onChanged(n.id)
    } catch (err) {
      toast.error(errMsg(err, isDeliver ? "交付失败" : "确认收货失败"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" className="mt-2" disabled={busy} onClick={(e) => void run(e)}>
      {busy ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : isDeliver ? (
        <Package className="mr-1.5 h-3.5 w-3.5" />
      ) : (
        <Check className="mr-1.5 h-3.5 w-3.5" />
      )}
      {isDeliver ? "标记已交付" : "确认收货"}
    </Button>
  )
}

/** 单条消息 */
function MessageRow({
  n,
  onOpen,
  onOrderChanged,
}: {
  n: Notification
  onOpen: () => void
  onOrderChanged: (messageId: string) => void
}) {
  const isSiteOrSystem = n.category === "site" || n.category === "system"
  const actor = n.actorNickname || n.actorUsername

  return (
    <Card
      className={`cursor-pointer transition-colors hover:bg-accent/40 ${n.read ? "" : "border-primary/40"}`}
      onClick={onOpen}
    >
      <CardContent className="flex items-start gap-3 p-4">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? "bg-transparent" : "bg-primary"}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {isSiteOrSystem && n.title && (
              <p className="text-sm font-medium">{n.title}</p>
            )}
            {!isSiteOrSystem && (
              <p className="text-sm font-medium">
                {n.type === "post_like"
                  ? `${actor ?? "有人"} 赞了你的帖子`
                  : `${actor ?? "有人"} 回复了你的帖子`}
              </p>
            )}
            <span className="text-xs text-muted-foreground">
              {new Date(n.createdAt).toLocaleString("zh-CN")}
            </span>
          </div>

          {/* 网站动态 / 系统消息：Markdown 正文 */}
          {isSiteOrSystem && n.body && (
            <div className="text-muted-foreground">
              <Markdown>{n.body}</Markdown>
            </div>
          )}

          {/* 订单消息：把「发货 / 确认收货」直接放在消息里 */}
          {isSiteOrSystem && <OrderMessageActions n={n} onChanged={onOrderChanged} />}

          {/* 社交消息：帖子摘要 + 回复正文 */}
          {!isSiteOrSystem && (
            <div className="space-y-0.5 text-xs text-muted-foreground">
              {n.postDeleted ? (
                <p className="italic">帖子已删除</p>
              ) : (
                n.postPreview && <p className="truncate">「{n.postPreview}」</p>
              )}
              {n.commentPreview && <p className="truncate">{n.commentPreview}</p>}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** 活动列表：卡片 + 领取按钮 */
function EventList({
  events,
  loading,
  claiming,
  codeDrafts,
  onCodeChange,
  onClaim,
}: {
  events: EventItem[]
  loading: boolean
  claiming: string | null
  /** 认证码草稿：{ eventId: 已输入的码 } */
  codeDrafts: Record<string, string>
  onCodeChange: (id: string, v: string) => void
  onClaim: (ev: EventItem) => void
}) {
  if (loading && events.length === 0) return <LoadingBlock />
  if (events.length === 0) {
    return (
      <EmptyState
        icon={PartyPopper}
        title="暂时没有活动"
        description="管理员发布新活动时会推送到这里。"
      />
    )
  }

  return (
    <div className="space-y-3">
      {events.map((ev) => (
        <EventCard
          key={ev.id}
          ev={ev}
          busy={claiming === ev.id}
          code={codeDrafts[ev.id] ?? ""}
          onCodeChange={(v) => onCodeChange(ev.id, v)}
          onClaim={() => onClaim(ev)}
        />
      ))}
    </div>
  )
}

function EventCard({
  ev,
  busy,
  code,
  onCodeChange,
  onClaim,
}: {
  ev: EventItem
  busy: boolean
  /** 当前输入的认证码（仅认证码活动用） */
  code: string
  onCodeChange: (v: string) => void
  onClaim: () => void
}) {
  const claim = ev.myClaim
  const claimed = !!claim && claim.rewardStatus !== "failed"
  /** 认证码活动：领取前必须输入管理员公布的口令（如 QQ 群群公告里的码） */
  const needsCode = ev.conditionType === "code" && !claimed
  /** 抽奖活动：参与只是报名，开奖后由服务端随机抽人发积分 */
  const isLottery = ev.conditionType === "lottery"
  /** 抽奖已开奖：不能再报名（报了也拿不到奖），按钮置灰 */
  const lotteryClosed = isLottery && !!ev.lottery?.drawn
  /** 未满足奖励前置条件（如未开通中转站）：按钮置灰并说明原因，避免点了才失败 */
  const blockedReason = claimed ? "" : ev.claimBlockedReason ?? ""

  const timeText = (() => {
    if (ev.startsAt && ev.endsAt) {
      return `${new Date(ev.startsAt).toLocaleString("zh-CN")} 至 ${new Date(ev.endsAt).toLocaleString("zh-CN")}`
    }
    if (ev.endsAt) return `截止 ${new Date(ev.endsAt).toLocaleString("zh-CN")}`
    if (ev.startsAt) return `从 ${new Date(ev.startsAt).toLocaleString("zh-CN")} 开始`
    return "长期有效"
  })()

  /** 复制这场活动的分享链接（/activity/<id>，未登录也能打开看到内容） */
  const shareLink = async () => {
    const url = `${window.location.origin}/activity/${ev.id}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success("活动链接已复制，发给别人即可参与")
    } catch {
      toast.message("复制失败，请手动复制", { description: url })
    }
  }

  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Gift className="h-4 w-4 text-primary" />
          <p className="text-base font-semibold">{ev.title}</p>
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
          {ev.maxClaims != null &&
            (() => {
              // 限量活动：剩余份数 = 总量 - 已领（claimCount 由 /events 下发）。
              // 领满后按钮仍可点，但服务端会返回「活动名额已满」——这里先把状态摆明。
              const left = Math.max(0, ev.maxClaims - (ev.claimCount ?? 0))
              return (
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {isLottery
                    ? left > 0
                      ? `限 ${ev.maxClaims} 人参与，还剩 ${left} 个名额`
                      : "参与人数已满"
                    : left > 0
                      ? `限量 ${ev.maxClaims} 份，剩余 ${left} 份`
                      : "名额已满"}
                </span>
              )
            })()}
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
              {claim?.rewardDetail ?? "已领取"}
            </Badge>
          ) : (
            <>
              {needsCode && (
                <Input
                  className="h-9 w-44"
                  placeholder="输入认证码"
                  maxLength={64}
                  value={code}
                  onChange={(e) => onCodeChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && code.trim() && ev.claimState === "open" && !busy) {
                      onClaim()
                    }
                  }}
                />
              )}
              <Button
                size="sm"
                onClick={onClaim}
                disabled={
                  busy ||
                  ev.claimState !== "open" ||
                  (needsCode && !code.trim()) ||
                  !!blockedReason ||
                  lotteryClosed
                }
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {ev.claimState === "not_started"
                  ? "未开始"
                  : ev.claimState === "ended"
                    ? "已结束"
                    : blockedReason
                      ? "暂不可领取"
                      : claim?.rewardStatus === "failed"
                        ? "重新尝试领取"
                        : lotteryClosed
                          ? "已开奖"
                          : isLottery
                            ? "参与抽奖"
                            : "立即参与"}
              </Button>
            </>
          )}
          {!claimed && claim?.rewardStatus === "failed" && claim.rewardDetail && (
            <span className="inline-flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              {claim.rewardDetail}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => void shareLink()}>
            <Share2 className="h-4 w-4" />
            分享
          </Button>
        </div>
        {needsCode && (
          <p className="text-xs text-muted-foreground">
            该活动需要认证码才能参与，认证码通常在活动说明或指定群内公布。
          </p>
        )}
        {isLottery && !claimed && (
          <p className="text-xs text-muted-foreground">
            抽奖活动：点「参与抽奖」只是报名，当时不发奖。活动结束后由系统从报名者里随机抽取中奖者，
            按「{ev.lottery?.mode === "even" ? "平均分" : "随机分"}」发放奖池积分。
          </p>
        )}
        {blockedReason && (
          <p className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-3.5 w-3.5" />
            {blockedReason}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
