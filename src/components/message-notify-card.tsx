import * as React from "react"
import { BellRing, Check, BellOff, FlaskConical } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useNotifyPermission } from "@/hooks/use-message-notify"
import { ensurePushSubscription, pushState, type PushState } from "@/lib/web-push-client"
import {
  currentNotifyEnabled,
  ensureNotifyPermission,
  nativeBridgePresent,
  notifyAlways,
  openNotifySettings,
  probeNotification,
  setNotifyAlways,
  type NotifyProbe,
} from "@/lib/web-notify"
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
  const { permission, request } = useNotifyPermission()
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [probe, setProbe] = React.useState<NotifyProbe | null>(null)
  /** App 壳子有没有注入原生桥接（真机上是唯一能真发通知的路径） */
  const bridgePresent = React.useMemo(() => nativeBridgePresent(), [])
  /** 只读地取一次真实状态：有桥接看 App 开关，没有看浏览器权限 */
  const [reallyEnabled, setReallyEnabled] = React.useState(false)
  /** 「即使我正在用也提醒」—— 某些 WebView 不上报 page visibility，靠它兜底 */
  const [always, setAlways] = React.useState(() => notifyAlways())
  /** Web Push 是否已订阅（-1 = 还在探测） */
  const [push, setPush] = React.useState<PushState | "pending">("pending")

  const onToggleAlways = (on: boolean) => {
    setNotifyAlways(on)
    setAlways(on)
  }

  React.useEffect(() => {
    let alive = true
    void currentNotifyEnabled().then((v) => {
      if (alive) setReallyEnabled(v)
    })
    void pushState().then((s) => {
      if (alive) setPush(s)
    })
    return () => {
      alive = false
    }
  }, [permission, probe])

  const onEnable = async () => {
    setBusy(true)
    try {
      // 有原生桥接：权限在 App 侧，走 Android 授权框；没有就走浏览器标准授权
      const bridgeOk = await ensureNotifyPermission()
      if (bridgeOk === true) {
        toast.success(t("settings.notify.on"))
        return
      }
      if (bridgeOk === false) {
        toast.error(t("settings.notify.appDenied"))
        return
      }
      const res = await request()
      if (res === "granted") {
        // 拿到权限后立刻订阅 Web Push：之后就是服务端主动推，页面关着也能弹
        const s = await ensurePushSubscription()
        setPush(s)
        toast.success(t("settings.notify.on"))
      } else if (res === "denied") toast.error(t("settings.notify.denied"))
      else if (res === "unsupported") toast.error(t("settings.notify.unsupported"))
      // "default"：点了没反应也没弹框 —— Android WebView 的典型表现（不会把权限交出来）
      else toast.error(t("settings.notify.webviewBlocked"))
    } finally {
      setBusy(false)
    }
  }

  /** 真发一条测试通知，并把探测结果留在卡片上 */
  const onTest = async () => {
    setTesting(true)
    try {
      // 先要权限（本按钮就是用户手势，能弹框）；有桥接时走 Android 的授权框
      if (bridgePresent) await ensureNotifyPermission()
      else if (permission !== "granted") await request()

      // 顺手把 Web Push 订阅也建立起来（浏览器支持才有；不支持就继续靠轮询）
      setPush(await ensurePushSubscription())

      const r = await probeNotification()
      setProbe(r)
      if (r.path !== "none") toast.success(t("settings.notify.testOk"))
      else if (r.bridgePresent && r.bridgeEnabled === false)
        toast.error(t("settings.notify.appDenied"))
      else if (r.permission !== "granted" && r.bridges.length === 0)
        toast.error(t("settings.notify.webviewBlocked"))
      else toast.error(t("settings.notify.testFail"))
    } finally {
      setTesting(false)
    }
  }

  // 真实状态：优先用刚点过测试的探测结果，其次用挂载时读到的那次
  const enabled = probe ? probe.bridgePresent
    ? probe.bridgeEnabled === true
    : probe.path !== "none" || probe.permission === "granted"
    : reallyEnabled

  const stateText = enabled
    ? t("settings.notify.stateOn")
    : bridgePresent
      ? t("settings.notify.stateAppNeeded")
      : permission === "denied"
        ? t("settings.notify.stateDenied")
        : permission === "unsupported"
          ? t("settings.notify.stateUnsupported")
          : t("settings.notify.stateOff")

  const Icon = enabled ? Check : BellOff

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
          <Icon className={enabled ? "h-4 w-4 text-foreground" : "h-4 w-4 text-muted-foreground"} />
          <span className={enabled ? "" : "text-muted-foreground"}>{stateText}</span>
        </div>

        {/* 即时推送状态：on = 服务端一推就弹（页面关着也收）；其余会退回 60 秒轮询 */}
        <p className="text-xs text-muted-foreground">
          {t("settings.notify.push.label")}
          {"："}
          {push === "on"
            ? t("settings.notify.push.on")
            : push === "off"
              ? t("settings.notify.push.off")
              : push === "denied"
                ? t("settings.notify.push.denied")
                : push === "pending"
                  ? "…"
                  : t("settings.notify.push.unsupported")}
        </p>

        <div className="flex flex-wrap gap-2">
          {!enabled && permission !== "unsupported" && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void onEnable()}>
              <BellRing className="h-3.5 w-3.5" />
              {t("settings.notify.enable")}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={testing} onClick={() => void onTest()}>
            <FlaskConical className="h-3.5 w-3.5" />
            {testing ? t("settings.notify.testing") : t("settings.notify.test")}
          </Button>
          {bridgePresent && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!openNotifySettings()) toast.error(t("settings.notify.noSettings"))
              }}
            >
              {t("settings.notify.openSettings")}
            </Button>
          )}
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
            <div className="break-all">
              {t("settings.notify.diag.bridge")}:{" "}
              {probe.bridges.length > 0 ? probe.bridges.join(", ") : "none"}
              {probe.bridgePresent
                ? ` · ${t("settings.notify.diag.appPerm")} ${
                    probe.bridgeEnabled === null
                      ? "unknown"
                      : probe.bridgeEnabled
                        ? "on"
                        : "off"
                  } · enabled=${probe.bridgeRawEnabled ?? "?"} · state=${
                    probe.bridgeRawState ?? "?"
                  }`
                : ""}
            </div>
            {probe.bridgeMethods.length > 0 && (
              <div className="break-all">{probe.bridgeMethods.join(", ")}</div>
            )}
            <div>
              {t("settings.notify.diag.path")}: {probe.path}
              {probe.error ? ` · ${probe.error}` : ""}
            </div>
            <div className="truncate">{probe.ua}</div>
          </div>
        )}

        <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
          <div className="space-y-0.5">
            <p className="text-sm">{t("settings.notify.always")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.notify.alwaysHint")}
            </p>
          </div>
          <Switch checked={always} onCheckedChange={onToggleAlways} />
        </div>

        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("settings.notify.note")}
        </p>
      </CardContent>
    </Card>
  )
}
