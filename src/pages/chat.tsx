/**
 * 公共聊天室。
 *
 * 实时性：5 秒轮询新消息（且只在页面可见时轮询，见 src/lib/visible-interval.ts）；
 * 在线：每 60 秒心跳一次。
 * 登录后可发言；未登录只能看（发送会引导登录）。
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Send, Loader2, Users, AtSign } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { UserAvatar } from "@/components/user-avatar"
import { UserCardPopover } from "@/components/user-card"
import { AnchoredPanel } from "@/components/anchored-panel"
import { EmojiPicker } from "@/components/emoji-picker"
import { StickerPanel } from "@/components/sticker-panel"
import { Markdown } from "@/components/markdown"
import { useAuth } from "@/hooks/use-auth"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { useImageDrop } from "@/hooks/use-image-drop"
import { chatApi, errMsg, HttpError } from "@/services/api"
import { cn } from "@/lib/utils"
import { relTime } from "@/lib/format"
import { setVisibleInterval } from "@/lib/visible-interval"
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

export default function ChatPage() {
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

  const listRef = React.useRef<HTMLDivElement>(null)
  const lastIdRef = React.useRef<string | null>(null)
  /** 发言输入框：表情/表情包要插到光标处 */
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  /** 右键菜单自身，用于「点菜单外关闭」判断 */
  const ctxRef = React.useRef<HTMLDivElement | null>(null)

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
   * 输入框内容变化：顺手判断要不要弹艾特候选。
   * `caret` 取 `selectionStart`（刚敲完的那个字符之后）。
   */
  const handleDraftChange = (next: string, caret: number | null) => {
    setDraft(next)
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

  // 拉最新消息（首次 + 轮询增量）
  const poll = React.useCallback(async (initial = false) => {
    try {
      const res = await chatApi.list(initial ? undefined : (lastIdRef.current ?? undefined))
      if (res.messages.length > 0) {
        if (initial) {
          setMessages(res.messages)
        } else {
          setMessages((prev) => {
            const known = new Set(prev.map((m) => m.id))
            const fresh = res.messages.filter((m) => !known.has(m.id))
            return fresh.length > 0 ? [...prev, ...fresh] : prev
          })
        }
        lastIdRef.current = res.messages[res.messages.length - 1].id
      }
    } catch (err) {
      // 管理员关了聊天室：进入「已关闭」状态，effect 会据此停掉所有轮询
      if (err instanceof HttpError && err.code === "CHAT_DISABLED") {
        setChatOff(true)
        return
      }
      // ⚠️ 2026-09-26：首屏失败要能让用户看见，否则会和「真的还没人发言」
      // 混在一起（界面显示「还没有消息，来说第一句吧」）。
      // 后续轮询失败仍保持静默，避免网络抖动时反复弹错。
      if (initial) setFailed(true)
    } finally {
      if (initial) setLoading(false)
    }
  }, [])

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
    void poll(true)
    void pollPresence()
    if (user) void chatApi.heartbeat().catch(() => {})
    // ⚠️ 2026-09-30 降频：CF Workers 免费额度 10 万请求/天，当日实测已到 93.6%，
    //    聊天页轮询是最大头（2s 拉消息 = 4.3 万次/天/人）。改成 5s / 30s / 60s，
    //    并且**只在页面可见时跑**（见 src/lib/visible-interval.ts），
    //    切回标签页会立刻刷一次，不会看到旧数据。
    const stopMessages = setVisibleInterval(() => void poll(false), 5000)
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
  }, [poll, pollPresence, user, chatOff])

  /**
   * 新消息自动滚到底部。
   *
   * ⚠️ 选人面板开着时**不滚**：锚定浮层监听了 window 的 scroll（capture），
   * 任何滚动都会把它关掉。聊天室每 5 秒可能进新消息，若不跳过，正在打
   * `@名字` 的时候面板会被自动滚动收掉，根本选不中人。
   */
  React.useEffect(() => {
    if (mentionOpen) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, mentionOpen])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    if (!user) {
      navigate("/login", { state: { from: "/dashboard/chat" } })
      return
    }
    setSending(true)
    try {
      const res = await chatApi.send(text)
      setMessages((prev) => [...prev, res.message])
      lastIdRef.current = res.message.id
      setDraft("")
    } catch (err) {
      toast.error(errMsg(err, t("chat.err.send")))
    } finally {
      setSending(false)
    }
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
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col supports-[height:100dvh]:h-[calc(100dvh-8rem)]">
      {/* 顶部：返回 + 标题 + 在线头像堆叠 */}
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-2">
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
          <div>
            <h1 className="text-lg font-semibold">{t("chat.title")}</h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              {t("chat.onlineCount", { n: online.length })}
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

      {/* 消息流 */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-4">
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
                void poll(true)
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
            {messages.map((m) => {
              // 自己的消息靠右、主色底（与私信同一套观感）
              const mine = Boolean(user) && m.userId === user!.id
              // 别人在消息里艾特了我 —— 给个显眼的圈，不然群里刷得快根本注意不到
              const mentioned = !mine && mentionsMe(m.body, user?.username ?? "")
              return (
                <div key={m.id} className={cn("flex items-end gap-2", mine && "flex-row-reverse")}>
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
                        </span>
                      </div>
                    )}
                    <div
                      className={cn(
                        "inline-block max-w-full break-words rounded-lg px-3 py-2 text-sm",
                        mine ? "bubble-mine bg-primary text-primary-foreground" : "bg-muted",
                        mentioned && "ring-2 ring-primary/60"
                      )}
                    >
                      {/* 用 Markdown 渲染：表情包插进来的是 `![](/api/stickers/<id>/image)`，
                          纯文本会把它原样显示成一行字（2026-10-02 反馈）。
                          ⚠️ 外层用 div 不用 p —— Markdown 自己会产出 p 标签，嵌在 p 里是非法 HTML。 */}
                      <Markdown>{m.body}</Markdown>
                    </div>
                    {(mine || mentioned) && (
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {mine && <span>{relTime(m.createdAt)}</span>}
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
            })}
          </div>
        )}
      </div>

      {/* 输入框 */}
      <div
        {...dropProps}
        className={cn(
          "relative flex items-center gap-2 border-t pt-3 transition-colors",
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
            if (e.key === "Enter" && !e.shiftKey) {
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
    </div>
  )
}
