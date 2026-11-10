/**
 * 管理面板 → 商品审核（2026-10-30）。
 *
 * 背景：此前「用户上架商品的审核」只长在「积分」标签页里，而那一页的接口要求
 * `points.official`（官方商品管理）。站长给管理员只勾了「审核商品」（`points.review`）
 * 时，页面进不去、接口 403，界面上就是一句「还没有用户上架商品」——权限给了却看不见活。
 *
 * 所以这里单独做一个面板，只依赖 `points.review`：
 *   GET  /api/admin/points/review-queue   —— 只返回用户商品
 *   POST /api/admin/points/products/:id/review —— 通过 / 拒绝（复用既有接口）
 */
import * as React from "react"
import { Store, Check, X, RefreshCw, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/empty-state"
import { adminPointsApi, errMsg } from "@/services/api"
import type { PointProduct } from "@/types"

const STATUS_META: Record<string, { label: string; variant: "default" | "secondary" | "success" | "destructive" | "outline" }> = {
  pending: { label: "待审核", variant: "default" },
  approved: { label: "已通过", variant: "success" },
  rejected: { label: "已拒绝", variant: "destructive" },
}

export function ProductReviewPanel() {
  const [items, setItems] = React.useState<PointProduct[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  const [filter, setFilter] = React.useState<"pending" | "all">("pending")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminPointsApi.reviewQueue()
      setItems(res.userProducts ?? [])
    } catch (e) {
      toast.error(errMsg(e, "加载审核队列失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const review = async (p: PointProduct, approve: boolean) => {
    setBusy(p.id)
    try {
      await adminPointsApi.reviewProduct(p.id, approve, notes[p.id]?.trim() || undefined)
      toast.success(approve ? `已通过「${p.name}」` : `已拒绝「${p.name}」`)
      await load()
    } catch (e) {
      toast.error(errMsg(e, "审核失败"))
    } finally {
      setBusy(null)
    }
  }

  const shown = filter === "pending" ? items.filter((p) => p.reviewStatus === "pending") : items
  const pendingCount = items.filter((p) => p.reviewStatus === "pending").length

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Store className="h-4 w-4" />
            用户上架商品审核
            {pendingCount > 0 && (
              <Badge variant="default" className="text-[10px]">
                {pendingCount} 件待审核
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            用户自己挂的商品只能人工交付；审核通过后才会出现在用户端的「用户们的商城」里。
            买家支付的积分先由平台保管，卖家发货、买家确认收货后才结算给卖家。
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilter(filter === "pending" ? "all" : "pending")}
          >
            {filter === "pending" ? "只看待审核" : "看全部"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载…
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Store}
            title={pendingCount === 0 && filter === "pending" ? "当前没有待审核的商品" : "没有匹配的商品"}
            description="用户在「积分与商城 → 用户们的商城」里点「上传商品」提交后，会出现在这里等你审核。"
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {shown.map((p) => {
              const meta = STATUS_META[p.reviewStatus] ?? { label: p.reviewStatus, variant: "outline" as const }
              return (
                <div key={p.id} className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{p.name}</span>
                        <Badge variant={meta.variant} className="shrink-0 text-[10px]">
                          {meta.label}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {p.description || "（卖家未填写简介）"}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold tabular-nums">{p.price} 积分</div>
                      <div className="text-[11px] text-muted-foreground">
                        库存 {p.stock === null ? "不限" : p.stock}
                      </div>
                    </div>
                  </div>
                  {p.imageUrl && (
                    <img
                      src={p.imageUrl}
                      alt=""
                      className="mt-3 h-24 w-full rounded-md object-cover"
                      loading="lazy"
                    />
                  )}
                  {p.reviewStatus === "pending" ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Input
                        value={notes[p.id] ?? ""}
                        onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))}
                        placeholder="审核备注（拒绝时建议填写原因）"
                        className="h-8 flex-1 text-xs"
                      />
                      <Button
                        size="sm"
                        disabled={busy === p.id}
                        onClick={() => void review(p, true)}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" />
                        通过
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy === p.id}
                        onClick={() => void review(p, false)}
                      >
                        <X className="mr-1 h-3.5 w-3.5" />
                        拒绝
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {p.reviewStatus === "approved" ? "已通过，商品已在用户端上架。" : "已拒绝，卖家可在自己的商品里看到结果。"}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
