/**
 * 捐献渠道开通状态长条卡（2026-10-27）。
 *
 * 放在「AI 模型捐献」页最上面，一眼看清各渠道开没开通：
 *   小浣熊 / AutoClaw  →  已开通（绿）/ 未开通（红）
 *
 * ⚠️ 2026-11 起 WorkBuddy 与 Qoder2API 两条通道停用（AI 捐献统一走 agent2api 网关），
 * 后端 /api/donations/channels 已不再返回这两个渠道；组件里的 ChannelKey 保留它们
 * 只是为了让历史数据仍能对上类型。
 *
 * 数据来自 GET /api/donations/channels，口径是「有没有有效捐献账号」
 * （与 group-sync 的分组口径一致：active + invalid 都算捐过，分组不会因失效而取消）。
 */
import * as React from "react"
import { Card, CardContent } from "@/components/ui/card"
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react"

type ChannelKey = "workbuddy" | "qoder" | "raccoon" | "autoclaw"

type ChannelStatusRow = {
  key: ChannelKey
  label: string
  count: number
  activeCount: number
  open: boolean
  yuanPerDay: number
}

export function ChannelStatusCard() {
  const [rows, setRows] = React.useState<ChannelStatusRow[] | null>(null)

  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch("/api/donations/channels", { credentials: "include" })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = (await r.json()) as { channels?: ChannelStatusRow[] }
        if (alive) setRows(d.channels ?? [])
      } catch {
        if (alive) setRows([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!rows || rows.length === 0) return null

  const openCount = rows.filter((x) => x.open && x.activeCount > 0).length

  return (
    <Card className="mb-6 border-2">
      <CardContent className="p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">我的捐献渠道状态</p>
          <p className="text-xs text-muted-foreground">
            已开通 <span className="font-semibold text-emerald-600 dark:text-emerald-400">{openCount}</span> /{" "}
            {rows.length} 个渠道 · 每开通一个渠道即按账号数累加每日额度
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {rows.map((c) => (
            <div
              key={c.key}
              className={
                "rounded-lg border-2 px-3 py-3 text-center " +
                (c.open && c.activeCount > 0
                  ? "border-emerald-500/60 bg-emerald-500/10"
                  : c.open
                    ? "border-amber-500/60 bg-amber-500/10"
                    : "border-red-500/50 bg-red-500/5")
              }
            >
              <p className="truncate text-sm font-medium" title={c.label}>
                {c.label}
              </p>
              <div
                className={
                  "mt-1 flex items-center justify-center gap-1 text-base font-bold " +
                  (c.open && c.activeCount > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : c.open
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-red-600 dark:text-red-400")
                }
              >
                {c.open && c.activeCount > 0 ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : c.open ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                {c.open && c.activeCount > 0 ? "已开通" : c.open ? "已失效" : "未开通"}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {c.open && c.activeCount > 0
                  ? `${c.activeCount} 个有效 · ¥${c.yuanPerDay}/天`
                  : c.open
                    ? `账号已失效（额度已收回）`
                    : `捐 1 个 = ¥${c.yuanPerDay}/天`}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
