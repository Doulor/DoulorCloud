/**
 * 管理面板 → 功能开关（2026-11-16）。
 *
 * 站长需求：「关闭不只是关闭入口，关键是关闭整个功能，以及其对应的功能消耗。」
 *
 * 因此这一页的语义**不是**「前端隐藏一个入口」，而是改后端守卫真正读的那个
 * 设置项（见 worker/src/features.ts）：保存后
 *   · 该功能所有接口立刻 403 FEATURE_DISABLED；
 *   · 对应后台定时任务跳过；
 *   · 公开资源（/dl、/s、/p、/c、名片页、TG webhook）一起失效。
 *
 * 交互上刻意的两个约束：
 *   1. **开启是即时的，关闭要二次确认** —— 关闭会让在线用户当场用不了功能，
 *      而误触的代价远大于多一次点击。
 *   2. **把「关掉会发生什么」直接写在开关下面**（后端给的 impact 原文），
 *      不写成一句话的抽象描述 —— 管理员要在点之前就知道后果。
 */
import * as React from "react"
import { toast } from "sonner"
import { AlertTriangle, Gauge, RefreshCw } from "lucide-react"

import { adminApi, type FeatureSwitchItem, type FeatureSwitchesResponse } from "@/services/api"
import { refreshFeatureStates } from "@/hooks/use-features"
import { useT } from "@/i18n"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { LoadingBlock } from "@/components/loading-block"

export function AdminFeaturesPanel() {
  const { t } = useT()
  const [data, setData] = React.useState<FeatureSwitchesResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState<string | null>(null)
  /** 待确认「关闭」的那一项 */
  const [confirmOff, setConfirmOff] = React.useState<FeatureSwitchItem | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await adminApi.listFeatures())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const apply = React.useCallback(
    async (item: FeatureSwitchItem, enabled: boolean) => {
      setSaving(item.id)
      try {
        const r = await adminApi.updateFeatures({ [item.id]: enabled })
        setData((prev) => (prev ? { ...prev, features: r.features } : prev))
        // 让侧边栏导航与轮询 hook 立刻跟着变（同页不用刷新即可看到入口消失）
        refreshFeatureStates()
        toast.success(
          t("ftog.saved", { v0: item.label, v1: enabled ? t("ftog.on") : t("ftog.off") })
        )
      } catch (e) {
        toast.error(
          t("ftog.saveFail") + "：" + (e instanceof Error ? e.message : String(e))
        )
      } finally {
        setSaving(null)
        setConfirmOff(null)
      }
    },
    [t]
  )

  const groups = data?.groups ?? []
  const byGroup = React.useMemo(() => {
    const map = new Map<string, FeatureSwitchItem[]>()
    for (const f of data?.features ?? []) {
      const list = map.get(f.group) ?? []
      list.push(f)
      map.set(f.group, list)
    }
    return map
  }, [data])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">{t("ftog.title")}</CardTitle>
              <CardDescription>{t("ftog.desc")}</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading || saving !== null}
            >
              <RefreshCw className={"mr-1.5 h-3.5 w-3.5" + (loading ? " animate-spin" : "")} />
              {t("common.refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
            {t("ftog.tip")}
          </p>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {t("ftog.loadFail")}：{error}
          </CardContent>
        </Card>
      )}

      {loading && !data && <LoadingBlock variant="cards" />}

      {groups.map((g) => {
        const list = byGroup.get(g.key) ?? []
        if (list.length === 0) return null
        return (
          <Card key={g.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{g.label}</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              {list.map((f) => (
                <div
                  key={f.id}
                  className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{f.label}</span>
                      <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                        {f.settingKey}
                      </code>
                      {!f.enabled && <Badge variant="destructive">{t("ftog.offBadge")}</Badge>}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{f.impact}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Gauge className="h-3 w-3" />
                        {f.costHint}
                      </span>
                      <span>
                        {t("ftog.routes", { v0: f.routeCount })}
                        {f.jobCount > 0 ? " · " + t("ftog.jobs", { v0: f.jobCount }) : ""}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    {saving === f.id && (
                      <span className="text-[11px] text-muted-foreground">{t("ftog.saving")}</span>
                    )}
                    <Switch
                      checked={f.enabled}
                      disabled={saving !== null}
                      aria-label={f.label}
                      onCheckedChange={(v) => {
                        if (v) void apply(f, true)
                        else setConfirmOff(f)
                      }}
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )
      })}

      <Dialog
        open={confirmOff !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmOff(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t("ftog.confirmTitle", { v0: confirmOff?.label ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("ftog.confirmDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
              {confirmOff?.impact}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("ftog.routes", { v0: confirmOff?.routeCount ?? 0 })}
              {confirmOff && confirmOff.jobCount > 0
                ? " · " + t("ftog.jobs", { v0: confirmOff.jobCount })
                : ""}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOff(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={saving !== null}
              onClick={() => {
                if (confirmOff) void apply(confirmOff, false)
              }}
            >
              {t("ftog.confirmBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
