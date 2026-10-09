/**
 * 设置页「公开 API」卡片：Key 管理 + 我的层级额度 + 接口文档。
 *
 * ── Key 明文只出现一次 ──
 * 与恢复码同款逻辑：生成/重置后，明文只在内存里显示一次（带复制按钮），
 * 关闭提示后库里只有 hash，再也看不到。
 */
import * as React from "react"
import { toast } from "sonner"
import { Loader2, KeyRound, Copy, Trash2, RefreshCw, Webhook, AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { confirmDialog } from "@/components/confirm-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { publicApi, errMsg } from "@/services/api"
import { useT } from "@/i18n"

const FEATURE_LABEL_KEY: Record<string, string> = {
  dns: "apiset.featureDns",
  mailbox: "apiset.featureMailbox",
  temp_mailbox: "apiset.featureTempMailbox",
  subdomain: "apiset.featureSubdomain",
}

/** 接口文档（按功能分组；以后加功能这里同步登记 + 后端 public-api.ts 加路由） */
const API_GROUPS = [
  {
    labelKey: "apiset.groupDns",
    endpoints: [
      { method: "GET", path: "/api/v1/dns", descKey: "apiset.epDnsList" },
      { method: "POST", path: "/api/v1/dns", descKey: "apiset.epDnsCreate" },
      { method: "PUT", path: "/api/v1/dns/:id", descKey: "apiset.epDnsUpdate" },
      { method: "DELETE", path: "/api/v1/dns/:id", descKey: "apiset.epDnsDelete" },
    ],
  },
  {
    labelKey: "apiset.groupSubdomain",
    endpoints: [
      { method: "GET", path: "/api/v1/subdomain", descKey: "apiset.epSubList" },
      { method: "POST", path: "/api/v1/subdomain", descKey: "apiset.epSubCreate" },
      { method: "DELETE", path: "/api/v1/subdomain/:id", descKey: "apiset.epSubDelete" },
    ],
  },
  {
    labelKey: "apiset.groupMailbox",
    endpoints: [
      { method: "GET", path: "/api/v1/mailbox", descKey: "apiset.epMailboxList" },
      { method: "POST", path: "/api/v1/mailbox", descKey: "apiset.epMailboxCreate" },
      { method: "DELETE", path: "/api/v1/mailbox/:id", descKey: "apiset.epMailboxDelete" },
      { method: "GET", path: "/api/v1/mailbox/:id/messages", descKey: "apiset.epMailboxMessages" },
      { method: "GET", path: "/api/v1/mailbox/:id/messages/:mid", descKey: "apiset.epMailboxMessage" },
      { method: "POST", path: "/api/v1/mailbox/:id/messages/:mid/reply", descKey: "apiset.epMailboxReply" },
    ],
  },
  {
    labelKey: "apiset.groupTemp",
    endpoints: [
      { method: "POST", path: "/api/v1/temp-mailbox", descKey: "apiset.epTempCreate" },
      { method: "POST", path: "/api/v1/temp-mailbox/:id/refresh", descKey: "apiset.epTempRefresh" },
      { method: "GET", path: "/api/v1/temp-mailbox/:id/messages", descKey: "apiset.epTempMessages" },
      { method: "GET", path: "/api/v1/temp-mailbox/:id/messages/:mid", descKey: "apiset.epTempMessage" },
    ],
  },
]

export function ApiSettingsCard() {
  const { t } = useT()
  const [doc, setDoc] = React.useState<{
    achievementPoints: number
    tier: number
    features: { feature: string; enabled: boolean; tier: number; accountLimit: number; ipLimit: number }[]
  } | null>(null)
  const [keyStatus, setKeyStatus] = React.useState<{
    hasKey: boolean
    prefix: string | null
    createdAt: string | null
    lastUsedAt: string | null
    isAdmin: boolean
    canCreateAdminKey: boolean
  } | null>(null)
  const [newKey, setNewKey] = React.useState<string | null>(null)
  const [newKeyIsAdmin, setNewKeyIsAdmin] = React.useState(false)
  const [wantAdmin, setWantAdmin] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const [d, k] = await Promise.all([publicApi.getDoc(), publicApi.getKeyStatus()])
      setDoc(d)
      setKeyStatus(k)
    } catch (err) {
      toast.error(errMsg(err, t("apiset.loadFailed")))
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const generate = async () => {
    setBusy(true)
    try {
      const res = await publicApi.generateKey(wantAdmin)
      setNewKey(res.apiKey)
      setNewKeyIsAdmin(res.isAdmin)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("apiset.genFailed")))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: t("apiset.deleteConfirm"),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await publicApi.deleteKey()
      await load()
      toast.success(t("apiset.deleted"))
    } catch (err) {
      toast.error(errMsg(err, t("apiset.deleteFailed")))
    } finally {
      setBusy(false)
    }
  }

  const copyKey = async () => {
    if (!newKey) return
    try {
      await navigator.clipboard.writeText(newKey)
      toast.success(t("apiset.copied"))
    } catch {
      toast.error(t("apiset.copyFailed"))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Webhook className="h-4 w-4 text-muted-foreground" />
          {t("apiset.title")}
        </CardTitle>
        <CardDescription>{t("apiset.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!doc || !keyStatus ? (
          <div className="py-6">
            <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : newKey ? (
          /* Key 明文只出现一次 */
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t("apiset.keyWarn")}
                {newKeyIsAdmin ? <span className="mt-1 block font-medium">{t("apiset.adminKeyWarn")}</span> : null}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{newKey}</code>
              <Button size="sm" variant="outline" onClick={() => void copyKey()}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button size="sm" onClick={() => setNewKey(null)}>
              {t("apiset.savedIt")}
            </Button>
          </div>
        ) : (
          <>
            {/* Key 区 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  {keyStatus.hasKey ? (
                    <span className="flex items-center gap-2">
                      {t("apiset.hasKey")} <code className="font-mono">{keyStatus.prefix}…</code>
                      {keyStatus.isAdmin ? (
                        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                          {t("apiset.adminBadge")}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span>{t("apiset.noKey")}</span>
                  )}
                </div>
                {keyStatus.hasKey ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void generate()}>
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                      {t("apiset.reset")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
                      <Trash2 className="mr-1 h-3.5 w-3.5 text-destructive" />
                      {t("common.delete")}
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => void generate()}>
                    {t("apiset.generate")}
                  </Button>
                )}
              </div>

              {/* 管理员 Key 开关：只对超级管理员 / root 显示（普通 admin 不给） */}
              {keyStatus.canCreateAdminKey ? (
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-violet-200 bg-violet-50/60 p-3 text-xs dark:border-violet-900 dark:bg-violet-950/30">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-violet-600"
                    checked={wantAdmin}
                    onChange={(e) => setWantAdmin(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-violet-800 dark:text-violet-200">
                      {t("apiset.adminKeyTitle")}
                    </span>
                    <span className="mt-0.5 block text-muted-foreground">{t("apiset.adminKeyHint")}</span>
                  </span>
                </label>
              ) : null}
            </div>

            {/* 我的层级额度 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("apiset.myTier")}</span>
                <span className="font-medium">
                  {t("apiset.tierValue", { tier: doc.tier, points: doc.achievementPoints })}
                </span>
              </div>
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-normal">{t("apiset.colFeature")}</th>
                      <th className="px-3 py-2 text-left font-normal">{t("apiset.colStatus")}</th>
                      <th className="px-3 py-2 text-right font-normal">{t("apiset.colLimit")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.features.map((f) => (
                      <tr key={f.feature} className="border-t">
                        <td className="px-3 py-2">{t(FEATURE_LABEL_KEY[f.feature] ?? f.feature)}</td>
                        <td className="px-3 py-2">
                          {f.enabled ? (
                            <span className="text-emerald-600 dark:text-emerald-400">{t("apiset.open")}</span>
                          ) : (
                            <span className="text-muted-foreground">{t("apiset.closed")}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {f.enabled ? t("apiset.limitPerDay", { n: f.accountLimit }) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("apiset.tierHint")}</p>
            </div>

            {/* 接口文档 */}
            <div className="space-y-3">
              <div className="text-sm font-medium">{t("apiset.docTitle")}</div>
              <p className="text-xs text-muted-foreground">
                {t("apiset.authNote")} <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>
              </p>
              {API_GROUPS.map((g) => (
                <div key={g.labelKey} className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">{t(g.labelKey)}</div>
                  {g.endpoints.map((ep) => (
                    <div key={ep.path + ep.method} className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
                      <span
                        className={
                          "w-14 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-medium " +
                          (ep.method === "GET"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                            : ep.method === "POST"
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                              : ep.method === "PUT"
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                                : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300")
                        }
                      >
                        {ep.method}
                      </span>
                      <code className="shrink-0 break-all font-mono">{ep.path}</code>
                      <span className="min-w-0 flex-1 text-muted-foreground">{t(ep.descKey)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
