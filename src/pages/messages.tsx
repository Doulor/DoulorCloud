import * as React from "react"
import { useT } from "@/i18n"
import { useNavigate, useParams } from "react-router-dom"
import {
  Bell,
  Check,
  CheckCheck,
  Loader2,
  Megaphone,
  MessagesSquare,
  MessageSquare,
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

/**
 * 分类元数据。文案存 **i18n key**（不是译好的字符串）——
 * 模块级常量在加载时就把语言冻结了，key 留到渲染/取词时再解析。
 */
const CATEGORY_META: Record<
  MessageCategory,
  { labelKey: string; icon: typeof Bell; emptyKey: string; emptyDescKey: string }
> = {
  system: {
    labelKey: "msg.cat.system",
    icon: Info,
    emptyKey: "msg.empty.system",
    emptyDescKey: "msg.empty.systemDesc",
  },
  site: {
    labelKey: "msg.cat.site",
    icon: Megaphone,
    emptyKey: "msg.empty.site",
    emptyDescKey: "msg.empty.siteDesc",
  },
  social: {
    labelKey: "msg.cat.social",
    icon: MessagesSquare,
    emptyKey: "msg.empty.social",
    emptyDescKey: "msg.empty.socialDesc",
  },
  event: {
    labelKey: "msg.cat.event",
    icon: PartyPopper,
    emptyKey: "msg.empty.event",
    emptyDescKey: "msg.empty.eventDesc",
  },
}

const TABS: MessageCategory[] = ["system", "site", "social", "event"]

export default function MessagesPage() {
  const { t } = useT()
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
      toast.error(errMsg(err, t("msg.err.load")))
      setMessages((prev) => ({ ...prev, [c]: [] }))
    }
    // t 来自 context，语言切换会重建；这里只在 t 变化时重建即可
  }, [t])

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
      toast.error(errMsg(err, t("msg.err.loadEvents")))
      setEvents([])
    }
  }, [t])

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
        toast.error(t("msg.postDeleted"))
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
      toast.success(t("msg.markAllReadDone", { category: t(CATEGORY_META[c].labelKey) }))
    } catch (err) {
      toast.error(errMsg(err, t("common.error")))
    }
  }

  /** 每个活动的认证码输入：{ eventId: code }，认证码活动才需要 */
  const [codeDrafts, setCodeDrafts] = React.useState<Record<string, string>>({})

  const claim = async (ev: EventItem) => {
    setClaiming(ev.id)
    try {
      const res = await eventApi.claim(ev.id, codeDrafts[ev.id] ?? "")
      toast.success(res.detail || t("msg.claimOk"))
      setCodeDrafts((d) => {
        const next = { ...d }
        delete next[ev.id]
        return next
      })
      await loadEvents()
    } catch (err) {
      toast.error(errMsg(err, t("msg.claimFailed")))
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
        title={t("msg.title")}
        description={t("msg.desc")}
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
                  {t(meta.labelKey)}
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
            {t("msg.markAllRead")}
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
                title={t(CATEGORY_META[c].emptyKey)}
                description={t(CATEGORY_META[c].emptyDescKey)}
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
 * 后端在订单流转时写 `payload = { kind:"order", orderId, action, peer }`（见
 * worker/src/points-shop.ts 的 notifyOrder）。这里据此把操作直接放到消息里 ——
 * 卖家收到「有人买下了」就能当场点「标记已交付」，买家收到「卖家已交付」就能
 * 当场点「确认收货」，不用再去积分页翻订单。
 *
 * `peer` 是订单对端的用户名快照（买家/卖家）：有值就再给一个「去私聊」按钮，
 * 直达 /dashboard/dm/<peer> —— 商量交付、对齐发货细节不用再手动搜用户名。
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
  const { t } = useT()
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  const p = (n.payload ?? {}) as {
    kind?: string
    orderId?: string
    action?: string | null
    peer?: string | null
  }
  const isDeliver = p.action === "deliver"
  const isConfirm = p.action === "confirm"
  if (p.kind !== "order" || !p.orderId) return null
  const peer = p.peer?.trim() || null
  /**
   * ⚠️ 操作按钮必须只在**真的有动作**时才渲染。
   *
   * 「已买下」「积分到账」「订单已取消」这些订单消息的 action 是 null，但同样带着
   * kind:"order" —— 只看 kind 判断，它们就会长出一个点了必然报错的「确认收货」按钮。
   * 「去私聊」是与动作无关的入口，所以单独判断，不受这里影响。
   * （PR #8 合并后的回归修复，2026-10-02）
   */
  const hasAction = isDeliver || isConfirm
  // 既没动作、也没有对端可私聊 → 这条订单消息根本不需要按钮区
  if (!hasAction && !peer) return null

  const orderId = p.orderId
  const run = async (e: React.MouseEvent) => {
    // 别冒泡到卡片：点卡片是「打开消息并跳转」，点按钮只该执行操作
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      if (isDeliver) await pointsApi.sellerDeliver(orderId)
      else await pointsApi.confirmReceipt(orderId)
      toast.success(isDeliver ? t("msg.order.delivered") : t("msg.order.confirmed"))
      notifyPointsChanged()
      onChanged(n.id)
    } catch (err) {
      toast.error(errMsg(err, isDeliver ? t("msg.order.deliverFailed") : t("msg.order.confirmFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {hasAction && (
        <Button size="sm" disabled={busy} onClick={(e) => void run(e)}>
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : isDeliver ? (
            <Package className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          )}
          {isDeliver ? t("msg.order.markDelivered") : t("msg.order.confirmReceipt")}
        </Button>
      )}
      {peer && (
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            // 与上面的操作按钮同理：去私聊是导航，不该触发卡片的「打开消息」
            e.stopPropagation()
            navigate(`/dashboard/dm/${encodeURIComponent(peer)}`)
          }}
        >
          <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
          {t("msg.order.goToDm", { peer })}
        </Button>
      )}
    </div>
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
  const { t } = useT()
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
                  ? t("msg.liked", { actor: actor ?? t("msg.someone") })
                  : t("msg.replied", { actor: actor ?? t("msg.someone") })}
              </p>
            )}
            <span className="text-xs text-muted-foreground">
              {new Date(n.createdAt).toLocaleString(t("msg.dateLocale"))}
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
                <p className="italic">{t("msg.postDeletedShort")}</p>
              ) : (
                n.postPreview && <p className="truncate">{t("msg.postPreview", { text: n.postPreview })}</p>
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
}) {  const { t } = useT()

  if (loading && events.length === 0) return <LoadingBlock />
  if (events.length === 0) {
    return (
      <EmptyState
        icon={PartyPopper}
        title={t("msg.empty.event")}
        description={t("msg.empty.eventDesc")}
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
  const { t } = useT()
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

  const locale = t("msg.dateLocale")
  const timeText = (() => {
    if (ev.startsAt && ev.endsAt) {
      return t("msg.time.range", {
        from: new Date(ev.startsAt).toLocaleString(locale),
        to: new Date(ev.endsAt).toLocaleString(locale),
      })
    }
    if (ev.endsAt) {
      return t("msg.time.until", { at: new Date(ev.endsAt).toLocaleString(locale) })
    }
    if (ev.startsAt) {
      return t("msg.time.from", { at: new Date(ev.startsAt).toLocaleString(locale) })
    }
    return t("msg.time.always")
  })()

  /** 复制这场活动的分享链接（/activity/<id>，未登录也能打开看到内容） */
  const shareLink = async () => {
    const url = `${window.location.origin}/activity/${ev.id}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("msg.shareCopied"))
    } catch {
      toast.message(t("msg.shareCopyFailed"), { description: url })
    }
  }

  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Gift className="h-4 w-4 text-primary" />
          <p className="text-base font-semibold">{ev.title}</p>
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
                      ? t("msg.slots.lottery", { max: ev.maxClaims, left })
                      : t("msg.slots.lotteryFull")
                    : left > 0
                      ? t("msg.slots.quota", { max: ev.maxClaims, left })
                      : t("msg.slots.quotaFull")}
                </span>
              )
            })()}
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
          {ev.rewardLabel && (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Gift className="h-3.5 w-3.5" />
              {t("msg.rewardLabel", { label: ev.rewardLabel })}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {claimed ? (
            <Badge variant={claim?.rewardStatus === "granted" ? "success" : "secondary"}>
              {claim?.rewardDetail ?? t("msg.claimed")}
            </Badge>
          ) : (
            <>
              {needsCode && (
                <Input
                  className="h-9 w-44"
                  placeholder={t("msg.enterCode")}
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
                  ? t("msg.btn.notStarted")
                  : ev.claimState === "ended"
                    ? t("msg.btn.ended")
                    : blockedReason
                      ? t("msg.btn.blocked")
                      : claim?.rewardStatus === "failed"
                        ? t("msg.btn.retry")
                        : lotteryClosed
                          ? t("msg.btn.drawn")
                          : isLottery
                            ? t("msg.btn.joinLottery")
                            : t("msg.btn.join")}
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
            {t("msg.share")}
          </Button>
        </div>
        {needsCode && (
          <p className="text-xs text-muted-foreground">{t("msg.codeHint")}</p>
        )}
        {isLottery && !claimed && (
          <p className="text-xs text-muted-foreground">
            {t("msg.lottery.hint", {
              mode: ev.lottery?.mode === "even" ? t("msg.mode.even") : t("msg.mode.random"),
            })}
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
