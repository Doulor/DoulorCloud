/**
 * 邮件详情里的「验证码」提示条（2026-10-24）。
 *
 * 站长要求：识别到验证码就给一个一键复制按钮。
 * 识别逻辑在 `@/lib/verify-code`（前端纯函数），拿不准时不显示，绝不误导。
 */
import * as React from "react"
import { Check, Copy, KeyRound } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { extractVerificationCode } from "@/lib/verify-code"
import { useT } from "@/i18n"

export function VerificationCodeChip({ text }: { text: string | null | undefined }) {
  const { t } = useT()
  const code = React.useMemo(() => extractVerificationCode(text), [text])
  const [copied, setCopied] = React.useState(false)

  if (!code) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(code as string)
      setCopied(true)
      toast.success(t("common.copied"))
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t("api.networkError"))
    }
  }

  return (
    <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5">
      <KeyRound className="h-3.5 w-3.5 text-emerald-500" />
      <span className="text-xs text-muted-foreground">{t("em.code")}</span>
      <code className="font-mono text-base font-semibold tracking-[0.2em]">{code}</code>
      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={copy} aria-label={t("common.copy")}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}
