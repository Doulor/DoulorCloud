/**
 * 公共聊天室。
 *
 * 实时性：5 秒轮询新消息（且只在页面可见时轮询，见 src/lib/visible-interval.ts）；
 * 在线：每 60 秒心跳一次。
 * 登录后可发言；未登录只能看（发送会引导登录）。
 *
 * 流畅性（2026-10-05 借鉴 Telegram Android 源码逻辑改造）：
 *   · 乐观发送 —— 先本地出「发送中」气泡，服务端确认后原位替换，失败可重试
 *     （SendMessagesHelper 的 send_state 状态机）；
 *   · 智能贴底 —— 只有用户本来就贴着底部才自动吸底，否则累计「N 条新消息」
 *     的回到底部按钮（ChatActivity L26061 的 diff≤5dp 判据）；
 *   · 向上翻页 —— 滑到顶自动加载更早的消息并补偿滚动位置（checkScrollForLoad）；
 *   · 日期分组、typing 指示（5 秒节流）、草稿本地保存、点引用跳回原消息。
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Send, Loader2, Users, AtSign, Copy, Quote, Undo2, CornerDownLeft, X, Plus, ArrowDown, AlertCircle, PenLine, Forward } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { UserAvatar } from "@/components/user-avatar"
import { UserCardPopover } from "@/components/user-card"
import { AnchoredPanel } from "@/components/anchored-panel"
import { EmojiPicker } from "@/components/emoji-picker"
import { StickerPanel } from "@/components/sticker-panel"
import { Markdown } from "@/components/markdown"
import { DraftImagePreview } from "@/components/draft-image-preview"
import { useAuth } from "@/hooks/use-auth"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { useImageDrop } from "@/hooks/use-image-drop"
import { chatApi, dmApi, stickerApi, errMsg, HttpError } from "@/services/api"
import { cn } from "@/lib/utils"
import { relTime } from "@/lib/format"
import { setVisibleInterval } from "@/lib/visible-interval"
import {
  applyReactionToggle,
  dayKeyOf,
  dayLabel,
  isNearBottom,
  jumpToBottom,
  newClientId,
  QUICK_REACTIONS,
  smoothScrollToBottom,
  summarizeBody,
} from "@/lib/chat-fluent"
import type { ChatMessage, ChatPresenceUser } from "@/types"
import { useT } from "@/i18n"

/** 候选面板尺寸（宽固定；高按候选条数算，见 mentionPanelHeight） */
const MENTION_PANEL_WIDTH = 260
/** 最多同时显示多少个候选人 */
const MENTION_MAX = 6

/**
 * 这条消息是不是在艾特我。
 *
 * 用「子串 + 边界」而不是 `includes("@me")`：否则 `@ann` 这类**更长的用户名**
 * 会把叫 `ann` 的人误判成被艾特（用户名允许连字符/数字，所以边界就是
 * 「不能再跟用户名字符」）。大小写不敏感，因为用户名统一小写但用户可能输大写。
 */
function mentionsMe(body: string, username: string): boolean {
  if (!username) return false
  const hay = body.toLowerCase()
  const needle = "@" + username.toLowerCase()
  let idx = hay.indexOf(needle)
  while (idx !== -1) {
    const after = hay[idx + needle.length] ?? ""
    if (!/[a-z0-9_-]/.test(after)) return true
    idx = hay.indexOf(needle, idx + 1)
  }
  return false
}

/**
 * 光标前是不是一个「正在输入的 @提及」。
 * 是则返回它的起始下标与已敲的查询词（`@` 之后到光标之间的内容）。
 *
 * 两个刻意的限制：
 *   · `@` 必须位于开头或紧跟空白 —— 否则 `a@b.com` 这种邮箱会被当成提及；
 *   · 提及中间不允许空白 —— 敲了空格就说明这个词已经写完了。
 */
function mentionAtCaret(value: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = value[i]
    if (ch === "@") {
      if (i === 0 || /\s/.test(value[i - 1])) {
        return { start: i, query: value.slice(i + 1, caret) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

export default function ChatPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useT()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [online, setOnline] = React.useState<ChatPresenceUser[]>([])
  const [draft, setDraft] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  /** 首屏加载失败（用于区分「加载失败」与「真的还没人发言」） */
  const [failed, setFailed] = React.useState(false)
  /**
   * 聊天室被管理员关闭（后端 403 CHAT_DISABLED）。
   * 置位后**停止一切轮询与心跳** —— 2026-09-30 额度告急时，关闭状态下的
   * 每次轮询虽然只花 1 行读，但完全不发才是最省的。
   */
  const [chatOff, setChatOff] = React.useState(false)
  /** 艾特候选面板是否打开（输入框里正敲到一个 `@xxx` 时打开） */
  const [mentionOpen, setMentionOpen] = React.useState(false)
  /** 当前 `@` 之后已敲的内容，用来过滤候选人 */
  const [mentionQuery, setMentionQuery] = React.useState("")
  /** 键盘高亮的候选下标 */
  const [mentionIndex, setMentionIndex] = React.useState(0)
  /** 右键头像弹出的「艾特」快捷菜单：位置 + 目标用户 */
  const [ctxMenu, setCtxMenu] = React.useState<{
    x: number
    y: number
    user: ChatPresenceUser
  } | null>(null)

  /**
   * 右键消息弹出的菜单：顶部一排常用表情（点即回应），下面依次是
   * 引用 / 编辑 / 复制 / 转发 / 撤回（各按权限与消息状态显隐）。
   */
  const [msgMenu, setMsgMenu] = React.useState<{
    x: number
    y: number
    msg: ChatMessage
    /** 右键落在站内表情包上时的 sticker id；否则为 null */
    stickerId: string | null
  } | null>(null)
  /** 正在引用的消息（发送前展示在输入框上方） */
  const [quoteTarget, setQuoteTarget] = React.useState<ChatMessage | null>(null)
  /** 正在编辑的消息（输入区显示编辑条；提交走编辑接口而不是新发） */
  const [editingMsg, setEditingMsg] = React.useState<ChatMessage | null>(null)
  /** 转发面板：要转发的消息 + 目标会话（打开时懒加载，null = 加载中） */
  const [forwardMsg, setForwardMsg] = React.useState<ChatMessage | null>(null)
  const [forwardTargets, setForwardTargets] = React.useState<
    { peer: { username: string; nickname: string | null; hasAvatar: boolean } }[] | null
  >(null)
  /**
   * Enter 行为偏好：true = Enter 发送、Shift+Enter 换行（默认，符合聊天习惯）；
   * false = Enter 换行、Ctrl/Cmd+Enter 发送（想用 Enter 排版 markdown 列表时切这个）。
   * 存 localStorage（纯前端偏好，不上服务端）。
   */
  const [enterToSend, setEnterToSend] = React.useState(() => {
    try {
      return localStorage.getItem("chat:enterToSend") !== "0"
    } catch {
      return true
    }
  })

  // ———— 2026-10-05 流畅性改造新增的状态 ————

  /** 往前翻页游标（更早的消息）；null = 还没拿过首屏 */
  const [hasMore, setHasMore] = React.useState(false)
  /** 正在加载更早的消息（顶部提示行用） */
  const [loadingEarlier, setLoadingEarlier] = React.useState(false)
  /**
   * `hasMore` 的 ref 镜像 —— 滚动监听读它而不是 state（与私信同一个坑：
   * onScroll 闭包可能持有过期 state，2026-10-02 私信实测踩过）。
   */
  const hasMoreRef = React.useRef(false)
  /** 翻页请求单飞标志（滚动事件很密集） */
  const loadingEarlierRef = React.useRef(false)
  /** 用户是否贴着底部 —— 决定新消息要不要自动吸底（state 版供渲染用） */
  const [nearBottom, setNearBottom] = React.useState(true)
  /** 贴底判断的 ref 镜像（轮询回调里读它，避免闭包过期） */
  const stickBottomRef = React.useRef(true)
  /** 不在底部时累计的新消息数（回到底部按钮的角标） */
  const [newCount, setNewCount] = React.useState(0)
  /** 窗口内正在输入的人（消息轮询顺带下发） */
  const [typingUsers, setTypingUsers] = React.useState<ChatPresenceUser[]>([])
  /** typing 上报节流门闩（5 秒一次，抄 Telegram lastTypingTimeSend） */
  const typingSentAtRef = React.useRef(0)
  /**
   * 入场动画开关：首屏那一批渲染完再打开 —— 否则一进聊天室几十条一起跳。
   * 打开后**新挂载**的消息才带动画（key 是消息 id，旧消息重渲染不重放）。
   */
  const [animOn, setAnimOn] = React.useState(false)
  /** 点引用块跳回原消息后的高亮目标（900ms 后清除） */
  const [flashId, setFlashId] = React.useState<string | null>(null)
  /**
   * 上一次轮询的发出时刻 —— 增量请求带 `sinceEdit`（减 2 秒重叠防时钟边界），
   * 让「编辑过 / 新被回应过」的旧消息也能回传（它们已越过 created_at 游标）。
   */
  const lastPollAtRef = React.useRef(Date.now())

  const listRef = React.useRef<HTMLDivElement>(null)
  const lastIdRef = React.useRef<string | null>(null)
  /** 往前翻页游标（prevCursor，喂给 before 参数） */
  const prevCursorRef = React.useRef<string | null>(null)
  /**
   * 消息 id 集合的 ref 镜像（渲染后同步）。
   *
   * ⚠️ 轮询里判重**不能**靠 setMessages updater 的副作用返回值：
   * React 在同一批已有 pending 更新时（比如先调了 setTypingUsers）
   * 会把 updater 推迟到渲染阶段才执行，调用方立刻读到的计数还是 0 ——
   * 实测表现为「新消息进了列表，但回底角标与贴底判断全都没触发」。
   */
  const knownIdsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    knownIdsRef.current = new Set(messages.map((m) => m.id))
  }, [messages])
  /** 发言输入框：表情/表情包要插到光标处 */
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  /** 右键菜单自身，用于「点菜单外关闭」判断 */
  const ctxRef = React.useRef<HTMLDivElement | null>(null)
  /** 右键消息菜单自身 */
  const msgMenuRef = React.useRef<HTMLDivElement | null>(null)

  // 表情与表情包都插到光标处（与社区、私信共用同一个 hook）
  const insertEmoji = useEmojiInsert(inputRef, draft, setDraft)

  /** 拖入 / 粘贴图片：上传后把 `![](url)` 插到光标处 */
  const { dragging, uploading, dropProps } = useImageDrop({
    onImage: insertEmoji,
    disabled: chatOff,
  })

  /**
   * 可艾特的人：**在线的人优先**，其后补上「已经在本屏说过话的人」。
   *
   * 为什么不去后端拉一份全站用户名：聊天室的场景几乎都是「艾特正在这儿的人」，
   * 在线列表（每 30 秒已经轮询着）就是最贴切的来源，而且不用新开接口。
   * 说话的人列表还有一层作用：刚发言完就下线的人，你也还能艾特到他。
   */
  const mentionCandidates = React.useMemo(() => {
    const map = new Map<string, ChatPresenceUser>()
    for (const u of online) map.set(u.username, u)
    for (const m of messages) {
      if (!map.has(m.username)) {
        map.set(m.username, {
          userId: m.userId,
          username: m.username,
          nickname: m.nickname,
          hasAvatar: m.hasAvatar,
        })
      }
    }
    const me = user?.username?.toLowerCase() ?? ""
    return [...map.values()].filter((u) => u.username.toLowerCase() !== me)
  }, [online, messages, user])

  /** 按查询词过滤后的候选（上限 6 条，面板高度就按它算） */
  const mentionMatches = React.useMemo(() => {
    const q = mentionQuery.trim().toLowerCase()
    if (!q) return mentionCandidates.slice(0, MENTION_MAX)
    /**
     * 排序而不是只过滤：敲 `@li` 时 `liuli`（前缀命中）应该压过 `weduolijia`
     * （只是包含）。不然常见的短前缀会被一堆无关的人挤在前面，反而选不到想找的。
     */
    return mentionCandidates
      .map((u) => {
        const un = u.username.toLowerCase()
        const nk = (u.nickname ?? "").toLowerCase()
        const rank = un.startsWith(q)
          ? 0
          : nk.startsWith(q)
            ? 1
            : un.includes(q)
              ? 2
              : nk.includes(q)
                ? 3
                : -1
        return { u, rank }
      })
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MENTION_MAX)
      .map((x) => x.u)
  }, [mentionCandidates, mentionQuery])

  const mentionPanelHeight =
    32 + Math.max(mentionMatches.length, 1) * 38 + 8

  /**
   * 输入框内容变化：顺手判断要不要弹艾特候选、存草稿、节流上报「正在输入」。
   * `caret` 取 `selectionStart`（刚敲完的那个字符之后）。
   */
  const handleDraftChange = (next: string, caret: number | null) => {
    setDraft(next)
    // 草稿即时落盘：切页 / 刷新回来还在（借鉴 Telegram 的 saveDraft 时机）
    if (draftKey) {
      try {
        if (next) localStorage.setItem(draftKey, next)
        else localStorage.removeItem(draftKey)
      } catch {
        /* 隐私模式下写不了就算了 */
      }
    }
    if (next.trim()) notifyTyping()
    if (!user || caret === null) {
      setMentionOpen(false)
      return
    }
    const at = mentionAtCaret(next, caret)
    // 查询词过长就不弹了：多半不是在打用户名，而是在写正文里的 `@`（如邮箱）
    if (at && at.query.length <= 32) {
      setMentionQuery(at.query)
      setMentionIndex(0)
      setMentionOpen(true)
    } else {
      setMentionOpen(false)
    }
  }

  /** 选中某个候选人：把光标前的 `@xxx` 换成 `@用户名 `，并把光标放到后面 */
  const applyMention = (u: ChatPresenceUser) => {
    const ta = inputRef.current
    const caret = ta?.selectionStart ?? draft.length
    const at = mentionAtCaret(draft, caret)
    const start = at ? at.start : caret
    const before = draft.slice(0, start)
    const after = draft.slice(caret)
    // 后面补一个空格：不然还得手动敲一下才能接着写字
    const insert = `@${u.username} `
    setDraft(before + insert + after)
    setMentionOpen(false)
    // 等 React 把新值写进 DOM 再定位光标，否则会被重置到末尾。
    // 用定时器而不是 requestAnimationFrame —— 后者在后台标签页会被暂停。
    const pos = before.length + insert.length
    window.setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  /**
   * 把 `@用户名 ` 直接插到输入框光标处（右键头像选「艾特」走这里，不走候选面板）。
   * 输入框没聚焦时插到末尾 —— 用户多半是「正看着消息、想艾特某句的人」。
   */
  const insertMentionAtCaret = (u: ChatPresenceUser) => {
    const ta = inputRef.current
    const caret =
      ta && document.activeElement === ta ? (ta.selectionStart ?? draft.length) : draft.length
    const insert = `@${u.username} `
    setDraft(draft.slice(0, caret) + insert + draft.slice(caret))
    const pos = caret + insert.length
    window.setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  // 右键菜单：点别处 / 滚动 / 按 Esc 都收起
  React.useEffect(() => {
    if (!ctxMenu) return
    const onDown = (e: MouseEvent) => {
      if (ctxRef.current && ctxRef.current.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("scroll", close, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("scroll", close, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [ctxMenu])

  // 右键消息菜单：同样「点别处 / 滚动 / Esc」收起
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

  /**
   * 点页面别处就收起候选面板。
   *
   * ⚠️ 这里**不能**用 `isInsideAnchoredPanel` 放行：那个函数认的是「任何锚定浮层」，
   * 而表情/表情包面板也是锚定浮层 —— 点它们会被当成「在面板里」而留着候选面板。
   * 所以给本面板自己打了个 `data-mention-panel` 标记，只认它。
   */
  React.useEffect(() => {
    if (!mentionOpen) return
    const onDoc = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest("[data-mention-panel]")) return
      if (inputRef.current && inputRef.current.contains(e.target as Node)) return
      setMentionOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [mentionOpen])

  // 输入框随内容自动长高（上限 160px），清空后回落 —— 支持多行/换行
  React.useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 160) + "px"
  }, [draft])

  /** mentionOpen 的 ref 镜像（轮询回调里判断「选人面板开着别滚动」，避免闭包过期） */
  const mentionOpenRef = React.useRef(false)
  React.useEffect(() => {
    mentionOpenRef.current = mentionOpen
  }, [mentionOpen])

  /**
   * 贴底吸附：跳到最新，并在图片 / 表情包异步撑高后再补两轮。
   * 第 0ms 那跳是给「setState 之后 DOM 还没提交」兜底的 —— 同步调用时
   * scrollHeight 还是旧值，setTimeout(0) 才能读到新内容。
   * 用 setTimeout 而不是 requestAnimationFrame：后台标签页里 rAF 会被暂停。
   */
  const stickToBottom = React.useCallback(() => {
    const el = listRef.current
    if (!el) return
    for (const ms of [0, 120, 350]) {
      window.setTimeout(() => jumpToBottom(el), ms)
    }
  }, [])

  /**
   * 首屏：拉最新一批消息。
   * 成功后重置贴底 / 翻页游标，并把入场动画在 400ms 后打开（首屏那批不跳）。
   */
  const loadInitial = React.useCallback(async () => {
    try {
      const res = await chatApi.list()
      setMessages(res.messages)
      setTypingUsers(res.typing ?? [])
      prevCursorRef.current = res.prevCursor
      hasMoreRef.current = res.hasMore
      setHasMore(res.hasMore)
      // 游标存「编码格式」的 nextCursor（服务端两种都能解析）；
      // 空列表时是 null，下轮按「拉最新」处理
      lastIdRef.current = res.nextCursor
      // 进入聊天室 = 从底部开始（用户反馈：进来不在最新处）
      stickBottomRef.current = true
      setNearBottom(true)
      setNewCount(0)
      stickToBottom()
      window.setTimeout(() => setAnimOn(true), 400)
    } catch (err) {
      // 管理员关了聊天室：进入「已关闭」状态，effect 会据此停掉所有轮询
      if (err instanceof HttpError && err.code === "CHAT_DISABLED") {
        setChatOff(true)
        return
      }
      // ⚠️ 2026-09-26：首屏失败要能让用户看见，否则会和「真的还没人发言」
      // 混在一起（界面显示「还没有消息，来说第一句吧」）。
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [stickToBottom])

  /**
   * 轮询增量：拉比游标新的消息。贴底才吸底，否则累计进「新消息」角标（Telegram 判据）。
   *
   * 带 `sinceEdit`：编辑过 / 新被回应过的旧消息已越过 created_at 游标，服务端
   * 把它们一并回传；合并时对**已知 id 用服务端版本原位替换**（本地乐观中的
   * sending/failed 不动）—— 这样别人编辑了文案、点了回应，我 5 秒内就能看到。
   */
  const pollNew = React.useCallback(async () => {
    try {
      // 请求发出时刻作为下一轮的 sinceEdit 起点（减 2 秒重叠防时钟边界）
      const sinceEdit = new Date(lastPollAtRef.current - 2000).toISOString()
      lastPollAtRef.current = Date.now()
      const res = await chatApi.list({
        after: lastIdRef.current ?? undefined,
        sinceEdit,
      })
      setTypingUsers(res.typing ?? [])
      if (res.messages.length === 0) return
      // 先在 ref 镜像上数出「全新的消息」（理由见 knownIdsRef 注释），
      // 已知 id 的替换不计数 —— 它们不是新消息，不该触发吸底/角标。
      const known = knownIdsRef.current
      const fresh = res.messages.filter((m) => !known.has(m.id))
      for (const m of fresh) known.add(m.id)
      setMessages((prev) => {
        const byId = new Map(res.messages.map((m) => [m.id, m]))
        const next: ChatMessage[] = []
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
        // byId 里剩下的是全新消息（含上一轮之后刚到的），按序追加
        for (const m of byId.values()) next.push(m)
        return next.length === prev.length && next.every((m, i) => m === prev[i])
          ? prev
          : next
      })
      // 推进游标只认服务端的 nextCursor；本轮全是重复（别人发的已合并过）就原地不动
      if (res.nextCursor) lastIdRef.current = res.nextCursor
      if (fresh.length === 0) return
      // 选人面板开着时不滚动：锚定浮层监听 window scroll（capture），
      // 面板开着时任何滚动都会把它收掉（老注释里的坑）
      if (stickBottomRef.current && !mentionOpenRef.current) {
        stickToBottom()
        setNewCount(0)
      } else {
        setNewCount((n) => n + fresh.length)
      }
    } catch (err) {
      // 管理员关了聊天室：进入「已关闭」状态，effect 会据此停掉所有轮询
      if (err instanceof HttpError && err.code === "CHAT_DISABLED") {
        setChatOff(true)
        return
      }
      // 后续轮询失败保持静默，避免网络抖动时反复弹错
    }
  }, [stickToBottom])

  const pollPresence = React.useCallback(async () => {
    try {
      const res = await chatApi.presence()
      setOnline(res.online)
    } catch {
      /* 静默 */
    }
  }, [])

  React.useEffect(() => {
    // 聊天室已关闭：什么都不轮询（cleanup 已在上一轮把定时器清掉）
    if (chatOff) return
    void loadInitial()
    void pollPresence()
    if (user) void chatApi.heartbeat().catch(() => {})
    // ⚠️ 2026-09-30 降频：CF Workers 免费额度 10 万请求/天，当日实测已到 93.6%，
    //    聊天页轮询是最大头（2s 拉消息 = 4.3 万次/天/人）。改成 5s / 30s / 60s，
    //    并且**只在页面可见时跑**（见 src/lib/visible-interval.ts），
    //    切回标签页会立刻刷一次，不会看到旧数据。
    const stopMessages = setVisibleInterval(() => void pollNew(), 5000)
    const stopPresence = setVisibleInterval(() => void pollPresence(), 30000)
    // 心跳：只有登录用户才报（表示「我在聊天室」）
    const stopHeartbeat = user
      ? setVisibleInterval(() => void chatApi.heartbeat().catch(() => {}), 60000)
      : undefined
    return () => {
      stopMessages()
      stopPresence()
      stopHeartbeat?.()
    }
  }, [loadInitial, pollNew, pollPresence, user, chatOff])

  /**
   * 往上翻历史：加载更早的消息（借鉴 Telegram checkScrollForLoad：单飞 + 阈值触发）。
   *
   * 关键点是**补偿滚动位置**：新消息插在列表前面、内容整体变高，不补偿的话
   * 视口会跳到刚插入那批的顶部。记住插入前后的 scrollHeight 差值加回 scrollTop。
   * 返回是否真的加载到了东西（jumpToQuoted 要靠它决定要不要继续补批）。
   */
  const loadInitialEarlier = React.useCallback(async (): Promise<boolean> => {
    const pc = prevCursorRef.current
    if (!pc || loadingEarlierRef.current || !hasMoreRef.current || chatOff) return false
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    const el = listRef.current
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    try {
      const res = await chatApi.list({ before: pc })
      prevCursorRef.current = res.prevCursor
      hasMoreRef.current = res.hasMore
      setHasMore(res.hasMore)
      if (res.messages.length === 0) return false
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id))
        const fresh = res.messages.filter((m) => !seen.has(m.id))
        return fresh.length > 0 ? [...fresh, ...prev] : prev
      })
      // 等 DOM 提交后补偿（setTimeout 而非 rAF：后台标签页会暂停 rAF）
      window.setTimeout(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop
      }, 0)
      return true
    } catch {
      /* 静默：翻页失败不打断阅读，下次滚动会再试 */
      return false
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }, [chatOff])

  /**
   * 滚动监听：维护贴底状态 + 滑到顶部附近自动翻历史。
   * 依赖里带上「列表是否在渲染中」的几个条件 —— loading / 空态时列表元素
   * 根本不存在，监听挂不上去，重新出现时要重新挂。
   */
  React.useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      const near = isNearBottom(el)
      stickBottomRef.current = near
      setNearBottom(near)
      setNewCount((n) => (near ? 0 : n))
      if (el.scrollTop < 80) void loadInitialEarlier()
    }
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [loadInitialEarlier, loading, chatOff, failed, messages.length])

  /**
   * 关闭选人面板后若仍贴底，恢复吸底（面板开着期间被抑制的滚动）。
   * 只在 mentionOpen 变化时跑 —— 消息到达的吸底由 pollNew 负责，
   * 这里若监听 messages 会把正在翻历史的用户拽回底部（老 bug 的根源）。
   */
  React.useEffect(() => {
    if (!mentionOpen && stickBottomRef.current) stickToBottom()
  }, [mentionOpen, stickToBottom])

  /**
   * 「回到底部」按钮：平滑滚动（时长按距离映射，参数抄 Telegram）。
   * 用户滚动会打断动画，主动权还给人。
   */
  const jumpBottom = React.useCallback(() => {
    stickBottomRef.current = true
    setNearBottom(true)
    setNewCount(0)
    smoothScrollToBottom(listRef.current)
    // 图片后到把内容撑高时，动画目标会追着 scrollHeight（smoothScroll 内每帧重读）；
    // 这里再补一次瞬跳兜底动画结束后的图片增高
    window.setTimeout(() => {
      if (stickBottomRef.current) jumpToBottom(listRef.current)
    }, 1400)
  }, [])

  /**
   * 点引用块 → 跳回被引消息并高亮（借鉴 scrollToMessageId + highlightMessageId）。
   * 目标还没加载进列表时，最多往前补 3 批历史再找；找不到就放弃（不打扰）。
   */
  const jumpToQuoted = React.useCallback(
    async (quoteId: string) => {
      for (let i = 0; i < 3 && !document.getElementById(`msg-${quoteId}`); i++) {
        const got = await loadInitialEarlier()
        if (!got) break
      }
      const target = document.getElementById(`msg-${quoteId}`)
      if (!target) return
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" })
      setFlashId(quoteId)
      window.setTimeout(() => setFlashId((f) => (f === quoteId ? null : f)), 900)
    },
    [loadInitialEarlier]
  )

  /** 「我正在输入」：5 秒节流上报（抄 ChatActivityEnterView 的 lastTypingTimeSend 门闩） */
  const notifyTyping = React.useCallback(() => {
    if (!user || chatOff) return
    const now = Date.now()
    if (now - typingSentAtRef.current < 5000) return
    typingSentAtRef.current = now
    void chatApi.typing().catch(() => {})
  }, [user, chatOff])

  // ———— 草稿：按账号存本地，切回来还在（借鉴 MediaDataController 的 draft 持久化）————
  const draftKey = user ? `chat:draft:${user.id}` : null
  React.useEffect(() => {
    setDraft("") // 切换账号先把上一个人的草稿清掉，免得串台
    if (!draftKey) return
    try {
      const saved = localStorage.getItem(draftKey)
      if (saved) setDraft(saved)
    } catch {
      /* 隐私模式读不了就算了 */
    }
  }, [draftKey])

  /**
   * 乐观消息对账：把本地「发送中」的气泡换成服务端确认的真消息。
   *
   * 三种情形都要对（Telegram updateMessageStateAndId 的对应逻辑）：
   *   ① temp 还在、真消息没进来 → 原位替换（最常见）；
   *   ② 轮询先把真消息拉进来了 → 只删 temp，别留重复；
   *   ③ temp 已经不在（比如用户撤回过/切了页）→ 有真消息就不管，没有就补到末尾。
   * **不推进 lastIdRef**：让下一轮轮询自然对齐，避免「自己这条比别人晚，
   * after=自己 把别人更早那条永久跳过」的坑（老代码就有）。
   */
  const settleOptimistic = React.useCallback((tempId: string, real: ChatMessage) => {
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
   * 发消息：乐观插入「发送中」气泡（借鉴 SendMessagesHelper 的 send_state 状态机）。
   * 服务端确认后 settleOptimistic 原位替换；失败把气泡标成 failed，点它重试。
   * clientId 是幂等键：超时重发 / 双击提交在服务端只会落一行。
   */
  const send = async () => {
    const text = draft.trim()
    if (!text) return
    if (!user) {
      navigate("/login", { state: { from: "/dashboard/chat" } })
      return
    }
    // 编辑模式：提交 = 改原消息（不新发）。内容没变就直接退出编辑。
    if (editingMsg) {
      const target = editingMsg
      if (text === target.body) {
        cancelEdit()
        return
      }
      setSending(true)
      try {
        const res = await chatApi.edit(target.id, text)
        setMessages((prev) => prev.map((x) => (x.id === target.id ? res.message : x)))
        setEditingMsg(null)
        setDraft("")
        if (draftKey) {
          try {
            localStorage.removeItem(draftKey)
          } catch {
            /* 忽略 */
          }
        }
      } catch (err) {
        toast.error(errMsg(err, t("chat.err.edit")))
      } finally {
        setSending(false)
      }
      return
    }
    const clientId = newClientId()
    const tempId = `temp-${clientId}`
    const quoted = quoteTarget
    const optimistic: ChatMessage = {
      id: tempId,
      clientId,
      userId: user.id,
      username: user.username,
      nickname: user.nickname ?? null,
      hasAvatar: Boolean(user.hasAvatar),
      body: text,
      createdAt: new Date().toISOString(),
      replyTo: quoted?.id ?? null,
      quote: quoted
        ? {
            id: quoted.id,
            username: quoted.username,
            nickname: quoted.nickname,
            recalled: false,
            body: quoted.recalled ? "" : quoted.body.slice(0, 200),
          }
        : null,
      status: "sending",
    }
    // 先落气泡再发网络请求 —— 气泡秒出，滚动立即贴底
    setMessages((prev) => [...prev, optimistic])
    stickBottomRef.current = true
    setNearBottom(true)
    setNewCount(0)
    stickToBottom()
    // 输入框立刻清空（内容已经「在路上」了，草稿同步清掉）
    setDraft("")
    if (draftKey) {
      try {
        localStorage.removeItem(draftKey)
      } catch {
        /* 忽略 */
      }
    }
    setQuoteTarget(null)
    setMentionOpen(false)
    setSending(true)
    try {
      const res = await chatApi.send(text, {
        replyTo: quoted?.id ?? null,
        clientId,
      })
      settleOptimistic(tempId, res.message)
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, status: "failed" as const } : m))
      )
      toast.error(errMsg(err, t("chat.err.send")))
    } finally {
      setSending(false)
    }
  }

  /**
   * 重试点：失败气泡带着原文重发。
   * 沿用**同一个 clientId** —— 上次请求若其实已经入库，服务端幂等返回那条，
   * 不会写重复消息（这正是乐观发送敢重试的前提）。
   */
  const retrySend = async (m: ChatMessage) => {
    if (!m.clientId) return
    setMessages((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, status: "sending" as const } : x))
    )
    setSending(true)
    try {
      const res = await chatApi.send(m.body, {
        replyTo: m.replyTo ?? null,
        clientId: m.clientId,
      })
      settleOptimistic(m.id, res.message)
    } catch (err) {
      setMessages((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, status: "failed" as const } : x))
      )
      toast.error(errMsg(err, t("chat.err.send")))
    } finally {
      setSending(false)
    }
  }

  /** 失败气泡的「取回编辑」：内容放回输入框、删掉失败气泡 */
  const editFailed = (m: ChatMessage) => {
    setMessages((prev) => prev.filter((x) => x.id !== m.id))
    setDraft(m.body)
    if (draftKey) {
      try {
        localStorage.setItem(draftKey, m.body)
      } catch {
        /* 忽略 */
      }
    }
    inputRef.current?.focus()
  }

  /**
   * 表情回应开关：右键「回应」选表情、或直接点气泡下的胶囊。
   * 服务端 toggle 返回 active，本地据此增减（不用等 5 秒轮询回传）。
   */
  const toggleReaction = async (m: ChatMessage, emoji: string) => {
    if (m.status || m.recalled) return
    // 预判这次 toggle 的方向：我点过的表情 = 取消，没点过的 = 加上
    const expectActive = !(m.reactions ?? []).find((r) => r.emoji === emoji)?.mine
    const before = m.reactions ?? []
    // 乐观本地增减，点完立刻有反馈
    setMessages((prev) =>
      prev.map((x) =>
        x.id === m.id
          ? { ...x, reactions: applyReactionToggle(x, emoji, expectActive, user?.username ?? "") }
          : x
      )
    )
    try {
      const res = await chatApi.react(m.id, emoji)
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
      // 失败：把乐观增减撤销回请求前的样子
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, reactions: before } : x)))
      toast.error(errMsg(err, t("chat.err.react")))
    }
  }

  /** 右键「编辑」：正文放回输入框，提交时走编辑接口（不新发消息） */
  const startEdit = (m: ChatMessage) => {
    if (!m.body || m.recalled || m.status) return
    setEditingMsg(m)
    setQuoteTarget(null)
    setMentionOpen(false)
    setDraft(m.body)
    const pos = m.body.length
    window.setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  /** 取消编辑（编辑条上的 X / Esc）：输入框恢复空 */
  const cancelEdit = () => {
    setEditingMsg(null)
    setDraft("")
    if (draftKey) {
      try {
        localStorage.removeItem(draftKey)
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 右键「转发」：打开目标选择面板，目标会话懒加载一次 */
  const startForward = (m: ChatMessage) => {
    if (m.recalled || m.status || !m.body) return
    setForwardMsg(m)
    setForwardTargets(null)
    void dmApi
      .conversations()
      .then((res) => setForwardTargets(res.conversations))
      .catch(() => setForwardTargets([]))
  }

  /** 执行转发：正文由服务端取来源消息，这里只带来源 id */
  const doForward = async (
    target: { peer: { username: string } } | "chat"
  ) => {
    const m = forwardMsg
    if (!m) return
    const source = `chat:${m.id}`
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

  /** 撤回自己的消息（右键菜单） */
  const recallMessage = async (m: ChatMessage) => {
    try {
      await chatApi.recall(m.id)
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id ? { ...x, recalled: true, body: "", replyTo: null, quote: null } : x
        )
      )
      toast.success(t("chat.recalledToast"))
    } catch (err) {
      toast.error(errMsg(err, t("chat.err.recall")))
    }
  }

  /** 复制消息正文（右键菜单） */
  const copyMessage = async (m: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(m.body)
      toast.success(t("chat.copied"))
    } catch {
      toast.error(t("chat.err.copy"))
    }
  }

  /** 把消息里的表情包存到自己的表情包（右键菜单） */
  const saveSticker = async (id: string) => {
    try {
      const res = await stickerApi.save(id)
      toast.success(res.alreadySaved ? t("stk.saved") : t("stk.ok.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("stk.err.save")))
    }
  }

  /** 切换 Enter 行为并存进 localStorage */
  const toggleEnterToSend = () => {
    setEnterToSend((prev) => {
      const next = !prev
      try {
        localStorage.setItem("chat:enterToSend", next ? "1" : "0")
      } catch {
        /* 隐私模式下写不了就算了 */
      }
      return next
    })
  }

  /**
   * 头部「正在输入」文案（排除自己）：1 个人直呼其名，多个取第一个 + 「等 N 人」。
   * typing 数据随 5 秒消息轮询下发，过期自然消失，这里只管渲染。
   */
  const typingOthers = typingUsers.filter(
    (u) => u.username.toLowerCase() !== (user?.username ?? "").toLowerCase()
  )
  const typingLine =
    typingOthers.length === 0
      ? ""
      : typingOthers.length === 1
        ? t("chat.typingOne", { name: typingOthers[0].nickname || typingOthers[0].username })
        : t("chat.typingMany", {
            names: typingOthers[0].nickname || typingOthers[0].username,
            n: typingOthers.length - 1,
          })

  /** 渲染时按本地日期分组：每遇到新的一天插一条分割线（每次渲染重置） */
  let lastDayKey = ""

  /**
   * 单条消息（含日期分割行之外的所有结构）。
   *
   * 相比改造前新增：
   *   · `id=msg-<id>` 锚点 —— 点引用块 jumpToQuoted 滚过来 + chat-flash 高亮；
   *   · `chat-msg-in` 入场动画 —— 只在动画窗口打开后**新挂载**的消息上播；
   *   · 气泡 hover 快捷钮（引用 / 复制）—— 桌面端免右键；触屏仍走右键菜单；
   *   · 发送中 / 失败状态行（Telegram send_state 状态机的 Web 版）。
   */
  const renderMessage = (m: ChatMessage) => {
    // 自己的消息靠右、主色底（与私信同一套观感）
    const mine = Boolean(user) && m.userId === user!.id
    // 别人在消息里艾特了我 —— 给个显眼的圈，不然群里刷得快根本注意不到
    const mentioned = !mine && mentionsMe(m.body, user?.username ?? "")
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
        <div
          className="shrink-0"
          // 右键别人头像 → 快捷「艾特」（自己的头像不能艾特自己）
          onContextMenu={
            !mine
              ? (e) => {
                  e.preventDefault()
                  setCtxMenu({
                    x: e.clientX,
                    y: e.clientY,
                    user: {
                      userId: m.userId,
                      username: m.username,
                      nickname: m.nickname,
                      hasAvatar: m.hasAvatar,
                    },
                  })
                }
              : undefined
          }
        >
          {/* 点头像弹小卡片（可跳到对方个人空间） */}
          <UserCardPopover
            username={m.username}
            nickname={m.nickname}
            hasAvatar={m.hasAvatar}
            className="block"
          >
            <UserAvatar username={m.username} nickname={m.nickname} hasAvatar={m.hasAvatar} className="h-8 w-8" />
          </UserCardPopover>
        </div>
        <div className={cn("flex min-w-0 max-w-[75%] flex-col", mine ? "items-end" : "items-start")}>
          {/* 别人的消息要标出「谁说的」；自己的靠右+主色底，无需再写名字 */}
          {!mine && (
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {m.nickname || m.username}
              </span>
              <span className="text-[11px] text-muted-foreground/70">
                {relTime(m.createdAt)}
                {m.editedAt ? ` · ${t("chat.edited")}` : ""}
              </span>
            </div>
          )}
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
              "inline-block max-w-full break-words rounded-lg px-3 py-2 text-sm",
              mine ? "bubble-mine bg-primary text-primary-foreground" : "bg-muted",
              mentioned && "ring-2 ring-primary/60",
              m.status === "sending" && "opacity-60",
              m.status === "failed" && "ring-1 ring-destructive"
            )}
          >
            {/* 转发来源标注（纯展示；来源在别的表里，不做跳转） */}
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
            {/* 引用块：显示被引消息的作者 + 摘要（被引消息已撤回则显示「已撤回」）。
                点它跳回原消息并高亮 —— Telegram 点引用 scrollToMessageId 同款交互。 */}
            {quote && !m.recalled && (
              <div
                onClick={() => void jumpToQuoted(quote.id)}
                title={t("chat.ctx.jump")}
                className={cn(
                  "mb-1.5 cursor-pointer rounded border-l-2 px-2 py-1 text-xs transition-opacity hover:opacity-75",
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
                  纯文本会把它原样显示成一行字（2026-10-02 反馈）。
                  ⚠️ 外层用 div 不用 p —— Markdown 自己会产出 p 标签，嵌在 p 里是非法 HTML。 */
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
          {(mine || mentioned) && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {/* 发送中：转圈 + 时间（内容已在气泡里，气泡半透明） */}
              {mine && m.status === "sending" && (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{relTime(m.createdAt)}</span>
                </>
              )}
              {/* 失败：红字重试（幂等键原样重发，不会写重复）+ 取回编辑 */}
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
                    className="flex items-center gap-1 transition-colors hover:text-foreground"
                  >
                    <PenLine className="h-3 w-3" />
                  </button>
                </>
              )}
              {mine && !m.status && (
                <span>
                  {relTime(m.createdAt)}
                  {m.editedAt ? ` · ${t("chat.edited")}` : ""}
                </span>
              )}
              {mentioned && (
                <span className="rounded-full bg-primary/15 px-1.5 py-px font-medium text-primary">
                  {t("chat.mentionYou")}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  /**
   * 回上一页。
   *
   * 优先用浏览器历史往回退（进来时的来源可能是社区、也可能是别处）。
   * 直接粘贴链接打开时没有站内历史（react-router 的 `history.state.idx` 为 0），
   * 此时 `navigate(-1)` 会把用户弹出站外，所以退回到社区广场 ——
   * 聊天室的入口本来就在社区的右侧栏，这是最自然的上级页面。
   */
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate("/dashboard/community")
  }

  return (
    <div
      className={
        embedded
          ? "flex h-full min-h-0 flex-col"
          : "mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col supports-[height:100dvh]:h-[calc(100dvh-8rem)]"
      }
    >
      {/* 顶部：返回 + 标题 + 在线头像堆叠 */}
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-2">
          {!embedded && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 shrink-0 gap-1 px-2 text-muted-foreground"
              onClick={goBack}
              title={t("chat.back")}
              aria-label={t("chat.back")}
            >
              <ArrowLeft className="h-4 w-4" />
              {t("chat.backShort")}
            </Button>
          )}
          <div>
            <h1 className="text-lg font-semibold">{t("chat.title")}</h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              {t("chat.onlineCount", { n: online.length })}
              {/* 正在输入：随 5 秒消息轮询下发，随窗口过期自动消失 */}
              {typingLine && (
                <>
                  <span aria-hidden>·</span>
                  <span className="animate-pulse text-primary">{typingLine}</span>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex -space-x-2">
          {online.slice(0, 8).map((u) => (
            <div key={u.userId} className="rounded-full border-2 border-background" title={u.nickname || u.username}>
              <UserAvatar username={u.username} nickname={u.nickname} hasAvatar={u.hasAvatar} className="h-7 w-7" />
            </div>
          ))}
          {online.length > 8 && (
            <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] text-muted-foreground">
              +{online.length - 8}
            </div>
          )}
        </div>
      </div>

      {/* 消息流。外层包一层 relative：「回到底部」悬浮钮要锚在这里，不随内容滚走 */}
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} className="h-full overflow-y-auto py-4">
        {chatOff ? (
          <div className="flex flex-col items-center gap-1.5 py-10 text-center">
            <p className="text-sm font-medium">{t("chat.closed")}</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              {t("chat.closedDesc")}
            </p>
          </div>
        ) : loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : failed && messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
            <p>{t("chat.loadFailed")}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFailed(false)
                setLoading(true)
                void loadInitial()
              }}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("chat.empty")}
          </p>
        ) : (
          <div className="space-y-3">
            {/* 顶部：往上翻历史的状态提示（滑到顶自动加载，与私信同款） */}
            <div className="pb-1 text-center text-[11px] text-muted-foreground">
              {loadingEarlier
                ? t("chat.loadingEarlier")
                : hasMore
                  ? t("chat.scrollForEarlier")
                  : t("chat.noEarlier")}
            </div>
            {/* 按本地日期分桶插分割线（借鉴 MessageObject 的 dateKey + TYPE_DATE 伪消息）；
                flatMap 让「分割线 + 消息」平铺，key 各自稳定。 */}
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
          </div>
        )}
        </div>
        {/* 「回到底部」悬浮钮：不在底部才出现（贴底判断容差 48px）。
            带新消息计数 —— 用户往上翻历史时，新消息只累加计数、不打断他
            （Telegram ChatActivity 的 newUnreadMessageCount 同款行为）。 */}
        {!chatOff && !loading && !failed && messages.length > 0 && !nearBottom && (
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

      {/* 输入框 */}
      <div
        {...dropProps}
        className={cn(
          "relative flex flex-col gap-2 border-t pt-3 transition-colors",
          dragging && "bg-primary/5 ring-2 ring-inset ring-primary"
        )}
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
        {/* 编辑条：正在改一条旧消息（与引用条互斥 —— 进编辑会清掉引用） */}
        {editingMsg && (
          <div className="flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/50 px-2 py-1.5 text-xs">
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
        {/* 引用预览：发送前展示「正在引用谁」，可取消 */}
        {!editingMsg && quoteTarget && (          <div className="flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/50 px-2 py-1.5 text-xs">
            <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <span className="font-medium">
                {quoteTarget.nickname || quoteTarget.username}
              </span>
              <span className="ml-1 break-all text-muted-foreground">
                {summarizeBody(quoteTarget.body, t).slice(0, 120)}
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
        {/* 表情包/图片实时预览：发送前就把 `![](url)` 渲染成真实缩略图 */}
        <DraftImagePreview text={draft} />
        <div className="flex items-center gap-2">
        {/* 表情与表情包（与社区/私信同一套组件）。未登录时禁用 —— 反正发不出去 */}
        <EmojiPicker onPick={insertEmoji} />
        <StickerPanel onPick={insertEmoji} />
        <Textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => handleDraftChange(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            // 候选面板开着时先接管上下键与确认键，别让 Enter 把半截 `@xx` 直接发出去
            if (mentionOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setMentionIndex((i) => (i + 1) % Math.max(mentionMatches.length, 1))
                return
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                setMentionIndex(
                  (i) => (i - 1 + Math.max(mentionMatches.length, 1)) % Math.max(mentionMatches.length, 1)
                )
                return
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault()
                // 没匹配到人时只收面板，不发消息 —— 否则用户会以为「艾特没生效」
                if (mentionMatches.length > 0) {
                  applyMention(mentionMatches[mentionIndex] ?? mentionMatches[0])
                } else {
                  setMentionOpen(false)
                }
                return
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setMentionOpen(false)
                return
              }
            }
            // Esc 取消编辑 / 引用（面板没开时）—— 挂着容易误发
            if (e.key === "Escape" && editingMsg) {
              e.preventDefault()
              cancelEdit()
              return
            }
            if (e.key === "Escape" && quoteTarget) {
              e.preventDefault()
              setQuoteTarget(null)
              return
            }
            // 中文输入法「选词回车」也会触发 keydown —— 不判断的话就会选字即发送
            if (e.nativeEvent.isComposing) return
            if (e.key !== "Enter") return
            const mod = e.ctrlKey || e.metaKey
            if (enterToSend) {
              // Enter 发送、Shift+Enter 换行
              if (!e.shiftKey && !mod) {
                e.preventDefault()
                void send()
              }
            } else if (mod) {
              // 反向偏好：Enter 换行、Ctrl/Cmd+Enter 发送
              e.preventDefault()
              void send()
            }
          }}
          rows={1}
          placeholder={
            chatOff ? t("chat.closed") : user ? t("chat.placeholder") : t("chat.loginToSpeak")
          }
          className="!min-h-0 max-h-40 flex-1 resize-none overflow-y-auto py-2"
          disabled={chatOff}
        />
        <Button onClick={() => void send()} disabled={chatOff || sending || !draft.trim()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t("fb.send")}
        </Button>
        </div>
        {/* 发送键偏好：默认 Enter 发送；想用 Enter 排版（如 markdown 列表）就切到 Ctrl+Enter 发送 */}
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={toggleEnterToSend}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title={t("chat.enterHintTip")}
          >
            <CornerDownLeft className="h-3 w-3" />
            {enterToSend ? t("chat.enterHintSend") : t("chat.enterHintNewline")}
          </button>
        </div>

        {/* 艾特候选：贴着输入框弹（Portal 到 body，不会被任何容器裁掉）。
            点击用 onMouseDown + preventDefault —— 别把输入框的焦点抢走，
            否则光标位置丢了，插入点就算不出来。 */}
        <AnchoredPanel
          anchorRef={inputRef}
          open={mentionOpen}
          onClose={() => setMentionOpen(false)}
          width={MENTION_PANEL_WIDTH}
          height={mentionPanelHeight}
        >
          {/* data-mention-panel：供「点外部关闭」识别本面板。
              不能复用 isInsideAnchoredPanel —— 表情面板也是锚定浮层，会被误放行。 */}
          <div data-mention-panel="" className="flex min-h-0 flex-1 flex-col">
            <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
              {t("chat.mentionPick")}
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {mentionMatches.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("chat.mentionEmpty")}
                </p>
              ) : (
                mentionMatches.map((u, i) => (
                  <button
                    key={u.username}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyMention(u)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      i === mentionIndex ? "bg-accent" : "hover:bg-accent/60"
                    )}
                  >
                    <UserAvatar
                      username={u.username}
                      nickname={u.nickname}
                      hasAvatar={u.hasAvatar}
                      className="h-6 w-6 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{u.nickname || u.username}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">@{u.username}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </AnchoredPanel>
      </div>

      {/* 右键头像的「艾特」快捷菜单：跟随鼠标，Portal 到 body。
          夹逼在视口内，别让菜单跑到屏幕外点不到。 */}
      {ctxMenu &&
        createPortal(
          <div
            ref={ctxRef}
            className="fixed z-50 w-44 rounded-lg border bg-popover p-1 shadow-lg"
            style={{
              top: Math.max(8, Math.min(ctxMenu.y, window.innerHeight - 48)),
              left: Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 184)),
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const u = ctxMenu.user
                setCtxMenu(null)
                insertMentionAtCaret(u)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <AtSign className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {t("chat.mentionCtx")} @{ctxMenu.user.username}
              </span>
            </button>
          </div>,
          document.body
        )}

      {/* 右键消息的菜单：顶部一排常用表情（点即回应），下面引用 / 编辑 / 复制 /
          存表情包 / 转发 / 撤回 —— 一个样子全摊开，不搞二级面板。 */}
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
            {/* 表情回应行：消息未撤回、非乐观气泡、已登录时才给 */}
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
              msgMenu.msg.userId === user!.id &&
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
            {Boolean(user) &&
              msgMenu.msg.userId === user!.id &&
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

      {/* 转发面板：居中 Modal —— 目标是私信会话（聊天室自己转自己没意义，
          所以这里只列会话；私信页那边会多一个「公共聊天室」目标）。 */}
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
              {forwardTargets === null ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : forwardTargets.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t("chat.forwardEmpty")}
                </p>
              ) : (
                <div className="space-y-1">
                  {forwardTargets.map((c) => (
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
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
