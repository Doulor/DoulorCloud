/**
 * 管理端通知的「强制已读」弹窗（2026-10-03）。
 *
 * 仿照 `appeal-ack-dialog.tsx`（封禁解除后的强制弹窗）：
 *   登录后（或已登录打开页面时）拉一次 `/api/notice/pending`，只要有未确认的
 *   通知就弹这个**关不掉**的窗，用户点「确认收到」后才放行。
 *
 * 如果通知在发送时勾了「禁用某些权限（如中转站）」，用户确认收到后，
 * 后端会自动还原权限 + 重新启用 NewAPI 账户。
 *
 * 2026-10-04 增加「捐献门槛」：通知还可能要求用户**捐献指定渠道**才解锁。
 * 此时点「确认收到」会被后端拒绝，弹窗切到「还需捐献」态，列出缺哪些渠道，
 * 按钮变成「我已捐献，重新检测」—— 用户去捐完再点一次即可。
 *
 * ⚠️ **带捐献门槛的通知，弹窗必须可以正常关闭**（2026-10-04 站长指出）：
 * 第一版把它做成了「关不掉」的强制弹窗，但 Radix Dialog 是模态的
 * （全屏遮罩 + 焦点锁），用户被锁在里面**根本点不到侧边栏、去不了捐献页** ——
 * 「要你先去捐献」和「不让你去捐献」自相矛盾，是个死锁。
 * 现在改成：门槛未满足时可以关（右上角 X / 点遮罩 / Esc），
 * 关掉后左下角留一个常驻小药丸提醒，点它重新打开。
 * 另外**每次进入 AI 中转站栏目（`/dashboard/ai`）会自动再弹一次** ——
 * 那正是用户想用中转站的时候，必须让他看到「为什么用不了、怎么解」，
 * 但依然可以关掉（不阻断他去看别的）。
 * **真正的约束在后端**（`permissions.ai = false` + NewAPI 已禁用），
 * 弹窗只是通知渠道 —— 关掉弹窗不会解锁，用户照样用不了中转站。
 *
 * 无门槛的通知仍保持原有「强制已读」语义（那是它的设计目的）。
 *
 * 多条未读：一条一条来，确认一条弹下一条。
 */
import * as React from "react"
import { useLocation } from "react-router-dom"
import { Loader2, Megaphone, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { noticeApi, HttpError } from "@/services/api"
import type { DonationChannel, PendingNotice } from "@/types"
import { useAuth } from "@/hooks/use-auth"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"

/** 渠道 → i18n key（与管理端共用一套标签文案） */
const CHANNEL_LABEL_KEY: Record<DonationChannel, string> = {
  wb: "adm.notice.ch.wb",
  frp: "adm.notice.ch.frp",
  proxy: "adm.notice.ch.proxy",
}

/**
 * 「进入 AI 中转站栏目就重新提醒」要匹配的路径。
 * 用 `\/ai` 后面跟 `/` 或结尾来锚定，避免误命中 `/dashboard/airdrop` 这类前缀相同的路径。
 */
const AI_SECTION_RE = /^\/dashboard\/ai(\/|$)/

export function NoticeAckGate() {
  const { t } = useT()
  const { user, loading } = useAuth()
  const location = useLocation()
  const [queue, setQueue] = React.useState<PendingNotice[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  /**
   * 被捐献门槛拦下后的最新状态（后端每次都会重算，所以这里以后端返回为准）。
   * 切换通知时清空，回落到该通知自带的 donationMissing。
   */
  const [blocked, setBlocked] = React.useState<{
    required: DonationChannel[]
    missing: DonationChannel[]
  } | null>(null)
  /** 用户手动关掉了弹窗（仅「带捐献门槛」的通知允许），左下角改为常驻提醒 */
  const [closed, setClosed] = React.useState(false)
  /** 每个账号只探测一次，避免路由切换时反复打接口 */
  const probedFor = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (loading) return
    if (!user) {
      probedFor.current = null
      setQueue([])
      return
    }
    if (probedFor.current === user.id) return
    probedFor.current = user.id
    let cancelled = false
    noticeApi
      .pending()
      .then((r) => {
        if (!cancelled && r.notices.length > 0) setQueue(r.notices)
      })
      .catch(() => {}) // 静默：提醒不是门禁，接口抖动不能把用户挡住
    return () => {
      cancelled = true
    }
  }, [loading, user])

  const current = queue[0]

  // 换一条通知就丢掉上一条的「还缺什么」和「已关闭」，避免串台
  React.useEffect(() => {
    setBlocked(null)
    setClosed(false)
  }, [current?.id])

  /**
   * 进 AI 中转站栏目时再提醒一次（2026-10-04 站长要求）。
   *
   * 只在**路径真正发生变化**时触发，避免每次重渲染都把它弹回来 ——
   * 否则用户刚关掉就被立刻重新打开，等于关不掉。
   */
  const prevPath = React.useRef(location.pathname)
  React.useEffect(() => {
    const path = location.pathname
    const changed = path !== prevPath.current
    prevPath.current = path
    if (changed && AI_SECTION_RE.test(path)) setClosed(false)
  }, [location.pathname])

  if (!current) return null

  const state = blocked ?? {
    required: current.donationRequired,
    missing: current.donationMissing,
  }
  const needDonation = state.required.length > 0 && state.missing.length > 0
  /**
   * 可关闭 = 这条通知带捐献门槛。
   * 无门槛的通知必须确认收到才能继续（强制已读，与申诉弹窗同一约定）。
   */
  const closable = state.required.length > 0

  const confirm = async () => {
    setSubmitting(true)
    try {
      const r = await noticeApi.ack(current.id)
      if (r.ok) {
        setQueue((prev) => prev.slice(1))
        toast.success(t("noticeAck.done"))
        return
      }
      // 被捐献门槛拦住：权限仍锁着，按钮切到「重新检测」
      if (r.donationRequired) {
        setBlocked(r.donationRequired)
        toast.warning(t("noticeAck.needDonation"))
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("noticeAck.fail"))
    } finally {
      setSubmitting(false)
    }
  }

  // 关掉之后：左下角留一个常驻入口，点它重新打开（不能就此让用户找不到）
  if (closed) {
    return (
      <button
        type="button"
        onClick={() => setClosed(false)}
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border bg-background px-3.5 py-2 text-xs font-medium shadow-lg transition-colors hover:bg-accent"
      >
        <Megaphone className="h-3.5 w-3.5 text-primary" />
        {t("noticeAck.pill", { n: queue.length })}
      </button>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 只有带捐献门槛的通知允许关闭；其余保持关不掉
        if (!open && closable) setClosed(true)
      }}
    >
      <DialogContent
        hideClose={!closable}
        className="z-[100] max-w-xl"
        onEscapeKeyDown={(e) => {
          if (!closable) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (!closable) e.preventDefault()
        }}
        onPointerDownOutside={(e) => {
          if (!closable) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" />
            {current.title}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("noticeAck.sentAt", { time: fmtDateTime(current.createdAt) })}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/50 p-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{current.body}</p>
        </div>

        {state.required.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{t("noticeAck.donationTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {t("noticeAck.donationHint", {
                ch: state.required.map((c) => t(CHANNEL_LABEL_KEY[c])).join(" / "),
              })}
            </p>
            {needDonation && (
              <p className="text-xs text-muted-foreground">
                {t("noticeAck.donationMissing", {
                  ch: state.missing.map((c) => t(CHANNEL_LABEL_KEY[c])).join(" / "),
                })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("noticeAck.closeHint")}</p>
          </div>
        )}

        {queue.length > 1 && (
          <p className="text-xs text-muted-foreground">
            {t("noticeAck.remaining", { n: queue.length - 1 })}
          </p>
        )}

        <Button className="w-full" disabled={submitting} onClick={confirm}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : needDonation ? (
            <RefreshCw className="h-4 w-4" />
          ) : null}
          {needDonation ? t("noticeAck.recheck") : t("noticeAck.confirm")}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
