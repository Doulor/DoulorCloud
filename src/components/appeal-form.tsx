import * as React from "react"
import { CheckCircle2, Loader2, Send } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { appealApi, errMsg } from "@/services/api"
import { useT } from "@/i18n"

/**
 * 封禁申诉表单。
 *
 * 用在两个地方：登录页（检测到账号被封禁时直接展开）和独立页 `/appeal`
 * （用户没在登录页时也能找到入口）。两处共用同一个组件，行为一致。
 *
 * ⚠️ 提交是**公开接口**：被封禁的账号登录会被 403、拿不到会话，
 * 所以这里不带任何鉴权，只凭「用户名 + 说明」提交。服务端会校验
 * 「该账号当前确实处于封禁状态」，否则拒绝（避免变成公开留言板）。
 */
export function AppealForm({ defaultUsername = "" }: { defaultUsername?: string }) {
  const { t } = useT()
  /** 账号标识：用户名**或**注册邮箱（登录页带过来的是用户名） */
  const [identifier, setIdentifier] = React.useState(defaultUsername)
  const [contact, setContact] = React.useState("")
  const [content, setContent] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState(false)

  const len = content.trim().length
  const canSubmit = identifier.trim().length > 0 && len >= 10 && !busy

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      await appealApi.submit({
        identifier: identifier.trim(),
        contact: contact.trim(),
        content: content.trim(),
      })
      setDone(true)
    } catch (err) {
      toast.error(errMsg(err, t("appeal.err.submit")))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t("appeal.submitted")}</p>
          <p className="text-muted-foreground">{t("appeal.submittedDesc")}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="appeal-username">{t("appeal.username")}</Label>
        <Input
          id="appeal-username"
          placeholder={t("appeal.usernamePlaceholder")}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="appeal-contact">{t("appeal.contact")}</Label>
        <Input
          id="appeal-contact"
          placeholder={t("appeal.contactPlaceholder")}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="appeal-content">{t("appeal.content")}</Label>
        <Textarea
          id="appeal-content"
          rows={5}
          placeholder={t("appeal.contentPlaceholder")}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {len < 10 ? t("appeal.tooShort", { n: 10 - len }) : t("appeal.charCount", { n: len })}
        </p>
      </div>
      <Button onClick={() => void submit()} disabled={!canSubmit} className="w-full">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {t("appeal.submit")}
      </Button>
    </div>
  )
}
