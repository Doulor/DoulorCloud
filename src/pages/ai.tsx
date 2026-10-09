import * as React from "react"
import { useNavigate, Link } from "react-router-dom"
import {
  ArrowDown,
  Bot,
  ChevronDown,
  Copy,
  ExternalLink,
  Gift,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Trophy,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { FeatureLockedNotice } from "@/components/feature-locked-notice"
import { EmptyState } from "@/components/empty-state"
import { FeatureCardsSkeleton, SkeletonList, SkeletonTable } from "@/components/skeletons"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { KeyGroupCell, KeyGroupNote, KeyGroupPicker, ModelVendorSections } from "@/components/ai-key-group"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { newapiApi, HttpError } from "@/services/api"
import { fmtTime } from "@/lib/format"
import { useT, tStatic } from "@/i18n"
import type {
  NewApiHealth,
  NewApiKey,
  NewApiModels,
  NewApiPreflight,
  NewApiStatus,
  NewApiSubscriptionGroup,
  RecommendedTier,
} from "@/types"

/** 中转站在线/离线徽章，含延迟与版本 */
function HealthBadge({ health }: { health?: NewApiHealth }) {
  const { t } = useT()
  if (!health) return null
  return (
    <div className="flex items-center gap-2">
      <Badge variant={health.online ? "success" : "destructive"} className="gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            health.online ? "bg-emerald-500" : "bg-destructive"
          }`}
        />
        {health.online ? t("ai.online") : t("ai.offline")}
      </Badge>
      {health.online && (
        <span className="text-xs text-muted-foreground">
          {health.latencyMs}ms
          {health.version ? ` · v${health.version}` : ""}
        </span>
      )}
    </div>
  )
}

/**
 * 推荐模型分档：管理员在管理面板维护，此处按梯队从高到低纵向排列，
 * 梯队之间用向下的箭头连接，直观表达「首选 → 备选 → 兜底」的推荐次序。
 */
function RecommendedModels({
  tiers,
  onCopy,
}: {
  tiers: RecommendedTier[]
  onCopy: (model: string) => void
}) {
  const { t } = useT()
  return (
    <div className="space-y-1">
      {tiers.map((tier, i) => {
        // 颜色随梯队递减：第一梯队最醒目，越往后越淡
        const tone =
          i === 0
            ? "border-primary/50 bg-primary/5"
            : i === 1
              ? "border-border bg-muted/40"
              : "border-border bg-muted/20"
        return (
          <React.Fragment key={`${tier.tier}-${i}`}>
            <div className={`rounded-lg border p-3.5 ${tone}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    i === 0
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted-foreground/20 text-muted-foreground"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="text-sm font-semibold">{tier.tier}</span>
                <Badge variant="secondary" className="text-xs">
                  {t("ai.modelCount", { n: tier.models.length })}
                </Badge>
              </div>
              {tier.desc && (
                <p className="mt-1.5 pl-7 text-xs text-muted-foreground">{tier.desc}</p>
              )}
              <div className="mt-2.5 flex flex-wrap gap-1.5 pl-7">
                {tier.models.map((m) => (
                  <Badge
                    key={m}
                    variant="outline"
                    className="cursor-pointer bg-background font-mono text-xs"
                    onClick={() => onCopy(m)}
                    title={t("ai.clickCopyModel")}
                  >
                    {m}
                  </Badge>
                ))}
              </div>
            </div>
            {i < tiers.length - 1 && (
              <div className="flex justify-center py-0.5">
                <ArrowDown className="h-4 w-4 text-muted-foreground/50" />
              </div>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

/** 订阅下次重置时间（unix 秒）→ 友好文案 */
function formatResetTime(ts: number): string {
  if (!ts) return "—"
  const d = new Date(ts * 1000)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`
  if (isToday) return tStatic("ai.time.today", { time: hhmm })
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) {
    return tStatic("ai.time.tomorrow", { time: hhmm })
  }
  return tStatic("ai.time.date", {
    month: d.getMonth() + 1,
    day: d.getDate(),
    time: hhmm,
  })
}

/** NewAPI quota 单位 → 站点金额（换算率由服务端下发，见 status.quotaPerUnit） */
function fmtAmount(quota: number, symbol: string, perUnit: number): string {
  if (!perUnit) return `${symbol}0.00`
  return `${symbol}${(quota / perUnit).toFixed(2)}`
}

/** 订阅有效期（unix 秒）→ 日期文案 */
function formatExpiry(ts: number): string {
  if (!ts) return "—"
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return "—"
  return tStatic("ai.time.fullDate", {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  })
}

/**
 * 分段进度条的颜色池：按套餐顺序循环取用 —— **一个颜色 = 一个套餐**。
 *
 * 每个颜色成对出现：`solid` 画「剩余」，`faded` 画「已用」。同色系的两档
 * 让「这段属于哪个套餐」在部分消耗后依然一目了然（比跨段盖一层灰罩准确）。
 *
 * 颜色走中性灰阶 + 一个暖琥珀点缀，与站点「黑白灰 + 暖橙」的整体风格一致，
 * 避免冷调的蓝/绿/紫在页面上显得突兀。
 */
const SEGMENT_COLORS = [
  { solid: "bg-zinc-600 dark:bg-zinc-300", faded: "bg-zinc-600/20 dark:bg-zinc-300/20" },
  { solid: "bg-stone-500 dark:bg-stone-400", faded: "bg-stone-500/20 dark:bg-stone-400/20" },
  { solid: "bg-amber-600 dark:bg-amber-500", faded: "bg-amber-600/20 dark:bg-amber-500/20" },
  { solid: "bg-neutral-500 dark:bg-neutral-400", faded: "bg-neutral-500/20 dark:bg-neutral-400/20" },
  { solid: "bg-stone-600 dark:bg-stone-300", faded: "bg-stone-600/20 dark:bg-stone-300/20" },
]

/**
 * 其他订阅卡片：把全部**非免费**的活跃订阅（邀请奖励、成就奖励等）汇总成
 * 一条总额度，并用分段进度条区分「哪一段属于哪个套餐」。
 *
 * 为什么按套餐合并、而不是一张订阅一段：NewAPI 里同一套餐可以有多张订阅
 * （每邀请一个人就多开一张），逐张画会出现多段同色相邻、图例也冗长。
 * 合并后颜色含义稳定，且新增套餐会自动出现在这里，无需改代码。
 */
function RewardSubscriptionsCard({
  groups,
  symbol,
  perUnit,
}: {
  groups: NewApiSubscriptionGroup[]
  symbol: string
  perUnit: number
}) {
  const total = groups.reduce((sum, g) => sum + g.amountTotal, 0)
  const used = groups.reduce((sum, g) => sum + g.amountUsed, 0)
  const remaining = Math.max(0, total - used)
  // 各张订阅的重置时刻本应对齐（统一 UTC 次日 0 点），取最早的一个更保守
  const nextReset = groups.reduce(
    (min, g) =>
      g.nextResetTime > 0 && (min === 0 || g.nextResetTime < min)
        ? g.nextResetTime
        : min,
    0
  )
  // 有效期取最晚的一张：表示「这份额度最迟什么时候失效」
  const expiry = groups.reduce((max, g) => Math.max(max, g.endTime), 0)
  const { t } = useT()
  const [infoOpen, setInfoOpen] = React.useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          {t("ai.rewards.title")}
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
            title={t("ai.rewards.why")}
          >
            <Info className="h-4 w-4" />
          </button>
        </CardTitle>
        <CardDescription>{t("ai.rewards.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {groups.length === 0 ? (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("ai.rewards.empty")}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/donations?tab=invite">
                  <Gift className="h-4 w-4" />
                  {t("ai.rewards.invite")}
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/achievements">
                  <Trophy className="h-4 w-4" />
                  {t("ai.rewards.achievements")}
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("ai.todayLeft")}</span>
                <span className="font-medium">
                  {fmtAmount(remaining, symbol, perUnit)}
                  {" / "}
                  {fmtAmount(total, symbol, perUnit)}
                </span>
              </div>
              {/* 分段进度条：每段宽度 = 该套餐额度占比；段内左侧实色为剩余、右侧淡色为已用。
                  段与段之间留出间隙、各自独立圆角胶囊，一眼分清「哪个套餐还剩多少」。
                  悬停任意一段可看该套餐的额度 / 剩余 / 重置 / 有效期。 */}
              <TooltipProvider delayDuration={100}>
                <div className="mt-1.5 flex h-2.5 w-full gap-1">
                  {groups.map((g, i) => {
                    const c = SEGMENT_COLORS[i % SEGMENT_COLORS.length]
                    const planRemaining = Math.max(0, g.amountTotal - g.amountUsed)
                    return (
                      <Tooltip key={g.planId}>
                        <TooltipTrigger asChild>
                          <div
                            className={`relative h-full overflow-hidden rounded-full ${c.faded}`}
                            style={{ flexGrow: g.amountTotal, flexBasis: 0 }}
                          >
                            <div
                              className={`absolute inset-y-0 left-0 rounded-full ${c.solid}`}
                              style={{
                                width: `${(planRemaining / g.amountTotal) * 100}%`,
                              }}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="font-medium">{g.title}</p>
                          <p>
                            {t("ai.quotaLine", { total: fmtAmount(g.amountTotal, symbol, perUnit) })}{" "}
                            {fmtAmount(planRemaining, symbol, perUnit)}
                          </p>
                          {g.count > 1 && <p>{t("ai.subCount", { n: g.count })}</p>}
                          <p>{t("ai.nextResetAt", { time: formatResetTime(g.nextResetTime) })}</p>
                          <p>{t("ai.validUntil", { date: formatExpiry(g.endTime) })}</p>
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              </TooltipProvider>
              {/* 图例：颜色 ↔ 套餐，不悬停也能对上号 */}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {groups.map((g, i) => (
                  <span
                    key={g.planId}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        SEGMENT_COLORS[i % SEGMENT_COLORS.length].solid
                      }`}
                    />
                    {g.title}
                    <span className="text-muted-foreground/70">{t("ai.left")}</span>
                    <span className="tabular-nums">
                      {fmtAmount(Math.max(0, g.amountTotal - g.amountUsed), symbol, perUnit)}
                    </span>
                    {g.count > 1 && <span>{t("ai.cardsSuffix", { n: g.count })}</span>}
                  </span>
                ))}
              </div>
            </div>
            {/* 下次重置：各套餐可能不同（邀请每天、成就每周），时间不同则分别列出 */}
            {groups.length <= 1 ||
            groups.every((g) => g.nextResetTime === groups[0].nextResetTime) ? (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("ai.nextReset")}</span>
                <span className="font-medium tabular-nums">
                  {formatResetTime(nextReset)}
                </span>
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.planId} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("ai.resetOf", { title: g.title })}</span>
                  <span className="font-medium tabular-nums">
                    {formatResetTime(g.nextResetTime)}
                  </span>
                </div>
              ))
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("ai.validUntilLabel")}</span>
              <span className="font-medium tabular-nums">{formatExpiry(expiry)}</span>
            </div>
            <Separator />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/donations?tab=invite">
                  <Gift className="h-4 w-4" />
                  {t("ai.rewards.invite")}
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/achievements">
                  <Trophy className="h-4 w-4" />
                  {t("ai.rewards.achievements")}
                </Link>
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* 其他订阅的说明弹窗 */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ai.rewards.why")}</DialogTitle>
            <DialogDescription>
              {t("ai.dialog.rewards.intro")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <p className="font-medium text-foreground">{t("ai.dialog.invite.title")}</p>
              <p className="text-muted-foreground">
                {t("ai.dialog.invite.desc")}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>{t("ai.dialog.invite.wb")}</li>
                <li>{t("ai.dialog.invite.channel")}</li>
              </ul>
              <p className="text-xs text-muted-foreground">{t("ai.dialog.invite.once")}</p>
            </div>
            <div className="space-y-1.5">
              <p className="font-medium text-foreground">{t("ai.dialog.ach.title")}</p>
              <p className="text-muted-foreground">
                {t("ai.dialog.ach.desc")}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("ai.dialog.resetNote")}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default function AiPage() {
  const { t } = useT()
  const navigate = useNavigate()
  const [status, setStatus] = React.useState<NewApiStatus | null>(null)
  const [keys, setKeys] = React.useState<NewApiKey[]>([])
  /**
   * Key 列表单独一个加载态：它要额外去上游拉「每个 Key 所属分组」（慢），
   * **不能让它拖住整页首屏** —— 页面主体只等 status，Key 卡片自己转骨架。
   */
  const [keysLoading, setKeysLoading] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [deletingKeyId, setDeletingKeyId] = React.useState<string | null>(null)
  /** 正在「取回完整 Key 并复制」的行 id（现取现复制，本地不留明文） */
  const [revealingKeyId, setRevealingKeyId] = React.useState<string | null>(null)
  /** 订阅下次重置的倒计时文案（每秒刷新） */
  const [resetCountdown, setResetCountdown] = React.useState<string | null>(null)

  // 开通
  const [bindOpen, setBindOpen] = React.useState(false)
  const [preflight, setPreflight] = React.useState<NewApiPreflight | null>(null)
  const [preflightLoading, setPreflightLoading] = React.useState(false)
  const [password, setPassword] = React.useState("")
  /** OAuth 授权弹窗引用（用于轮询期间检查是否被关闭） */
  const oauthPopupRef = React.useRef<Window | null>(null)
  /** 是否正在等待用户在弹窗里完成授权 */
  const [awaitingOAuth, setAwaitingOAuth] = React.useState(false)

  // 新建 Key
  const [keyOpen, setKeyOpen] = React.useState(false)
  const [keyName, setKeyName] = React.useState("")
  /**
   * 新建 Key 选的分组。空串 = 用服务端给的默认（站点分组）。
   * 捐献模型在独立分组里，只有选了那个分组的 Key 才调得到 —— 见 status.keyGroups。
   */
  const [keyGroup, setKeyGroup] = React.useState("")
  /** 建 Key 可选的分组（服务端下发，别在前端写死分组名） */
  const keyGroups = status?.keyGroups ?? []
  /** 捐献模型所在的分组名 */
  const donationGroup = status?.donationGroup ?? "donation"
  /** 全部模型清单默认折叠：推荐分档已给出选择建议，完整清单是查漏用途 */
  const [modelsOpen, setModelsOpen] = React.useState(false)
  /**
   * 全部模型清单（懒加载）。**不在首屏拉** —— 上游返回全量模型很慢且无缓存，
   * 原先内联在 /dev/status 里会把整个页面拖住好几秒。只有用户展开下面那张
   * 「全部可用模型」卡片时才请求。
   */
  const [modelCatalog, setModelCatalog] = React.useState<NewApiModels | null>(null)
  const [modelsLoading, setModelsLoading] = React.useState(false)
  const [modelsError, setModelsError] = React.useState(false)

  // 兑换码
  const [redeemCode, setRedeemCode] = React.useState("")
  const [redeemBusy, setRedeemBusy] = React.useState(false)
  const [subscribing, setSubscribing] = React.useState(false)

  // 改中转站密码
  const [aiPwOpen, setAiPwOpen] = React.useState(false)
  const [aiPw, setAiPw] = React.useState({ current: "", next: "", confirm: "" })
  const [aiPwBusy, setAiPwBusy] = React.useState(false)
  /** 创建后弹窗里展示的完整 key（本地只保留到弹窗关闭；之后可在列表中随时再复制） */
  const [createdKey, setCreatedKey] = React.useState<string | null>(null)

  /** 拉取状态与 Key 列表；silent 用于对话框流程中刷新，避免整页 loading 卸载弹窗 */
  // 无权限（403 FEATURE_NOT_PERMITTED）：整页显示提示 + 捐献入口
  const [locked, setLocked] = React.useState(false)

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await newapiApi.status()
      setStatus(res)
      // ⚠️ 首屏只等 status！`listKeys` 会额外去上游拉每个 Key 的分组（慢，
      // 实测出现过几十秒），以前是 await 在这里 ⇒ 整页骨架一直转到它回来。
      // 现在先放行渲染，Key 列表在自己的卡片里单独转骨架。
      if (!silent) setLoading(false)
      if (res.account) {
        // silent 刷新（建 Key / 同步后的回调）不切成骨架，保持旧列表可见，
        // 免得弹窗流程里表格闪一下
        if (!silent) setKeysLoading(true)
        try {
          const k = await newapiApi.listKeys()
          setKeys(k.keys)
        } finally {
          if (!silent) setKeysLoading(false)
        }
      } else {
        setKeys([])
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
        setLocked(true)
        return
      }
      toast.error(err instanceof HttpError ? err.message : t("ai.err.load"))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /**
   * 拉「全部可用模型」清单（懒加载）。已加载过就直接复用，不重复请求；
   * 失败时只标记错误、不弹 toast 打断 —— 页面上会显示「加载失败 + 重试」。
   */
  const loadModels = React.useCallback(async () => {
    if (modelCatalog || modelsLoading) return // 已有清单 / 正在拉，不重复请求
    setModelsLoading(true)
    setModelsError(false)
    try {
      setModelCatalog(await newapiApi.models())
    } catch {
      setModelsError(true)
    } finally {
      setModelsLoading(false)
    }
  }, [modelCatalog, modelsLoading])

  /** 展开/收起模型清单；展开时若还没拉过就顺手拉一次 */
  const toggleModels = React.useCallback(() => {
    setModelsOpen((open) => {
      const next = !open
      if (next) void loadModels()
      return next
    })
  }, [loadModels])

  // 订阅下次重置倒计时：每秒刷新
  React.useEffect(() => {
    const next = status?.subscription?.nextResetTime
    if (!next) {
      setResetCountdown(null)
      return
    }
    const tick = () => {
      const diff = next * 1000 - Date.now()
      if (diff <= 0) {
        setResetCountdown(t("ai.reset.soon"))
        return
      }
      const totalSec = Math.floor(diff / 1000)
      const h = Math.floor(totalSec / 3600)
      const m = Math.floor((totalSec % 3600) / 60)
      const s = totalSec % 60
      setResetCountdown(t("ai.reset.countdown", { h, m, s }))
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [status?.subscription?.nextResetTime, t])

  // 自动认领（account 存在但 bound=false）的用户：进入页面即强制弹出密码绑定，
  // 不允许直接使用界面。只触发一次，避免每次 status 变化都重复弹。
  const autoOpenedRef = React.useRef(false)
  React.useEffect(() => {
    if (!status || status.account?.bound !== false) return
    if (autoOpenedRef.current) return
    autoOpenedRef.current = true
    void openBind()
  }, [status])

  const copyText = async (text: string, label = t("common.copied")) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(label)
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  /** 用户 access token 失效（被 NewAPI 吊销/过期）→ 直接弹出输密码框重新绑定 */
  const handleTokenExpired = () => {
    toast.error(t("ai.err.tokenExpired"))
    // 用户已经 OIDC 绑定过（只是 token 失效），直接构造「已绑定」状态弹输密码框，
    // 不依赖 preflight 探测（探测若失败会把弹窗关掉，导致「没输入密码的地方」）。
    setPreflight({
      featureEnabled: true,
      username: "",
      exists: true,
      oidcBound: true,
      // 标记为「重新绑定」，弹窗文案改成「重新输入密码」，而非「开通」
      rebind: true,
    })
    setAwaitingOAuth(false)
    setPreflightLoading(false)
    setPassword("")
    setBindOpen(true)
  }

  /**
   * 统一的 NewAPI 操作报错处理：access token 失效 ⇒ 弹「重新输入密码」框；
   * 其余走普通 toast。
   *
   * ⚠️ 别再在各自的 catch 里「先判 USER_TOKEN_EXPIRED 再各自 toast」了 ——
   * 只要漏掉一处，用户就会看到「登录已失效，请重新输入密码绑定」却**找不到
   * 输入密码的地方**（2026-10-05 用户反馈）。所有 key 管理操作都必须走这里。
   */
  const reportAiError = (err: unknown, fallbackKey: string) => {
    if (err instanceof HttpError && err.code === "USER_TOKEN_EXPIRED") {
      handleTokenExpired()
      return
    }
    toast.error(err instanceof HttpError ? err.message : t(fallbackKey))
  }

  /**
   * 打开开通弹窗：先探测，若已 OIDC 绑定则直接进入「输密码」；
   * 否则自动弹窗让用户去中转站授权，并轮询等待授权完成。
   */
  const openBind = async () => {
    setPreflightLoading(true)
    setBindOpen(true)
    try {
      const p = await newapiApi.preflight()
      setPreflight(p)
      if (p.oidcBound) {
        // 已经授权过了，直接进输密码步骤
        setAwaitingOAuth(false)
      } else {
        startOAuthPopup()
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("ai.err.unreachable"))
      setBindOpen(false)
    } finally {
      setPreflightLoading(false)
    }
  }

  /** 打开中转站授权弹窗，并开始轮询等待 oidc 绑定完成 */
  const startOAuthPopup = () => {
    setAwaitingOAuth(true)
    // 打开中转站登录页（用户在里面点「用 Doulor Cloud 登录」）
    // 弹窗不能直接跳我们的 /oauth/authorize —— state 由 NewAPI 生成，
    // 必须让它自己发起 OAuth 流程。
    const w = window.open("https://api.doulor.cn/sign-in", "doulor_oauth", "width=480,height=680")
    oauthPopupRef.current = w
    pollOAuth()
  }

  /**
   * 轮询检测中转站账号是否已通过 OIDC 绑定。
   * 一旦 oidcBound 变 true，自动切到「输入密码」步骤。
   * 弹窗被用户关掉则停止轮询（提示用户可手动重试）。
   */
  const pollOAuth = async () => {
    for (let i = 0; i < 40; i++) {
      // 弹窗被关了就不再轮询（除非已经绑定成功）
      const popup = oauthPopupRef.current
      if (popup && popup.closed) {
        // 弹窗关了，做最后一次检查：可能刚好授权完成
        try {
          const p = await newapiApi.preflight()
          if (p.oidcBound) {
            setPreflight(p)
            setAwaitingOAuth(false)
            return
          }
        } catch {
          /* ignore */
        }
        setAwaitingOAuth(false)
        toast.info(t("ai.info.windowClosed"))
        return
      }

      try {
        const p = await newapiApi.preflight()
        if (p.oidcBound) {
          // 授权完成：尝试关闭弹窗，然后自动切到「输入密码」步骤
          try {
            popup?.close()
          } catch {
            /* 跨域关闭可能失败，忽略 —— 用户可手动关弹窗 */
          }
          oauthPopupRef.current = null
          setPreflight(p)
          setAwaitingOAuth(false)
          return
        }
      } catch {
        /* 轮询失败静默，下一轮再试 */
      }

      // 每 2 秒轮询一次，最多 80 秒
      await new Promise((r) => setTimeout(r, 2000))
    }
    setAwaitingOAuth(false)
  }

  const handleBind = async () => {
    // 复用 cloud 密码，只输入一次
    if (password.length < 8) {
      toast.error(t("ai.err.enterPassword"))
      return
    }
    setBusy(true)
    try {
      const res = await newapiApi.bind(password)
      toast.success(
        Boolean(res.account?.rebind) ? t("ai.ok.rebound") : t("ai.ok.activated")
      )
      setBindOpen(false)
      setPassword("")
      // 静默刷新：非静默会整页 loading，把弹窗和错误提示一起卸载掉
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("ai.err.activate"))
    } finally {
      setBusy(false)
    }
  }

  const handleSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await newapiApi.sync()
      await load(true)
      toast.success(t("ai.ok.synced"))
    } catch (err) {
      reportAiError(err, "ai.err.sync")
    } finally {
      setSyncing(false)
    }
  }

  const handleCreateKey = async () => {
    setBusy(true)
    try {
      const res = await newapiApi.createKey(keyName, keyGroup || undefined)
      setCreatedKey(res.key.fullKey)
      setKeyName("")
      // 静默刷新列表，不能让整页 loading 卸载掉展示完整 Key 的弹窗
      await load(true)
    } catch (err) {
      if (err instanceof HttpError && err.code === "SUBSCRIPTION_REQUIRED") {
        toast.error(t("ai.err.claimFirst"))
        return
      }
      reportAiError(err, "ai.err.create")
    } finally {
      setBusy(false)
    }
  }

  const handleRedeem = async () => {
    if (!redeemCode.trim()) return
    setRedeemBusy(true)
    try {
      const res = await newapiApi.redeem(redeemCode.trim())
      toast.success(
        t("ai.ok.redeemed", { symbol: res.currencySymbol, amount: res.addedDisplay })
      )
      setRedeemCode("")
      await load(true)
    } catch (err) {
      reportAiError(err, "ai.err.redeem")
    } finally {
      setRedeemBusy(false)
    }
  }

  const handleSubscribe = async () => {
    setSubscribing(true)
    try {
      const res = await newapiApi.subscribe()
      toast.success(res.message || t("ai.ok.freeClaimed"))
      await load(true)
    } catch (err) {
      reportAiError(err, "ai.err.claim")
    } finally {
      setSubscribing(false)
    }
  }

  const handleAiPassword = async () => {
    if (aiPw.next !== aiPw.confirm) {
      toast.error(t("ai.err.passwordMismatch"))
      return
    }
    setAiPwBusy(true)
    try {
      await newapiApi.changePassword({
        currentPassword: aiPw.current,
        newPassword: aiPw.next,
      })
      toast.success(t("ai.ok.passwordChanged"))
      setAiPwOpen(false)
      setAiPw({ current: "", next: "", confirm: "" })
    } catch (err) {
      reportAiError(err, "ai.err.update")
    } finally {
      setAiPwBusy(false)
    }
  }

  const handleDeleteKey = async (key: NewApiKey) => {
    if (deletingKeyId) return
    setDeletingKeyId(key.id)
    try {
      await newapiApi.removeKey(key.id)
      toast.success(t("ai.ok.keyDeleted"))
      await load(true)
    } catch (err) {
      reportAiError(err, "ai.err.delete")
    } finally {
      setDeletingKeyId(null)
    }
  }

  /**
   * 复制完整 Key —— 从服务端现取现复制，本地不缓存明文。
   * 原先「完整 Key 只在创建时显示一次」，用户没存下来就只能删了重建；
   * 现在列表里随时可复制（取回失败/登录失效都走统一错误处理）。
   */
  const handleCopyKey = async (key: NewApiKey) => {
    if (revealingKeyId) return
    setRevealingKeyId(key.id)
    try {
      const res = await newapiApi.revealKey(key.id)
      await copyText(res.key, t("ai.key.copied"))
    } catch (err) {
      reportAiError(err, "ai.err.copy")
    } finally {
      setRevealingKeyId(null)
    }
  }

  const handleSyncKeys = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const res = await newapiApi.syncKeys()
      setKeys(res.keys)
      toast.success(
        res.added > 0 ? t("ai.ok.keysSynced", { n: res.added }) : t("ai.ok.noNewKeys")
      )
    } catch (err) {
      reportAiError(err, "ai.err.sync")
    } finally {
      setSyncing(false)
    }
  }

  /**
   * 关闭「重新输入密码绑定」弹窗时的收尾。
   * 「未绑定」是有门槛的页面（用户还没完成绑定），关掉弹窗就离开本页回仪表盘
   * （沿用原行为）；**已绑定**用户只是 access token 失效来补密码，关掉后留在
   * 本页即可，不该被踢走。
   */
  const closeBindDialog = () => {
    setBindOpen(false)
    setPreflight(null)
    setPassword("")
    setAwaitingOAuth(false)
    if (!status?.account?.bound) navigate("/dashboard")
  }

  /**
   * 「重新输入密码绑定」弹窗。
   *
   * ⚠️ 2026-10-05 用户反馈「key 管理报登录失效，却没有输密码的弹窗」：
   * 该弹窗此前只挂在「未开通 / 未绑定」那个提前 return 分支里，已绑定用户
   * （正常使用中的绝大多数人）token 失效时 `handleTokenExpired()` 虽然把
   * `bindOpen` 置了 true，但组件根本没渲染 ⇒ 只弹报错、没有输入框。
   * 现在把它提出来，**未绑定与已绑定两条分支都渲染**。
   */
  const bindDialogEl = (
    <BindDialog
      open={bindOpen}
      onOpenChange={(o) => {
        setBindOpen(o)
        if (!o) closeBindDialog()
      }}
      preflight={preflight}
      preflightLoading={preflightLoading}
      awaitingOAuth={awaitingOAuth}
      password={password}
      setPassword={setPassword}
      busy={busy}
      onReopenOAuth={() => startOAuthPopup()}
      onConfirm={() => void handleBind()}
      onCancel={closeBindDialog}
    />
  )

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="ai"
        featureLabel={t("ai.title")}
        description={t("locked.desc", { feature: t("ai.title") })}
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={t("ai.title")} description={t("ai.subtitle")} />
        <FeatureCardsSkeleton />
      </div>
    )
  }

  if (!status?.configured) {
    return (
      <div>
        <PageHeader title={t("ai.title")} description={t("ai.subtitle")} />
        <EmptyState
          title={t("ai.notConfigured")}
          description={t("ai.notConfiguredDesc")}
        />
      </div>
    )
  }

  if (!status.featureEnabled) {
    return (
      <div>
        <PageHeader title={t("ai.title")} description={t("ai.subtitle")} />
        <EmptyState
          title={t("ai.disabled")}
          description={t("ai.disabledDesc")}
        />
      </div>
    )
  }

  // 未开通，或「自动认领了但还没绑密码」：都要求完成密码绑定，否则不允许进入。
  // 后者（account 存在但 bound=false）也需要走 BindDialog，只是文案用「补密码」。
  if (!status.account || !status.account.bound) {
    return (
      <div>
        <PageHeader
          title={t("ai.title")}
          description={t("ai.tagline")}
          actions={<HealthBadge health={status.health} />}
        />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              {status.account ? t("ai.bind.title") : t("ai.activate.title")}
            </CardTitle>
            <CardDescription>
              {status.account
                ? t("ai.bind.ready")
                : t("ai.activate.desc") + " " +
                  status.currencySymbol +
                  status.trialQuotaUsd +
                  "。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!status.account && (
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>{t("ai.activate.b1")}</li>
                <li>{t("ai.activate.b2")}</li>
                <li>{t("ai.activate.b3")}</li>
              </ul>
            )}
            <Button onClick={() => void openBind()}>
              <Sparkles className="h-4 w-4" />
              {status.account ? t("ai.bind.now") : t("ai.activate.now")}
            </Button>
          </CardContent>
        </Card>

        {bindDialogEl}
      </div>
    )
  }

  const account = status.account

  return (
    <div>
      <PageHeader
        title={t("ai.title")}
        description={t("ai.accountLine", { username: account.username, email: account.email })}
        actions={<HealthBadge health={status.health} />}
      />

      <div className="space-y-6">
        {/* 免费订阅 —— 放在最上：必须领订阅才能建 Key，是第一优先操作 */}
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              {t("ai.free.title")}
            </CardTitle>
            <CardDescription>
              {t("ai.free.mustClaim")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.subscription ? (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("ai.todayLeft")}</span>
                    <span className="font-medium">
                      {fmtAmount(
                        status.subscription.amountTotal -
                          status.subscription.amountUsed,
                        status.currencySymbol,
                        status.quotaPerUnit
                      )}
                      {" / "}
                      {fmtAmount(
                        status.subscription.amountTotal,
                        status.currencySymbol,
                        status.quotaPerUnit
                      )}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(
                            0,
                            ((status.subscription.amountTotal -
                              status.subscription.amountUsed) /
                              status.subscription.amountTotal) *
                              100
                          )
                        )}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("ai.nextReset")}</span>
                  <span className="font-medium tabular-nums">
                    {resetCountdown !== null ? resetCountdown : formatResetTime(status.subscription.nextResetTime)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("ai.validUntilLabel")}</span>
                  <span className="font-medium tabular-nums">
                    {formatExpiry(status.subscription.endTime)}
                  </span>
                </div>
                <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  {t("ai.free.rulesClaimed")}
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  {t("ai.free.rulesUnclaimed")}
                </div>
                <Button onClick={() => void handleSubscribe()} disabled={subscribing}>
                  {subscribing && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("ai.free.claim")}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* 其他订阅（邀请/成就等）—— 紧随免费订阅：额度叠加消费，放在一起才看得出总量 */}
        <RewardSubscriptionsCard
          groups={status.subscriptions.filter((s) => s.planId !== status.freePlanId)}
          symbol={status.currencySymbol}
          perUnit={status.quotaPerUnit}
        />

        {/* 接入信息：Base URL + API Key 管理融合在一起 —— 新用户第一件事就是"怎么用" */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("ai.access.title")}
            </CardTitle>
            <CardDescription>
              {t("ai.access.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Base URL</Label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value="https://api.doulor.cn/v1"
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    void copyText("https://api.doulor.cn/v1", t("ai.access.copied"))
                  }
                  title={t("common.copy")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <Separator />

            {/* API Key：创建与管理，与 Base URL 同卡 */}
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label>API Key</Label>
                <p className="text-xs text-muted-foreground">
                  {t("ai.key.hint")}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSyncKeys()}
                  disabled={syncing}
                >
                  {syncing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {t("ai.sync")}
                </Button>
                <Button size="sm" onClick={() => setKeyOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  {t("ai.key.new")}
                </Button>
              </div>
            </div>

            {keysLoading ? (
              <SkeletonTable rows={3} cols={5} />
            ) : keys.length === 0 ? (
              <EmptyState
                title={t("ai.key.empty")}
                description={t("ai.key.emptyDesc")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("ai.key.col.name")}</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>{t("ai.key.col.group")}</TableHead>
                    <TableHead>{t("ai.key.col.created")}</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-1.5">
                          <span>{k.name}</span>
                          {k.system && (
                            <Badge
                              variant="secondary"
                              className="gap-1 px-1.5 py-0 text-[10px] font-normal"
                              title={t("ai.key.systemHint")}
                            >
                              <Lock className="h-2.5 w-2.5" />
                              {t("ai.key.system")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <span>{k.maskedKey}</span>
                          {k.system ? (
                            // 系统 Key 不给复制：界面上不显示按钮，
                            // 后端 revealKey 也会拒绝（藏按钮挡不住直接调接口）
                            <span
                              className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground/60"
                              title={t("ai.key.systemHint")}
                            >
                              <Lock className="h-3.5 w-3.5" />
                            </span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => void handleCopyKey(k)}
                              disabled={revealingKeyId !== null}
                              title={t("ai.key.copy")}
                              aria-label={t("ai.key.copy")}
                            >
                              {revealingKeyId === k.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {/* 分组决定这个 Key 能调哪些模型（捐献模型在独立分组里） */}
                        <KeyGroupCell group={k.group} donationGroup={donationGroup} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(k.createdAt)}
                      </TableCell>
                      <TableCell>
                        {k.system ? (
                          <span
                            className="flex h-8 w-8 items-center justify-center text-muted-foreground/40"
                            title={t("ai.key.systemHint")}
                          >
                            <Lock className="h-4 w-4" />
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => void handleDeleteKey(k)}
                            disabled={deletingKeyId !== null}
                            title={t("common.delete")}
                          >
                            {deletingKeyId === k.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href="https://api.doulor.cn" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t("ai.goSite")}
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAiPwOpen(true)}
              >
                <KeyRound className="h-3.5 w-3.5" />
                {t("ai.pw.title")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("ai.goSite.desc")}
            </p>
          </CardContent>
        </Card>

        {/* 推荐模型：管理员在管理面板维护的分档，帮用户跳过"模型名一长串看不懂" */}
        {status.recommended.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                {t("ai.rec.title")}
              </CardTitle>
              <CardDescription>
                {t("ai.rec.desc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RecommendedModels
                tiers={status.recommended}
                onCopy={(m) => void copyText(m, t("ai.modelCopied", { model: m }))}
              />
            </CardContent>
          </Card>
        )}

        {/* 钱包余额 */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                  {t("ai.wallet.title")}
                </CardTitle>
                <CardDescription>
                  {t("ai.wallet.left", { symbol: status.currencySymbol })}
                  {account.quotaUsd.toFixed(4)}{t("ai.wallet.used", { symbol: status.currencySymbol })}
                  {account.usedUsd.toFixed(4)}{t("ai.wallet.requests", { n: account.requestCount })}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSync()}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t("ai.sync")}
              </Button>
            </div>
          </CardHeader>
          {account.syncedAt && (
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {t("ai.lastSync", { time: fmtTime(account.syncedAt) })}
                {account.group ? t("ai.groupSuffix", { group: account.group }) : ""}
              </p>
            </CardContent>
          )}
        </Card>

        {/* 全部模型：默认折叠。推荐分档已给出选择建议，完整清单是「查漏」用途。
            ⚠️ 清单是**懒加载**的：展开时才请求 /dev/models（上游拉全量模型很慢），
            首屏不再为它等待。 */}
        <Card>
          <CardHeader
            className="cursor-pointer select-none"
            onClick={toggleModels}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  {/* 清单没拉回来之前不知道有几种，就不显示计数，别先写个「0」 */}
                  {modelCatalog
                    ? t("ai.models.title", { n: modelCatalog.models.length })
                    : t("ai.models.titlePlain")}
                </CardTitle>
                <CardDescription>
                  {t("ai.models.desc")}
                </CardDescription>
              </div>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  modelsOpen ? "rotate-180" : ""
                }`}
              />
            </div>
          </CardHeader>
          {modelsOpen && (
            <CardContent className="space-y-4">
              {modelsLoading && !modelCatalog ? (
                <SkeletonList count={3} />
              ) : modelsError ? (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-muted-foreground">{t("ai.err.load")}</p>
                  <Button size="sm" variant="outline" onClick={() => void loadModels()}>
                    {t("common.retry")}
                  </Button>
                </div>
              ) : !modelCatalog || modelCatalog.models.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("ai.models.empty")}</p>
              ) : (
                modelCatalog.availableGroups.map((g) => {
                  const list = modelCatalog.groupModels[g] ?? []
                  if (list.length === 0) return null
                  // ⚠️ 分组名来自服务端（可在管理面板改），别在前端写死 "donation"
                  const isDonation = g === donationGroup
                  const label = isDonation ? t("ai.group.donation") : g === "default" ? t("ai.group.default") : g
                  return (
                    <div key={g} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t("ai.groupLabel", { group: label })}</span>
                        <Badge variant="secondary" className="text-xs">
                          {t("ai.modelCount", { n: list.length })}
                        </Badge>
                        {status.accountGroup === g && (
                          <Badge variant="success" className="text-xs">
                            {t("ai.currentAccount")}
                          </Badge>
                        )}
                        {/* 捐献分组必须点明「要用另一个分组的 Key」——
                            否则用户会拿 default 的 Key 去调，直接 403 报无权访问 */}
                        {isDonation && <KeyGroupNote donationGroup={donationGroup} />}
                      </div>
                      {/* 模型多的分组（捐献）会在内部再按厂商分小节；
                          十几个模型的分组保持平铺 —— 分厂反而是画蛇添足 */}
                      <ModelVendorSections
                        models={list}
                        onCopy={(m) => void copyText(m, t("ai.modelCopied", { model: m }))}
                      />
                    </div>
                  )
                })
              )}
            </CardContent>
          )}
        </Card>

        {/* 额度兑换 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift className="h-4 w-4 text-muted-foreground" />
              {t("ai.redeem.title")}
            </CardTitle>
            <CardDescription>
              {t("ai.redeem.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder={t("ai.redeem.placeholder")}
                value={redeemCode}
                onChange={(e) => setRedeemCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRedeem()
                }}
              />
              <Button
                onClick={() => void handleRedeem()}
                disabled={redeemBusy || !redeemCode.trim()}
              >
                {redeemBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("ai.redeem.btn")}
              </Button>
            </div>
          </CardContent>
        </Card>

      </div>

      {/* 新建 Key */}
      <Dialog
        open={keyOpen}
        onOpenChange={(open) => {
          setKeyOpen(open)
          if (!open) setCreatedKey(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ai.key.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {createdKey
                ? t("ai.key.saveHint")
                : t("ai.key.nameHint")}
            </DialogDescription>
          </DialogHeader>

          {createdKey ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={createdKey} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void copyText(createdKey, t("ai.key.copied"))}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                {t("ai.key.onceOnly")}
              </div>
            </div>
          ) : (
            <>
            <div className="space-y-2">
              <Label htmlFor="keyName">{t("ai.key.name")}</Label>
              <Input
                id="keyName"
                placeholder={t("ai.key.namePlaceholder")}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>
            <KeyGroupPicker
              keyGroups={keyGroups}
              donationGroup={donationGroup}
              value={keyGroup}
              onChange={setKeyGroup}
            />
            </>
          )}

          <DialogFooter>
            {createdKey ? (
              <Button onClick={() => setKeyOpen(false)}>{t("common.done")}</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setKeyOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={() => void handleCreateKey()} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("common.create")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改中转站密码 */}
      <Dialog
        open={aiPwOpen}
        onOpenChange={(open) => {
          setAiPwOpen(open)
          if (!open) setAiPw({ current: "", next: "", confirm: "" })
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ai.pw.title")}</DialogTitle>
            <DialogDescription>
              {t("ai.pw.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="aiPwCurrent">{t("settings.pw.current")}</Label>
              <Input
                id="aiPwCurrent"
                type="password"
                autoComplete="current-password"
                value={aiPw.current}
                onChange={(e) =>
                  setAiPw((f) => ({ ...f, current: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aiPwNext">{t("settings.pw.new")}</Label>
              <Input
                id="aiPwNext"
                type="password"
                autoComplete="new-password"
                value={aiPw.next}
                onChange={(e) => setAiPw((f) => ({ ...f, next: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">{t("settings.pw.atLeast8")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="aiPwConfirm">{t("settings.pw.confirm")}</Label>
              <Input
                id="aiPwConfirm"
                type="password"
                autoComplete="new-password"
                value={aiPw.confirm}
                onChange={(e) =>
                  setAiPw((f) => ({ ...f, confirm: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiPwOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleAiPassword()}
              disabled={
                aiPwBusy ||
                !aiPw.current ||
                aiPw.next.length < 8 ||
                aiPw.next !== aiPw.confirm
              }
            >
              {aiPwBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.saveChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* token 失效时「重新输入密码绑定」——已绑定用户也必须能弹出来 */}
      {bindDialogEl}
    </div>
  )
}

interface BindDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preflight: NewApiPreflight | null
  preflightLoading: boolean
  awaitingOAuth: boolean
  password: string
  setPassword: (v: string) => void
  busy: boolean
  onReopenOAuth: () => void
  onConfirm: () => void
  /** 点「{t("common.cancel")}」：关闭弹窗并跳回概览 */
  onCancel: () => void
}

function BindDialog({
  open,
  onOpenChange,
  preflight,
  preflightLoading,
  awaitingOAuth,
  password,
  setPassword,
  busy,
  onReopenOAuth,
  onConfirm,
  onCancel,
}: BindDialogProps) {
  const { t } = useT()
  // 探测尚未返回时不渲染表单，避免用户先填了再被告知流程不同
  const ready = !preflightLoading && preflight !== null
  const oidcBound = Boolean(preflight?.oidcBound)
  /** 是「重新绑定（刷新密码）」而非首次开通 —— 文案要区分，别对老用户说「开通」 */
  const rebind = Boolean(preflight?.rebind)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rebind ? t("ai.rebind.title") : t("ai.activate.title")}</DialogTitle>
          <DialogDescription>
            {!ready
              ? t("ai.activate.checkingAccount")
              : awaitingOAuth
                ? t("ai.activate.step2")
                : oidcBound
                  ? t(rebind ? "ai.rebind.desc" : "ai.activate.step3")
                  : t("ai.activate.needAccount")}
          </DialogDescription>
        </DialogHeader>

        {!ready ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("ai.activate.checking")}
          </div>
        ) : awaitingOAuth ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
              <div>{t("ai.activate.waiting")}</div>
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={onReopenOAuth}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t("ai.activate.reopen")}
            </Button>
          </div>
        ) : oidcBound ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="aiPassword">{t("ai.activate.passwordLabel")}</Label>
              <Input
                id="aiPassword"
                type="password"
                autoComplete="current-password"
                placeholder={t("ai.activate.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
              <p className="font-medium">
                {t("ai.activate.passwordNote.a")}
                <b>{t("ai.activate.passwordNote.bold")}</b>
                {t("ai.activate.passwordNote.b")}
              </p>
              <p className="mt-1 text-muted-foreground">{t("ai.activate.passwordNote.c")}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              {t("ai.activate.noAccountYet")}
            </div>
            <Button variant="outline" className="w-full" onClick={onReopenOAuth}>
              <ExternalLink className="h-4 w-4" />
              {t("ai.activate.goLogin")}
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          {oidcBound && !awaitingOAuth && (
            <Button
              onClick={onConfirm}
              disabled={busy || password.length < 8}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? t("ai.activate.processing") : t("ai.activate.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}