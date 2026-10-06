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
 *
 * 流畅性（2026-10-05 与聊天室一起借鉴 Telegram 改造）：乐观发送状态机、
 * 回到底部按钮 + 新消息计数、日期分组、引用回复（含点引用跳回）、
 * 撤回、对端「正在输入」、按会话草稿。
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, ArrowDown, Loader2, MessageSquarePlus, Send, Users, Copy, Plus, Quote, Undo2, AlertCircle, PenLine, X, Forward } from "lucide-react"
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
import { DraftImagePreview } from "@/components/draft-image-preview"
import { chatApi, dmApi, stickerApi, errMsg, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { useImageDrop } from "@/hooks/use-image-drop"
import {
  applyReactionToggle,
  dayKeyOf,
  dayLabel,
  newClientId,
  QUICK_REACTIONS,
  removeImageFromBody,
  smoothScrollToBottom,
  summarizeBody,
} from "@/lib/chat-fluent"
import ChatPage from "@/pages/chat"
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
  /** 右侧是否显示「公共聊天室」（用户反馈 2026-10-03：私信列表固定聊天室入口 + 右侧直接聊） */
  const [showChat, setShowChat] = React.useState(false)
  /**
   * 对端信息（含昵称 / hasAvatar）。消息表里只有 userId，头像与昵称得从
   * `list` 返回的 peer 上取 —— 之前这里硬编码了 hasAvatar=false/nickname=null，
   * 结果上传过头像的用户在私信里也显示成首字母（2026-10-01 站长反馈）。
   */
  const [peer, setPeer] = React.useState<DmPeer | null>(null)
  const [msgLoading, setMsgLoading] = React.useState(false)
  const [text, setText] = React.useState("")
  const [sending, setSending] = React.useState(false)

  /** 右键消息弹出的菜单：复制 /（落在表情包上时）存表情包 */
  const [msgMenu, setMsgMenu] = React.useState<{
    x: number
    y: number
    msg: DmMessage
    /** 右键落在站内表情包上时的 sticker id；否则为 null */
    stickerId: string | null
  } | null>(null)
  /** 右键消息菜单自身（点菜单外关闭用） */
  const msgMenuRef = React.useRef<HTMLDivElement | null>(null)

  // ———— 2026-10-05 流畅性改造新增 ————

  /** 正在引用的消息（发送前展示在输入区上方，可取消） */
  const [quoteTarget, setQuoteTarget] = React.useState<DmMessage | null>(null)
  /** 对端是否正在输入（listDm 轮询顺带下发） */
  const [peerTyping, setPeerTyping] = React.useState(false)
  /** 「正在输入」上报节流门闩（5 秒一次） */
  const typingSentAtRef = React.useRef(0)
  /** 入场动画开关：开会话 400ms 后打开，首屏那批不跳（与聊天室同款） */
  const [animOn, setAnimOn] = React.useState(false)
  /** 点引用块跳回后的高亮目标 */
  const [flashId, setFlashId] = React.useState<string | null>(null)
  /** 是否贴着底部（state 版，渲染回底按钮用） */
  const [nearBottom, setNearBottom] = React.useState(true)
  /** 不在底部时累计的新消息数（回底按钮角标） */
  const [newCount, setNewCount] = React.useState(0)
  /** 正在编辑的消息（输入区显示编辑条；提交走编辑接口不新发） */
  const [editingMsg, setEditingMsg] = React.useState<DmMessage | null>(null)
  /** 转发面板：要转发的消息 + 目标会话（打开时懒加载，null = 加载中） */
  const [forwardMsg, setForwardMsg] = React.useState<DmMessage | null>(null)
  const [forwardTargets, setForwardTargets] = React.useState<
    { peer: { username: string; nickname: string | null; hasAvatar: boolean } }[] | null
  >(null)
  /**
   * 上一次轮询的发出时刻 —— 增量请求带 `sinceEdit`（减 2 秒重叠防时钟边界），
   * 让「编辑过 / 新被回应过」的旧消息也能回传（它们已越过 created_at 游标）。
   */
  const lastPollAtRef = React.useRef(Date.now())

  // 右键消息菜单：点别处 / 滚动 / Esc 收起（与聊天室同款）
  React.useEffect(() => {
    if (!msgMenu) return
    const onDown = (e: MouseEvent) => {
      if (msgMenuRef.current && msgMenuRef.current.contains(e.target as Node)) return
      setMsgMenu(null)
    }
    const close = () => setMsgMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMsgMenu(null)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("scroll", close, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("scroll", close, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [msgMenu])

  // 转发面板：Esc 关闭（遮罩点击关闭在 JSX 里）
  React.useEffect(() => {
    if (!forwardMsg) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setForwardMsg(null)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [forwardMsg])

  /** 复制私信正文（右键菜单） */
  const copyMessage = async (m: DmMessage) => {
    try {
      await navigator.clipboard.writeText(m.body)
      toast.success(t("chat.copied"))
    } catch {
      toast.error(t("chat.err.copy"))
    }
  }

  /** 把私信里的表情包存到自己的表情包（右键菜单） */
  const saveSticker = async (id: string) => {
    try {
      const res = await stickerApi.save(id)
      toast.success(res.alreadySaved ? t("stk.saved") : t("stk.ok.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("stk.err.save")))
    }
  }

  /** 增量轮询游标 */
  const cursorRef = React.useRef<string | null>(null)
  /**
   * 消息 id 集合的 ref 镜像（渲染后同步）。
   * 轮询判重要在**调用侧**做：setMessages updater 的副作用读值在 React
   * 已有 pending 更新时会被推迟到渲染阶段，立刻读到的计数恒为 0
   * （与聊天室 chat.tsx 同一个坑，实测「新消息进了列表、计数不涨」）。
   */
  const knownIdsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    knownIdsRef.current = new Set(messages.map((m) => m.id))
  }, [messages])
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
    setNearBottom(true)
    setNewCount(0)
    setPeerTyping(false)
    setQuoteTarget(null)
    setAnimOn(false)
    // 重置翻页游标：上一个会话的历史不该串到这里来
    prevCursorRef.current = null
    hasMoreRef.current = true
    setHasMore(true)
    // 恢复这个会话的草稿（借鉴 Telegram 按 dialog 存 draft）
    try {
      setText(localStorage.getItem(`dm:draft:${peer}`) ?? "")
    } catch {
      setText("")
    }
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
      setPeerTyping(res.peerTyping)
      // 首屏渲染完再开入场动画（400ms 后），首屏这批不跳
      window.setTimeout(() => setAnimOn(true), 400)
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

  /**
   * 增量拉新消息（静默，不动 loading）。
   *
   * 带 `sinceEdit`：编辑过 / 新被回应过的旧消息已越过 created_at 游标，服务端
   * 把它们一并回传；合并时对**已知 id 用服务端版本原位替换**（本地乐观中的
   * sending/failed 不动）—— 对方编辑了文案、点了回应，我 5 秒内就能看到。
   */
  const pollMessages = React.useCallback(async () => {
    const peer = peerRef.current
    if (!peer) return
    try {
      // 请求发出时刻作为下一轮的 sinceEdit 起点（减 2 秒重叠防时钟边界）
      const sinceEdit = new Date(lastPollAtRef.current - 2000).toISOString()
      lastPollAtRef.current = Date.now()
      const res = await dmApi.list(peer, {
        after: cursorRef.current ?? undefined,
        sinceEdit,
      })
      if (peerRef.current !== peer) return // 期间切了会话，丢弃
      setPeerTyping(res.peerTyping)
      if (res.messages.length > 0) {
        // 先在 ref 镜像上数「全新的消息」（理由见 knownIdsRef 注释）；
        // 已知 id 的替换不计数 —— 它们不是新消息，不该触发计数。
        const known = knownIdsRef.current
        const fresh = res.messages.filter((m) => !known.has(m.id))
        for (const m of fresh) known.add(m.id)
        setMessages((prev) => {
          const byId = new Map(res.messages.map((m) => [m.id, m]))
          const next: DmMessage[] = []
          for (const m of prev) {
            if (m.status) {
              // 本地「发送中/失败」的乐观气泡不被服务端版本覆盖
              next.push(m)
              continue
            }
            const freshVer = byId.get(m.id)
            if (freshVer) {
              next.push(freshVer)
              byId.delete(m.id)
            } else {
              next.push(m)
            }
          }
          for (const m of byId.values()) next.push(m)
          return next.length === prev.length && next.every((m, i) => m === prev[i])
            ? prev
            : next
        })
        cursorRef.current = res.nextCursor
        // 贴底才跟着滚（由下面的 messages effect 执行），不贴底就累计新消息计数 ——
        // 用户正翻历史时绝不打断（Telegram newUnreadMessageCount 同款）
        if (fresh.length > 0 && !stickBottomRef.current) {
          setNewCount((n) => n + fresh.length)
        }
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
   * 返回是否真的加载到了东西（点引用跳转要靠它决定要不要继续补批）。
   */
  const loadEarlier = React.useCallback(async (): Promise<boolean> => {
    const peer = peerRef.current
    if (!peer || loadingEarlierRef.current || !hasMoreRef.current) return false
    loadingEarlierRef.current = true
    setLoadingEarlier(true)

    const el = listRef.current
    const scroller = el ? findScroller(el) : null
    const prevHeight = scroller?.scrollHeight ?? 0
    const prevTop = scroller?.scrollTop ?? 0

    try {
      const res = await dmApi.list(peer, { before: prevCursorRef.current ?? undefined })
      if (peerRef.current !== peer) return false // 期间切了会话，丢弃
      if (res.messages.length === 0) {
        hasMoreRef.current = false
        setHasMore(false)
        return false
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
      return true
    } catch {
      /* 静默：翻页失败不该打断阅读，下次滚动会再试 */
      return false
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
      const near = s.scrollHeight - s.scrollTop - s.clientHeight < 48
      stickBottomRef.current = near
      setNearBottom(near) // 值不变时 React 会 bail-out，开销可忽略
      setNewCount((n) => (near ? 0 : n))
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

  /** 渲染时按本地日期分组：每遇到新的一天插一条分割线（每次渲染重置） */
  let lastDayKey = ""

  /**
   * 一条私信的作者信息（用户名 + 昵称）。
   * 私信表里只有 userId，作者要么是「我」要么是「当前对端」——从上下文推导，
   * 引用块 / 发送预览都要用它显示「引用了谁」。
   */
  const authorOf = (m: DmMessage): { username: string; nickname: string | null } => {
    if (user && m.fromUserId === user.id) {
      return { username: user.username, nickname: user.nickname ?? null }
    }
    return { username: peer?.username ?? peerName ?? "", nickname: peer?.nickname ?? null }
  }

  /**
   * 单条私信。相比改造前新增：锚点 id（点引用跳回）、入场动画、
   * hover 快捷钮（引用 / 复制）、引用块渲染、发送中 / 失败状态行。
   */
  const renderMessage = (m: DmMessage) => {
    const mine = m.fromUserId === user?.id
    const quote = m.quote
    return (
      <div
        key={m.id}
        id={`msg-${m.id}`}
        className={cn(
          "flex items-end gap-2",
          mine && "flex-row-reverse",
          animOn && "chat-msg-in",
          flashId === m.id && "chat-flash"
        )}
      >
        <UserAvatar
          username={mine ? (user?.username ?? "") : (peerName ?? "")}
          nickname={mine ? (user?.nickname ?? null) : (peer?.nickname ?? null)}
          hasAvatar={mine ? Boolean(user?.hasAvatar) : Boolean(peer?.hasAvatar)}
          className="h-6 w-6"
        />
        <div className={cn("max-w-[75%]", mine && "text-right")}>
          <div
            onContextMenu={(e) => {
              e.preventDefault()
              // 已撤回 / 乐观发送中的消息没有任何可执行操作：菜单项会被逐个过滤掉，
              // 只剩一个空白小白框（2026-10-05 站长反馈）。这里直接不弹。
              if (m.recalled || m.status) return
              // 右键落在站内表情包上时，把 sticker id 带进菜单（供「存到我的表情包」）
              const el = (e.target as HTMLElement).closest?.(
                "img.sticker-img"
              ) as HTMLImageElement | null
              const stickerId = el
                ? el.src.match(/\/api\/stickers\/([0-9a-f-]{36})\/image/)?.[1] ?? null
                : null
              setMsgMenu({ x: e.clientX, y: e.clientY, msg: m, stickerId })
            }}
            className={cn(
              "inline-block max-w-full break-words rounded-lg px-3 py-2 text-sm text-left",
              // `bubble-mine` 只是给 CSS 挂钩子：主色底上的链接要跟随前景色，
              // 否则 `.markdown-body a { color: var(--primary) }` 会「同色隐形」。
              mine ? "bubble-mine bg-primary text-primary-foreground" : "bg-muted",
              m.status === "sending" && "opacity-60",
              m.status === "failed" && "ring-1 ring-destructive"
            )}
          >
            {/* 转发来源标注（纯展示） */}
            {m.forwardFrom && !m.recalled && (
              <div
                className={cn(
                  "mb-1 flex items-center gap-1 text-xs",
                  mine ? "text-primary-foreground/70" : "text-muted-foreground"
                )}
              >
                <Forward className="h-3 w-3" />
                <span className="truncate">
                  {t("chat.forwardedFrom", {
                    name: m.forwardFrom.nickname || m.forwardFrom.username,
                  })}
                </span>
              </div>
            )}
            {/* 引用块：点它跳回被引消息并高亮 */}
            {quote && !m.recalled && (
              <div
                onClick={() => void jumpToQuoted(quote.id)}
                title={t("chat.ctx.jump")}
                className={cn(
                  "mb-1.5 cursor-pointer rounded border-l-2 px-2 py-1 text-xs text-left transition-opacity hover:opacity-75",
                  mine
                    ? "border-primary-foreground/40 bg-primary-foreground/10"
                    : "border-primary/40 bg-background/60"
                )}
              >
                <span className="font-medium">
                  {quote.nickname || quote.username}
                </span>
                <span className={cn("ml-1", mine ? "text-primary-foreground/80" : "text-muted-foreground")}>
                  {quote.recalled ? t("chat.recalled") : summarizeBody(quote.body, t)}
                </span>
              </div>
            )}
            {m.recalled ? (
              <span className={cn("italic", mine ? "text-primary-foreground/70" : "text-muted-foreground")}>
                {t("chat.recalled")}
              </span>
            ) : (
              /* 用 Markdown 渲染：表情包插进来的是 `![](/api/stickers/<id>/image)`，
                  纯文本渲染会把它原样显示成一行字（2026-10-02 反馈）。
                  换行由 remarkBreaks 负责，所以这里不再加 whitespace-pre-wrap。 */
              <Markdown stickerSaveButton={false}>{m.body}</Markdown>
            )}
          </div>
          {/* 表情回应胶囊：紧贴气泡下方，mine 高亮；点一下 toggle（本地即时反馈） */}
          {!m.recalled && (m.reactions?.length ?? 0) > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {(m.reactions ?? []).map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  title={r.names.join(", ")}
                  onClick={() => void toggleReaction(m, r.emoji)}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition-colors",
                    r.mine
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-background/70 hover:bg-accent"
                  )}
                >
                  <span>{r.emoji}</span>
                  <span className="font-medium">{r.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
            {mine && m.status === "sending" && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{relTime(m.createdAt)}</span>
              </>
            )}
            {mine && m.status === "failed" && (
              <>
                <button
                  type="button"
                  onClick={() => void retrySend(m)}
                  className="flex items-center gap-1 font-medium text-destructive transition-colors hover:underline"
                >
                  <AlertCircle className="h-3 w-3" />
                  {t("chat.sendFailed")}
                </button>
                <button
                  type="button"
                  onClick={() => editFailed(m)}
                  title={t("chat.ctx.edit")}
                  className="transition-colors hover:text-foreground"
                >
                  <PenLine className="h-3 w-3" />
                </button>
              </>
            )}
            {mine && !m.status && (
              <>
                {relTime(m.createdAt)}
                {m.editedAt ? ` · ${t("chat.edited")}` : ""}
                {m.readAt ? t("dmsg.read") : ""}
              </>
            )}
            {!mine && (
              <span>
                {relTime(m.createdAt)}
                {m.editedAt ? ` · ${t("chat.edited")}` : ""}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

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

  /**
   * 乐观消息对账：本地「发送中」气泡 → 服务端确认的真消息。
   * 三种情形与聊天室 settleOptimistic 一致（原位替换 / 去重删 temp / 补到末尾）。
   */
  const settleOptimistic = React.useCallback((tempId: string, real: DmMessage) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === tempId)
      const hasReal = prev.some((m) => m.id === real.id)
      if (idx === -1) return hasReal ? prev : [...prev, real]
      if (hasReal) return prev.filter((_m, i) => i !== idx)
      const next = [...prev]
      next[idx] = real
      return next
    })
  }, [])

  /**
   * 发私信：乐观插入「发送中」气泡（借鉴 Telegram send_state 状态机）。
   * clientId 幂等键保证超时重发 / 双击只落一行；失败标 failed、点气泡重试。
   */
  const send = async () => {
    const body = text.trim()
    // ⚠️ 局部叫 peerNameStr：不能叫 peer —— 会遮蔽 state 里的 DmPeer 对象
    const peerNameStr = peerRef.current
    if (!peerNameStr || !body) return
    if (!user) return
    // 编辑模式：提交 = 改原消息（不新发）。内容没变就直接退出编辑。
    if (editingMsg) {
      const target = editingMsg
      if (body === target.body) {
        cancelEdit()
        return
      }
      setSending(true)
      try {
        const res = await dmApi.edit(target.id, body)
        setMessages((prev) => prev.map((x) => (x.id === target.id ? res.message : x)))
        setEditingMsg(null)
        setText("")
        clearDraft(peerNameStr)
      } catch (err) {
        if (err instanceof HttpError) toast.error(err.message)
        else toast.error(t("chat.err.edit"))
      } finally {
        setSending(false)
      }
      return
    }
    const clientId = newClientId()
    const tempId = `temp-${clientId}`
    const quoted = quoteTarget
    const quotedAuthor = quoted ? authorOf(quoted) : null
    const optimistic: DmMessage = {
      id: tempId,
      clientId,
      fromUserId: user.id,
      toUserId: peer?.id ?? "",
      body,
      createdAt: new Date().toISOString(),
      readAt: null,
      replyTo: quoted?.id ?? null,
      quote: quoted && quotedAuthor
        ? {
            id: quoted.id,
            username: quotedAuthor.username,
            nickname: quotedAuthor.nickname,
            recalled: false,
            body: quoted.recalled ? "" : quoted.body.slice(0, 200),
          }
        : null,
      status: "sending",
    }
    setMessages((prev) => [...prev, optimistic])
    stickBottomRef.current = true
    setNearBottom(true)
    setNewCount(0)
    scrollToBottom()
    setText("")
    setQuoteTarget(null)
    clearDraft(peerNameStr)
    setSending(true)
    try {
      const res = await dmApi.send(peerNameStr, body, {
        replyTo: quoted?.id ?? null,
        clientId,
      })
      settleOptimistic(tempId, res.message)
      void loadConversations()
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, status: "failed" as const } : m))
      )
      if (err instanceof HttpError) toast.error(err.message)
      else toast.error(t("dmsg.err.send"))
    } finally {
      setSending(false)
    }
  }

  /** 失败气泡重发：沿用同一个 clientId（服务端幂等，不会写重复） */
  const retrySend = async (m: DmMessage) => {
    if (!m.clientId) return
    const peer = peerRef.current
    if (!peer) return
    setMessages((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, status: "sending" as const } : x))
    )
    setSending(true)
    try {
      const res = await dmApi.send(peer, m.body, {
        replyTo: m.replyTo ?? null,
        clientId: m.clientId,
      })
      settleOptimistic(m.id, res.message)
      void loadConversations()
    } catch (err) {
      setMessages((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, status: "failed" as const } : x))
      )
      if (err instanceof HttpError) toast.error(err.message)
      else toast.error(t("dmsg.err.send"))
    } finally {
      setSending(false)
    }
  }

  /** 失败气泡的「取回编辑」：内容放回输入框、删掉失败气泡 */
  const editFailed = (m: DmMessage) => {
    setMessages((prev) => prev.filter((x) => x.id !== m.id))
    setText(m.body)
    if (peerRef.current) saveDraft(peerRef.current, m.body)
    inputRef.current?.focus()
  }

  /**
   * 表情回应开关：右键菜单顶部那排表情、或点气泡下的胶囊。
   * 服务端 toggle 返回 active，本地据此增减（不用等 5 秒轮询回传）。
   */
  const toggleReaction = async (m: DmMessage, emoji: string) => {
    if (m.status || m.recalled) return
    const expectActive = !(m.reactions ?? []).find((r) => r.emoji === emoji)?.mine
    const before = m.reactions ?? []
    setMessages((prev) =>
      prev.map((x) =>
        x.id === m.id
          ? { ...x, reactions: applyReactionToggle(x, emoji, expectActive, user?.username ?? "") }
          : x
      )
    )
    try {
      const res = await dmApi.react(m.id, emoji)
      // 服务端确认：以请求前的基线 + active 重算（幂等校准，防并发双击算歪）
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id
            ? {
                ...x,
                reactions: applyReactionToggle(
                  { ...x, reactions: before },
                  emoji,
                  res.active,
                  user?.username ?? ""
                ),
              }
            : x
        )
      )
    } catch (err) {
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, reactions: before } : x)))
      toast.error(errMsg(err, t("chat.err.react")))
    }
  }

  /** 右键「编辑」：正文放回输入框，提交时走编辑接口（不新发消息） */
  const startEdit = (m: DmMessage) => {
    if (!m.body || m.recalled || m.status) return
    setEditingMsg(m)
    setQuoteTarget(null)
    setText(m.body)
    const pos = m.body.length
    window.setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  /** 取消编辑：输入框恢复空，草稿同步清掉 */
  const cancelEdit = () => {
    setEditingMsg(null)
    setText("")
    if (peerRef.current) clearDraft(peerRef.current)
  }

  /** 右键「转发」：打开目标选择（公共聊天室 + 其他会话），会话列表懒加载一次 */
  const startForward = (m: DmMessage) => {
    if (m.recalled || m.status || !m.body) return
    setForwardMsg(m)
    setForwardTargets(null)
    void dmApi
      .conversations()
      .then((res) =>
        setForwardTargets(
          res.conversations.filter((c) => c.peer.username !== peerRef.current)
        )
      )
      .catch(() => setForwardTargets([]))
  }

  /** 执行转发：正文由服务端取来源消息，这里只带来源 id（dm 消息 → "dm:<id>"） */
  const doForward = async (target: { peer: { username: string } } | "chat") => {
    const m = forwardMsg
    if (!m) return
    const source = `dm:${m.id}`
    try {
      if (target === "chat") {
        await chatApi.send(m.body, { forwardFrom: source })
      } else {
        await dmApi.send(target.peer.username, m.body, { forwardFrom: source })
      }
      setForwardMsg(null)
      toast.success(t("chat.forwardedToast"))
    } catch (err) {
      toast.error(errMsg(err, t("chat.err.forward")))
    }
  }

  /** 撤回自己的消息（右键菜单；10 分钟外后端会拒绝并给出提示） */
  const recallMessage = async (m: DmMessage) => {
    try {
      await dmApi.recall(m.id)
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id
            ? { ...x, recalled: true, body: "", replyTo: null, quote: null }
            : x
        )
      )
      toast.success(t("chat.recalledToast"))
    } catch (err) {
      toast.error(errMsg(err, t("dmsg.err.recall")))
    }
  }

  /**
   * 点引用块 → 跳回被引消息并高亮。目标没加载时最多往前补 3 批历史。
   */
  const jumpToQuoted = async (quoteId: string) => {
    for (let i = 0; i < 3; i++) {
      if (document.getElementById(`msg-${quoteId}`)) break
      if (!hasMoreRef.current) break
      const got = await loadEarlier()
      if (!got) break
    }
    const target = document.getElementById(`msg-${quoteId}`)
    if (!target) return
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" })
    setFlashId(quoteId)
    window.setTimeout(() => setFlashId((f) => (f === quoteId ? null : f)), 900)
  }

  /** 「回到底部」：平滑滚动（时长按距离映射，参数抄 Telegram），用户滚动即打断 */
  const jumpBottom = () => {
    stickBottomRef.current = true
    setNearBottom(true)
    setNewCount(0)
    smoothScrollToBottom(listRef.current)
    window.setTimeout(() => {
      if (stickBottomRef.current) scrollToBottom()
    }, 1400)
  }

  /** 「我正在给对端打字」：5 秒节流上报，对端靠 list 轮询看到 */
  const notifyTyping = React.useCallback(() => {
    const peer = peerRef.current
    if (!peer || !user) return
    const now = Date.now()
    if (now - typingSentAtRef.current < 5000) return
    typingSentAtRef.current = now
    void dmApi.typing(peer).catch(() => {})
  }, [user])

  // ———— 草稿：按会话存本地（借鉴 Telegram 的 per-dialog draft）————
  const saveDraft = React.useCallback((peer: string, value: string) => {
    try {
      if (value) localStorage.setItem(`dm:draft:${peer}`, value)
      else localStorage.removeItem(`dm:draft:${peer}`)
    } catch {
      /* 隐私模式写不了就算了 */
    }
  }, [])
  const clearDraft = React.useCallback(
    (peer: string) => {
      saveDraft(peer, "")
    },
    [saveDraft]
  )

  return (
    <div>
      <PageHeader title={t("dmsg.title")} description={t("dmsg.desc")} />

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        {/* 左：会话列表 + 找人 */}
        <aside className="space-y-3">
          {/* 公共聊天室固定入口（用户反馈 2026-10-03）：始终钉在列表最上面 */}
          <button
            type="button"
            onClick={() => {
              setShowChat(true)
              navigate("/dashboard/dm")
            }}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent",
              showChat && "border-primary bg-accent"
            )}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Users className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t("dmsg.publicChat")}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {t("dmsg.publicChatHint")}
              </span>
            </div>
          </button>

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
                      {summarizeBody(r.body, t) || t("dmsg.req.noBody")}
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
                      onClick={() => setShowChat(false)}
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
                          {summarizeBody(c.last.body, t)}
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
        {/* relative：「回到底部」悬浮钮锚在这里，不随消息内容滚走 */}
        <section className="relative flex max-h-[calc(100vh-10rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border">
          {showChat ? (
            <div className="flex-1 overflow-hidden p-4">
              <ChatPage embedded />
            </div>
          ) : !peerName ? (
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
                {/* 对端「正在输入」：list 轮询顺带下发，过期自动消失 */}
                {peerTyping && (
                  <span className="animate-pulse text-xs text-primary">{t("dmsg.typing")}</span>
                )}
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
              {/* 包一层 relative：回底按钮锚这里；内层才是真正的滚动容器 */}
              <div className="relative min-h-0 flex-1">
                <div
                  ref={listRef}
                  className={cn(
                    "h-full space-y-3 overflow-y-auto p-4",
                    // 首屏那批不播入场动画（animOn 打开后新挂载的才有）
                    !animOn && "no-enter-anim"
                  )}
                >
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
                    {/* 按本地日期分桶插分割线（借鉴 Telegram 的 dateKey 分组） */}
                    {messages.flatMap((m) => {
                      const rows: React.ReactNode[] = []
                      const dk = dayKeyOf(m.createdAt)
                      if (dk !== lastDayKey) {
                        lastDayKey = dk
                        rows.push(
                          <div key={`day-${dk}`} className="flex justify-center py-1">
                            <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
                              {dayLabel(m.createdAt, t)}
                            </span>
                          </div>
                        )
                      }
                      rows.push(renderMessage(m))
                      return rows
                    })}
                  </>
                )}
                </div>
                {/* 「回到底部」悬浮钮：不在底部才出现，带新消息计数（与聊天室同款） */}
                {!msgLoading && messages.length > 0 && !nearBottom && (
                  <button
                    type="button"
                    onClick={jumpBottom}
                    className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover px-3 py-1.5 text-xs font-medium shadow-lg transition-colors hover:bg-accent"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                    {newCount > 0 ? t("chat.newMessages", { n: newCount }) : t("chat.jumpToBottom")}
                    {newCount > 0 && (
                      <span className="ml-0.5 rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                        {newCount > 99 ? "99+" : newCount}
                      </span>
                    )}
                  </button>
                )}
              </div>

              {/* 编辑条：正在改一条旧消息（与引用条互斥 —— 进编辑会清掉引用） */}
              {editingMsg && (
                <div className="flex items-start gap-2 border-t bg-muted/50 px-3 py-1.5 text-xs">
                  <PenLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{t("chat.editing")}</span>
                    <span className="ml-1 break-all text-muted-foreground">
                      {summarizeBody(editingMsg.body, t).slice(0, 120)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title={t("common.cancel")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {/* 引用预览：发送前展示「正在引用谁」，可取消（Esc 也行） */}
              {!editingMsg && quoteTarget && (
                <div className="flex items-start gap-2 border-t bg-muted/50 px-3 py-1.5 text-xs">
                  <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">
                      {authorOf(quoteTarget).nickname || authorOf(quoteTarget).username}
                    </span>
                    <span className="ml-1 break-all text-muted-foreground">
                      {quoteTarget.recalled ? t("chat.recalled") : summarizeBody(quoteTarget.body, t).slice(0, 120)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQuoteTarget(null)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title={t("common.cancel")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* 表情包/图片实时预览：发送前看到真实缩略图（点图放大、× 移除） */}
              <DraftImagePreview
                text={text}
                className="mx-3 mt-2"
                onRemove={(url) => {
                  const next = removeImageFromBody(text, url)
                  setText(next)
                  if (peerRef.current) saveDraft(peerRef.current, next)
                }}
              />
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
                  onChange={(e) => {
                    setText(e.target.value)
                    // 草稿即时落盘（按会话）+「正在输入」5 秒节流上报
                    if (peerRef.current) saveDraft(peerRef.current, e.target.value)
                    if (e.target.value.trim()) notifyTyping()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && editingMsg) {
                      e.preventDefault()
                      cancelEdit()
                      return
                    }
                    if (e.key === "Escape" && quoteTarget) {
                      e.preventDefault()
                      setQuoteTarget(null)
                    }
                  }}
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

      {/* 右键消息的菜单：顶部一排常用表情（点即回应），下面引用 / 编辑 / 复制 /
          存表情包 / 转发 / 撤回 —— 与聊天室同一套平铺结构，不搞二级面板。 */}
      {msgMenu &&
        createPortal(
          <div
            ref={msgMenuRef}
            className="fixed z-50 w-52 rounded-lg border bg-popover p-1 shadow-lg"
            style={{
              top: Math.max(8, Math.min(msgMenu.y, window.innerHeight - 300)),
              left: Math.max(8, Math.min(msgMenu.x, window.innerWidth - 218)),
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* 表情回应行：未撤回、非乐观气泡、已登录时才给 */}
            {Boolean(user) && !msgMenu.msg.recalled && !msgMenu.msg.status && (
              <div className="mb-1 flex flex-wrap gap-0.5 border-b px-1 pb-1.5 pt-1">
                {QUICK_REACTIONS.map((e) => {
                  const active = (msgMenu.msg.reactions ?? []).find(
                    (r) => r.emoji === e
                  )?.mine
                  return (
                    <button
                      key={e}
                      type="button"
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => {
                        const m = msgMenu.msg
                        setMsgMenu(null)
                        void toggleReaction(m, e)
                      }}
                      title={t("chat.ctx.react")}
                      className={cn(
                        "rounded-md px-1.5 py-1 text-lg leading-none transition-colors hover:bg-accent",
                        active && "bg-primary/15 ring-1 ring-primary"
                      )}
                    >
                      {e}
                    </button>
                  )
                })}
              </div>
            )}
            {!msgMenu.msg.recalled && !msgMenu.msg.status && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuoteTarget(msgMenu.msg)
                  setMsgMenu(null)
                  inputRef.current?.focus()
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <Quote className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("chat.ctx.quote")}
              </button>
            )}
            {Boolean(user) &&
              msgMenu.msg.fromUserId === user!.id &&
              !msgMenu.msg.recalled &&
              !msgMenu.msg.status && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const m = msgMenu.msg
                    setMsgMenu(null)
                    startEdit(m)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <PenLine className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {t("chat.ctx.editMsg")}
                </button>
              )}
            {!msgMenu.msg.recalled && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const m = msgMenu.msg
                  setMsgMenu(null)
                  void copyMessage(m)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <Copy className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("chat.ctx.copy")}
              </button>
            )}
            {Boolean(user) && msgMenu.stickerId && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const id = msgMenu.stickerId!
                  setMsgMenu(null)
                  void saveSticker(id)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("stk.save")}
              </button>
            )}
            {Boolean(user) && !msgMenu.msg.recalled && !msgMenu.msg.status && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const m = msgMenu.msg
                  setMsgMenu(null)
                  startForward(m)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <Forward className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("chat.ctx.forward")}
              </button>
            )}
            {/* 撤回：只有自己的未撤回消息；10 分钟时限由后端裁决（超时弹错误） */}
            {Boolean(user) &&
              msgMenu.msg.fromUserId === user!.id &&
              !msgMenu.msg.recalled &&
              !msgMenu.msg.status && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const m = msgMenu.msg
                    setMsgMenu(null)
                    void recallMessage(m)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-accent"
                >
                  <Undo2 className="h-4 w-4 shrink-0" />
                  {t("chat.ctx.recall")}
                </button>
              )}
          </div>,
          document.body
        )}

      {/* 转发面板：目标 = 公共聊天室 + 其他会话（当前会话自己排除） */}
      {forwardMsg &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setForwardMsg(null)}
          >
            <div
              className="w-80 max-h-[70vh] overflow-y-auto rounded-lg border bg-popover p-3 shadow-xl"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">{t("chat.forwardTitle")}</p>
                <button
                  type="button"
                  onClick={() => setForwardMsg(null)}
                  className="text-muted-foreground hover:text-foreground"
                  title={t("common.cancel")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {/* 待转发内容预览 */}
              <p className="mb-2 line-clamp-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                {summarizeBody(forwardMsg.body, t)}
              </p>
              <div className="space-y-1">
                {/* 公共聊天室目标 */}
                <button
                  type="button"
                  onClick={() => void doForward("chat")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Users className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t("dmsg.publicChat")}</span>
                </button>
                {/* 私信会话目标 */}
                {forwardTargets === null ? (
                  <div className="flex justify-center py-3">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : forwardTargets.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground">
                    {t("chat.forwardEmpty")}
                  </p>
                ) : (
                  forwardTargets.map((c) => (
                    <button
                      key={c.peer.username}
                      type="button"
                      onClick={() => void doForward(c)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                    >
                      <UserAvatar
                        username={c.peer.username}
                        nickname={c.peer.nickname}
                        hasAvatar={c.peer.hasAvatar}
                        className="h-6 w-6 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {c.peer.nickname || c.peer.username}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        @{c.peer.username}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
