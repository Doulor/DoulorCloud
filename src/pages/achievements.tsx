import * as React from "react"
import {
  Award,
  Calendar,
  Contact,
  Crown,
  Eye,
  Globe,
  HardDrive,
  Inbox,
  LogIn,
  Mail,
  Network,
  RefreshCw,
  Sparkles,
  Trophy,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { achievementApi, HttpError } from "@/services/api"
import { cn } from "@/lib/utils"
import type { AchievementProgress, AchievementsResponse } from "@/types"

/** 后端 icon 标识 → lucide 图标 */
const ICONS: Record<string, React.ElementType> = {
  "hard-drive": HardDrive,
  sparkles: Sparkles,
  contact: Contact,
  globe: Globe,
  mail: Mail,
  network: Network,
  "log-in": LogIn,
  eye: Eye,
  inbox: Inbox,
  crown: Crown,
  calendar: Calendar,
}

/** 单个成就勋章卡 */
function AchievementCard({ a }: { a: AchievementProgress }) {
  const Icon = ICONS[a.icon] ?? Award
  const unlocked = a.level > 0
  const tierName = a.tierNames?.[Math.max(0, a.level - 1)] ?? null

  // 分级成就的进度百分比（相对下一等级）
  const prevTier = a.tiers && a.level > 0 ? a.tiers[a.level - 1] : 0
  const progressPct =
    a.tiers && a.nextTier !== null
      ? Math.min(100, Math.max(0, ((a.value - prevTier) / (a.nextTier - prevTier)) * 100))
      : 100

  return (
    <Card
      className={cn(
        "transition-colors",
        unlocked ? "border-primary/40" : "opacity-60"
      )}
    >
      <CardContent className="flex flex-col items-center gap-2 p-5 text-center">
        <div
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full border-2",
            unlocked
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border bg-muted text-muted-foreground"
          )}
        >
          <Icon className="h-6 w-6" />
        </div>
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{a.name}</p>
          {a.single ? (
            <p className="text-xs text-muted-foreground">{a.desc}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {tierName ?? a.desc}
            </p>
          )}
        </div>

        {/* 分级成就：等级点 + 进度 */}
        {!a.single && a.tiers && (
          <div className="w-full space-y-1.5">
            <div className="flex items-center justify-center gap-1">
              {a.tiers.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    i < a.level ? "bg-primary" : "bg-border"
                  )}
                />
              ))}
            </div>
            {a.nextTier !== null ? (
              <>
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {a.value} / {a.nextTier}
                </p>
              </>
            ) : (
              <p className="text-[10px] text-primary">已满级</p>
            )}
          </div>
        )}

        {a.single && (
          <Badge variant={unlocked ? "success" : "secondary"} className="text-[10px]">
            {unlocked ? "已解锁" : "未解锁"}
          </Badge>
        )}
      </CardContent>
    </Card>
  )
}

export default function AchievementsPage() {
  const [data, setData] = React.useState<AchievementsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await achievementApi.list()
      setData(res)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载成就失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div>
        <PageHeader title="成就" description="记录你在 Doulor Cloud 的足迹" />
        <LoadingBlock />
      </div>
    )
  }

  const achievements = data?.achievements ?? []
  const summary = data?.summary ?? { unlocked: 0, total: 0 }
  const pct = summary.total > 0 ? (summary.unlocked / summary.total) * 100 : 0

  return (
    <div>
      <PageHeader
        title="成就"
        description="记录你在 Doulor Cloud 的足迹"
        actions={
          <Button variant="outline" size="icon" onClick={() => void load()} aria-label="刷新">
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />

      {/* 总览 */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Trophy className="h-4 w-4 text-muted-foreground" />
                成就进度
              </CardTitle>
              <CardDescription>
                已解锁 {summary.unlocked} / {summary.total} 个成就
              </CardDescription>
            </div>
            <span className="text-2xl font-semibold tracking-tight">
              {Math.round(pct)}%
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {data?.registeredAt && (
            <p className="mt-3 text-xs text-muted-foreground">
              加入于 {new Date(data.registeredAt).toLocaleDateString("zh-CN")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 勋章墙 */}
      {achievements.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">暂无成就</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {achievements.map((a) => (
            <AchievementCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  )
}
