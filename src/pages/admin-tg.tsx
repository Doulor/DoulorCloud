/**
 * 管理端「TG 机器人」面板（2026-10-22）。
 *
 * 只做配置与观测，**不在这里处理机器人消息**（消息走 `/tg/webhook` 公开回调）。
 *
 * 安全约定（与后端 handlers/telegram.ts 对齐）：
 *  · Bot Token 输入框永远是空的：后端只回脱敏值（`8887249358:AAHx****HPck`），
 *    想换 token 就填新的，留空表示不改。填了就一定先 getMe 验真再落库。
 *  · 轮换回调密钥后必须重新「设置 Webhook」，否则 Telegram 回调会因 secret 不匹配被 401。
 *  · 解绑用户是即时生效的（DB 删除），不需要刷新机器人。
 */
import * as React from "react"
import { Bot, KeyRound, Link2, ListOrdered, Radio, RefreshCw, Send, Trash2, Unlink } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import {
  adminTgApi,
  errMsg,
  type AdminTgBinding,
  type AdminTgConfig,
  type AdminTgChannel,
  type AdminTgLog,
} from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"

const COMMAND_KEYS = [
  "menu",
  "me",
  "frp",
  "mail",
  "dns",
  "points",
  "invite",
  "storage",
  "community",
  "notices",
  "security",
  "settings",
  "status",
  "help",
] as const
const PUSH_KEYS = [
  "login",
  "frpExpiry",
  "nodeDown",
  "daily",
  "email",
  "comment",
  "like",
  "points",
] as const

export function AdminTgPanel() {
  const { t } = useT()
  const [cfg, setCfg] = React.useState<AdminTgConfig | null>(null)
  const [bindings, setBindings] = React.useState<AdminTgBinding[]>([])
  const [logs, setLogs] = React.useState<AdminTgLog[]>([])
  const [channels, setChannels] = React.useState<AdminTgChannel[]>([])
  const [channelInput, setChannelInput] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  /** 只在用户真的想换 token 时才有值；提交成功后清空 */
  const [tokenInput, setTokenInput] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [c, b, l, ch] = await Promise.all([
        adminTgApi.config(),
        adminTgApi.bindings(),
        adminTgApi.logs(),
        adminTgApi.channels(),
      ])
      setCfg(c)
      setBindings(b.bindings)
      setLogs(l.logs)
      setChannels(ch.channels)
    } catch (e) {
      toast.error(errMsg(e, t("tg.saveFailed")))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])


  /** 频道事件的中文名（i18n 的 key 是联合类型，不能拼变量，这里显式映射） */
  function eventLabel(k: string): string {
    switch (k) {
      case "announcement":
        return t("tg.chev.announcement")
      case "gallery":
        return t("tg.chev.gallery")
      case "post":
        return t("tg.chev.post")
      case "daily":
        return t("tg.chev.daily")
      default:
        return k
    }
  }

  async function run(key: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusy(key)
    try {
      await fn()
      if (okMsg) toast.success(okMsg)
      await load()
    } catch (e) {
      toast.error(errMsg(e, t("tg.saveFailed")))
    } finally {
      setBusy(null)
    }
  }

  if (loading && !cfg) return <LoadingBlock />

  const commands = cfg?.commands ?? {}
  const pushes = cfg?.pushes ?? {}

  return (
    <div className="space-y-6">
      {/* ---------------- 概览 ---------------- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              {t("tg.title")}
            </CardTitle>
            <CardDescription>{t("tg.desc")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={cfg?.enabled ? "default" : "secondary"}>
              {cfg?.enabled ? t("tg.enabled") : t("tg.disabled")}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void run("reload", load)}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t("tg.refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t("tg.bot")} value={cfg?.botUsername ? `@${cfg.botUsername}` : "—"} />
          <Stat
            label={t("tg.stats24h")}
            value={`${cfg?.stats.total24h ?? 0} / ${t("tg.failed")} ${cfg?.stats.failed24h ?? 0}`}
          />
          <Stat label={t("tg.bound")} value={String(cfg?.stats.boundUsers ?? 0)} />
          <Stat
            label={t("tg.webhook")}
            value={cfg?.webhookSet ? t("tg.webhookSet") : t("tg.webhookUnset")}
          />
        </CardContent>
      </Card>

      {/* ---------------- Token ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            {t("tg.token")}
          </CardTitle>
          <CardDescription>{t("tg.tokenHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <Label htmlFor="tg-token" className="text-xs text-muted-foreground">
                {cfg?.hasToken ? cfg.tokenMasked : t("tg.tokenUnset")}
              </Label>
              <Input
                id="tg-token"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t("tg.tokenPlaceholder")}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button
              disabled={busy !== null || !tokenInput.trim()}
              onClick={() =>
                void run(
                  "token",
                  async () => {
                    await adminTgApi.update({ token: tokenInput.trim() })
                    setTokenInput("")
                  },
                  t("tg.saved")
                )
              }
            >
              {t("tg.save")}
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "enable",
                  () => adminTgApi.update({ enabled: !cfg?.enabled }),
                  t("tg.saved")
                )
              }
            >
              {cfg?.enabled ? t("tg.disable") : t("tg.enable")}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !cfg?.hasToken}
              onClick={() =>
                void run("webhook", () => adminTgApi.setWebhook(), t("tg.webhookUpdated"))
              }
            >
              <Link2 className="mr-1 h-3.5 w-3.5" />
              {t("tg.setWebhook")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !cfg?.hasToken}
              onClick={() => void run("unhook", () => adminTgApi.deleteWebhook(), t("tg.saved"))}
            >
              {t("tg.delWebhook")}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null || !cfg?.hasToken}
              onClick={() => void run("test", () => adminTgApi.test(), t("tg.testSent"))}
            >
              <Send className="mr-1 h-3.5 w-3.5" />
              {t("tg.testPush")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !cfg?.hasToken}
              onClick={() =>
                void run("menu", () => adminTgApi.syncCommands(), t("tg.menuSynced"))
              }
            >
              <ListOrdered className="mr-1 h-3.5 w-3.5" />
              {t("tg.syncMenu")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "rotate",
                  () => adminTgApi.update({ rotateSecret: true }),
                  t("tg.rotateDone")
                )
              }
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t("tg.rotateSecret")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("tg.rotateHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 开关 ---------------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("tg.commands")}</CardTitle>
            <CardDescription>{t("tg.commandsHint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {COMMAND_KEYS.map((k) => (
              <Toggle
                key={k}
                label={t(`tg.cmd.${k}`)}
                checked={commands[k] !== false}
                disabled={busy !== null}
                onChange={(v) =>
                  void run(`cmd-${k}`, () =>
                    adminTgApi.update({ commands: { ...commands, [k]: v } })
                  )
                }
              />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("tg.pushes")}</CardTitle>
            <CardDescription>{t("tg.pushesHint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {PUSH_KEYS.map((k) => (
              <Toggle
                key={k}
                label={t(`tg.push.${k}`)}
                checked={pushes[k] !== false}
                disabled={busy !== null}
                onChange={(v) =>
                  void run(`push-${k}`, () =>
                    adminTgApi.update({ pushes: { ...pushes, [k]: v } })
                  )
                }
              />
            ))}
          </CardContent>
        </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4" />
            {t("tg.channels")}
          </CardTitle>
          <CardDescription>{t("tg.channelsHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("tg.noChannels")}</p>
          ) : (
            <div className="space-y-2">
              {channels.map((ch) => (
                <div key={ch.chatId} className="rounded-lg border p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{ch.title || ch.chatId}</span>
                    {ch.username ? (
                      <span className="text-xs text-muted-foreground">@{ch.username}</span>
                    ) : null}
                    <Badge variant={ch.enabled ? "default" : "secondary"}>
                      {ch.enabled ? t("tg.chEnabled") : t("tg.chDisabled")}
                    </Badge>
                    <span className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            `ch-test-${ch.chatId}`,
                            () => adminTgApi.testChannel(ch.chatId),
                            t("tg.testSent")
                          )
                        }
                      >
                        <Send className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`ch-del-${ch.chatId}`, () => adminTgApi.deleteChannel(ch.chatId))
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(ch.events) as Array<keyof typeof ch.events>).map((k) => (
                      <Button
                        key={String(k)}
                        size="sm"
                        variant={ch.events[k] ? "default" : "outline"}
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`ch-ev-${ch.chatId}-${String(k)}`, () =>
                            adminTgApi.updateChannel(ch.chatId, {
                              events: { [String(k)]: !ch.events[k] },
                            })
                          )
                        }
                      >
                        {ch.events[k] ? "✅" : "⛔"} {eventLabel(String(k))}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`ch-tog-${ch.chatId}`, () =>
                          adminTgApi.updateChannel(ch.chatId, { enabled: !ch.enabled })
                        )
                      }
                    >
                      {ch.enabled ? t("tg.chDisableBtn") : t("tg.chEnableBtn")}
                    </Button>
                  </div>
                  {ch.lastError ? (
                    <p className="text-xs text-destructive">{ch.lastError}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={channelInput}
              onChange={(e) => setChannelInput(e.target.value)}
              placeholder={t("tg.channelPlaceholder")}
              className="max-w-xs"
            />
            <Button
              size="sm"
              disabled={busy !== null || !channelInput.trim()}
              onClick={() =>
                void run("ch-add", async () => {
                  await adminTgApi.addChannel(channelInput.trim())
                  setChannelInput("")
                }, t("tg.channelAdded"))
              }
            >
              {t("tg.channelAdd")}
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>

      {/* ---------------- 绑定用户 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("tg.bindings")}</CardTitle>
          <CardDescription>{t("tg.bindingsHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {bindings.length === 0 ? (
            <EmptyState title={t("tg.noBindings")} description={t("tg.bindHowTo")} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3">{t("tg.colUser")}</th>
                    <th className="py-2 pr-3">{t("tg.colTg")}</th>
                    <th className="py-2 pr-3">{t("tg.colRole")}</th>
                    <th className="py-2 pr-3">{t("tg.colBoundAt")}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {bindings.map((b) => (
                    <tr key={b.telegramId} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium">{b.username ?? b.userId}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {b.tgUsername ? `@${b.tgUsername}` : b.telegramId}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline">{b.role ?? "user"}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {fmtDateTime(new Date(b.boundAt).toISOString())}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              `unbind-${b.telegramId}`,
                              () => adminTgApi.unbind(b.telegramId),
                              t("tg.saved")
                            )
                          }
                        >
                          <Unlink className="mr-1 h-3.5 w-3.5" />
                          {t("tg.unbind")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- 审计日志 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trash2 className="h-4 w-4" />
            {t("tg.logs")}
          </CardTitle>
          <CardDescription>{t("tg.logsHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <EmptyState title={t("tg.noLogs")} />
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3">{t("tg.colTime")}</th>
                    <th className="py-2 pr-3">{t("tg.colKind")}</th>
                    <th className="py-2 pr-3">{t("tg.colTarget")}</th>
                    <th className="py-2 pr-3">{t("tg.colResult")}</th>
                    <th className="py-2">{t("tg.colError")}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted-foreground">
                        {fmtDateTime(new Date(l.created_at).toISOString())}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{l.kind}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{l.target ?? "—"}</td>
                      <td className="py-1.5 pr-3">
                        {l.ok ? (
                          <Badge variant="secondary">{t("tg.ok")}</Badge>
                        ) : (
                          <Badge variant="destructive">{t("tg.fail")}</Badge>
                        )}
                      </td>
                      <td className="max-w-[280px] truncate py-1.5 text-xs text-muted-foreground">
                        {l.error ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  )
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-sm font-normal">{label}</Label>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}
