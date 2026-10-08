import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { AlertTriangle, CheckCheck, CheckSquare, Copy, Inbox, ListChecks, Loader2, Mail, Pencil, Plus, RefreshCw, Reply, RotateCcw, Send, Settings, Square, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { fmtMailTime } from "@/lib/format"
import { emailApi, HttpError } from "@/services/api"
import { useT } from "@/i18n"
import type { Mailbox, MailMessage, RootDomainOption } from "@/types"

/** 邮箱数量上限的兜底值（真实值由后端 GET /api/mailbox 的 limit 返回，
 *  管理员为 999999 哨兵值 → 界面显示「不限」） */
const FALLBACK_MAILBOX_LIMIT = 3
/** 后端表示「不限」的哨兵值 */
const UNLIMITED_LIMIT = 999999
/** 临时邮箱额度的兜底值（真实值由后端 tempLimit 返回，与普通邮箱额度互不占用） */
const FALLBACK_TEMP_LIMIT = 1

/**
 * 收件箱自动刷新间隔（毫秒）。
 *
 * 为什么用轮询而不是 WebSocket / SSE：新邮件是「邮件路由 → Worker」这条
 * **一次性调用**链路写进 D1 的，Worker 之间没有常驻连接；想把新邮件主动推给
 * 某个用户的浏览器，就得引入 Durable Object 常驻房间（本项目刻意不引 DO）。
 * 几秒一次的轮询在体验上几乎等价，做法也与聊天室一致（见 chat.tsx 的 5s 轮询）。
 */
const INBOX_POLL_MS = 15000
/** 轮询只取最近 N 封：目的是看「有没有新邮件」，没必要每次都拉满 100 条 */
const INBOX_POLL_LIMIT = 20
/** 刷新图标至少转这么久 —— 请求再快也转满一圈，否则「刷新过」看不出来 */
const REFRESH_SPIN_MIN_MS = 600

/**
 * 把轮询拿到的最新一页合并进本地列表。
 *
 * 规则：
 *   · 服务端有、本地没有的 → 是新邮件，插到最前面（incoming 本身就是新→旧，顺序可直接用）；
 *   · 本地已有的 → **原样保留**，不拿服务端结果覆盖。
 *     它们唯一会变的字段是 read，而 read 在本地有乐观更新（点开邮件立刻减未读），
 *     用轮询结果覆盖会把「刚点开」的邮件闪回未读（markRead 请求还在路上时尤其明显）。
 *   · 本地有、本次这一页没有的 → 保留。它们可能是「加载更早」翻出来的旧邮件，
 *     也可能是被新邮件从第一页挤出去的，直接丢掉会让列表凭空少几行。
 */
function mergeIncomingMessages(prev: MailMessage[], incoming: MailMessage[]): MailMessage[] {
  if (incoming.length === 0) return prev
  if (prev.length === 0) return incoming
  const seen = new Set(prev.map((m) => m.id))
  const added = incoming.filter((m) => !seen.has(m.id))
  return added.length > 0 ? [...added, ...prev] : prev
}

type View = "list" | "message"

export default function EmailPage() {
  const { t } = useT()
  const [searchParams, setSearchParams] = useSearchParams()
  const pendingMailbox = searchParams.get("mailbox")
  const pendingMessage = searchParams.get("message")

  /**
   * 可选根域（按权限由后端筛过：没解锁 `doulor` 权限就没有 doulor.cn）。
   * 只有多于一个时才渲染选择器 —— 多数用户只有一个域，多一个下拉框只是噪音。
   */
  const [rootOptions, setRootOptions] = React.useState<RootDomainOption[]>([])
  /** 新建邮箱要用的域名（默认取默认域） */
  const [mailDomain, setMailDomain] = React.useState("")
  const [mailboxes, setMailboxes] = React.useState<Mailbox[]>([])
  const [mailboxLimit, setMailboxLimit] = React.useState(FALLBACK_MAILBOX_LIMIT)
  // 临时邮箱额度：与 mailboxLimit 独立，互不占用
  const [tempLimit, setTempLimit] = React.useState(FALLBACK_TEMP_LIMIT)
  const [tempBusy, setTempBusy] = React.useState(false)
  const [selected, setSelected] = React.useState<Mailbox | null>(null)
  const [messages, setMessages] = React.useState<MailMessage[]>([])
  // M16：非 null 表示收件箱还有更旧的邮件没取回来（后端游标分页）
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [opened, setOpened] = React.useState<MailMessage | null>(null)
  const [view, setView] = React.useState<View>("list")
  const [loadingMailboxes, setLoadingMailboxes] = React.useState(true)
  const [loadingMessages, setLoadingMessages] = React.useState(false)
  const [loadingBody, setLoadingBody] = React.useState(false)
  /** 收件箱正在静默刷新（只驱动刷新图标转，不显示骨架屏） */
  const [refreshing, setRefreshing] = React.useState(false)
  /** 同一次静默刷新不叠加：自动轮询与手动点击撞在一起时，后到的直接跳过 */
  const refreshInFlight = React.useRef(false)
  /**
   * 当前选中的邮箱 id（给异步回调用）。
   *
   * 静默刷新是异步的，飞行期间用户可能切到别的邮箱；回来时必须先确认
   * 「这份结果还是不是给当前这个邮箱的」，否则会把 A 的邮件混进 B 的列表。
   */
  const selectedMailboxIdRef = React.useRef<string | null>(null)
  /**
   * 最近一次「本地改动未读数」的时间戳。
   *
   * 用途：本地点开邮件会先乐观地 -1，再等服务端 markRead 落库。如果轮询恰好在这个
   * 窗口里读到服务端的旧值，就会把刚减掉的未读数又加回去（3 → 2 → 3 → 2 的闪烁）。
   * 所以本地刚改过的短时间内，不用服务端数据覆盖。
   */
  const lastLocalUnreadChange = React.useRef(0)
  const [busy, setBusy] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  /** 批量删除：选中的邮件 id 集合 */
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  /** 「编辑模式」：默认关，点工具栏「编辑」才显示勾选框 + 全选（2026-10-04 站长要求） */
  const [selecting, setSelecting] = React.useState(false)

  // 添加邮箱
  const [addOpen, setAddOpen] = React.useState(false)
  const [localPart, setLocalPart] = React.useState("")

  // 写邮件（站内互发）：以当前选中邮箱为发件人，发给本站另一个邮箱
  const [composeOpen, setComposeOpen] = React.useState(false)
  const [composeTo, setComposeTo] = React.useState("")
  const [composeSubject, setComposeSubject] = React.useState("")
  const [composeText, setComposeText] = React.useState("")
  const [composeBusy, setComposeBusy] = React.useState(false)
  const [composeError, setComposeError] = React.useState<string | null>(null)

  // 转发配置（按邮箱独立弹窗）
  const [forwardBox, setForwardBox] = React.useState<Mailbox | null>(null)
  const [forwardInput, setForwardInput] = React.useState("")
  const [savingForward, setSavingForward] = React.useState(false)
  // 转发目标验证码流程
  const [verifyingEmail, setVerifyingEmail] = React.useState<string | null>(null)
  const [forwardCode, setForwardCode] = React.useState("")
  const [forwardVerifyBusy, setForwardVerifyBusy] = React.useState(false)

  const loadMailboxes = React.useCallback(async (selectId?: string) => {
    setLoadingMailboxes(true)
    try {
      const res = await emailApi.list()
      setMailboxes(res.mailboxes)
      if (typeof res.limit === "number") setMailboxLimit(res.limit)
      if (typeof res.tempLimit === "number") setTempLimit(res.tempLimit)
      const roots = res.rootDomains ?? []
      const fallback = (roots.find((r) => r.isDefault) ?? roots[0])?.name ?? ""
      setRootOptions(roots)
      // 只在「没选过 / 原选中项已不可用」时重置，别把用户的选择冲掉
      setMailDomain((prev) =>
        roots.some((r) => r.name === prev) ? prev : fallback
      )
      // 优先级：显式指定 > query 参数 ?mailbox= > 主邮箱 > 第一个
      const target =
        res.mailboxes.find((m) => m.id === selectId) ??
        (pendingMailbox ? res.mailboxes.find((m) => m.id === pendingMailbox) : null) ??
        res.mailboxes.find((m) => m.primary) ??
        res.mailboxes[0] ??
        null
      setSelected(target)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.loadMailboxes"))
    } finally {
      setLoadingMailboxes(false)
    }
  }, [pendingMailbox])

  const loadMessages = React.useCallback(async (mailboxId: string) => {
    setLoadingMessages(true)
    setView("list")
    setOpened(null)
    try {
      const res = await emailApi.listMessages(mailboxId)
      setMessages(res.messages)
      setNextCursor(res.nextCursor)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.loadMessages"))
      setMessages([])
      setNextCursor(null)
    } finally {
      setLoadingMessages(false)
    }
  }, [])

  /**
   * M16：取更旧的一页并**追加**到列表尾部。
   * 用 nextCursor 而不是 offset —— 收件箱在翻页过程中会不断有新邮件进来，
   * offset 会让同一封邮件重复出现或整条被跳过。
   */
  const loadMoreMessages = React.useCallback(async () => {
    if (!selected || !nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await emailApi.listMessages(selected.id, nextCursor)
      // 按 id 去重再追加：期间若有新邮件到达导致页边界重叠，也不会出现重复项
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id))
        return [...prev, ...res.messages.filter((m) => !seen.has(m.id))]
      })
      setNextCursor(res.nextCursor)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.loadOlder"))
    } finally {
      setLoadingMore(false)
    }
  }, [selected, nextCursor, loadingMore])

  /**
   * 静默刷新收件箱：只把新邮件合并进列表。
   *
   * 为什么不直接复用 loadMessages —— 它有两点在后台刷新时是致命的：
   *   1. 会 setView("list") + setOpened(null)：用户正在读邮件时被这么刷一下，正文会被踢掉；
   *   2. 会 setLoadingMessages(true)：每轮询一次列表就闪一次骨架屏。
   * 所以自动轮询与手动「刷新」按钮都走这条独立路径。
   */
  const silentRefresh = React.useCallback(async (mailboxId: string) => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    const startedAt = Date.now()
    try {
      const res = await emailApi.listMessages(mailboxId, null, INBOX_POLL_LIMIT)
      // 飞行期间用户可能已经切了邮箱：这份结果只对当时的那个邮箱有效，
      // 否则会把上一个邮箱的邮件混进当前列表
      if (selectedMailboxIdRef.current !== mailboxId) return
      setMessages((prev) => mergeIncomingMessages(prev, res.messages))
      // ⚠️ 刻意**不**更新 nextCursor：它锚在「本地列表尾部」，而新邮件只会插到头部。
      //    若改用本次（只取 20 条）响应里的游标，反而会把中间那段邮件整段跳过去。
    } catch {
      // 静默失败：网络抖一下就在界面上弹错误太吵，下一次轮询自然会补上。
    } finally {
      // 请求很快时图标只转一点点，看不出刷新过；补足到最短旋转时长
      const rest = REFRESH_SPIN_MIN_MS - (Date.now() - startedAt)
      if (rest > 0) await new Promise((r) => setTimeout(r, rest))
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [])

  /**
   * 同步左侧各邮箱的未读数。
   *
   * 为什么不复用 loadMailboxes —— 它内部会按「显式指定 > query 参数 > 主邮箱 > 第一个」
   * 重新挑一次当前邮箱，拿它做定时刷新会在用户正看 B 邮箱时被莫名切走。
   * 这里只按 id 对齐未读数，**绝不改当前选中**。
   */
  const syncMailboxUnread = React.useCallback(async () => {
    // 本地刚改过未读数（点开邮件 / 全部已读）时先跳过一个周期，避免和乐观更新打架
    if (Date.now() - lastLocalUnreadChange.current < 2000) return
    try {
      const res = await emailApi.list()
      setMailboxes((prev) =>
        prev.map((m) => {
          const fresh = res.mailboxes.find((x) => x.id === m.id)
          return fresh && fresh.unread !== m.unread ? { ...m, unread: fresh.unread } : m
        })
      )
    } catch {
      /* 静默：下一次轮询会补 */
    }
  }, [])

  React.useEffect(() => {
    void loadMailboxes()
    // 只在挂载时跑一次。?mailbox= 只用于「初始选中」；自动打开邮件会清掉 query，
    // 若这里依赖 loadMailboxes（其内部依赖 pendingMailbox），清 query 会触发本
    // effect 重跑，把已选中的子邮箱冲回主邮箱/第一个（2026-10-02 反馈「首页最近
    // 邮件点子邮箱 → 先跳对再刷回默认邮箱」）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    if (selected) {
      setSelectedIds(new Set()) // 切邮箱清空批量选择的勾选
      setSelecting(false) // 切邮箱退出编辑模式
      void loadMessages(selected.id)
    }
  }, [selected?.id, loadMessages])

  // 带 ?message= 跳转过来：messages 加载后自动打开该邮件，然后清掉 query
  React.useEffect(() => {
    if (!pendingMessage || !selected || loadingMessages) return
    const target = messages.find((m) => m.id === pendingMessage)
    if (target) {
      void handleOpenMessage(target)
      // 清除 query 参数，避免刷新又触发
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete("mailbox")
        next.delete("message")
        return next
      })
    }
  }, [pendingMessage, messages, selected, loadingMessages])

  /**
   * 收件箱自动刷新：定时轮询 + 从后台切回前台时立刻补一次。
   *
   * 页面在后台时**不打接口** —— 用户切走了还在每 5 秒查一次 D1 没有意义。
   * 依赖 selectedMailboxId 而不是 selected 对象：后者每次 loadMailboxes 都会换
   * 新对象，效果会被反复拆了重建，轮询节奏就乱了。
   */
  const selectedMailboxId = selected?.id ?? null
  // 让异步回调始终能拿到「当前是哪个邮箱」（见 selectedMailboxIdRef 的说明）
  React.useEffect(() => {
    selectedMailboxIdRef.current = selectedMailboxId
  }, [selectedMailboxId])

  React.useEffect(() => {
    if (!selectedMailboxId) return
    const tick = () => {
      if (document.visibilityState !== "visible") return
      void silentRefresh(selectedMailboxId)
      void syncMailboxUnread()
    }
    const timer = window.setInterval(tick, INBOX_POLL_MS)
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [selectedMailboxId, silentRefresh, syncMailboxUnread])

  // 更新本地未读数（邮件已读时）
  /**
   * 按增量调整未读数。
   * 必须在函数式更新里计算：直接读 selected.unread 会拿到渲染时的旧值，
   * 连续快速操作两封邮件时两次都基于同一个旧值，未读数会被算错。
   */
  const bumpUnread = React.useCallback(
    (mailboxId: string, delta: number) => {
      // 记下本地改动时间：轮询在随后一小段时间内不覆盖未读数（见 lastLocalUnreadChange）
      lastLocalUnreadChange.current = Date.now()
      setMailboxes((prev) =>
        prev.map((mb) =>
          mb.id === mailboxId
            ? { ...mb, unread: Math.max(0, mb.unread + delta) }
            : mb
        )
      )
    },
    []
  )

  const handleOpenMessage = async (message: MailMessage) => {
    if (!selected) return
    const mailboxId = selected.id

    // 列表接口不返回正文，先展示占位再拉取单封详情（含正文）
    setOpened(message)
    setView("message")
    setLoadingBody(true)
    try {
      const res = await emailApi.getMessage(mailboxId, message.id)
      setOpened(res.message)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.loadBody"))
    } finally {
      setLoadingBody(false)
    }

    if (!message.read) {
      setMessages((prev) =>
        prev.map((m) => (m.id === message.id ? { ...m, read: true } : m))
      )
      bumpUnread(mailboxId, -1)
      try {
        await emailApi.markRead(mailboxId, message.id, true)
      } catch (err) {
        // ⚠️ 2026-09-26：乐观更新回写失败要提示 —— 否则用户以为已经读了，
        // 刷新后又变回未读。与同文件「标记未读」的失败处理保持一致。
        toast.error(err instanceof HttpError ? err.message : t("em.err.markRead"))
      }
    }
  }

  const totalUnread = mailboxes.reduce((sum, m) => sum + (m.unread ?? 0), 0)

  const handleMarkUnread = async () => {
    if (!opened || !selected) return
    setMessages((prev) => prev.map((m) => (m.id === opened.id ? { ...m, read: false } : m)))
    bumpUnread(selected.id, 1)
    setOpened({ ...opened, read: false })
    setView("list")
    try {
      await emailApi.markRead(selected.id, opened.id, false)
      toast.success(t("em.ok.markedUnread"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.op"))
    }
  }

  // 一键全部已读：把所有 mailbox 的未读标已读
  const handleMarkAllRead = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await emailApi.markAllRead()
      // 本地：所有邮箱未读清零、当前列表全标已读
      lastLocalUnreadChange.current = Date.now()
      setMailboxes((prev) => prev.map((m) => ({ ...m, unread: 0 })))
      setMessages((prev) => prev.map((m) => ({ ...m, read: true })))
      toast.success(t("em.ok.markedRead", { n: res.updated }))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.op"))
    } finally {
      setBusy(false)
    }
  }

  /** 写邮件：以当前选中邮箱为发件人，站内互发（只发给本站根域邮箱） */
  const handleSendInternal = async () => {
    if (!selected || composeBusy) return
    const to = composeTo.trim()
    const text = composeText.trim()
    if (!to || !text) return
    setComposeBusy(true)
    setComposeError(null)
    try {
      const res = await emailApi.sendInternal(selected.id, {
        to,
        subject: composeSubject.trim(),
        text,
      })
      toast.success(t("em.ok.sentInternal", { to: res.to }))
      // 发完清空并关闭；如果收件人就是自己当前这个邮箱，顺手刷新列表让它立刻出现
      setComposeOpen(false)
      setComposeTo("")
      setComposeSubject("")
      setComposeText("")
      if (res.to === selected.address.toLowerCase()) void loadMessages(selected.id)
    } catch (err) {
      // 保留内容让用户改完重试（例如收件人写错）
      setComposeError(err instanceof HttpError ? err.message : t("em.err.send"))
    } finally {
      setComposeBusy(false)
    }
  }

  const handleDeleteMessage = async (messageId: string) => {
    if (!selected) return
    setDeletingId(messageId)
    try {
      await emailApi.deleteMessage(selected.id, messageId)
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
      if (opened?.id === messageId) {
        setOpened(null)
        setView("list")
      }
      void loadMailboxes()
      toast.success(t("em.ok.deleted"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    } finally {
      setDeletingId(null)
    }
  }

  /** 切换一封邮件的选中态（批量删除用） */
  const toggleSelect = (messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }

  /** 当前列表是否已全选（用于「全选 / 取消全选」按钮切换） */
  const allSelected = messages.length > 0 && messages.every((m) => selectedIds.has(m.id))

  /** 全选 / 取消全选：只对当前已加载的邮件生效 */
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(messages.map((m) => m.id)))
  }

  /** 退出编辑模式：清空勾选并隐藏勾选框 */
  const exitSelecting = () => {
    setSelecting(false)
    setSelectedIds(new Set())
  }

  /** 批量删除选中的邮件 */
  const handleBatchDelete = async () => {
    if (!selected || selectedIds.size === 0) return
    const ids = Array.from(selectedIds)
    setBusy(true)
    try {
      await emailApi.batchDeleteMessages(selected.id, ids)
      setMessages((prev) => prev.filter((m) => !selectedIds.has(m.id)))
      if (opened && selectedIds.has(opened.id)) {
        setOpened(null)
        setView("list")
      }
      setSelectedIds(new Set())
      void loadMailboxes()
      toast.success(t("em.ok.batchDeleted", { n: ids.length }))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    } finally {
      setBusy(false)
    }
  }

  const handleAddMailbox = async () => {
    setBusy(true)
    try {
      await emailApi.create({ localPart, domain: mailDomain || undefined })
      toast.success(t("em.ok.mailboxAdded"))
      setLocalPart("")
      setAddOpen(false)
      await loadMailboxes()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.create"))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteMailbox = async (mailbox: Mailbox) => {
    if (mailbox.primary) return
    setBusy(true)
    try {
      await emailApi.remove(mailbox.id)
      toast.success(t("em.ok.mailboxDeleted"))
      await loadMailboxes()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    } finally {
      setBusy(false)
    }
  }

  const openForwardDialog = (mailbox: Mailbox) => {
    setForwardBox(mailbox)
    setForwardInput(mailbox.forwardingTo.join(", "))
  }

  const handleSaveForwarding = async () => {
    if (!forwardBox) return
    setSavingForward(true)
    try {
      const targets = forwardInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const res = await emailApi.updateForwarding(forwardBox.id, targets)
      // 只更新这个邮箱的配置，不影响其他邮箱
      setMailboxes((prev) =>
        prev.map((mb) => (mb.id === res.mailbox.id ? res.mailbox : mb))
      )
      setForwardBox(null)

      const unverified = (res.forwardingStatus ?? []).filter((s) => !s.verified)
      if (unverified.length > 0) {
        toast.warning(
          t("em.ok.savedUnverified", { emails: unverified.map((u) => u.email).join(", ") })
        )
      } else {
        toast.success(t("em.ok.forwardSaved", { address: forwardBox.address }))
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.save"))
    } finally {
      setSavingForward(false)
    }
  }

  /** 发送转发目标验证码 */
  const handleSendForwardCode = async (email: string) => {
    setVerifyingEmail(email)
    setForwardCode("")
    setForwardVerifyBusy(true)
    try {
      const res = await emailApi.verifyForwardTarget(email)
      toast.success(res.message ?? t("em.ok.codeSent"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.send"))
      setVerifyingEmail(null)
    } finally {
      setForwardVerifyBusy(false)
    }
  }

  /** 回填转发目标验证码 */
  const handleConfirmForwardCode = async (email: string) => {
    if (!/^\d{6}$/.test(forwardCode)) {
      toast.error(t("em.err.enter6"))
      return
    }
    setForwardVerifyBusy(true)
    try {
      await emailApi.verifyForwardTarget(email, "confirm", forwardCode)
      toast.success(t("em.ok.emailVerified"))
      setVerifyingEmail(null)
      setForwardCode("")
      // 重新拉取邮箱列表，刷新转发目标的验证状态（保留当前选中）
      if (forwardBox) await loadMailboxes(forwardBox.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.verify"))
    } finally {
      setForwardVerifyBusy(false)
    }
  }

  /** 生成一个临时邮箱：地址由服务端随机产生，客户端不参与生成 */
  const handleCreateTemp = async () => {
    setTempBusy(true)
    try {
      const res = await emailApi.createTemp()
      toast.success(t("em.ok.tempCreated", { address: res.mailbox.address }))
      await loadMailboxes(res.mailbox.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.generate"))
    } finally {
      setTempBusy(false)
    }
  }

  /**
   * 换一个地址。服务端是「删旧建新」，所以旧地址立即失效、
   * 它收到的邮件也会一起消失 —— 这正是「临时」该有的语义。
   */
  const handleRefreshTemp = async (mailbox: Mailbox) => {
    setTempBusy(true)
    try {
      const res = await emailApi.refreshTemp(mailbox.id)
      toast.success(t("em.ok.tempRotated", { address: res.mailbox.address }))
      await loadMailboxes(res.mailbox.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.refresh"))
    } finally {
      setTempBusy(false)
    }
  }

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address)
      toast.success(t("em.ok.addressCopied"))
    } catch {
      // clipboard 在非 HTTPS / 无权限时会抛错，此时只能让用户手动选中
      toast.error(t("em.err.copy"))
    }
  }

  // 临时邮箱与普通邮箱由同一个接口返回，这里按标记分成两组展示
  const normalMailboxes = mailboxes.filter((mb) => !mb.isTemp)
  const tempMailboxes = mailboxes.filter((mb) => mb.isTemp)

  const unlimited = mailboxLimit >= UNLIMITED_LIMIT
  // ⚠️ 只能数普通邮箱：临时邮箱有自己的额度，混进来会把「添加邮箱」按钮误禁用
  const canAdd = unlimited || normalMailboxes.length < mailboxLimit
  const canAddTemp = unlimited || tempMailboxes.length < tempLimit

  return (
    <div>
      <PageHeader
        title={t("em.title")}
        description={
          unlimited
            ? t("em.quota.admin", { n: normalMailboxes.length })
            : t("em.quota.user", { n: normalMailboxes.length, limit: mailboxLimit })
        }
        actions={
          <div className="flex items-center gap-2">
            {totalUnread > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleMarkAllRead()}
                disabled={busy}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
                {t("em.markAllRead")}
                <Badge variant="secondary" className="ml-1">{totalUnread}</Badge>
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setComposeError(null)
                setComposeOpen(true)
              }}
              disabled={!selected}
              title={t("em.composeOnlyInternal")}
            >
              <Send className="h-4 w-4" />
              {t("em.compose")}
            </Button>
            <Button onClick={() => setAddOpen(true)} disabled={!canAdd}>
              <Plus className="h-4 w-4" />
              {t("em.addMailbox")}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
        {/* 邮箱侧栏 */}
        <div className="flex flex-col gap-3">
          {loadingMailboxes ? (
            <LoadingBlock variant="list" />
          ) : normalMailboxes.length === 0 ? (
            <EmptyState
              icon={Mail}
              title={t("em.empty")}
              description={t("em.emptyDesc")}
            />
          ) : (
            normalMailboxes.map((mb) => (
              <div
                key={mb.id}
                className={cn(
                  "group flex items-center gap-2 rounded-md border px-3 py-2.5 transition-colors",
                  selected?.id === mb.id ? "border-foreground/20 bg-accent" : "hover:bg-accent/50"
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setSelected(mb)}
                  title={
                    mb.forwardingTo.length > 0
                      ? t("em.forwardingTo", { to: mb.forwardingTo.join(", ") })
                      : undefined
                  }
                >
                  <div className="truncate">
                    <p className="truncate font-mono text-sm">{mb.address}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {mb.unread > 0 ? t("em.unreadCount", { n: mb.unread }) : t("em.totalCount", { n: mb.total })}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs">
                      {mb.forwardingTo.length === 0 ? (
                        <span className="text-muted-foreground/70">{t("em.forward.off")}</span>
                      ) : mb.lastForwardError ? (
                        <span className="font-medium text-destructive">{t("em.forward.failed")}</span>
                      ) : mb.forwardingVerified?.every((v) => v === true) ? (
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">
                          {t("em.forward.on")}
                        </span>
                      ) : (
                        <span className="font-medium text-amber-600 dark:text-amber-400">
                          {t("em.forward.pending")}
                        </span>
                      )}
                      {mb.forwardingTo.length > 0 && (
                        <span className="truncate font-mono text-muted-foreground">
                          → {mb.forwardingTo.join(", ")}
                        </span>
                      )}
                    </p>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {!mb.primary && (
                    <button
                      type="button"
                      className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                      onClick={() => void handleDeleteMailbox(mb)}
                      aria-label={t("em.deleteAria", { address: mb.address })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => openForwardDialog(mb)}
                    aria-label={t("em.setupAria", { address: mb.address })}
                  >
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}

          {/* 临时邮箱：地址由服务端随机生成，额度与上面的普通邮箱互不占用 */}
          {!loadingMailboxes && (
            <div className="mt-2 flex flex-col gap-2 border-t pt-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium">{t("em.temp.title")}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {unlimited ? t("em.temp.unlimited") : `${tempMailboxes.length} / ${tempLimit}`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => void handleCreateTemp()}
                  disabled={tempBusy || !canAddTemp}
                  title={canAddTemp ? undefined : t("em.temp.limitHint", { n: tempLimit })}
                >
                  {tempBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  {t("em.temp.generate")}
                </Button>
              </div>

              {tempMailboxes.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("em.temp.desc")}
                </p>
              ) : (
                tempMailboxes.map((mb) => (
                  <div
                    key={mb.id}
                    className={cn(
                      "rounded-md border border-dashed px-3 py-2.5 transition-colors",
                      selected?.id === mb.id
                        ? "border-foreground/20 bg-accent"
                        : "hover:bg-accent/50"
                    )}
                  >
                    <button
                      type="button"
                      className="w-full min-w-0 text-left"
                      onClick={() => setSelected(mb)}
                    >
                      <p className="truncate font-mono text-sm">{mb.address}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {mb.unread > 0 ? t("em.unreadCount", { n: mb.unread }) : t("em.totalCount", { n: mb.total })}
                      </p>
                    </button>
                    <div className="mt-1.5 flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => void handleCopyAddress(mb.address)}
                      >
                        <Copy className="h-3 w-3" />
                        {t("common.copy")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => void handleRefreshTemp(mb)}
                        disabled={tempBusy}
                        title={t("em.temp.rotateHint")}
                      >
                        <RefreshCw className="h-3 w-3" />
                        {t("em.temp.rotate")}
                      </Button>
                      <button
                        type="button"
                        className="ml-auto rounded p-1 text-muted-foreground hover:text-destructive"
                        onClick={() => void handleDeleteMailbox(mb)}
                        disabled={tempBusy}
                        aria-label={t("em.deleteAria", { address: mb.address })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 主区域：列表 / 阅读 */}
        <div className="min-w-0">
          {!selected ? (
            <EmptyState
              icon={Inbox}
              title={t("em.pickMailbox")}
              description={t("em.pickMailboxDesc")}
            />
          ) : view === "message" && opened ? (
            <MailMessageView
              mailbox={selected}
              message={opened}
              loadingBody={loadingBody}
              deleting={deletingId === opened.id}
              onBack={() => {
                setView("list")
                void loadMessages(selected.id)
              }}
              onMarkUnread={() => void handleMarkUnread()}
              onDelete={() => void handleDeleteMessage(opened.id)}
            />
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{selected.address}</span>
                </div>
                <div className="flex items-center gap-2">
                  {selecting ? (
                    <>
                      <Button variant="outline" size="sm" onClick={toggleSelectAll}>
                        <ListChecks className="mr-1 h-3.5 w-3.5" />
                        {allSelected ? t("em.deselectAll") : t("em.selectAll")}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {t("em.selectedCount", { n: selectedIds.size })}
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy || selectedIds.size === 0}
                        onClick={() => void handleBatchDelete()}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        {t("em.batchDelete")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={exitSelecting}>
                        {t("common.cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setSelecting(true)}>
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        {t("em.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => {
                          void silentRefresh(selected.id)
                          void syncMailboxUnread()
                        }}
                        aria-label={t("common.refresh")}
                        title={t("em.autoRefreshHint", { n: INBOX_POLL_MS / 1000 })}
                      >
                        <RotateCcw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="max-h-[560px] overflow-y-auto">
                {loadingMessages ? (
                  <LoadingBlock variant="list" />
                ) : messages.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title={t("em.inboxEmpty")}
                    description={t("em.inboxEmptyDesc", { address: selected.address })}
                  />
                ) : (
                  <>
                    {messages.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => void handleOpenMessage(m)}
                      className={cn(
                        "flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/50",
                        opened?.id === m.id && "bg-accent/60"
                      )}
                    >
                      {/* 勾选框默认隐藏，点「编辑」进入编辑模式才显示 */}
                      {selecting && (
                        <span
                          role="checkbox"
                          aria-checked={selectedIds.has(m.id)}
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleSelect(m.id)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              toggleSelect(m.id)
                            }
                          }}
                          className="shrink-0 text-muted-foreground/60 hover:text-foreground"
                        >
                          {selectedIds.has(m.id) ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "truncate text-sm",
                              !m.read ? "font-semibold" : "text-muted-foreground"
                            )}
                          >
                            {m.from || t("em.unknownSender")}
                          </span>
                          {!m.read && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {m.subject}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {fmtMailTime(m.receivedAt)}
                      </span>
                    </button>
                    ))}
                    {/* M16：还有更旧的邮件时才出现。修复前这里没有入口，
                        收件箱超过 100 封后旧邮件在界面上永久不可达。 */}
                    {nextCursor && (
                      <div className="border-t p-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          disabled={loadingMore}
                          onClick={() => void loadMoreMessages()}
                        >
                          {loadingMore ? t("common.loading") : t("em.loadOlder")}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 添加邮箱 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("em.addMailbox")}</DialogTitle>
            <DialogDescription>
              {t("em.dialog.addDesc")}
            </DialogDescription>
          </DialogHeader>
          {/* 邮箱建在哪个域名下：只有多个可选域时才需要选（列表由后端按权限下发） */}
          {rootOptions.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="mailDomain">{t("em.dialog.domain")}</Label>
              <Select value={mailDomain} onValueChange={setMailDomain}>
                <SelectTrigger id="mailDomain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rootOptions.map((r) => (
                    <SelectItem key={r.name} value={r.name}>
                      {r.label || r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="localPart">{t("em.dialog.localPart")}</Label>
            <div className="flex items-center gap-1">
              <Input
                id="localPart"
                placeholder="hello"
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                className="flex-1"
              />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {mailDomain ? `@${mailDomain}` : "@"}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleAddMailbox()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 写邮件（站内互发：只发给本站邮箱，直接落对方收件箱，不需付费通道） */}
      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("em.compose")}</DialogTitle>
            <DialogDescription>
              {t("em.composeDesc", { from: selected?.address ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>{t("em.composeOnlyInternal")}</span>
          </p>
          <div className="space-y-2">
            <Label htmlFor="composeTo">{t("em.composeTo")}</Label>
            <Input
              id="composeTo"
              placeholder={t("em.composeToPh")}
              value={composeTo}
              onChange={(e) => setComposeTo(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="composeSubject">{t("em.composeSubject")}</Label>
            <Input
              id="composeSubject"
              value={composeSubject}
              onChange={(e) => setComposeSubject(e.target.value)}
              maxLength={300}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="composeText">{t("em.composeBody")}</Label>
            <Textarea
              id="composeText"
              value={composeText}
              onChange={(e) => setComposeText(e.target.value)}
              rows={6}
              maxLength={20000}
              className="resize-y"
            />
          </div>
          {composeError && (
            <p className="flex items-start gap-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{composeError}</span>
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setComposeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleSendInternal()}
              disabled={composeBusy || !composeTo.trim() || !composeText.trim()}
            >
              {composeBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {t("em.composeSend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 转发设置（每个邮箱独立） */}
      <Dialog
        open={forwardBox !== null}
        onOpenChange={(open) => {
          if (!open) setForwardBox(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("em.forward.title")}</DialogTitle>
            <DialogDescription>
              {t("em.forward.desc", { address: forwardBox?.address ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="forwardInput">{t("em.forward.target")}</Label>
            <Input
              id="forwardInput"
              placeholder="you@example.com"
              value={forwardInput}
              onChange={(e) => setForwardInput(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("em.forward.hint")}
            </p>

            {/* 验证目标邮箱：输入任意邮箱 → 发验证码 → 回填 */}
            {verifyingEmail === null ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const first = forwardInput.split(",")[0]?.trim()
                  if (!first) {
                    toast.error(t("em.err.enterTarget"))
                    return
                  }
                  void handleSendForwardCode(first)
                }}
                disabled={forwardVerifyBusy}
              >
                {forwardVerifyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("settings.btn.sendCode")}
              </Button>
            ) : (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">
                  {t("em.codeSentTo.a")}
                  <span className="font-mono">{verifyingEmail}</span>
                  {t("em.codeSentTo.b")}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder={t("em.codePlaceholder")}
                    inputMode="numeric"
                    maxLength={6}
                    value={forwardCode}
                    onChange={(e) =>
                      setForwardCode(e.target.value.replace(/\D/g, ""))
                    }
                    className="font-mono text-sm tracking-widest"
                  />
                  <Button
                    size="sm"
                    onClick={() => void handleConfirmForwardCode(verifyingEmail)}
                    disabled={forwardVerifyBusy}
                  >
                    {forwardVerifyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("settings.email.confirmVerify")}
                  </Button>
                </div>
              </div>
            )}

            {forwardBox && forwardBox.forwardingTo.length > 0 && (
              <div className="space-y-1 rounded-md border px-3 py-2">
                {forwardBox.forwardingTo.map((email, i) => {
                  const state = forwardBox.forwardingVerified?.[i]
                  return (
                    <div
                      key={email}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="truncate font-mono">{email}</span>
                      {state === true ? (
                        <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
                          {t("settings.email.verified")}
                        </span>
                      ) : state === false ? (
                        <span className="shrink-0 text-amber-600 dark:text-amber-400">
                          {t("em.forward.pendingShort")}
                        </span>
                      ) : (
                        <span className="shrink-0 text-muted-foreground">
                          {t("em.forward.unknown")}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {forwardBox?.lastForwardError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                <p className="text-xs font-medium text-destructive">
                  {t("em.forward.lastFailed")}
                </p>
                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                  {forwardBox.lastForwardError}
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t("em.forward.verifyNote")}
            </p>

            {/* 转发进垃圾箱的说明：这是用户最常反馈的问题 */}
            <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  {t("em.forward.tip.title")}
                </p>
                <p>
                  {t("em.forward.tip.body")}
                </p>
                <p>
                  {t("em.forward.tip.fallback")}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForwardBox(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleSaveForwarding()} disabled={savingForward}>
              {savingForward && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MailMessageView({
  mailbox,
  message,
  loadingBody,
  deleting,
  onBack,
  onMarkUnread,
  onDelete,
}: {
  mailbox: Mailbox
  message: MailMessage
  loadingBody: boolean
  deleting: boolean
  onBack: () => void
  onMarkUnread: () => void
  onDelete: () => void
}) {
  const { t } = useT()
  const [replyOpen, setReplyOpen] = React.useState(false)

  /**
   * 回信走 mailto：点一下把收件人/主题/原文引用填进本机邮件客户端，
   * 在那边点发送（发件人是用户自己真实邮箱，完全免费、立刻可用）。
   *
   * 曾有一条「网页直接发信」的路径（Cloudflare Email Sending），但它依赖
   * **付费**的 Email Sending 域名 Onboard；未开通时只能发到账户内已验证地址，
   * 给任意外部来信人回信必然失败。2026-10-08 站长确认无法开通，已整体移除，
   * mailto 成为唯一的回信方式。原文引用截断到 ~1200 字：mailto URL 有长度限制。
   */
  /**
   * 解析原邮件的发件地址（供 mailto 填入收件人）。
   * 拒绝：多个尖括号组、以及 display name 里与真实地址不同的邮箱
   * —— 避免「看起来要发给 A、实际发给 B」的伪装。
   */
  const replyToAddress = React.useMemo(() => {
    const input = message.from ?? ""
    if ((input.match(/<[^>]*>/g) ?? []).length > 1) return ""
    const angled = /<([^>]+)>/.exec(input)
    const candidate = (angled ? angled[1] : input).trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return ""
    if (angled) {
      const displayName = input.slice(0, angled.index ?? 0)
      const lookalike = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.exec(displayName)
      if (lookalike && lookalike[0].trim().toLowerCase() !== candidate.toLowerCase()) {
        return ""
      }
    }
    return candidate
  }, [message.from])

  const mailtoHref = React.useMemo(() => {
    if (!replyToAddress) return ""
    const subject = /^re\s*:/i.test(message.subject ?? "")
      ? message.subject
      : t("em.replySubject", { subject: message.subject || t("em.noSubject") })
    const quoted = (message.body ?? "").slice(0, 1200)
    const body = quoted
      ? t("em.quoteBlock", { from: message.from ?? "", quoted })
      : ""
    return `mailto:${replyToAddress}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }, [replyToAddress, message.subject, message.body, message.from])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base leading-snug">
              {message.subject || t("em.noSubject")}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {t("em.metaLine", {
                from: message.from || t("em.unknownSender"),
                to: mailbox.address,
              })}{" "}
              {new Date(message.receivedAt).toLocaleString("zh-CN")}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t("em.backToList")}
          </Button>
        </div>
      </CardHeader>
      <div className="flex items-center gap-2 px-6 pb-4">
        <Button
          variant={replyOpen ? "secondary" : "outline"}
          size="sm"
          onClick={() => setReplyOpen((v) => !v)}
        >
          <Reply className="h-3.5 w-3.5" />
          {t("em.reply")}
        </Button>
        <Button variant="outline" size="sm" onClick={onMarkUnread}>
          <Mail className="h-3.5 w-3.5" />
          {t("em.markUnread")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          disabled={deleting}
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {t("common.delete")}
        </Button>
      </div>
      <CardContent className="space-y-4">
        {loadingBody ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("em.loadingBody")}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {message.body || t("em.noBody")}
          </pre>
        )}

        {replyOpen && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Reply className="h-3.5 w-3.5" />
              {message.from ? (
                <>
                  <span className="font-medium text-foreground">
                    {mailbox.address}
                  </span>
                  <span>{t("em.replyTo")}</span>
                  <span className="font-medium text-foreground">{message.from}</span>
                </>
              ) : (
                <span className="font-medium text-foreground">{mailbox.address}</span>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("em.mailtoNote")}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setReplyOpen(false)}>
                {t("em.collapse")}
              </Button>
              {mailtoHref ? (
                <Button asChild size="sm">
                  <a href={mailtoHref}>
                    <Send className="h-3.5 w-3.5" />
                    {t("em.useOwnMail")}
                  </a>
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">{t("em.noReplyAddress")}</span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}