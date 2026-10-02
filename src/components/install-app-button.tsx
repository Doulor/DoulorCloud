import * as React from "react"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useInstallPrompt } from "@/hooks/use-install-prompt"
import { useT } from "@/i18n"

const IS_IOS =
  typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent)

/**
 * 「安装到桌面 / 添加到主屏」按钮。
 *
 * - 桌面 Chrome/Edge、安卓 Chrome：用 beforeinstallprompt 弹系统安装框。
 * - iOS Safari：没有 beforeinstallprompt，只能弹教程教用户「分享 → 添加到主屏幕」。
 * - 都不满足（已安装 / 不支持）时返回 null 不渲染。
 */
export function InstallAppButton({ className }: { className?: string }) {
  const { t } = useT()
  const { canInstall, install } = useInstallPrompt()
  const [busy, setBusy] = React.useState(false)
  const [iosOpen, setIosOpen] = React.useState(false)

  if (IS_IOS) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          className={className}
          onClick={() => setIosOpen(true)}
        >
          <Download className="h-4 w-4" />
          {t("pwa.install")}
        </Button>
        <Dialog open={iosOpen} onOpenChange={setIosOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("pwa.iosTitle")}</DialogTitle>
              <DialogDescription>{t("pwa.iosDesc")}</DialogDescription>
            </DialogHeader>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>{t("pwa.iosStep1")}</li>
              <li>{t("pwa.iosStep2")}</li>
              <li>{t("pwa.iosStep3")}</li>
            </ol>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  if (!canInstall) return null

  const onClick = async () => {
    setBusy(true)
    try {
      await install()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      onClick={() => void onClick()}
      disabled={busy}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      {t("pwa.install")}
    </Button>
  )
}
