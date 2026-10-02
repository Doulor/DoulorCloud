/**
 * 一对一私信（2026-10-01 新增）。
 *
 * 谁会用：积分商城的买卖双方（商量交付 / 催确认收货）、以及从个人空间
 * 或聊天室点进来想私聊的人。
 *
 * 实时性：**5 秒轮询**（只在页面可见时轮询，见 lib/visible-interval），
 * 与聊天室同一套做法 —— 本项目不引 Durable Object。
 * 轮询走的是「独立静默路径」：不整页 loading、不打断输入框。
 *
 * 已读语义：**拉到消息本身不算已读**，只有「会话真的打开着且页面可见」时才
 * 调 `/dm/seen`。否则切走再回来，未读会被轮询悄悄清零。
 */
import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Loader2, MessageSquarePlus, Send } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { EmojiPicker } from "@/components/emoji-picker"
import { StickerPanel } from "@/components/sticker-panel"
import { Markdown } from "@/components/markdown"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { UserAvatar } from "@/components/user-avatar"
import { cn } from "@/lib/utils"
import { relTime } from "@/lib/format"
import { setVisibleInterval } from "@/lib/visible-interval"
import { dmApi, errMsg, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { useImageDrop } from "@/hooks/use-image-drop"
import type { DmConversation, DmMessage, DmPeer, DmRequest } from "@/types"
import { useT } from "@/i18n"

/** 轮询间隔：会话列表与当前会话都用它 */
const POLL_MS = 5000

export default function DmPage() {
  const { t } = useT()
  const { username: routePeer } = useParams<{ username?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [conversations, setConversations] = React.useState<DmConversation[]>([])
  const [listLoading, setListLoading] = React.useState(true)
  /** 我收到的待处理聊天申请（陌生人发第一条消息后出现在这里） */
  const [requests, setRequests] = React.useState<DmRequest[]>([])
  /** 左栏「找人」输入框 */
  const [peerInput, setPeerInput] = React.useState("")

  const [messages, setMessages] = React.useState<DmMessage[]>([])
  const [peerName, setPeerName] = React.useState<string | null>(null)
  /**
   * 对端信息（含昵称 / hasAvatar）。消息表里只有 userId，头像与昵称得从
   * `list` 返回的 peer 上取 —— 之前这里硬编码了 hasAvatar=false/nickname=null，
   * 结果上传过头像的用户在私信里也显示成首字母（2026-10-01 站长反馈）。
   */
  const [peer, setPeer] = React.useState<DmPeer | null>(null)
  const [msgLoading, setMsgLoading] = React.useState(false)
  const [text, setText] = React.useState("")
  const [sending, setSending] = React.useState(false)

  /** 增量轮询游标 */
  const cursorRef = React.useRef<string | null>(null)
  /** 当前打开的对端（供定时器里的静默路径用 ref 校验，避免切会话时串台） */
  const peerRef = React.useRef<string | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  /** 发消息输入框：表情/表情包要插到光标处 */
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  // 表情与表情包都插到光标处（与社区共用同一个 hook）
  const insertEmoji = useEmojiInsert(inputRef, text, setText)

  /**
   * 拖入 / 粘贴图片。上传成功后把 `![](url)` 插到光标处 ——
   * 复用 `insertEmoji`，因为它做的就是「往光标位置插一段文本」，
   * 对图片 markdown 和 emoji 是同一种操作。
   */
  const { dragging, uploading, dropProps } = useImageDrop({
    onImage: insertEmoji,
    disabled: !peer,
  })

  const loadConversations = React.useCallback(async () => {
    try {
      const [res, req] = await Promise.all([dmApi.conversations(), dmApi.requests()])
      setConversations(res.conversations)
      setRequests(req.requests)
    } catch {
      /* 静默：列表拉不到不该打断会话 */
    } finally {
      setListLoading(false)
    }
  }, [])

  /** 打开某个对端的会话（首次进入：整段拉） */
  const openConversation = React.useCallback(async (peer: string) => {
    peerRef.current = peer
    setPeerName(peer)
    setMsgLoading(true)
    setMessages([])
    cursorRef.current = null
    // 新会话默认贴底（消息到位后下面那个 effect 会滚到底）
    stickBottomRef.current = true
    // 重置翻页游标：上一个会话的历史不该串到这里来
    prevCursorRef.current = null
    hasMoreRef.current = true
    setHasMore(true)
    try {
      const res = await dmApi.list(peer)
      setMessages(res.messages)
      setPeer(res.peer)
      cursorRef.current = res.nextCursor
      // ⚠️ 必须把首屏的 prevCursor 存下来，否则往上翻页时传的是空游标 ——
      // 后端会当成「不传 before」，又把最新一批拉一遍，去重后看不到任何新消息
      // （2026-10-02 实测踩到：滚到顶部毫无反应）。
      prevCursorRef.current = res.prevCursor
      hasMoreRef.current = res.hasMore
      setHasMore(res.hasMore)
    } catch (err) {
      toast.error(errMsg(err, t("dmsg.err.open")))
    } finally {
      setMsgLoading(false)
    }
    // 打开就算已读（页面可见时才做，见下面的定时器）
    void markSeen(peer)
    void loadConversations()
  }, [loadConversations])

  /** 标记已读：只在页面可见时调用 */
  const markSeen = React.useCallback(async (peer: string) => {
    if (document.hidden) return
    try {
      await dmApi.seen(peer)
      // 本地把未读抹掉，免得等下一轮列表刷新才消失
      setConversations((prev) =>
        prev.map((c) => (c.peer.username === peer ? { ...c, unread: 0 } : c))
      )
    } catch {
      /* 标已读失败不打扰用户 */
    }
  }, [])

  /** 增量拉新消息（静默，不动 loading） */
  const pollMessages = React.useCallback(async () => {
    const peer = peerRef.current
    if (!peer) return
    try {
      const res = await dmApi.list(peer, { after: cursorRef.current ?? undefined })
      if (peerRef.current !== peer) return // 期间切了会话，丢弃
      if (res.messages.length > 0) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id))
          return [...prev, ...res.messages.filter((m) => !seen.has(m.id))]
        })
        cursorRef.current = res.nextCursor
        void markSeen(peer)
      }
    } catch {
      /* 静默 */
    }
  }, [markSeen])

  // 路由变化 → 打开对应会话；没有参数就是「不选任何会话」
  React.useEffect(() => {
    if (routePeer) void openConversation(routePeer)
    else {
      peerRef.current = null
      setPeerName(null)
      setPeer(null)
      setMessages([])
    }
  }, [routePeer, openConversation])

  React.useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  // 轮询：列表 + 当前会话
  React.useEffect(() => {
    if (!user) return
    const offList = setVisibleInterval(() => void loadConversations(), POLL_MS)
    const offMsg = setVisibleInterval(() => void pollMessages(), POLL_MS)
    return () => {
      offList()
      offMsg()
    }
  }, [user, loadConversations, pollMessages])

  /**
   * 找到「真正带滚动条的那个元素」。
   * 布局一变（比如某个祖先少了 `min-h-0`），滚动条可能挂到外层容器上，
   * 对着没有滚动条的元素赋值是无效的 —— 所以每次都往上找一遍。
   */
  const findScroller = React.useCallback((el: HTMLElement): HTMLElement => {
    let node: HTMLElement | null = el
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const oy = getComputedStyle(node).overflowY
        if (oy === "auto" || oy === "scroll") return node
      }
      node = node.parentElement
    }
    return el
  }, [])

  /**
   * 滚到最新一条（列表是正序的，所以 = 滚到最底部）。
   *
   * 只在两处调用：进入/切换会话时、以及用户本来就贴着底部时收到新消息。
   */
  const scrollToBottom = React.useCallback(() => {
    const el = listRef.current
    if (!el) return
    const scroller = findScroller(el)
    const jump = () => {
      scroller.scrollTop = scroller.scrollHeight
    }
    // 多滚几次：贴纸图片异步加载完会改变内容高度，之前算好的位置会失效
    jump()
    for (const delay of [60, 200, 500]) window.setTimeout(jump, delay)
  }, [findScroller])

  /** 用户是否停在底部 —— 决定收到新消息时要不要跟着滚 */
  const stickBottomRef = React.useRef(true)
  /** 往前翻页游标（更早的消息）；null 表示还没拉过 */
  const prevCursorRef = React.useRef<string | null>(null)
  /** 是否可能还有更早的消息（后端按「取满了 limit」判断） */
  const [hasMore, setHasMore] = React.useState(true)
  /**
   * `hasMore` 的 ref 镜像 —— 判断逻辑一律读它。
   *
   * ⚠️ 不能直接在 `loadEarlier` 里读 state：`loadEarlier` 被 `onScroll` 闭包持有，
   * 而 `onScroll` 又是注册在 DOM 上的监听器。state 一变、effect 重建，
   * 但**滚动事件可能仍命中旧闭包**，于是判断用的是过期的 `hasMore`
   * （2026-10-02 实测：滚到顶部毫无反应）。ref 是同一个对象，永远读到最新值。
   */
  const hasMoreRef = React.useRef(true)
  /** 正在加载更早的消息（UI 提示用） */
  const [loadingEarlier, setLoadingEarlier] = React.useState(false)
  /** 防止翻页请求并发（滚动事件触发很密集） */
  const loadingEarlierRef = React.useRef(false)

  /**
   * 往上翻页：加载更早的消息。
   *
   * 关键点是**补偿滚动位置**：新消息插在列表**前面**，内容整体变高，
   * 若不补偿，视口会「跳」到刚插入那批的顶部，用户正在看的内容被顶走。
   * 做法是记住插入前后的 scrollHeight 差值，再把它加回 scrollTop。
   */
  const loadEarlier = React.useCallback(async () => {
    const peer = peerRef.current
    if (!peer || loadingEarlierRef.current || !hasMoreRef.current) return
    loadingEarlierRef.current = true
    setLoadingEarlier(true)

    const el = listRef.current
    const scroller = el ? findScroller(el) : null
    const prevHeight = scroller?.scrollHeight ?? 0
    const prevTop = scroller?.scrollTop ?? 0

    try {
      const res = await dmApi.list(peer, { before: prevCursorRef.current ?? undefined })
      if (peerRef.current !== peer) return // 期间切了会话，丢弃
      if (res.messages.length === 0) {
        hasMoreRef.current = false
        setHasMore(false)
        return
      }
      prevCursorRef.current = res.prevCursor
      hasMoreRef.current = res.hasMore
      setHasMore(res.hasMore)
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id))
        return [...res.messages.filter((m) => !seen.has(m.id)), ...prev]
      })
      // 等 DOM 更新后补偿（用定时器而不是 rAF：后者在后台标签页会被暂停）
      window.setTimeout(() => {
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight - prevHeight + prevTop
        }
      }, 0)
    } catch {
      /* 静默：翻页失败不该打断阅读，下次滚动会再试 */
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
    // ⚠️ 依赖里**故意没有** hasMore：判断读的是 hasMoreRef，
    // 让这个函数保持稳定引用，避免滚动监听反复重建 / 命中旧闭包
  }, [findScroller])

  React.useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      const s = findScroller(el)
      stickBottomRef.current = s.scrollHeight - s.scrollTop - s.clientHeight < 48
      // 滑到接近顶部 → 继续加载更早的
      if (s.scrollTop < 80) void loadEarlier()
    }
    el.addEventListener("scroll", onScroll, true)
    return () => el.removeEventListener("scroll", onScroll, true)
  }, [findScroller, loadEarlier])

  /**
   * 消息变化时贴底。
   *
   * ⚠️ 只在「用户本来就在底部」时才滚：他可能正在往上翻历史，
   * 每 2 秒一次的轮询若是无脑拉到底，就没法好好看旧消息了。
   * 切会话时要重置回 true（新会话默认贴底）—— 见下面路由变化的 effect。
   */
  React.useEffect(() => {
    if (messages.length === 0) return
    if (stickBottomRef.current) scrollToBottom()
  }, [messages, scrollToBottom])

  // 这里**故意没有**「消息变了就滚到底」的 effect。
  // 反序布局（flex-col-reverse）已经保证默认看到最新一条，
  // 再叠一层自动滚动只会在用户翻历史时把他拽回底部。
  // 只有「自己发消息」才主动拉回来 —— 见 send()。

  /** 同意 / 拒绝聊天申请 */
  const handleRequest = async (peerName: string, action: "accept" | "decline") => {
    try {
      await dmApi.respondRequest(peerName, action)
      toast.success(action === "accept" ? t("dmsg.req.accepted") : t("dmsg.req.declined"))
      await loadConversations()
      if (action === "accept") navigate(`/dashboard/dm/${encodeURIComponent(peerName)}`)
    } catch (err) {
      toast.error(errMsg(err, t("dmsg.req.failed")))
    }
  }

  const openPeer = (name: string) => {
    const target = name.trim()
    if (!target) return
    if (user && target.toLowerCase() === user.username.toLowerCase()) {
      toast.error(t("dmsg.err.self"))
      return
    }
    navigate(`/dashboard/dm/${encodeURIComponent(target)}`)
  }

  const send = async () => {
    const body = text.trim()
    const peer = peerRef.current
    if (!peer || !body) return
    setSending(true)
    try {
      const res = await dmApi.send(peer, body)
      setText("")
      setMessages((prev) => [...prev, res.message])
      // 自己发的消息要立刻看到 —— 反序布局下它在视觉底部，滚回 0 即可
      scrollToBottom()
      void loadConversations()
    } catch (err) {
      if (err instanceof HttpError) toast.error(err.message)
      else toast.error(t("dmsg.err.send"))
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <PageHeader title={t("dmsg.title")} description={t("dmsg.desc")} />

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        {/* 左：会话列表 + 找人 */}
        <aside className="space-y-3">
          {requests.length > 0 && (
            /* 聊天申请（2026-10-01）：陌生人发来第一条消息后要先经过这里，
               同意之前他发不出第二条（服务端在 sendDm 里拦） */
            <div className="rounded-lg border border-primary/40 bg-primary/5">
              <p className="border-b px-3 py-2 text-xs font-medium">
                {t("dmsg.req.title", { n: requests.length })}
              </p>
              <div className="divide-y">
                {requests.map((r) => (
                  <div key={r.peer.id} className="space-y-2 p-3">
                    <div className="flex items-center gap-2">
                      <UserAvatar
                        username={r.peer.username}
                        nickname={r.peer.nickname}
                        hasAvatar={r.peer.hasAvatar}
                        className="h-7 w-7"
                      />
                      <span className="min-w-0 truncate text-sm font-medium">
                        {r.peer.nickname || r.peer.username}
                      </span>
                    </div>
                    <p className="line-clamp-3 break-all rounded-md bg-background px-2 py-1 text-xs text-muted-foreground">
                      {r.body || t("dmsg.req.noBody")}
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void handleRequest(r.peer.username, "accept")}>
                        {t("dmsg.req.accept")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleRequest(r.peer.username, "decline")}
                      >
                        {t("dmsg.req.decline")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              openPeer(peerInput)
              setPeerInput("")
            }}
          >
            <Input
              placeholder={t("dmsg.peerPlaceholder")}
              value={peerInput}
              maxLength={64}
              onChange={(e) => setPeerInput(e.target.value)}
            />
            <Button type="submit" size="icon" variant="outline" title={t("dmsg.startChat")}>
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          </form>

          <div className="rounded-lg border">
            {listLoading ? (
              <div className="p-6">
                <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : conversations.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {t("dmsg.empty")}
              </p>
            ) : (
              <div className="divide-y">
                {conversations.map((c) => {
                  const active = c.peer.username === peerName
                  return (
                    <Link
                      key={c.peer.id}
                      to={`/dashboard/dm/${encodeURIComponent(c.peer.username)}`}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent",
                        active && "bg-accent"
                      )}
                    >
                      <UserAvatar
                        username={c.peer.username}
                        nickname={c.peer.nickname}
                        hasAvatar={c.peer.hasAvatar}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.peer.nickname || c.peer.username}
                          </span>
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                            {relTime(c.last.createdAt)}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.last.mine && t("dmsg.minePrefix")}
                          {c.last.body}
                        </p>
                      </div>
                      {c.unread > 0 && (
                        <Badge className="shrink-0 bg-primary text-primary-foreground">
                          {c.unread > 99 ? "99+" : c.unread}
                        </Badge>
                      )}
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

        {/*
          右：会话内容

          ⚠️ 必须有**高度上限**（`max-h-*` + `overflow-hidden`），否则消息一多就把整个
          页面撑开，滚动条跑到 <html> 上 —— 消息区自己不出滚动条，
          `flex-col-reverse` 的「默认显示最新」也就无从谈起
          （实测：30 条消息把 section 撑到 2084px，而视口只有 625px）。
          `min-h-[28rem]` 保底让小屏不至于太扁，两者一起给出「高度确定」的容器，
          内部的 `flex-1 min-h-0` 才能正常收缩、在框内滚动。
          2026-10-02 排查「进入会话停在最上面」的真正断点就在这里。
        */}
        <section className="flex max-h-[calc(100vh-10rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border">
          {!peerName ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <EmptyState
                title={t("dmsg.pickTitle")}
                description={t("dmsg.pickDesc")}
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b px-4 py-2.5">
                <Link
                  to="/dashboard/dm"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground lg:hidden"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t("dmsg.list")}
                </Link>
                <UserAvatar
                  username={peerName}
                  nickname={peer?.nickname ?? null}
                  hasAvatar={peer?.hasAvatar ?? false}
                  className="h-7 w-7"
                />
                <span className="text-sm font-medium">{peerName}</span>
                <Link
                  to={`/space/${encodeURIComponent(peerName)}`}
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("lay.viewSpace")}
                </Link>
              </div>

              {/*
                正序渲染 + 进入时滚到底（`scrollTop = scrollHeight`）。
                之所以以前这套写法不生效，不是写法错，而是**容器根本不可滚** ——
                外层 section 没有高度上限，消息把整页撑开、滚动跑到 <html> 上，
                消息框自己 scrollHeight === clientHeight，怎么赋值都没用。
                现在 section 有了 `max-h` + `overflow-hidden`，容器真的会滚了，
                这个最直白的方案就能正常工作（实测 scrollMax 从 0 变成 1619）。
                2026-10-02：中途试过 `flex-col-reverse`，但它和「数组倒序」叠在一起
                容易把方向搞反（实测滚到了最旧一条），不如正序 + 滚到底好懂。
              */}
              <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                {msgLoading ? (
                  <div className="py-8">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("dmsg.noMessages")}
                  </p>
                ) : (
                  <>
                    {/* 顶部：往上翻历史的状态提示（滑到顶会自动加载更早的消息） */}
                    <div className="pb-1 text-center text-[11px] text-muted-foreground">
                      {loadingEarlier
                        ? t("dmsg.loadingEarlier")
                        : hasMore
                          ? t("dmsg.scrollForEarlier")
                          : t("dmsg.noEarlier")}
                    </div>
                    {messages.map((m) => {
                    const mine = m.fromUserId === user?.id
                    return (
                      <div
                        key={m.id}
                        className={cn("flex items-end gap-2", mine && "flex-row-reverse")}
                      >
                        <UserAvatar
                          username={mine ? (user?.username ?? "") : peerName}
                          nickname={mine ? (user?.nickname ?? null) : (peer?.nickname ?? null)}
                          hasAvatar={mine ? Boolean(user?.hasAvatar) : Boolean(peer?.hasAvatar)}
                          className="h-6 w-6"
                        />
                        <div className={cn("max-w-[75%]", mine && "text-right")}>
                          <div
                            className={cn(
                              "inline-block max-w-full break-words rounded-lg px-3 py-2 text-sm",
                              // `bubble-mine` 只是给 CSS 挂钩子：主色底上的链接要跟随前景色，
                              // 否则 `.markdown-body a { color: var(--primary) }` 会「同色隐形」。
                              mine ? "bubble-mine bg-primary text-primary-foreground" : "bg-muted"
                            )}
                          >
                            {/* 用 Markdown 渲染：表情包插进来的是 `![](/api/stickers/<id>/image)`，
                                纯文本渲染会把它原样显示成一行字（2026-10-02 反馈）。
                                换行由 remarkBreaks 负责，所以这里不再加 whitespace-pre-wrap。 */}
                            <Markdown>{m.body}</Markdown>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {relTime(m.createdAt)}
                            {mine && m.readAt ? t("dmsg.read") : ""}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  </>
                )}
              </div>

              <form
                {...dropProps}
                className={cn(
                  "relative flex items-center gap-2 border-t p-3 transition-colors",
                  // 拖着图片进入时整条输入区高亮，明确「松手就传到这里」
                  dragging && "bg-primary/5 ring-2 ring-inset ring-primary"
                )}
                onSubmit={(e) => {
                  e.preventDefault()
                  void send()
                }}
              >
                {dragging && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/70 text-xs font-medium text-primary">
                    {t("img.dropHint")}
                  </div>
                )}
                {uploading && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-1.5 bg-background/70 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("img.uploading")}
                  </div>
                )}
                {/* 表情与表情包（与社区同一套组件）。放在输入框左侧，
                    点一下把内容插到光标处 —— 发出去就是一段带表情的消息 */}
                <EmojiPicker onPick={insertEmoji} />
                <StickerPanel onPick={insertEmoji} />
                <Input
                  ref={inputRef}
                  className="flex-1"
                  placeholder={t("dmsg.inputPlaceholder")}
                  value={text}
                  maxLength={2000}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button type="submit" disabled={sending || !text.trim()}>
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
