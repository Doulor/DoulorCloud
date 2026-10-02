/**
 * 公共聊天室。
 *
 * 实时性：5 秒轮询新消息（且只在页面可见时轮询，见 src/lib/visible-interval.ts）；
 * 在线：每 60 秒心跳一次。
 * 登录后可发言；未登录只能看（发送会引导登录）。
 */
import * as React from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Send, Loader2, Users } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { UserAvatar } from "@/components/user-avatar"
import { UserCardPopover } from "@/components/user-card"
import { useAuth } from "@/hooks/use-auth"
import { chatApi, errMsg, HttpError } from "@/services/api"
import { relTime } from "@/lib/format"
import { setVisibleInterval } from "@/lib/visible-interval"
import type { ChatMessage, ChatPresenceUser } from "@/types"
import { useT } from "@/i18n"

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

  const listRef = React.useRef<HTMLDivElement>(null)
  const lastIdRef = React.useRef<string | null>(null)

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

  // 新消息自动滚到底部
  React.useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

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
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
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
            {messages.map((m) => (
              <div key={m.id} className="flex gap-2.5">
                <div className="shrink-0">
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
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{m.nickname || m.username}</span>
                    <span className="text-[11px] text-muted-foreground">{relTime(m.createdAt)}</span>
                  </div>
                  <p className="break-words text-sm leading-relaxed">{m.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 输入框 */}
      <div className="flex items-center gap-2 border-t pt-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={
              chatOff ? t("chat.closed") : user ? t("chat.placeholder") : t("chat.loginToSpeak")
            }
          className="flex-1"
          disabled={chatOff}
        />
        <Button onClick={() => void send()} disabled={chatOff || sending || !draft.trim()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t("fb.send")}
        </Button>
      </div>
    </div>
  )
}
