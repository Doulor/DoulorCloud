import * as React from "react"
import { BellRing, Check, BellOff } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useMessageNotify } from "@/hooks/use-message-notify"
import { useT } from "@/i18n"

/**
 * 「消息通知」设置卡 —— 零配置。
 *
 * 站长明确要求「所有人都能统一用、不要每人配置」，所以这里只是一个开关：
 * 点一下申请浏览器/App 的通知权限，之后有新消息就弹系统通知。
 * 不涉及任何地址、令牌之类需要用户手填的东西。
 */
export function MessageNotifyCard() {
  const { t } = useT()
  const { permission, request } = useMessageNotify()
  const [busy, setBusy] = React.useState(false)

  const onEnable = async () => {
    setBusy(true)
    const res = await request()
    setBusy(false)
    if (res === "granted") toast.success(t("settings.notify.on"))
    else if (res === "denied") toast.error(t("settings.notify.denied"))
    else if (res === "unsupported") toast.error(t("settings.notify.unsupported"))
  }

  const stateText =
    permission === "granted"
      ? t("settings.notify.stateOn")
      : permission === "denied"
        ? t("settings.notify.stateDenied")
        : permission === "unsupported"
          ? t("settings.notify.stateUnsupported")
          : t("settings.notify.stateOff")

  const Icon = permission === "granted" ? Check : BellOff

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4 text-muted-foreground" />
          {t("settings.notify.title")}
        </CardTitle>
        <CardDescription>{t("settings.notify.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Icon
            className={
              permission === "granted"
                ? "h-4 w-4 text-foreground"
                : "h-4 w-4 text-muted-foreground"
            }
          />
          <span className={permission === "granted" ? "" : "text-muted-foreground"}>
            {stateText}
          </span>
        </div>

        {permission !== "granted" && permission !== "unsupported" && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void onEnable()}>
            <BellRing className="h-3.5 w-3.5" />
            {t("settings.notify.enable")}
          </Button>
        )}

        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("settings.notify.note")}
        </p>
      </CardContent>
    </Card>
  )
}
