/**
 * 管理端「通知」面板：给单个/多个用户发通知，可要求强制已读，
 * 可选「确认收到前禁用 AI 中转站」（同步禁用 NewAPI 账户），确认后自动还原。
 *
 * 2026-10-04 起还可在下面加一层「捐献门槛」：勾选渠道后，用户确认收到
 * **也不会解锁** AI 中转站，必须先捐献所选渠道（任选其一）才行。
 */
import * as React from "react"
import { Megaphone, Send, RotateCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { adminNoticeApi, errMsg } from "@/services/api"
import type { AdminNotice, DonationChannel } from "@/types"
import { fmtDateTime, relTime } from "@/lib/format"
import { useT } from "@/i18n"

/** 可作为门槛的捐献渠道（顺序即展示顺序） */
const DONATION_OPTIONS: { value: DonationChannel; labelKey: string }[] = [
  { value: "wb", labelKey: "adm.notice.ch.wb" },
  { value: "frp", labelKey: "adm.notice.ch.frp" },
  { value: "proxy", labelKey: "adm.notice.ch.proxy" },
]

export function AdminNoticesPanel() {
  const { t } = useT()
  const [usernames, setUsernames] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [body, setBody] = React.useState("")
  const [restrictAi, setRestrictAi] = React.useState(false)
  const [requireDonation, setRequireDonation] = React.useState<DonationChannel[]>([])
  const [sending, setSending] = React.useState(false)
  const [notices, setNotices] = React.useState<AdminNotice[] | null>(null)

  const load = React.useCallback(async () => {
    try {
      setNotices((await adminNoticeApi.list()).notices)
    } catch {
      /* 静默 */
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 用户名支持逗号 / 空格 / 换行分隔 */
  const parseUsernames = () =>
    usernames
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean)

  /**
   * 勾选捐献渠道时**自动锁上** AI 中转站：
   * 「确认后也不解锁」的前提是「确认前先锁住了」，否则用户本来就有权限，
   * 门槛形同虚设。锁住之后把开关置灰，避免站长误取消。
   */
  const toggleDonation = (ch: DonationChannel) => {
    setRequireDonation((prev) => {
      const next = prev.includes(ch) ? prev.filter((x) => x !== ch) : [...prev, ch]
      if (next.length > 0) setRestrictAi(true)
      return next
    })
  }

  const send = async () => {
    const targets = parseUsernames()
    if (targets.length === 0) {
      toast.error(t("adm.notice.needUsers"))
      return
    }
    if (!title.trim() || !body.trim()) {
      toast.error(t("adm.notice.needContent"))
      return
    }
    setSending(true)
    try {
      const r = await adminNoticeApi.send({
        usernames: targets,
        title: title.trim(),
        body: body.trim(),
        restrictFeatures: restrictAi ? ["ai"] : [],
        requireDonation,
      })
      toast.success(t("adm.notice.sent", { n: r.sent.length }))
      if (r.missing.length > 0) {
        toast.warning(t("adm.notice.missing", { n: r.missing.length, names: r.missing.join("、") }))
      }
      if (r.whitelisted.length > 0) {
        toast.info(t("adm.notice.whitelisted", { n: r.whitelisted.length }))
      }
      if (r.alreadyDonated.length > 0) {
        toast.info(t("adm.notice.alreadyDonated", { n: r.alreadyDonated.length }))
      }
      setUsernames("")
      setTitle("")
      setBody("")
      setRestrictAi(false)
      setRequireDonation([])
      void load()
    } catch (err) {
      toast.error(errMsg(err, t("adm.notice.fail")))
    } finally {
      setSending(false)
    }
  }

  const revoke = async (id: string) => {
    if (!confirm(t("adm.notice.revokeConfirm"))) return
    try {
      await adminNoticeApi.revoke(id)
      toast.success(t("adm.notice.revoked"))
      void load()
    } catch (err) {
      toast.error(errMsg(err, t("adm.notice.fail")))
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" />
            {t("adm.notice.sendTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("adm.notice.users")}</Label>
            <Textarea
              value={usernames}
              onChange={(e) => setUsernames(e.target.value)}
              placeholder={t("adm.notice.usersPh")}
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("adm.notice.title")}</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("adm.notice.titlePh")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("adm.notice.body")}</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder={t("adm.notice.bodyPh")} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("adm.notice.restrictAi")}</p>
              <p className="text-xs text-muted-foreground">{t("adm.notice.restrictAiHint")}</p>
            </div>
            <Switch
              checked={restrictAi}
              onCheckedChange={setRestrictAi}
              disabled={requireDonation.length > 0}
            />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("adm.notice.requireDonation")}</p>
              <p className="text-xs text-muted-foreground">{t("adm.notice.requireDonationHint")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {DONATION_OPTIONS.map((o) => {
                const on = requireDonation.includes(o.value)
                return (
                  <Button
                    key={o.value}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    onClick={() => toggleDonation(o.value)}
                  >
                    {t(o.labelKey)}
                  </Button>
                )
              })}
            </div>
            {requireDonation.length > 0 && (
              <p className="text-xs text-muted-foreground">{t("adm.notice.requireDonationOr")}</p>
            )}
          </div>

          <Button className="w-full" onClick={send} disabled={sending}>
            {sending ? <RotateCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t("adm.notice.send")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("adm.notice.listTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {notices === null ? (
            <LoadingBlock />
          ) : notices.length === 0 ? (
            <EmptyState icon={Megaphone} title={t("adm.notice.empty")} />
          ) : (
            <div className="divide-y">
              {notices.map((n) => (
                <div key={n.id} className="flex flex-wrap items-start gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{n.title}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        @{n.username}
                      </Badge>
                      {n.restrictFeatures.length > 0 && (
                        <Badge variant="outline" className="text-[10px] text-destructive">
                          {t("adm.notice.restricted")}
                        </Badge>
                      )}
                      {n.requireDonation.length > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {t("adm.notice.needDonationBadge", {
                            ch: n.requireDonation
                              .map((c) => t(DONATION_OPTIONS.find((o) => o.value === c)!.labelKey))
                              .join("/"),
                          })}
                        </Badge>
                      )}
                      {n.readAt && (
                        <Badge variant="secondary" className="text-[10px] text-emerald-600 dark:text-emerald-400">
                          {t("adm.notice.read")}
                        </Badge>
                      )}
                      {n.revokedAt && (
                        <Badge variant="secondary" className="text-[10px]">
                          {t("adm.notice.revoked")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                      {n.body}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground" title={fmtDateTime(n.createdAt)}>
                      {relTime(n.createdAt)}
                    </p>
                  </div>
                  {!n.readAt && !n.revokedAt && (
                    <Button variant="outline" size="sm" onClick={() => revoke(n.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("adm.notice.revoke")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
