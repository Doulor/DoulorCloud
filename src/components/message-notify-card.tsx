import * as React from "react"
import { BellRing, Check, BellOff, FlaskConical } from "lucide-react"
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
import { probeNotification, type NotifyProbe } from "@/lib/web-notify"
import { useT } from "@/i18n"

/**
 * 「消息与邮件通知」设置卡 —— 零配置。
 *
 * 站长明确要求「所有人都能统一用、不要每人配置」，所以这里只是一个开关：
 * 点一下申请浏览器/App 的通知权限，之后有新消息或新邮件就弹系统通知。
 * 不涉及任何地址、令牌之类需要用户手填的东西。
 *
 * 2026-11-10 加了「发送测试通知」：之前只有一个开关，用户说"开了也不弹"时
 * 完全无从判断是没权限、壳子不支持、还是走了 Android 上会抛错的老路子。
 * 点一下就把每条路径的真实结果摊在卡片上（见 src/lib/web-notify.ts 的 probeNotification）。
 */
export function MessageNotifyCard() {
  const { t } = useT()
  const { permission, request } = useMessageNotify()
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [probe, setProbe] = React.useState<NotifyProbe | null>(null)

  const onEnable = async () => {
    setBusy(true)
    const res = await request()
    setBusy(false)
    if (res === "granted") toast.success(t("settings.notify.on"))
    else if (res === "denied") toast.error(t("settings.notify.denied"))
    else if (res === "unsupported") toast.error(t("settings.notify.unsupported"))
  }

  /** 真发一条测试通知，并把探测结果留在卡片上 */
  const onTest = async () => {
    setTesting(true)
    try {
      // 没授权就先要一次（测试按钮本身就是用户手势，浏览器允许弹权限框）
      if (permission !== "granted") await request()
      const r = await probeNotification()
      setProbe(r)
      if (r.path !== "none") toast.success(t("settings.notify.testOk"))
      else toast.error(t("settings.notify.testFail"))
    } finally {
      setTesting(false)
    }
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

        <div className="flex flex-wrap gap-2">
          {permission !== "granted" && permission !== "unsupported" && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void onEnable()}>
              <BellRing className="h-3.5 w-3.5" />
              {t("settings.notify.enable")}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={testing} onClick={() => void onTest()}>
            <FlaskConical className="h-3.5 w-3.5" />
            {testing ? t("settings.notify.testing") : t("settings.notify.test")}
          </Button>
        </div>

        {probe && (
          <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            <div>
              {t("settings.notify.diag.permission")}: {probe.permission}
            </div>
            <div>
              {t("settings.notify.diag.sw")}: {probe.hasServiceWorker ? "yes" : "no"} ·
              ready {probe.swReady ? "yes" : "no"} · showNotification{" "}
              {probe.swShowNotification ? "yes" : "no"}
            </div>
            <div>
              {t("settings.notify.diag.ctor")}: {probe.ctorWorks ? "ok" : probe.ctorError ?? "no"}
            </div>
            <div>
              {t("settings.notify.diag.path")}: {probe.path}
              {probe.error ? ` · ${probe.error}` : ""}
            </div>
            <div className="truncate">{probe.ua}</div>
          </div>
        )}

        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("settings.notify.note")}
        </p>
      </CardContent>
    </Card>
  )
}
