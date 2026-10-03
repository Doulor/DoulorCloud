/**
 * 管理面板「公开 API」板块：每个功能的开关 + 各成就点层级的每日限额 + 「计入成就」开关。
 *
 * 层级口径：每 10 成就点一层（0-9 = 层级 0，10-19 = 层级 1…），封顶 10 层（100+ 点）。
 * 每个功能的「账号限额」是 11 个输入框（层级 0~10），IP 限额单独一个（IP 无成就点，
 * 所以不分层）。
 */
import * as React from "react"
import { toast } from "sonner"
import { Loader2, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { adminApi, errMsg } from "@/services/api"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

/** 功能标识 → 展示名（用 i18n key） */
const FEATURE_LABEL_KEY: Record<string, string> = {
  dns: "adm.api.featureDns",
  mailbox: "adm.api.featureMailbox",
  temp_mailbox: "adm.api.featureTempMailbox",
}

/** 层级数（0~10，11 档） */
const TIER_COUNT = 11

interface FeatureDraft {
  feature: string
  enabled: boolean
  tierLimits: number[]
  ipLimit: number
}

export function AdminApiTab() {
  const { t } = useT()
  const [features, setFeatures] = React.useState<FeatureDraft[]>([])
  const [countAchievements, setCountAchievements] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    void load()
  }, [])

  const load = async () => {
    setLoading(true)
    try {
      const res = await adminApi.getApiConfig()
      setCountAchievements(res.countAchievements)
      setFeatures(
        res.features.map((f) => ({
          feature: f.feature,
          enabled: f.enabled,
          // 补齐到 TIER_COUNT 档，缺的补 0
          tierLimits: Array.from({ length: TIER_COUNT }, (_, i) => f.tierLimits[i] ?? 0),
          ipLimit: f.ipLimit,
        }))
      )
    } catch (err) {
      toast.error(errMsg(err, t("adm.api.loadFailed")))
    } finally {
      setLoading(false)
    }
  }

  const patch = (feature: string, upd: Partial<FeatureDraft>) => {
    setFeatures((prev) =>
      prev.map((f) => (f.feature === feature ? { ...f, ...upd } : f))
    )
  }

  const patchTier = (feature: string, tier: number, value: string) => {
    const n = Math.max(0, Math.floor(Number(value)) || 0)
    setFeatures((prev) =>
      prev.map((f) => {
        if (f.feature !== feature) return f
        const tierLimits = [...f.tierLimits]
        tierLimits[tier] = n
        return { ...f, tierLimits }
      })
    )
  }

  const save = async () => {
    setBusy(true)
    try {
      await adminApi.saveApiConfig({
        countAchievements,
        features: features.map((f) => ({
          feature: f.feature,
          enabled: f.enabled,
          tierLimits: f.tierLimits,
          ipLimit: f.ipLimit,
        })),
      })
      toast.success(t("adm.api.saved"))
      void load()
    } catch (err) {
      toast.error(errMsg(err, t("adm.api.saveFailed")))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="py-16">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 计入成就开关 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("adm.api.title")}</CardTitle>
          <CardDescription>{t("adm.api.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{t("adm.api.countAchievements")}</p>
              <p className="text-xs text-muted-foreground">{t("adm.api.countAchievementsHint")}</p>
            </div>
            <Switch checked={countAchievements} onCheckedChange={setCountAchievements} />
          </div>
        </CardContent>
      </Card>

      {/* 每个功能 */}
      {features.map((f) => (
        <Card key={f.feature}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle className="text-base">{t(FEATURE_LABEL_KEY[f.feature] ?? f.feature)}</CardTitle>
              <CardDescription>
                {t("adm.api.tierHint", { n: TIER_COUNT - 1 })}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("text-xs", f.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                {f.enabled ? t("adm.api.open") : t("adm.api.closed")}
              </span>
              <Switch checked={f.enabled} onCheckedChange={(v) => patch(f.feature, { enabled: v })} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">{t("adm.api.accountLimit")}</Label>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-11">
                {f.tierLimits.map((v, i) => (
                  <div key={i} className="space-y-1">
                    <div className="text-center text-[10px] text-muted-foreground">
                      {t("adm.api.tierLabel", { n: i })}
                    </div>
                    <Input
                      type="number"
                      min={0}
                      className="h-8 px-1 text-center text-xs"
                      value={v}
                      onChange={(e) => patchTier(f.feature, i, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{t("adm.api.tierLegend")}</p>
            </div>

            <div className="flex items-end gap-3">
              <div className="w-40 space-y-1">
                <Label className="text-xs">{t("adm.api.ipLimit")}</Label>
                <Input
                  type="number"
                  min={0}
                  className="h-8"
                  value={f.ipLimit}
                  onChange={(e) => patch(f.feature, { ipLimit: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
                />
              </div>
              <p className="pb-1 text-[11px] text-muted-foreground">{t("adm.api.ipLimitHint")}</p>
            </div>
          </CardContent>
        </Card>
      ))}

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          {t("common.save")}
        </Button>
      </div>
    </div>
  )
}
