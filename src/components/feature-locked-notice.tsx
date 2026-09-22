import { Link } from "react-router-dom"
import { Lock, HeartHandshake } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
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
  return (
    <div>
      <PageHeader title={featureLabel} description="功能未开放" />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4 text-muted-foreground" />
            该功能暂未向你开放
          </CardTitle>
          <CardDescription>
            {description ??
              `你的账号未被授予「${featureLabel}」权限。站长资源有限，该服务暂未全量开放。`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <HeartHandshake className="h-4 w-4 text-muted-foreground" />
              如何解锁
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              如果你愿意贡献自己的资源（例如 AI 渠道、穿透配置、代理订阅），
              提交捐献申请经管理员审核通过后，该功能会自动为你解锁。
            </p>
          </div>
          <Button asChild>
            <Link to="/dashboard/donations">前往捐献</Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            功能标识：<span className="font-mono">{feature}</span>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}