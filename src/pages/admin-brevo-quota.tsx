/**
 * 管理面板 → 邮件 → Brevo 额度（图形化）。
 *
 * 独立文件（同 admin-cf-quota.tsx 的考量）：admin.tsx 已 6000+ 行，且有其它
 * 改动可能在动它。UI 本体放这里，admin.tsx 只插 1 行挂载。
 *
 * 为什么放「邮件」板块而不是「Cloudflare 额度」：CF 面板的品牌口径是
 * 「Cloudflare 免费额度 / 账号级基础设施」，Brevo 是发信通道，和 Posta、CF
 * 发信是同一层的东西，跟邮件配置放一起才找得到。
 *
 * 图形化做法：**纯 CSS 占用条**，不引图表库（数据量极小）。
 *
 * ⚠️ 展示原则（同 CF 面板）：
 *   a. **读不到的 Key 要显示原因**，不能显示成 0 —— 那会被误读成「额度用完了」。
 *   b. 这里画的是「剩余」，所以**剩余越少越危险**：<15% 红、<40% 黄、其余绿。
 *   c. 额度口径（每账号每天 300 封、按天重置）写在卡片上。
 */
import * as React from "react"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { adminApi, errMsg } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import type { BrevoKeyQuota, BrevoQuotaOverview } from "@/types"
import { useT } from "@/i18n"

/** 千分位整数 */
function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN")
}

/** 剩余比例 → 颜色（剩余越少越危险：绿 / 黄 / 红） */
function remainingClass(remainingPercent: number): { bar: string; text: string } {
  if (remainingPercent < 15) return { bar: "bg-red-500", text: "text-red-600" }
  if (remainingPercent < 40) return { bar: "bg-amber-500", text: "text-amber-600" }
  return { bar: "bg-emerald-500", text: "text-emerald-600" }
}

/** 单把 Key 的一行 */
function KeyRow({ key_, limit }: { key_: BrevoKeyQuota; limit: number }) {
  const { t } = useT()
  // 读不到：明确写原因，不装成 0
  if (!key_.ok || key_.credits == null) {
    return (
      <div className="rounded-md border border-dashed p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {t("bq.keyNth", { n: key_.index })}{key_.email ? ` · ${key_.email}` : ""}
          </span>
          <Badge variant="outline" className="text-xs">
            {t("bq.unreadable")}
          </Badge>
        </div>
        {key_.error && <p className="mt-1 text-xs text-destructive">{key_.error}</p>}
      </div>
    )
  }

  const remainingPercent = limit > 0 ? Math.min(100, (key_.credits / limit) * 100) : 0
  const cls = remainingClass(remainingPercent)
  const used = Math.max(0, limit - key_.credits)

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="text-sm font-medium">
          {t("bq.keyNth", { n: key_.index })}{key_.email ? ` · ${key_.email}` : ""}
          {key_.plan && <span className="ml-1 text-[11px] text-muted-foreground">（{key_.plan}）</span>}
        </span>
        <span className="font-mono text-xs">
          <span className={cls.text}>{t("bq.left", { n: fmtNum(key_.credits) })}</span>
          <span className="text-muted-foreground">{t("bq.ofQuota", { n: fmtNum(limit) })}</span>
          <span className={`ml-2 ${cls.text}`}>{remainingPercent.toFixed(0)}%</span>
        </span>
      </div>

      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${cls.bar}`}
          style={{ width: `${Math.max(remainingPercent > 0 ? 1 : 0, remainingPercent)}%` }}
        />
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground">
        {t("bq.usedToday", { n: fmtNum(used) })}{key_.creditsType ? t("bq.creditsType", { type: key_.creditsType }) : ""}
      </p>
    </div>
  )
}

export function BrevoQuotaPanel() {
  const { t } = useT()
  const [data, setData] = React.useState<BrevoQuotaOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(async (fresh = false) => {
    if (fresh) setRefreshing(true)
    try {
      setData(await adminApi.brevoQuota())
    } catch (err) {
      // 首次加载失败不弹 toast 打扰编辑（可能只是没配 Key），刷新失败才提示
      if (fresh) toast.error(errMsg(err, t("bq.err.load")))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // 未配置任何 Key 就整块不显示（邮件板块已另有 Key 输入框）
  if (loading) return <div className="text-xs text-muted-foreground">{t("bq.loading")}</div>
  if (!data || data.totalCount === 0) return null

  const capacity = data.totalCount * data.freeDailyLimit
  const totalPercent = capacity > 0 ? Math.min(100, (data.totalRemaining / capacity) * 100) : 0
  const cls = remainingClass(totalPercent)

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{t("bq.title")}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("bq.summary", {
              ok: data.okCount,
              total: data.totalCount,
              limit: fmtNum(data.freeDailyLimit),
              at: fmtDateTime(data.generatedAt),
            })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {t("common.refresh")}
        </Button>
      </div>

      <div>
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-medium">{t("bq.totalLeft")}</span>
          <span className="font-mono">
            <span className={cls.text}>{fmtNum(data.totalRemaining)}</span>
            <span className="text-muted-foreground">{t("bq.ofQuota", { n: fmtNum(capacity) })}</span>
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${cls.bar}`}
            style={{ width: `${Math.max(totalPercent > 0 ? 1 : 0, totalPercent)}%` }}
          />
        </div>
      </div>

      <div className="space-y-2">
        {data.keys.map((k) => (
          <KeyRow key={k.index} key_={k} limit={data.freeDailyLimit} />
        ))}
      </div>
    </div>
  )
}
