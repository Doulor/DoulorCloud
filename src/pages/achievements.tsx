import * as React from "react"
import { Link } from "react-router-dom"
import { RefreshCw, RotateCw, Trophy, UserRound, WifiOff } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { FeatureCardsSkeleton } from "@/components/skeletons"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/format"
import { achievementIcon } from "@/lib/achievement-icons"
import { useAuth } from "@/hooks/use-auth"
import type { AchievementProgress, AchievementsResponse } from "@/types"
import { useT, tStatic } from "@/i18n"

/** 格式化解锁时间 */
function fmtUnlock(iso: string | null): string {
  if (!iso) return tStatic("ach.locked")
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 按成就自己声明的格式渲染进度数字（网盘容量要按 MB/GB 显示） */
function fmtValue(a: AchievementProgress, n: number): string {
  return a.valueFormat === "bytes" ? formatBytes(n) : String(n)
}

/** 单个成就勋章卡（可点击查看详情） */
function AchievementCard({
  a,
  onClick,
}: {
  a: AchievementProgress
  onClick: () => void
}) {
  const { t } = useT()
  const Icon = achievementIcon(a.icon)
  const unlocked = a.level > 0
  const tierName = a.tierNames?.[Math.max(0, a.level - 1)] ?? null

  // 分级成就的进度百分比（相对下一等级）
  const prevTier = a.tiers && a.level > 0 ? a.tiers[a.level - 1] : 0
  const progressPct =
    a.tiers && a.nextTier !== null
      ? Math.min(100, Math.max(0, ((a.value - prevTier) / (a.nextTier - prevTier)) * 100))
      : 100

  return (
    <button type="button" onClick={onClick} className="text-left">
      <Card
        className={cn(
          "h-full cursor-pointer transition-all hover:border-primary/60 hover:shadow-sm",
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
                    {fmtValue(a, a.value)} / {fmtValue(a, a.nextTier)}
                  </p>
                </>
              ) : (
                <p className="text-[10px] text-primary">{t("ach.maxed")}</p>
              )}
            </div>
          )}

          {a.single && (
            <Badge variant={unlocked ? "success" : "secondary"} className="text-[10px]">
              {unlocked ? t("ach.unlocked") : t("ach.locked")}
            </Badge>
          )}
        </CardContent>
      </Card>
    </button>
  )
}

/** 成就详情弹窗 */
function AchievementDetailDialog({
  a,
  onClose,
}: {
  a: AchievementProgress | null
  onClose: () => void
}) {
  const { t } = useT()
  if (!a) return null
  const Icon = achievementIcon(a.icon)
  const unlocked = a.level > 0

  return (
    <Dialog open={!!a} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2",
                unlocked
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-muted text-muted-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>{a.name}</DialogTitle>
              <DialogDescription>{a.desc}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* 获取途径 */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("ach.howTo")}</p>
            <p className="text-sm">{a.how}</p>
          </div>

          <Separator />

          {/* 单级成就 */}
          {a.single ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("ach.status")}</p>
              <p className="text-sm">
                {unlocked ? (
                  <>
                    {t("ach.unlockedAt")} · <span className="text-muted-foreground">{fmtUnlock(a.unlockedAt)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{t("ach.notYet")}</span>
                )}
              </p>
            </div>
          ) : (
            /* 分级成就：各等级详情 */
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t("ach.tierProgress")}</p>
              <div className="space-y-2">
                {(a.tiers ?? []).map((tier, i) => {
                  const lv = i + 1
                  const reached = a.level >= lv
                  const unlockedAt = a.unlockedLevels[i] ?? null
                  return (
                    <div
                      key={lv}
                      className={cn(
                        "flex items-center justify-between rounded-md border px-3 py-2",
                        reached ? "border-primary/40 bg-primary/5" : "border-border"
                      )}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          Lv.{lv} {a.tierNames?.[i] ?? ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {a.tierReqs?.[i] ?? t("ach.reach", { value: fmtValue(a, tier) })}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {reached ? (
                          <Badge variant="success" className="text-[10px]">
                            {t("ach.unlocked")}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {fmtValue(a, a.value)} / {fmtValue(a, tier)}
                          </span>
                        )}
                        {reached && unlockedAt && (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {fmtUnlock(unlockedAt)}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function AchievementsPage() {
  const { t } = useT()
  const { user } = useAuth()
  const username = user?.username ?? ""
  const [data, setData] = React.useState<AchievementsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [selected, setSelected] = React.useState<AchievementProgress | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await achievementApi.list()
      setData(res)
    } catch (err) {
      // ⚠️ 2026-09-26：失败不再伪装成「零成就」——原先只 toast，`data` 保持 null
      // 就一路渲染成空成就墙，用户以为是自己没解锁任何成就。
      toast.error(err instanceof HttpError ? err.message : t("ach.err.load"))
      setFailed(true)
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
        <PageHeader title={t("ach.title")} description={t("ach.desc")} />
        <FeatureCardsSkeleton />
      </div>
    )
  }

  if (failed) {
    return (
      <div>
        <PageHeader title={t("ach.title")} description={t("ach.desc")} />
        <EmptyState
          icon={WifiOff}
          title={t("ach.loadFailed")}
          description={t("ach.loadFailedDesc")}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCw className="h-4 w-4" /> {t("common.retry")}
            </Button>
          }
        />
      </div>
    )
  }

  const achievements = data?.achievements ?? []
  const groups = data?.groups ?? []
  const summary = data?.summary ?? { unlocked: 0, total: 0, points: 0, maxPoints: 0 }
  const title = data?.title ?? {
      name: t("ach.defaultTitle"),
      min: 0,
      next: null,
      nextName: null,
      ladder: [],
    }
  // 总览进度按**成就点**算（而不是成就个数）：分级成就练到 Lv.3 值 3 点，
  // 只看个数会把「浅尝辄止」和「全部练满」算成一样的进度。
  const pct = summary.maxPoints > 0 ? (summary.points / summary.maxPoints) * 100 : 0

  // 每个分组的进度（组内已解锁 / 组内总数）
  const groupStats = groups.map((g) => {
    const inGroup = achievements.filter((a) => a.group === g.id)
    return {
      ...g,
      total: inGroup.length,
      unlocked: inGroup.filter((a) => a.level > 0).length,
      items: inGroup,
    }
  })
  // 没有分组的成就（后端加了新分组但前端还没更新时不至于整块消失）
  const knownGroups = new Set(groups.map((g) => g.id))
  const orphans = achievements.filter((a) => !knownGroups.has(a.group))

  // 「即将达成」：未满级、已完成度 ≥ 60% 的成就，按完成度从高到低取前 6 个。
  // 成就数量变多后，一眼看不出「哪个差一点就拿到了」，这一块专门解决它。
  const almostDone = achievements
    .filter((a) => a.nextTier !== null && a.tiers && a.tiers.length > 0)
    .map((a) => {
      const prevTier = a.level > 0 ? (a.tiers?.[a.level - 1] ?? 0) : 0
      const span = (a.nextTier ?? 0) - prevTier
      const ratio = span > 0 ? (a.value - prevTier) / span : 0
      return { a, ratio }
    })
    .filter((x) => x.ratio >= 0.6)
    .sort((x, y) => y.ratio - x.ratio)
    .slice(0, 6)

  const unlockedCount = summary.unlocked
  const lockedCount = summary.total - unlockedCount

  return (
    <div>
      <PageHeader
        title={t("ach.title")}
        description={t("ach.desc")}
        actions={
          <div className="flex items-center gap-2">
            {/* 成就要别人看得到才有意思 —— 直接给个入口去自己的空间（徽章墙在那儿） */}
            {username && (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/space/${encodeURIComponent(username)}`}>
                  <UserRound className="h-4 w-4" />
                  {t("ach.mySpace")}
                </Link>
              </Button>
            )}
            <Button variant="outline" size="icon" onClick={() => void load()} aria-label={t("common.refresh")}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      {/* 总览：称号 + 点数 + 分组进度 */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Trophy className="h-4 w-4 text-muted-foreground" />
                {t("ach.progress")}
              </CardTitle>
              <CardDescription>
                {t("ach.progressLine", { unlocked: summary.unlocked, total: summary.total })}{" "}

                {summary.points} / {summary.maxPoints}
              </CardDescription>
            </div>
            <span className="text-2xl font-semibold tracking-tight">
              {Math.round(pct)}%
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 称号 */}
          <div className="flex flex-wrap items-center gap-3 rounded-md border px-4 py-3">
            <Badge variant="secondary" className="shrink-0">
              {t("ach.currentTitle")}
            </Badge>
            <span className="text-lg font-semibold tracking-tight">{title.name}</span>
            {title.next !== null && (
              <span className="text-xs text-muted-foreground">
                {t("ach.nextTitle", { n: title.next - summary.points, name: title.nextName ?? "" })}
              </span>
            )}
            {title.next === null && (
              <span className="text-xs text-muted-foreground">{t("ach.maxTitle")}</span>
            )}
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* 称号阶梯：像 VIP 等级一样线性展示所有档位，前后都能看到 */}
          {title.ladder.length > 1 && (
            <div className="overflow-x-auto pb-1">
              <div className="flex w-full min-w-[560px] items-start">
                {title.ladder.map((rung, i) => {
                  const reached = summary.points >= rung.min
                  const isLast = i === title.ladder.length - 1
                  return (
                    <div key={`${rung.min}-${rung.name}`} className="flex flex-1 items-start">
                      <div className="flex w-16 shrink-0 flex-col items-center gap-1">
                        <div
                          className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-[11px] font-semibold transition-colors ${
                            rung.current
                              ? "border-primary bg-primary text-primary-foreground"
                              : reached
                                ? "border-primary bg-primary/15 text-primary"
                                : "border-muted-foreground/30 text-muted-foreground"
                          }`}
                        >
                          {i + 1}
                        </div>
                        <span
                          className={`text-[11px] leading-tight ${
                            rung.current
                              ? "font-semibold text-foreground"
                              : reached
                                ? "text-foreground"
                                : "text-muted-foreground"
                          }`}
                        >
                          {rung.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{rung.min}</span>
                      </div>
                      {!isLast && (
                        <div
                          className={`mt-3.5 h-0.5 flex-1 ${
                            summary.points >= title.ladder[i + 1].min
                              ? "bg-primary"
                              : "bg-muted-foreground/25"
                          }`}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 分组进度 */}
          {groupStats.length > 1 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {groupStats.map((g) => (
                <div key={g.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{g.label}</span>
                    <span className="text-muted-foreground">
                      {g.unlocked} / {g.total}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70 transition-all"
                      style={{
                        width: `${g.total > 0 ? (g.unlocked / g.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {data?.registeredAt && (
            <p className="text-xs text-muted-foreground">
              {t("ach.joinedAt", { date: new Date(data.registeredAt).toLocaleDateString(t("msg.dateLocale")) })}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 即将达成：完成度 ≥60% 的成就，给用户一个明确的下一步 */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Trophy className="h-4 w-4 text-muted-foreground" />
                {t("ach.almost")}
              </CardTitle>
              <CardDescription>{t("ach.almostDesc")}</CardDescription>
            </div>
            <div className="shrink-0 space-y-0.5 text-right text-xs text-muted-foreground">
              <p>{t("ach.summaryUnlocked", { n: unlockedCount })}</p>
              <p>{t("ach.summaryLocked", { n: lockedCount })}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {almostDone.length === 0 ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              {t("ach.almostEmpty")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {almostDone.map(({ a, ratio }) => {
                const Icon = achievementIcon(a.icon)
                const prevTier = a.level > 0 ? (a.tiers?.[a.level - 1] ?? 0) : 0
                const remain = (a.nextTier ?? 0) - a.value
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelected(a)}
                    className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/60"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-primary/40 bg-primary/10 text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-medium">{a.name}</p>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {Math.round(ratio * 100)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${Math.min(100, ratio * 100)}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {t("ach.remaining", { n: fmtValue(a, remain > 0 ? remain : 0) })}
                        {prevTier > 0 ? ` · ${fmtValue(a, a.value)} / ${fmtValue(a, a.nextTier ?? 0)}` : ""}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 勋章墙（按分组） */}
      {achievements.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("ach.empty")}</p>
      ) : (
        <div className="space-y-8">
          {groupStats
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <section key={g.id} className="space-y-3">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold">{g.label}</h2>
                  <span className="text-xs text-muted-foreground">{g.desc}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {g.unlocked} / {g.total}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {g.items.map((a) => (
                    <AchievementCard key={a.id} a={a} onClick={() => setSelected(a)} />
                  ))}
                </div>
              </section>
            ))}

          {orphans.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">{t("ach.other")}</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {orphans.map((a) => (
                  <AchievementCard key={a.id} a={a} onClick={() => setSelected(a)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <AchievementDetailDialog a={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
