/**
 * 公共聊天室。
 *
 * 实时性：2 秒轮询新消息；在线：每 30 秒心跳一次。
 * 登录后可发言；未登录只能看（发送会引导登录）。
 */
import * as React from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Send, Loader2, Users } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { UserAvatar } from "@/components/user-avatar"
import { useAuth } from "@/hooks/use-auth"
import { chatApi, errMsg } from "@/services/api"
import { relTime } from "@/lib/format"
import type { ChatMessage, ChatPresenceUser } from "@/types"

export default function ChatPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [online, setOnline] = React.useState<ChatPresenceUser[]>([])
  const [draft, setDraft] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const [loading, setLoading] = React.useState(true)

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
    } catch {
      /* 轮询失败静默 */
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
    void poll(true)
    void pollPresence()
    const msgTimer = setInterval(() => void poll(false), 2000)
    const presenceTimer = setInterval(() => void pollPresence(), 10000)
    // 心跳：只有登录用户才报（表示「我在聊天室」）
    let hbTimer: ReturnType<typeof setInterval> | undefined
    if (user) {
      void chatApi.heartbeat().catch(() => {})
      hbTimer = setInterval(() => void chatApi.heartbeat().catch(() => {}), 30000)
    }
    return () => {
      clearInterval(msgTimer)
      clearInterval(presenceTimer)
      if (hbTimer) clearInterval(hbTimer)
    }
  }, [poll, pollPresence, user])

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
      toast.error(errMsg(err, "发送失败"))
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
            title="返回上一页"
            aria-label="返回上一页"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </Button>
          <div>
            <h1 className="text-lg font-semibold">公共聊天室</h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              {online.length} 人在线
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
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            还没有消息，来说第一句吧。
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div key={m.id} className="flex gap-2.5">
                <div className="shrink-0">
                  <UserAvatar username={m.username} nickname={m.nickname} hasAvatar={m.hasAvatar} className="h-8 w-8" />
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
          placeholder={user ? "说点什么…（Enter 发送）" : "登录后可发言"}
          className="flex-1"
        />
        <Button onClick={() => void send()} disabled={sending || !draft.trim()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          发送
        </Button>
      </div>
    </div>
  )
}
