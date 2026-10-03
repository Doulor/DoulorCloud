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
 * 多条未读：一条一条来，确认一条弹下一条。
 */
import * as React from "react"
import { Loader2, Megaphone } from "lucide-react"
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
import type { PendingNotice } from "@/types"
import { useAuth } from "@/hooks/use-auth"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"

export function NoticeAckGate() {
  const { t } = useT()
  const { user, loading } = useAuth()
  const [queue, setQueue] = React.useState<PendingNotice[]>([])
  const [submitting, setSubmitting] = React.useState(false)
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
  if (!current) return null

  const confirm = async () => {
    setSubmitting(true)
    try {
      await noticeApi.ack(current.id)
      setQueue((prev) => prev.slice(1))
      toast.success(t("noticeAck.done"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("noticeAck.fail"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        hideClose
        className="z-[100] max-w-xl"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
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

        {queue.length > 1 && (
          <p className="text-xs text-muted-foreground">
            {t("noticeAck.remaining", { n: queue.length - 1 })}
          </p>
        )}

        <Button className="w-full" disabled={submitting} onClick={confirm}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("noticeAck.confirm")}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
