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
 * ⚠️ 本文件是新增文件，文案直接写中文（与 admin.tsx 等后台页面一致）——
 * 避免碰全站的 i18n 字典（那份正在被另一个会话重构）。
 */
import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Loader2, MessageSquarePlus, Send } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { UserAvatar } from "@/components/user-avatar"
import { cn } from "@/lib/utils"
import { relTime } from "@/lib/format"
import { setVisibleInterval } from "@/lib/visible-interval"
import { dmApi, errMsg, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import type { DmConversation, DmMessage } from "@/types"
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
  /** 左栏「找人」输入框 */
  const [peerInput, setPeerInput] = React.useState("")

  const [messages, setMessages] = React.useState<DmMessage[]>([])
  const [peerName, setPeerName] = React.useState<string | null>(null)
  const [msgLoading, setMsgLoading] = React.useState(false)
  const [text, setText] = React.useState("")
  const [sending, setSending] = React.useState(false)

  /** 增量轮询游标 */
  const cursorRef = React.useRef<string | null>(null)
  /** 当前打开的对端（供定时器里的静默路径用 ref 校验，避免切会话时串台） */
  const peerRef = React.useRef<string | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)

  const loadConversations = React.useCallback(async () => {
    try {
      const res = await dmApi.conversations()
      setConversations(res.conversations)
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
    try {
      const res = await dmApi.list(peer)
      setMessages(res.messages)
      cursorRef.current = res.nextCursor
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
      const res = await dmApi.list(peer, cursorRef.current ?? undefined)
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

  // 新消息自动滚到底
  React.useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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

        {/* 右：会话内容 */}
        <section className="flex min-h-[28rem] flex-col rounded-lg border">
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
                  nickname={null}
                  hasAvatar={false}
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

              <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
                {msgLoading ? (
                  <div className="py-8">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("dmsg.noMessages")}
                  </p>
                ) : (
                  messages.map((m) => {
                    const mine = m.fromUserId === user?.id
                    return (
                      <div
                        key={m.id}
                        className={cn("flex items-end gap-2", mine && "flex-row-reverse")}
                      >
                        <UserAvatar
                          username={mine ? (user?.username ?? "") : peerName}
                          nickname={null}
                          hasAvatar={false}
                          className="h-6 w-6"
                        />
                        <div className={cn("max-w-[75%]", mine && "text-right")}>
                          <div
                            className={cn(
                              "inline-block whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
                              mine
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted"
                            )}
                          >
                            {m.body}
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {relTime(m.createdAt)}
                            {mine && m.readAt ? t("dmsg.read") : ""}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <form
                className="flex gap-2 border-t p-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void send()
                }}
              >
                <Input
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
