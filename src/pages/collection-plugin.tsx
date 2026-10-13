import * as React from "react"
import { Link, useParams } from "react-router-dom"
import { Loader2, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { SkeletonCards } from "@/components/skeletons"
import { useT } from "@/i18n"
import { collectionApi, type CollectionPlugin } from "@/services/api"
import { pluginViewFor } from "@/lib/collection-plugins"

/**
 * 造物典藏 —— **插件宿主**。
 *
 * 路由 `/dashboard/gallery/collection/:slug`。它自己**不画任何游戏界面**，
 * 只做三件事：
 *   1. 从服务端清单里按 slug 找到这个插件（名字/图标/说明都来自清单）；
 *   2. 按 `runtime` 选择渲染方式：
 *        · `react`   —— 从 `lib/collection-plugins.tsx` 的注册表取组件（内置游戏）；
 *        · `sandbox` —— 将来用户写的 HTML，走沙盒 iframe 宿主（拿不到会话 cookie）；
 *   3. 用 `<Suspense>` 兜住懒加载（交易界面这类重组件不该进首屏包）。
 *
 * 这就是「造物典藏是插件宿主」的落点：**同一个 slug、同一个路由、同一个宿主**，
 * 内置游戏与将来的用户游戏走的是同一套。将来开放用户发布时，
 * 只需要在这里补上 `sandbox` 那一支，其余一行都不用改。
 */
export default function CollectionPluginPage() {
  const { slug = "" } = useParams<{ slug: string }>()
  const { t } = useT()
  const [plugin, setPlugin] = React.useState<CollectionPlugin | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    collectionApi
      .plugins()
      .then((res) => {
        if (!alive) return
        setPlugin((res.plugins ?? []).find((p) => p.slug === slug) ?? null)
      })
      .catch(() => {
        if (alive) setPlugin(null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [slug])

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t("gal.loading")}</span>
        </div>
        <SkeletonCards count={3} />
      </div>
    )
  }

  const View = plugin ? pluginViewFor(plugin.slug) : null

  // 清单里没有（slug 拼错 / 还没上架 / 已下架）与「组件还没接上」是两件事，
  // 提示文案不一样 —— 对站长来说这两者的处理方式完全不同。
  if (!plugin || plugin.runtime !== "react" || !View) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
          <Sparkles className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t("col.soon")}</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {plugin ? t("col.soonDesc") : t("gal.notFound")}
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link to="/dashboard/gallery/collection">{t("col.tab.hall")}</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      {/* 游戏自己负责全屏布局（含返回入口），宿主不套任何容器 */}
      <View />
    </React.Suspense>
  )
}
