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
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
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
import type {
  NewApiHealth,
  NewApiKey,
  NewApiPreflight,
  NewApiStatus,
  NewApiSubscriptionGroup,
  RecommendedTier,
} from "@/types"

/** 中转站在线/离线徽章，含延迟与版本 */
function HealthBadge({ health }: { health?: NewApiHealth }) {
  if (!health) return null
  return (
    <div className="flex items-center gap-2">
      <Badge variant={health.online ? "success" : "destructive"} className="gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            health.online ? "bg-emerald-500" : "bg-destructive"
          }`}
        />
        {health.online ? "在线" : "离线"}
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
  return (
    <div className="space-y-1">
      {tiers.map((t, i) => {
        // 颜色随梯队递减：第一梯队最醒目，越往后越淡
        const tone =
          i === 0
            ? "border-primary/50 bg-primary/5"
            : i === 1
              ? "border-border bg-muted/40"
              : "border-border bg-muted/20"
        return (
          <React.Fragment key={`${t.tier}-${i}`}>
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
                <span className="text-sm font-semibold">{t.tier}</span>
                <Badge variant="secondary" className="text-xs">
                  {t.models.length} 个
                </Badge>
              </div>
              {t.desc && (
                <p className="mt-1.5 pl-7 text-xs text-muted-foreground">{t.desc}</p>
              )}
              <div className="mt-2.5 flex flex-wrap gap-1.5 pl-7">
                {t.models.map((m) => (
                  <Badge
                    key={m}
                    variant="outline"
                    className="cursor-pointer bg-background font-mono text-xs"
                    onClick={() => onCopy(m)}
                    title="点击复制模型名"
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
  if (isToday) return `今天 ${hhmm}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hhmm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
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
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
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
  const [infoOpen, setInfoOpen] = React.useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          其他订阅
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
            title="其他订阅是什么？"
          >
            <Info className="h-4 w-4" />
          </button>
        </CardTitle>
        <CardDescription>
          通过邀请好友、完成成就等获得的额外额度，与免费订阅叠加使用 ——
          消费时逐张接力，互不浪费。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {groups.length === 0 ? (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              还没有额外订阅额度。邀请好友捐献 AI 渠道、绑定 WorkBuddy 账号，
              或完成成就积累成就点，都能获得额外额度。
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/donations?tab=invite">
                  <Gift className="h-4 w-4" />
                  去邀请好友
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/achievements">
                  <Trophy className="h-4 w-4" />
                  去完成成就
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">今日剩余额度</span>
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
                            额度 {fmtAmount(g.amountTotal, symbol, perUnit)} · 剩余{" "}
                            {fmtAmount(planRemaining, symbol, perUnit)}
                          </p>
                          {g.count > 1 && <p>共 {g.count} 张订阅</p>}
                          <p>下次重置 {formatResetTime(g.nextResetTime)}</p>
                          <p>有效期至 {formatExpiry(g.endTime)}</p>
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
                    <span className="text-muted-foreground/70">剩</span>
                    <span className="tabular-nums">
                      {fmtAmount(Math.max(0, g.amountTotal - g.amountUsed), symbol, perUnit)}
                    </span>
                    {g.count > 1 && <span>· {g.count} 张</span>}
                  </span>
                ))}
              </div>
            </div>
            {/* 下次重置：各套餐可能不同（邀请每天、成就每周），时间不同则分别列出 */}
            {groups.length <= 1 ||
            groups.every((g) => g.nextResetTime === groups[0].nextResetTime) ? (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">下次重置</span>
                <span className="font-medium tabular-nums">
                  {formatResetTime(nextReset)}
                </span>
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.planId} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{g.title} 重置</span>
                  <span className="font-medium tabular-nums">
                    {formatResetTime(g.nextResetTime)}
                  </span>
                </div>
              ))
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">有效期至</span>
              <span className="font-medium tabular-nums">{formatExpiry(expiry)}</span>
            </div>
            <Separator />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/donations?tab=invite">
                  <Gift className="h-4 w-4" />
                  去邀请好友
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/achievements">
                  <Trophy className="h-4 w-4" />
                  去完成成就
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
            <DialogTitle>其他订阅是什么？</DialogTitle>
            <DialogDescription>
              除免费订阅外，你还能通过以下方式获得额外额度，与免费订阅叠加使用。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <p className="font-medium text-foreground">邀请好友</p>
              <p className="text-muted-foreground">
                好友用你的邀请码注册，并解锁 AI 中转站后，你获得对应奖励：
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>绑定 WorkBuddy 反代账号 → 「wb邀请套餐」每天 ¥500</li>
                <li>捐献 AI 渠道 / 商汤 Key 并通过审核 → 「邀请套餐」每天 ¥200</li>
              </ul>
              <p className="text-xs text-muted-foreground">每个好友只计一次奖励。</p>
            </div>
            <div className="space-y-1.5">
              <p className="font-medium text-foreground">成就奖励</p>
              <p className="text-muted-foreground">
                每积累 10 点成就点，自动获得一份「成就奖励」订阅。
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              以上额度的重置周期可能不同（邀请通常每天重置、成就可能每周重置），
              以卡片上各套餐标注的重置时间为准。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default function AiPage() {
  const navigate = useNavigate()
  const [status, setStatus] = React.useState<NewApiStatus | null>(null)
  const [keys, setKeys] = React.useState<NewApiKey[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [deletingKeyId, setDeletingKeyId] = React.useState<string | null>(null)
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
  /** 全部模型清单默认折叠：推荐分档已给出选择建议，完整清单是查漏用途 */
  const [modelsOpen, setModelsOpen] = React.useState(false)

  // 兑换码
  const [redeemCode, setRedeemCode] = React.useState("")
  const [redeemBusy, setRedeemBusy] = React.useState(false)
  const [subscribing, setSubscribing] = React.useState(false)

  // 改中转站密码
  const [aiPwOpen, setAiPwOpen] = React.useState(false)
  const [aiPw, setAiPw] = React.useState({ current: "", next: "", confirm: "" })
  const [aiPwBusy, setAiPwBusy] = React.useState(false)
  /** 完整 key 只在创建时展示一次，不落库 */
  const [createdKey, setCreatedKey] = React.useState<string | null>(null)

  /** 拉取状态与 Key 列表；silent 用于对话框流程中刷新，避免整页 loading 卸载弹窗 */
  // 无权限（403 FEATURE_NOT_PERMITTED）：整页显示提示 + 捐献入口
  const [locked, setLocked] = React.useState(false)

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await newapiApi.status()
      setStatus(res)
      if (res.account) {
        const k = await newapiApi.listKeys()
        setKeys(k.keys)
      } else {
        setKeys([])
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
        setLocked(true)
        return
      }
      toast.error(err instanceof HttpError ? err.message : "加载失败")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

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
        setResetCountdown("即将重置")
        return
      }
      const totalSec = Math.floor(diff / 1000)
      const h = Math.floor(totalSec / 3600)
      const m = Math.floor((totalSec % 3600) / 60)
      const s = totalSec % 60
      setResetCountdown(`${h} 小时 ${m} 分 ${s} 秒`)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [status?.subscription?.nextResetTime])

  // 自动认领（account 存在但 bound=false）的用户：进入页面即强制弹出密码绑定，
  // 不允许直接使用界面。只触发一次，避免每次 status 变化都重复弹。
  const autoOpenedRef = React.useRef(false)
  React.useEffect(() => {
    if (!status || status.account?.bound !== false) return
    if (autoOpenedRef.current) return
    autoOpenedRef.current = true
    void openBind()
  }, [status])

  const copyText = async (text: string, label = "已复制") => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(label)
    } catch {
      toast.error("复制失败，请手动选择复制")
    }
  }

  /** 用户 access token 失效（被 NewAPI 吊销/过期）→ 直接弹出输密码框重新绑定 */
  const handleTokenExpired = () => {
    toast.error("你的中转站登录已失效，请重新输入密码绑定")
    // 用户已经 OIDC 绑定过（只是 token 失效），直接构造「已绑定」状态弹输密码框，
    // 不依赖 preflight 探测（探测若失败会把弹窗关掉，导致「没输入密码的地方」）。
    setPreflight({
      featureEnabled: true,
      username: "",
      exists: true,
      oidcBound: true,
    })
    setAwaitingOAuth(false)
    setPreflightLoading(false)
    setPassword("")
    setBindOpen(true)
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
      toast.error(err instanceof HttpError ? err.message : "无法连接中转站")
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
        toast.info("已关闭授权窗口。可点「重新打开」再次授权。")
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
      toast.error("请输入你的 Doulor Cloud 登录密码")
      return
    }
    setBusy(true)
    try {
      await newapiApi.bind(password)
      toast.success("AI 中转站已开通")
      setBindOpen(false)
      setPassword("")
      // 静默刷新：非静默会整页 loading，把弹窗和错误提示一起卸载掉
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "开通失败")
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
      toast.success("已同步额度")
    } catch (err) {
      if (err instanceof HttpError && err.code === "USER_TOKEN_EXPIRED") {
        handleTokenExpired()
        return
      }
      toast.error(err instanceof HttpError ? err.message : "同步失败")
    } finally {
      setSyncing(false)
    }
  }

  const handleCreateKey = async () => {
    setBusy(true)
    try {
      const res = await newapiApi.createKey(keyName)
      setCreatedKey(res.key.fullKey)
      setKeyName("")
      // 静默刷新列表，不能让整页 loading 卸载掉展示完整 Key 的弹窗
      await load(true)
    } catch (err) {
      if (err instanceof HttpError && err.code === "USER_TOKEN_EXPIRED") {
        handleTokenExpired()
        return
      }
      if (err instanceof HttpError && err.code === "SUBSCRIPTION_REQUIRED") {
        toast.error("请先领取免费订阅，再创建 API Key")
        return
      }
      toast.error(err instanceof HttpError ? err.message : "创建失败")
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
        `兑换成功：+${res.currencySymbol}${res.addedDisplay}`
      )
      setRedeemCode("")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "兑换失败")
    } finally {
      setRedeemBusy(false)
    }
  }

  const handleSubscribe = async () => {
    setSubscribing(true)
    try {
      const res = await newapiApi.subscribe()
      toast.success(res.message || "已领取免费订阅")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "领取失败")
    } finally {
      setSubscribing(false)
    }
  }

  const handleAiPassword = async () => {
    if (aiPw.next !== aiPw.confirm) {
      toast.error("两次输入的新密码不一致")
      return
    }
    setAiPwBusy(true)
    try {
      await newapiApi.changePassword({
        currentPassword: aiPw.current,
        newPassword: aiPw.next,
      })
      toast.success("中转站密码已修改")
      setAiPwOpen(false)
      setAiPw({ current: "", next: "", confirm: "" })
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "修改失败")
    } finally {
      setAiPwBusy(false)
    }
  }

  const handleDeleteKey = async (key: NewApiKey) => {
    if (deletingKeyId) return
    setDeletingKeyId(key.id)
    try {
      await newapiApi.removeKey(key.id)
      toast.success("Key 已删除")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setDeletingKeyId(null)
    }
  }

  const handleSyncKeys = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const res = await newapiApi.syncKeys()
      setKeys(res.keys)
      toast.success(
        res.added > 0 ? `已同步 ${res.added} 个 Key` : "没有新的 Key"
      )
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "同步失败")
    } finally {
      setSyncing(false)
    }
  }

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="ai"
        featureLabel="AI 中转站"
        description="你的账号未被授予「AI 中转站」权限。站长资源有限，该服务暂未全量开放。"
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="AI 中转站" description="NewAPI 集成" />
        <LoadingBlock />
      </div>
    )
  }

  if (!status?.configured) {
    return (
      <div>
        <PageHeader title="AI 中转站" description="NewAPI 集成" />
        <EmptyState
          title="AI 中转站尚未配置"
          description="管理员还未配置 NewAPI 凭据，请稍后再试。"
        />
      </div>
    )
  }

  if (!status.featureEnabled) {
    return (
      <div>
        <PageHeader title="AI 中转站" description="NewAPI 集成" />
        <EmptyState
          title="功能已关闭"
          description="管理员暂时关闭了 AI 中转站功能。"
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
          title="AI 中转站"
          description="统一的大模型 API 入口"
          actions={<HealthBadge health={status.health} />}
        />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              {status.account ? "完成密码绑定" : "开通 AI 中转站"}
            </CardTitle>
            <CardDescription>
              {status.account
                ? "你的中转站账号已就绪，输入 Doulor Cloud 密码完成绑定后即可使用。"
                : "用你的 Doulor Cloud 账号登录中转站，附赠试用额度 " +
                  status.currencySymbol +
                  status.trialQuotaUsd +
                  "。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!status.account && (
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>· 用 Doulor Cloud 账号登录中转站，无需单独注册</li>
                <li>· 开通时复用你的 Doulor Cloud 登录密码</li>
                <li>· 开通后可查看可用模型并自助创建 API Key</li>
              </ul>
            )}
            <Button onClick={() => void openBind()}>
              <Sparkles className="h-4 w-4" />
              {status.account ? "立即绑定" : "立即开通"}
            </Button>
          </CardContent>
        </Card>

        <BindDialog
          open={bindOpen}
          onOpenChange={(o) => {
            setBindOpen(o)
            if (!o) {
              setPreflight(null)
              setPassword("")
              setAwaitingOAuth(false)
              navigate("/dashboard")
            }
          }}
          preflight={preflight}
          preflightLoading={preflightLoading}
          awaitingOAuth={awaitingOAuth}
          password={password}
          setPassword={setPassword}
          busy={busy}
          onReopenOAuth={() => startOAuthPopup()}
          onConfirm={() => void handleBind()}
          onCancel={() => {
            setBindOpen(false)
            setPreflight(null)
            setPassword("")
            setAwaitingOAuth(false)
            navigate("/dashboard")
          }}
        />
      </div>
    )
  }

  const account = status.account

  return (
    <div>
      <PageHeader
        title="AI 中转站"
        description={`账号 ${account.username} · ${account.email}`}
        actions={<HealthBadge health={status.health} />}
      />

      <div className="space-y-6">
        {/* 免费订阅 —— 放在最上：必须领订阅才能建 Key，是第一优先操作 */}
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              免费订阅
            </CardTitle>
            <CardDescription>
              必须先领取免费订阅，才能创建 API Key 并调用模型。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.subscription ? (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">今日剩余额度</span>
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
                  <span className="text-muted-foreground">下次重置</span>
                  <span className="font-medium tabular-nums">
                    {resetCountdown !== null ? resetCountdown : formatResetTime(status.subscription.nextResetTime)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">有效期至</span>
                  <span className="font-medium tabular-nums">
                    {formatExpiry(status.subscription.endTime)}
                  </span>
                </div>
                <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  订阅规则：免费订阅每天自动发放额度（默认 ¥1000，按次计费、每次 ¥1），
                  当天额度用完则需等次日重置。额度长期有效，持续到订阅到期。
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  订阅规则：领取免费订阅后，每天自动发放额度（默认 ¥1000），
                  按次计费、每次调用扣 ¥1。未领取订阅将无法创建 Key 和调用模型。
                </div>
                <Button onClick={() => void handleSubscribe()} disabled={subscribing}>
                  {subscribing && <Loader2 className="h-4 w-4 animate-spin" />}
                  领取免费订阅
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
              接入信息
            </CardTitle>
            <CardDescription>
              在任意 OpenAI 兼容客户端中填入 Base URL 与 API Key 即可使用。
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
                    void copyText("https://api.doulor.cn/v1", "Base URL 已复制")
                  }
                  title="复制"
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
                  用于调用 OpenAI 兼容接口，完整 Key 只在创建时显示一次。
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
                  同步
                </Button>
                <Button size="sm" onClick={() => setKeyOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  新建 Key
                </Button>
              </div>
            </div>

            {keys.length === 0 ? (
              <EmptyState
                title="还没有 API Key"
                description="创建一个 Key 即可开始调用模型。"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="text-sm">{k.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {k.maskedKey}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(k.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteKey(k)}
                          disabled={deletingKeyId !== null}
                          title="删除"
                        >
                          {deletingKeyId === k.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
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
                  前往中转站本站
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAiPwOpen(true)}
              >
                <KeyRound className="h-3.5 w-3.5" />
                修改中转站密码
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              充值、渠道、日志等复杂操作请前往中转站本站完成。
            </p>
          </CardContent>
        </Card>

        {/* 推荐模型：管理员在管理面板维护的分档，帮用户跳过"模型名一长串看不懂" */}
        {status.recommended.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                推荐模型
              </CardTitle>
              <CardDescription>
                按综合能力与稳定性分档，从上到下依次递减。点击模型名可复制。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RecommendedModels
                tiers={status.recommended}
                onCopy={(m) => void copyText(m, `已复制模型名 ${m}`)}
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
                  钱包余额
                </CardTitle>
                <CardDescription>
                  剩余 {status.currencySymbol}
                  {account.quotaUsd.toFixed(4)} · 已用 {status.currencySymbol}
                  {account.usedUsd.toFixed(4)} · 请求 {account.requestCount} 次
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
                同步
              </Button>
            </div>
          </CardHeader>
          {account.syncedAt && (
            <CardContent>
              <p className="text-xs text-muted-foreground">
                最后同步：{fmtTime(account.syncedAt)}
                {account.group ? ` · 分组 ${account.group}` : ""}
              </p>
            </CardContent>
          )}
        </Card>

        {/* 全部模型：默认折叠。推荐分档已给出选择建议，完整清单是「查漏」用途 */}
        <Card>
          <CardHeader
            className="cursor-pointer select-none"
            onClick={() => setModelsOpen((v) => !v)}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  全部可用模型（{status.models.length}）
                </CardTitle>
                <CardDescription>
                  按分组分类显示，点击模型名可复制。不同分组的计费与可用渠道不同。
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
              {status.models.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无可用模型</p>
              ) : (
                status.availableGroups.map((g) => {
                  const list = status.groupModels[g] ?? []
                  if (list.length === 0) return null
                  const label = g === "donation" ? "捐献" : g === "default" ? "默认" : g
                  return (
                    <div key={g} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{label} 分组</span>
                        <Badge variant="secondary" className="text-xs">
                          {list.length} 个模型
                        </Badge>
                        {status.accountGroup === g && (
                          <Badge variant="success" className="text-xs">
                            当前账号
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {list.map((m) => (
                          <Badge
                            key={`${g}-${m}`}
                            variant="outline"
                            className="cursor-pointer font-mono text-xs"
                            onClick={() => void copyText(m, `已复制模型名 ${m}`)}
                          >
                            {m}
                          </Badge>
                        ))}
                      </div>
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
              兑换码充值
            </CardTitle>
            <CardDescription>
              输入兑换码（邀请码）为你的中转站额度充值。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="输入兑换码"
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
                兑换
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
            <DialogTitle>新建 API Key</DialogTitle>
            <DialogDescription>
              {createdKey
                ? "请立即复制保存，关闭后无法再次查看完整 Key。"
                : "给这个 Key 起个名字，便于日后分辨用途。"}
            </DialogDescription>
          </DialogHeader>

          {createdKey ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={createdKey} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void copyText(createdKey, "API Key 已复制")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                完整 Key 仅此一次显示，服务端不保存，请务必现在复制。
              </div>
            </div>
          ) : (
            <>
            <div className="space-y-2">
              <Label htmlFor="keyName">名称</Label>
              <Input
                id="keyName"
                placeholder="例如 chatbox、my-script"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              该 Key 固定属于 <span className="font-medium text-foreground">default（免费）</span> 分组，
              额度来自你的免费订阅每日发放。付费分组需联系管理员单独开通。
            </div>
            </>
          )}

          <DialogFooter>
            {createdKey ? (
              <Button onClick={() => setKeyOpen(false)}>完成</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setKeyOpen(false)}>
                  取消
                </Button>
                <Button onClick={() => void handleCreateKey()} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  创建
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
            <DialogTitle>修改中转站密码</DialogTitle>
            <DialogDescription>
              需要当前密码验证；修改后不影响已创建的 API Key。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="aiPwCurrent">当前密码</Label>
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
              <Label htmlFor="aiPwNext">新密码</Label>
              <Input
                id="aiPwNext"
                type="password"
                autoComplete="new-password"
                value={aiPw.next}
                onChange={(e) => setAiPw((f) => ({ ...f, next: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">至少 8 位</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="aiPwConfirm">确认新密码</Label>
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
              取消
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
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  /** 点「取消」：关闭弹窗并跳回概览 */
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
  // 探测尚未返回时不渲染表单，避免用户先填了再被告知流程不同
  const ready = !preflightLoading && preflight !== null
  const oidcBound = Boolean(preflight?.oidcBound)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>开通 AI 中转站</DialogTitle>
          <DialogDescription>
            {!ready
              ? "正在检查中转站账号…"
              : awaitingOAuth
                ? "请在打开的窗口里用 Doulor Cloud 登录，完成后这里会自动继续。"
                : oidcBound
                  ? "中转站账号已就绪，输入你的 Doulor Cloud 密码即可完成开通。"
                  : "需要先到中转站用 Doulor Cloud 登录创建账号。"}
          </DialogDescription>
        </DialogHeader>

        {!ready ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在检查…
          </div>
        ) : awaitingOAuth ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
              <div>
                正在等待授权完成… 在弹出窗口里点「用 Doulor Cloud 登录」并允许后，
                本页会自动继续，无需手动操作。
              </div>
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={onReopenOAuth}>
              <ExternalLink className="h-3.5 w-3.5" />
              没看到窗口？重新打开
            </Button>
          </div>
        ) : oidcBound ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="aiPassword">你的 Doulor Cloud 登录密码</Label>
              <Input
                id="aiPassword"
                type="password"
                autoComplete="current-password"
                placeholder="输入你登录 Doulor Cloud 时用的那个密码（不是新设密码）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
              <p className="font-medium">
                这里填的是你<b>已经在用的 Doulor Cloud 密码</b>，不是让你新设一个。
              </p>
              <p className="mt-1 text-muted-foreground">
                系统会验证它，然后同步为你中转站账号的密码，之后两边共用同一个密码。
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              中转站里还没有用 Doulor Cloud 登录创建的账号。
            </div>
            <Button variant="outline" className="w-full" onClick={onReopenOAuth}>
              <ExternalLink className="h-4 w-4" />
              前往中转站登录
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          {oidcBound && !awaitingOAuth && (
            <Button
              onClick={onConfirm}
              disabled={busy || password.length < 8}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? "处理中…" : "开通"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}