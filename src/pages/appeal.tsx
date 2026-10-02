import { ShieldAlert } from "lucide-react"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { AppealForm } from "@/components/appeal-form"
import { useT } from "@/i18n"

/**
 * 独立申诉页 `/appeal`。
 *
 * 为什么除了「登录页内联申诉」还要单独一页：被封禁的用户可能压根没在登录页
 * （比如从别人转发的链接进来、或者忘了自己是在哪被拦的），
 * 这一页给一个固定的、可以写在公告里的入口。
 */
export default function AppealPage() {
  const { t } = useT()
  return (
    <AuthShell
      title={t("appeal.title")}
      description={t("appeal.desc")}
      footer={
        <>
          <AuthFooterLink to="/login" label={t("appeal.backToLogin")} />
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs text-muted-foreground">{t("appeal.notice")}</p>
        </div>
        <AppealForm />
      </div>
    </AuthShell>
  )
}
