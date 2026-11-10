import * as React from "react"
import { Heart } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useT } from "@/i18n"

/**
 * 捐献页底部「赞赏」块（2026-11-02）
 *
 * 图片由管理员在后台「设置 → 捐献页赞赏码」上传，存 R2。
 * 没设置时 /api/tip-qr 返回 404，这里 img onError 直接把整块隐藏，
 * 不需要额外请求判断，也不会在页面上留一个破图。
 */
export function TipQrCard({ className }: { className?: string }) {
  const { t } = useT()
  const [visible, setVisible] = React.useState(true)

  // 后台还没传图时不要留白：给一句占位说明，避免用户点进「赞赏」看到空白页
  if (!visible) {
    return (
      <Card className={className ?? "mt-6"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Heart className="h-4 w-4 text-muted-foreground" />
            {t("don.tip.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("don.tip.emptyState")}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className ?? "mt-6"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Heart className="h-4 w-4 text-muted-foreground" />
          {t("don.tip.title")}
        </CardTitle>
        <CardDescription>{t("don.tip.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <img
          src="/api/tip-qr"
          alt={t("don.tip.alt")}
          className="h-72 w-72 max-w-full rounded-lg border bg-white object-contain p-2 sm:h-80 sm:w-80"
          onError={() => setVisible(false)}
        />
        <p className="max-w-md text-center text-xs text-muted-foreground">
          {t("don.tip.note")}
        </p>
      </CardContent>
    </Card>
  )
}
