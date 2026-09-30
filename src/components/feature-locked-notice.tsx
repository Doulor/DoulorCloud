import { Link } from "react-router-dom"
import { Lock, HeartHandshake } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { useT } from "@/i18n"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * 功能未授权时的整页提示。
 *
 * 之前各页面只在 toast 里弹一下 403，页面本身留在空白/加载态，
 * 用户看不出发生了什么。这里统一换成明确的说明 + 前往捐献的入口。
 *
 * 服务端始终是权限的唯一裁决者（requireFeatureUser）；
 * 这个组件只负责把 403 讲清楚，不能替代服务端校验。
 */
export function FeatureLockedNotice({
  feature,
  featureLabel,
  description,
}: {
  feature: string
  featureLabel: string
  description?: string
}) {
  const { t } = useT()
  return (
    <div>
      <PageHeader title={featureLabel} description={t("locked.subtitle")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4 text-muted-foreground" />
            {t("locked.title")}
          </CardTitle>
          <CardDescription>
            {description ?? t("locked.desc", { feature: featureLabel })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <HeartHandshake className="h-4 w-4 text-muted-foreground" />
              {t("locked.howToUnlock")}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("locked.unlockHint")}
            </p>
          </div>
          <Button asChild>
            <Link to="/dashboard/donations">{t("locked.goDonate")}</Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("locked.featureId")}
            <span className="font-mono">{feature}</span>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
