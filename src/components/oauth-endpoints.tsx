/**
 * 「接入信息」卡片 —— Doulor Cloud 作为身份提供方时，要填进对方站点的四个端点地址。
 *
 * 为什么抽成共用组件（2026-10-12）：
 *   管理端（OAuthAdminPanel）与设置页的用户自助卡片展示的是**同一份地址**。
 *   端点是**服务端全局常量**，与具体应用无关（Discovery URL 本身还是公开匿名可读的），
 *   所以没有理由只给站长看 —— 用户接自己的站点时照样要填，只放管理端等于逼他每次来问。
 *   两处共用一份实现，以后换域名/加端点只改这里。
 */
import * as React from "react"
import { toast } from "sonner"
import { Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useT, tStatic } from "@/i18n"

/**
 * 供对方站点填写的端点地址。用当前 origin 拼，换域名也不会写错。
 *
 * ⚠️ `Issuer URL` 必须**带 `/api`**：本站的协议端点都挂在 `/api` 下
 * （`/api/oauth/authorize` 等），发现文档里宣告的 issuer 也是
 * `${origin}/api`（见 worker/src/handlers/oauth.ts::oauthBase）。
 * OIDC 客户端会把「你填的 issuer」与「发现文档里的 issuer」逐字符比对，
 * 少一个 `/api` 就会报 issuer mismatch 或拼出 404 的发现地址。
 */
export function oauthEndpoints(origin: string) {
  return [
    { label: "Issuer URL", value: `${origin}/api` },
    { label: "Discovery URL", value: `${origin}/api/.well-known/openid-configuration` },
    { label: "Authorization Endpoint", value: `${origin}/api/oauth/authorize` },
    { label: "Token Endpoint", value: `${origin}/api/oauth/token` },
    { label: "UserInfo Endpoint", value: `${origin}/api/oauth/userinfo` },
  ]
}

/** 复制到剪贴板 + 统一 toast（管理端与用户端共用同一套提示） */
export async function copyText(value: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(tStatic("ao.ok.copied", { what }))
  } catch {
    toast.error(tStatic("ao.err.copy"))
  }
}

/** 一条端点地址 + 复制按钮 */
function EndpointRow({ label, value }: { label: string; value: string }) {
  const { t } = useT()
  return (
    <div className="flex items-center gap-2">
      <span className="w-44 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => void copyText(value, label)}
        title={t("ao.copyTitle", { label })}
        aria-label={t("ao.copyTitle", { label })}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

/** 接入信息卡片本体（自带 Card 外壳，直接放进页面即可） */
export function OAuthEndpointsCard() {
  const { t } = useT()
  const [origin] = React.useState(() => window.location.origin)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("ao.info.title")}</CardTitle>
        <CardDescription>{t("ao.info.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {oauthEndpoints(origin).map((e) => (
          <EndpointRow key={e.label} label={e.label} value={e.value} />
        ))}
        <p className="pt-1 text-xs text-muted-foreground">{t("ao.info.issuerNote")}</p>
        <p className="text-xs text-muted-foreground">
          {t("ao.info.callbackNoteA")}
          <code className="font-mono">{t("ao.info.peerDomain")}/oauth/oidc</code>
          {t("ao.info.callbackNoteB")}
        </p>
      </CardContent>
    </Card>
  )
}
