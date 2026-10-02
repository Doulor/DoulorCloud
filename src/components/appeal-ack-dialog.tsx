/**
 * 申诉回复的「强制已读」弹窗（2026-10-02 站长要求）。
 *
 * 背景：管理员处理完申诉、写了回复，用户却「没看见」。原因是他解封后直接进站，
 * 站里没有任何地方再展示这条回复。所以这里做**补发**：
 *   登录后（或已登录打开页面时）拉一次 `/api/appeal/pending-reply`，
 *   只要还有「有回复但没确认看过」的申诉，就弹这个**关不掉**的窗。
 *
 * 三条硬约束（都来自站长原话）：
 *   1. 强行、醒目地显示 —— 无右上角关闭按钮、点遮罩和按 ESC 都关不掉；
 *   2. **必须勾第一个**（"我已完全明白封号原因，并承诺以后不再违规"）才能点确认；
 *   3. 确认后写入 `note_read_at`，从此不再弹（同一账号不会重复骚扰）。
 *
 * 🚨 勾第二个**不会**让弹窗关闭，也不会留下「已读」记录 —— 这是他自己的选择；
 *    他随时可以改回勾第一个再点确认。所以不存在「被永久卡住」的人。
 *    这里另外给一个「意见反馈」的入口（新标签打开，否则弹窗一拦就点不到），
 *    让确实没看明白的人能直接找管理员说明情况。
 */
import * as React from "react"
import { Loader2, ShieldAlert, MessageSquareWarning, ExternalLink, Info } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { appealApi, HttpError } from "@/services/api"
import type { AppealPendingReply } from "@/types"
import { useAuth } from "@/hooks/use-auth"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"

/** 用户在弹窗里勾的那一项 */
type Choice = "understood" | "unclear"

export function AppealAckGate() {
  const { t } = useT()
  const { user, loading } = useAuth()
  const [reply, setReply] = React.useState<AppealPendingReply | null>(null)
  const [choice, setChoice] = React.useState<Choice | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  /** 每个账号只探测一次，避免路由切换时反复打接口 */
  const probedFor = React.useRef<string | null>(null)
  /** 「勾了第二个」只需上报一次（重复点会刷审计） */
  const reportedUnclear = React.useRef(false)

  React.useEffect(() => {
    if (loading) return
    if (!user) {
      // 登出后清干净，换账号再登时能重新探测
      probedFor.current = null
      setReply(null)
      setChoice(null)
      reportedUnclear.current = false
      return
    }
    if (probedFor.current === user.id) return
    probedFor.current = user.id
    let cancelled = false
    appealApi
      .pendingReply()
      .then((r) => {
        if (!cancelled && r.reply) setReply(r.reply)
      })
      // 失败静默：这是个「提醒」而不是「门禁」，不能因为接口抖动把用户挡住
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [loading, user])

  if (!reply) return null

  /**
   * 勾选。
   *
   * 勾第二个时**只上报、不关窗** —— 让管理员知道这个人自称没看明白，
   * 好去申诉列表里点「放行」把他放回来。
   */
  const pick = (next: Choice) => {
    setChoice(next)
    if (next !== "unclear") return
    if (reportedUnclear.current) return
    reportedUnclear.current = true
    appealApi
      .acknowledge({ appealId: reply.id, choice: "unclear" })
      // 静默失败：这只是给管理员的一条线索，不能因此弹错误提示吓到用户
      .catch(() => {})
  }

  const confirm = async () => {
    // 兜底：只有勾第一个才允许提交（按钮本身也已 disabled）
    if (choice !== "understood") return
    setSubmitting(true)
    try {
      await appealApi.acknowledge({ appealId: reply.id, choice })
      setReply(null)
      setChoice(null)
      toast.success(t("appealAck.done"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("appealAck.fail"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        // hideClose：去掉右上角 ×，配合下面的三个 preventDefault 做到「关不掉」
        hideClose
        className="z-[100] max-w-xl"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            {t("appealAck.title")}
          </DialogTitle>
          <DialogDescription>{t("appealAck.desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 处理结果 + 时间 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              className={
                reply.status === "accepted"
                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                  : "font-medium text-destructive"
              }
            >
              {t(
                reply.status === "accepted"
                  ? "appealAck.status.accepted"
                  : reply.status === "rejected"
                    ? "appealAck.status.rejected"
                    : "login.appealStatus"
              )}
            </span>
            {reply.reviewedAt && (
              <span>{t("appealAck.repliedAt", { time: fmtDateTime(reply.reviewedAt) })}</span>
            )}
          </div>

          {/* 管理员回复正文 —— 弹窗的主体，要最醒目 */}
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t("appealAck.replyLabel")}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{reply.reviewNote}</p>
          </div>

          {/* 两个选项：必须勾第一个才能确认 */}
          <div className="space-y-2">
            <ChoiceRow
              checked={choice === "understood"}
              disabled={submitting}
              onSelect={() => pick("understood")}
              label={t("appealAck.understood")}
            />
            <ChoiceRow
              checked={choice === "unclear"}
              disabled={submitting}
              onSelect={() => pick("unclear")}
              label={t("appealAck.unclear")}
            />
          </div>

          {/* 勾了第二个 → 说明为什么关不掉，并给出联系管理员的出口 */}
          {choice === "unclear" && (
            <div className="space-y-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <p className="flex items-start gap-2">
                <MessageSquareWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t("appealAck.unclearHint")}
              </p>
              <a
                // 新标签打开 —— 弹窗盖住整个站，同页跳转等于点不到
                href="/dashboard/feedback"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                {t("appealAck.unclearLink")}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {/* 只有勾第一个才亮；勾第二个时明说按钮为什么不亮 */}
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {choice === "unclear" ? t("appealAck.mustPickUnderstood") : t("appealAck.pickHint")}
          </p>
        </div>

        <Button
          className="w-full"
          disabled={choice !== "understood" || submitting}
          onClick={confirm}
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? t("appealAck.confirming") : t("appealAck.confirm")}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 单个可勾选项。
 *
 * 用 checkbox 而不是 radio 是因为站长原话是「勾选选项」；
 * 但语义上是**单选**（两个选项互斥，说的是相反的两种情况），
 * 所以在父组件里 `setChoice` 天然实现了「选一个新的就取消旧的」。
 */
function ChoiceRow({
  checked,
  disabled,
  onSelect,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onSelect: () => void
  label: string
}) {
  return (
    <label
      className={
        "flex items-start gap-3 rounded-lg border p-3 text-sm transition-colors " +
        (disabled ? "cursor-not-allowed opacity-70 " : "cursor-pointer ") +
        (checked ? "border-primary bg-primary/5" : "hover:bg-muted/60")
      }
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="leading-relaxed">{label}</span>
    </label>
  )
}
