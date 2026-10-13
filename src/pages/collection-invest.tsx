import * as React from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Loader2, TrendingDown, TrendingUp } from "lucide-react"
import { toast } from "sonner"

import { CandleChart } from "@/components/candle-chart"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SkeletonCards } from "@/components/skeletons"
import { useAuth } from "@/hooks/use-auth"
import { localeOf, useT } from "@/i18n"
import { setVisibleInterval } from "@/lib/visible-interval"
import { cn } from "@/lib/utils"
import { isAdminRole } from "@/components/collection-nav"
import {
  HttpError,
  investApi,
  errMsg,
  type GameCandle,
  type GameLeaderItem,
  type GamePosition,
  type GameState,
  type GameTrade,
} from "@/services/api"

/**
 * 造物典藏 ·「在线投资」—— 游戏本体（全屏插件形态）。
 *
 * 几条实现上的约定：
 *
 * 1. **轮询 `/state` 就是「让行情走」**。服务端每次读行情都会把 tick 补到当前时刻
 *    并顺手强平，所以前端不需要（也没有）单独的「推进」接口。间隔 3 秒：比 5 秒的
 *    tick 略密一点，操作后能立刻看到结果，又不会把 Worker 请求额度打满
 *    （`setVisibleInterval` 保证切走标签页就停）。
 *
 * 2. **K 线只在「跨了一根」时重拉**。`/state` 里带着正在走的那根（`market.candle`），
 *    前端把它拼在历史后面 —— 所以每秒刷新的只有价格，不需要反复传输 300 根历史。
 *
 * 3. **预估爆仓价 / 手续费在前端算**，公式与 `worker/src/game-engine.ts` 的
 *    `liquidationPrice` / `computeFee` **必须一致**。真正权威的数值始终来自
 *    服务端的下单响应（`entry_price` / `liq_price` 都是服务端算好存下来的）；
 *    前端这份只用于下单前的预览。⚠️ 改公式时两边一起改。
 *
 * 4. 全屏：用负边距突破站点的 `max-w-6xl` 内边距，视觉上「这就是一个游戏」，
 *    而不是「站点里的一个页面」。
 */

/** 与 worker/src/game-engine.ts 的 computeFee 同口径（最小 1 积分） */
function estimateFee(notional: number, bps: number): number {
  if (notional <= 0 || bps <= 0) return 0
  return Math.max(1, Math.round((notional * bps) / 10_000))
}

/**
 * 数字格式化（模块级，供主页面与 TradeRow 共用）。
 *
 * ⚠️ 原来是主组件内部的三个闭包（`nf` 依赖 locale），TradeRow 抽成独立组件后
 *    就看不见它们了 —— 所以把实现提到模块级、locale 走参数，
 *    主组件里保留同名薄封装，避免改动几十处调用点。
 */
function formatNum(v: number, locale: string, digits = 0): string {
  return Number.isFinite(v)
    ? v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "—"
}

/** 价格：大数留 2 位、个位数留 3 位、小于 1 留 4 位（K 线上也是这个口径） */
function formatPrice(v: number): string {
  return !Number.isFinite(v) ? "—" : v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4)
}

function formatSigned(v: number, locale: string): string {
  return v > 0 ? `+${formatNum(v, locale)}` : formatNum(v, locale)
}

/**
 * 杠杆显示。
 *
 * 单笔开仓时杠杆是整数（5x）；但加仓合并后记的是**有效杠杆** = 名义/保证金，
 * 可能是 6.25 这种带小数的值（两笔不同杠杆加在一起）—— 那也必须如实显示，
 * 因为它就是爆仓价的推导依据。
 */
function formatLeverage(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "1"
  return Math.abs(v - Math.round(v)) < 0.005
    ? String(Math.round(v))
    : v.toFixed(2).replace(/\.?0+$/, "")
}
const MIN_DEPTH = 100

/**
 * 预估**成交价**：买入成交在「被自己推高后」的价、卖出成交在「被自己压低后」的价。
 *
 * ⚠️ 这一条必须与服务端的 `orderImpactBps` + `applyOrderImpact` 保持一致，
 *    否则面板上显示的预估爆仓价会比真实值差一截（用户的止损线是被真实成交价决定的）。
 *    服务端的权威值仍然来自下单响应里的 `position.entryPrice`。
 */
function estimateFillPrice(
  side: "long" | "short",
  price: number,
  size: number,
  pool: number,
  impactBps: number,
  maxImpactBps: number
): number {
  const signed = side === "long" ? size : -size
  const depth = Math.max(pool, MIN_DEPTH)
  const raw = (impactBps * signed) / depth
  const bps = Math.max(-maxImpactBps, Math.min(maxImpactBps, raw))
  return price * (1 + bps / 10_000)
}

/**
 * 盈亏平衡价：**扣掉全部手续费之后**回到不赚不亏的那个平仓价。
 *
 * 推导（与服务端 settlePosition 同口径）：
 *   到账 credit = 保证金 + 盈亏 − 平仓手续费；令 credit = 保证金 ⇒ 盈亏 = 平仓手续费。
 *   而 盈亏 = size × (exit − entry) / entry（空单取负）。
 *   ⇒ exit = entry × (1 ± (开仓手续费 + 平仓手续费) / size)
 *
 * ⚠️ 手续费必须用服务端的 `computeFee` 口径（最小 1 积分、四舍五入），
 *    否则小额仓位的平衡价会差出可见的几分钱。
 */
function estimateBreakEven(
  side: "long" | "short",
  entryPrice: number,
  size: number,
  fees: number
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || size <= 0) return entryPrice
  const ratio = Math.max(0, fees) / size
  const p = side === "long" ? entryPrice * (1 + ratio) : entryPrice * (1 - ratio)
  return p < 0.01 ? 0.01 : p
}

/**
 * 与 worker/src/game-engine.ts 的 `crossLiqPrice` 同口径（全仓）。
 *
 * 全仓的强平价把**可用余额**也算进缓冲：buffer = 保证金 + 余额 − 维持保证金。
 * ⚠️ 它只是「本仓估算值」：全仓真正的判据是账户级的（权益 < 维持保证金总和），
 *    多仓/对冲时以服务端为准（服务端每次 /state 都会实时算好下发）。
 */
function estimateCrossLiq(
  side: "long" | "short",
  entry: number,
  size: number,
  margin: number,
  balance: number,
  mmBps: number
): number {
  if (size <= 0 || entry <= 0) return 0
  const buffer = margin + Math.max(0, balance) - (size * mmBps) / 10_000
  if (buffer <= 0) return side === "long" ? 0.01 : 1_000_000
  const ratio = buffer / size
  const p = side === "long" ? entry * (1 - ratio) : entry * (1 + ratio)
  return p < 0.01 ? 0.01 : p
}

/** 与 worker/src/game-engine.ts 的 liquidationPrice 同口径（逐仓） */
function estimateLiq(side: "long" | "short", entry: number, leverage: number, mmBps: number): number {  const ratio = 1 / Math.max(1, leverage) - mmBps / 10_000
  const p = side === "long" ? entry * (1 - ratio) : entry * (1 + ratio)
  return p < 0.01 ? 0.01 : p
}

export default function CollectionInvestPage() {
  const { t, lang } = useT()
  const { user } = useAuth()
  const locale = localeOf(lang)

  const [state, setState] = React.useState<GameState | null>(null)
  const [candles, setCandles] = React.useState<GameCandle[]>([])
  const [interval, setIntervalId] = React.useState("1m")
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)

  // 下单表单
  const [side, setSide] = React.useState<"long" | "short">("long")
  /**
   * 保证金模式：逐仓（默认）/ 全仓。
   *
   * 默认逐仓是**刻意的**：逐仓亏损上限就是这一笔保证金，最坏情况一目了然；
   * 全仓会让整份可用余额为仓位担保，风险大得多，必须是用户主动选的。
   */
  const [marginMode, setMarginMode] = React.useState<"isolated" | "cross">("isolated")
  const [leverage, setLeverage] = React.useState(5)
  const [margin, setMargin] = React.useState("100")
  const [busy, setBusy] = React.useState(false)
  const [closingId, setClosingId] = React.useState<string | null>(null)

  // 下方标签页
  const [tab, setTab] = React.useState<"trades" | "board">("trades")
  const [trades, setTrades] = React.useState<GameTrade[]>([])
  const [board, setBoard] = React.useState<GameLeaderItem[]>([])
  const [boardMe, setBoardMe] = React.useState<{ rank: number; profit: number; trades: number } | null>(null)
  const [range, setRange] = React.useState<"today" | "week" | "all">("today")

  /** 上一次拉 K 线的 (candleOpenAt, interval)：两者任一变了才重拉 */
  const lastFetch = React.useRef({ at: "", interval: "" })
  const aliveRef = React.useRef(true)

  const loadCandles = React.useCallback(
    async (iv: string) => {
      const res = await investApi.candles(iv, 300)
      if (aliveRef.current) setCandles(res.candles ?? [])
      return res
    },
    []
  )

  const refreshSide = React.useCallback(async () => {
    const [hist, lb] = await Promise.all([investApi.history(50), investApi.leaderboard(range)])
    if (!aliveRef.current) return
    setTrades(hist.trades ?? [])
    setBoard(lb.items ?? [])
    setBoardMe(lb.me)
  }, [range])

  // ---- 状态轮询（同时驱动行情的推进与强平）----
  React.useEffect(() => {
    aliveRef.current = true
    const tick = async () => {
      try {
        const s = await investApi.state()
        if (!aliveRef.current) return
        setState(s)
        setFailed(false)

        if (s.liquidatedInThisPoll > 0) {
          toast.warning(
            t("inv.liquidatedToast").replace("{n}", String(s.liquidatedInThisPoll))
          )
        }

        // 跨了 K 线边界（或切换了周期）才重拉历史
        const cur = lastFetch.current
        if (s.market.candle.openAt !== cur.at || interval !== cur.interval) {
          lastFetch.current = { at: s.market.candle.openAt, interval }
          await loadCandles(interval)
        }
      } catch {
        if (aliveRef.current) setFailed(true)
      } finally {
        if (aliveRef.current) setLoading(false)
      }
    }
    void tick()
    const stop = setVisibleInterval(() => void tick(), 3000)
    return () => {
      aliveRef.current = false
      stop()
    }
  }, [interval, loadCandles, t])

  // ---- 交易记录 / 排行榜（只在看的时候拉，不必跟着 3 秒轮询）----
  React.useEffect(() => {
    let alive = true
    if (tab === "trades") {
      investApi
        .history(50)
        .then((r) => {
          if (alive) setTrades(r.trades ?? [])
        })
        .catch(() => {
          /* 记录拉不到不影响交易，静默 */
        })
    } else {
      investApi
        .leaderboard(range)
        .then((r) => {
          if (alive) {
            setBoard(r.items ?? [])
            setBoardMe(r.me)
          }
        })
        .catch(() => {
          /* 同上 */
        })
    }
    return () => {
      alive = false
    }
  }, [tab, range, state?.me.balance])

  // ---- 下单预览 ----
  const price = state?.market.price ?? 0
  const cfg = state?.config
  const balance = state?.me.balance ?? 0
  /**
   * ⚠️ 当前货币名（积分 / 测试币）。
   * 页面上**所有**「积分」字样都必须走它 —— 写死的话，切到测试币模式后
   * 用户会以为自己在拿真积分下单（这是最不能出现的一种误导）。
   */
  const coin = t(state?.currency === "test" ? "inv.coin.test" : "inv.coin.points")

  /** 领取测试币（每人一次）。领完直接就地更新余额，不再多打一次接口。 */
  const claimTest = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await investApi.claimTest()
      if (res.granted > 0) {
        toast.success(t("inv.claimTestDone").replace("{n}", nf(res.granted)))
      }
      setState((prev) =>
        prev
          ? { ...prev, canClaimTest: false, me: { ...prev.me, balance: res.balance } }
          : prev
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("col.loadFailedDesc"))
    } finally {
      setBusy(false)
    }
  }
  const marginNum = Math.max(0, Math.floor(Number(margin) || 0))
  const size = marginNum * leverage
  const fee = cfg ? estimateFee(size, cfg.feeOpenBps) : 0
  /**
   * 预估成交价（含自己的冲击）与由它推出的爆仓价。
   * 用户看到的必须是**成交价**，不是盘口价 —— 否则杠杆一高，
   * 面板上显示的爆仓价与实际止损线能差出好几个百分点。
   */
  const pool = state?.pool.balance ?? 0
  const fillPrice = cfg
    ? estimateFillPrice(side, price, size, pool, cfg.impactBps, cfg.maxImpactBps)
    : price
  const liq = cfg
    ? marginMode === "cross"
      ? estimateCrossLiq(side, fillPrice, size, marginNum, balance, cfg.maintenanceBps)
      : estimateLiq(side, fillPrice, leverage, cfg.maintenanceBps)
    : 0
  /** 爆仓距离（%）：价格反向走这么多就爆 */
  const liqDistance = fillPrice > 0 && liq > 0 ? Math.abs((fillPrice - liq) / fillPrice) * 100 : 0
  const riskWarn = leverage >= 10

  const nf = (v: number, digits = 0) => formatNum(v, locale, digits)
  const pf = formatPrice
  const signed = (v: number) => formatSigned(v, locale)

  const doOpen = async () => {
    if (!cfg) return
    if (marginNum < cfg.minMargin) {
      toast.error(t("inv.badInput"))
      return
    }
    setBusy(true)
    try {
      const res = await investApi.open({
        side,
        leverage,
        margin: marginNum,
        marginMode,
        // 幂等键：网络重试不会开出两个仓
        orderNo: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      })
      if (!res.duplicated) toast.success(t("inv.opened"))

      // 先把余额落到界面上（万一下面的刷新失败，用户至少看得到钱扣了）。
      // ⚠️ 刷新必须各自 try/catch：开仓**已经成功**了，
      //    不能因为「刷新那一下网络抖动」就弹「开仓失败」——
      //    那会让用户以为没开成，然后重复下单。
      setState((prev) => (prev ? { ...prev, me: { ...prev.me, balance: res.balance } } : prev))
      try {
        const fresh = await investApi.state()
        if (aliveRef.current) setState(fresh)
      } catch {
        /* 下一次轮询会补上 */
      }
      try {
        await refreshSide()
      } catch {
        /* 记录稍后再看 */
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "INSUFFICIENT_POINTS") {
        toast.error(t("inv.insufficient"))
      } else {
        toast.error(errMsg(err, t("inv.openFailed")))
      }
    } finally {
      setBusy(false)
    }
  }

  const doClose = async (p: GamePosition) => {
    setClosingId(p.id)
    try {
      const res = await investApi.close(p.id)
      if (res.alreadyClosed) {
        toast.info(t("inv.alreadyClosed"))
      } else if (res.capped) {
        // 「赚了但没赔满」必须说清楚，否则用户会以为算错了
        toast.warning(
          `${t("inv.closed")} ${t("inv.profit")} ${signed(res.pnl)} · ${t("inv.capped")}`
        )
      } else {
        toast.success(`${t("inv.closed")} ${t("inv.profit")} ${signed(res.pnl)}`)
      }
      setState((prev) => (prev ? { ...prev, me: { ...prev.me, balance: res.balance } } : prev))
      try {
        const fresh = await investApi.state()
        if (aliveRef.current) setState(fresh)
      } catch {
        /* 下一次轮询会补上 */
      }
      try {
        await refreshSide()
      } catch {
        /* 记录稍后再看 */
      }
    } catch (err) {
      toast.error(errMsg(err, t("inv.closeFailed")))
    } finally {
      setClosingId(null)
    }
  }

  const maxMargin = React.useMemo(() => {
    if (!cfg) return 0
    return Math.max(0, Math.floor(balance / (1 + cfg.feeOpenBps / 10_000)))
  }, [balance, cfg])

  /**
   * 把流水按仓位配成「一轮来回」：一条记录 = 一次开仓 + 一次平仓。
   *
   * 为什么要在前端配：`game_trades` 里开仓与平仓是两行（金额口径完全不同 ——
   * 开仓行只有保证金与手续费、pnl 恒为 0；平仓行才有真实盈亏），
   * 分开显示时用户看到「只写了保证金」的那一行根本不知道赚亏了多少。
   * 配起来之后一条横排就能讲完整：左边开仓、右边平仓、最右边盈亏。
   *
   * 配对键是 `positionId`（服务端 `game_trades.position_id`）：一次开仓只有一条
   * open 流水，对应最多一条 close/liquidate 流水 —— 所以一个分组就是一轮。
   * 顺序沿用流水的时间倒序（`trades` 本身就是倒序），没有平仓的排在最前面
   * （它们就是当前持仓，用户最关心）。
   */
  const roundTrips = React.useMemo<RoundTrip[]>(() => {
    const byPosition = new Map<string, RoundTrip>()
    const order: string[] = []
    for (const tr of trades) {
      const key = tr.positionId || tr.id
      let rt = byPosition.get(key)
      if (!rt) {
        rt = { key, positionId: tr.positionId, opens: [], closed: null }
        byPosition.set(key, rt)
        order.push(key)
      }
      // kind === "open" 是开仓那一腿（加仓会有多条），其余（close / liquidate）是平仓那一腿
      if (tr.kind === "open") {
        rt.opens.push(tr)
      } else if (!rt.closed) {
        rt.closed = tr
      }
    }
    // ⚠️ /history 是时间**倒序**返回的，opens 会被倒着收集 ——
    //    要按时间正序排一下，否则「第一笔开仓时间」与「加权均价」的展示会反。
    for (const rt of byPosition.values()) {
      rt.opens.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    }
    return order.map((k) => byPosition.get(k) as RoundTrip)
  }, [trades])

  /** 空状态/加载中：给一个带返回链接的骨架，别让用户以为页面坏了 */
  if (loading && !state) {
    return (
      <div className="-mx-4 space-y-4 lg:-mx-8">
        <BackBar />
        <SkeletonCards count={3} />
      </div>
    )
  }

  if (!state) {
    return (
      <div className="-mx-4 lg:-mx-8">
        <BackBar />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <p className="text-sm font-medium">{t("col.loadFailed")}</p>
            <p className="text-xs text-muted-foreground">{t("col.loadFailedDesc")}</p>
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
              {t("col.retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!state.enabled) {
    return (
      <div className="-mx-4 lg:-mx-8">
        <BackBar />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <span className="text-4xl">📈</span>
            <p className="text-base font-medium">{t("inv.disabled")}</p>
            <p className="max-w-md text-xs text-muted-foreground">{t("inv.disabledDesc")}</p>
            {isAdminRole(user?.role) && (
              <Button asChild size="sm" variant="secondary">
                <Link to="/dashboard/gallery/collection/settings">{t("inv.goSettings")}</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  const up = state.market.change24hPct >= 0
  const poolEmpty = !state.pool.canOpen

  return (
    <div className="-mx-4 space-y-4 lg:-mx-8">
      <BackBar />

      {/* ---- 顶栏：价格 / 涨跌 / 对手盘 ---- */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-1">
        <div className="flex items-end gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold tracking-tight">
                {state.market.symbol}
              </span>
              <Badge variant="secondary" className="font-normal">
                {t("inv.subtitle")}
              </Badge>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className={cn(
                  "text-3xl font-semibold tabular-nums tracking-tight",
                  up ? "text-emerald-500" : "text-rose-500"
                )}
              >
                {pf(state.market.price)}
              </span>
              <span className="text-xs text-muted-foreground">{state.market.quote}</span>
              <span
                className={cn(
                  "flex items-center gap-0.5 text-sm tabular-nums",
                  up ? "text-emerald-500" : "text-rose-500"
                )}
              >
                {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {up ? "+" : ""}
                {state.market.change24hPct.toFixed(2)}%
              </span>
            </div>
          </div>
          <div className="hidden gap-4 pb-1 text-xs text-muted-foreground sm:flex">
            <span>
              {t("inv.dayHigh")} <span className="tabular-nums">{pf(state.market.dayHigh)}</span>
            </span>
            <span>
              {t("inv.dayLow")} <span className="tabular-nums">{pf(state.market.dayLow)}</span>
            </span>
          </div>
        </div>

        <div className="flex items-end gap-6">
          {/* 鼠标悬停给出「对手盘的钱是哪来的」—— 这句话很长，放在顶栏会撑破布局 */}
          <div className="text-right" title={t("inv.poolHint")}>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
              {t("inv.pool")}
            </p>
            <p className="text-lg font-medium tabular-nums">{nf(state.pool.balance)}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("inv.maxPayout").replace("{n}", nf(state.pool.maxPayout))}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
              {t("inv.balance").replace("{n}", coin)}
            </p>
            <p className="text-lg font-medium tabular-nums">{nf(balance)}</p>
            {state.canClaimTest && (
              <button
                type="button"
                onClick={() => void claimTest()}
                disabled={busy}
                title={t("inv.claimTestHint")}
                className="mt-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50"
              >
                {t("inv.claimTest").replace("{n}", nf(state.testGrant))}
              </button>
            )}
            {state.me.unrealizedTotal !== 0 && (
              <p
                className={cn(
                  "text-[11px] tabular-nums",
                  state.me.unrealizedTotal > 0 ? "text-emerald-500" : "text-rose-500"
                )}
              >
                {t("inv.unrealized")} {signed(state.me.unrealizedTotal)}
              </p>
            )}
          </div>
        </div>
      </div>

      {failed && (
        <p className="px-1 text-xs text-amber-600 dark:text-amber-400">
          {t("col.loadFailedDesc")}
        </p>
      )}

      {/* ---- 主区：K 线 + 下单面板 ---- */}
      <div className="flex flex-col gap-4 xl:flex-row">
        <Card className="min-w-0 flex-1 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex items-center gap-1">
              {(["1m", "5m", "15m"] as const).map((iv) => (
                <button
                  key={iv}
                  type="button"
                  onClick={() => setIntervalId(iv)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs tabular-nums transition-colors",
                    interval === iv
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  {iv}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-4" style={{ background: "#f59e0b" }} />
                MA5
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-4" style={{ background: "#6366f1" }} />
                MA20
              </span>
              {/* 交互提示放在图例旁边：滚轮/拖动这些操作不看提示基本猜不到 */}
              <span className="hidden sm:inline">{t("inv.chartHint")}</span>
            </div>
          </div>
          <div className="h-[400px] p-1">
            <CandleChart
              candles={candles}
              live={state.market.candle}
              positions={state.me.positions.map((p) => ({
                side: p.side,
                entryPrice: p.entryPrice,
                liqPrice: p.liqPrice,
              }))}
              emptyText={t("inv.chartEmpty")}
            />
          </div>
        </Card>

        {/* 下单面板 */}
        <Card className="w-full shrink-0 xl:w-[330px]">
          <CardContent className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSide("long")}
                className={cn(
                  "rounded-xl border py-2.5 text-sm font-medium transition-all",
                  side === "long"
                    ? "border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "border-border text-muted-foreground hover:bg-accent/60"
                )}
              >
                {t("inv.sideLong")}
              </button>
              <button
                type="button"
                onClick={() => setSide("short")}
                className={cn(
                  "rounded-xl border py-2.5 text-sm font-medium transition-all",
                  side === "short"
                    ? "border-rose-500 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                    : "border-border text-muted-foreground hover:bg-accent/60"
                )}
              >
                {t("inv.sideShort")}
              </button>
            </div>

            {/*
              保证金模式：逐仓 / 全仓。
              用两个并排的小按钮（不是开关）—— 它决定的是**爆仓时会不会动到余额**，
              这种事必须一眼看清自己选的是哪个，开关的「开/关」表达不了这层区别。
            */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t("inv.marginMode")}</Label>
                <span
                  className={cn(
                    "text-[11px]",
                    marginMode === "cross" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                  )}
                >
                  {marginMode === "cross" ? t("inv.modeCrossHint") : t("inv.modeIsolatedHint")}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(["isolated", "cross"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMarginMode(m)}
                    title={m === "cross" ? t("inv.modeCrossDesc") : t("inv.modeIsolatedDesc")}
                    className={cn(
                      "rounded-lg border py-1.5 text-xs font-medium transition-all",
                      marginMode === m
                        ? "border-foreground/40 bg-accent text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent/60"
                    )}
                  >
                    {m === "isolated" ? t("inv.modeIsolated") : t("inv.modeCross")}
                  </button>
                ))}
              </div>
              {marginMode === "cross" && (
                <p className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                  {t("inv.modeCrossWarn")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t("inv.leverage")}</Label>
                <span className="text-sm font-medium tabular-nums">{leverage}x</span>
              </div>
              <input
                type="range"
                min={1}
                max={cfg?.maxLeverage ?? 20}
                step={1}
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-full accent-foreground"
              />
              <div className="flex gap-1.5">
                {[1, 5, 10, 20]
                  .filter((v) => v <= (cfg?.maxLeverage ?? 20))
                  .map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setLeverage(v)}
                      className={cn(
                        "flex-1 rounded-md border py-1 text-xs tabular-nums transition-colors",
                        leverage === v
                          ? "border-foreground/30 bg-accent font-medium"
                          : "text-muted-foreground hover:bg-accent/60"
                      )}
                    >
                      {v}x
                    </button>
                  ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs" htmlFor="inv-margin">
                  {t("inv.margin")}
                </Label>
                <span className="text-[11px] text-muted-foreground">
                  {t("inv.available").replace("{n}", nf(balance))}
                </span>
              </div>
              <Input
                id="inv-margin"
                inputMode="numeric"
                value={margin}
                onChange={(e) => setMargin(e.target.value.replace(/[^0-9]/g, ""))}
                className="tabular-nums"
              />
              <div className="flex gap-1.5">
                {[0.25, 0.5, 0.75, 1].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setMargin(String(Math.floor(maxMargin * r)))}
                    className="flex-1 rounded-md border py-1 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent/60"
                  >
                    {r === 1 ? "MAX" : `${r * 100}%`}
                  </button>
                ))}
              </div>
            </div>

            {/* 预览：成交价 / 名义规模 / 手续费 / 爆仓价 */}
            <div className="space-y-1 rounded-lg bg-muted/40 p-2.5 text-xs">
              <Row label={t("inv.estEntry")} value={pf(fillPrice)} tone={side} />
              <Row label={t("inv.size")} value={`${nf(size)} ${state.market.quote}`} />
              <Row label={t("inv.feeShort")} value={nf(fee)} />
              <Row label={t("inv.liqShort")} value={pf(liq)} tone={side} />
            </div>

            {riskWarn && (
              <p className="rounded-lg bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                {t("inv.riskWarn")
                  .replace("{n}", String(leverage))
                  .replace("{p}", liqDistance.toFixed(1))}
              </p>
            )}

            {poolEmpty && (
              <p className="rounded-lg bg-rose-500/10 p-2 text-[11px] text-rose-600 dark:text-rose-400">
                {t("inv.poolEmpty")}
              </p>
            )}

            <Button
              className={cn(
                "w-full",
                side === "long"
                  ? "bg-emerald-600 text-white hover:bg-emerald-600/90"
                  : "bg-rose-600 text-white hover:bg-rose-600/90"
              )}
              // 开仓要扣「保证金 + 手续费」，所以门槛是两者的和 —— 只看保证金的话，
              // 余额刚好等于保证金时点下去会被服务端拒（体验上像「按钮骗人」）
              disabled={busy || poolEmpty || marginNum + fee > balance || marginNum < (cfg?.minMargin ?? 1)}
              onClick={() => void doOpen()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {side === "long" ? t("inv.openLong") : t("inv.openShort")} {leverage}x
            </Button>

            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("inv.hintFee")}</p>
          </CardContent>
        </Card>
      </div>

      {/* ---- 持仓 ---- */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-medium">{t("inv.positions")}</p>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("inv.unrealized")} {signed(state.me.unrealizedTotal)}
          </span>
        </div>
        <CardContent className="p-0">
          {/*
            全仓账户条：只在有全仓仓位时出现。
            全仓的强平判据是账户级的，单看某一行的「爆仓价」讲不清风险 ——
            这里直接把「权益 vs 维持保证金」和「触发时会从余额追缴多少」摊开。
          */}
          {state.cross.positions > 0 && (
            <div
              className={cn(
                "border-b px-4 py-2.5 text-xs",
                state.cross.equity < state.cross.maintenance * 1.5
                  ? "bg-amber-500/10"
                  : "bg-muted/30"
              )}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  {t("inv.crossAccount")}
                </span>
                <span className="text-muted-foreground">
                  {t("inv.crossEquity")}{" "}
                  <span className="tabular-nums text-foreground">{nf(state.cross.equity)}</span>
                </span>
                <span className="text-muted-foreground">
                  {t("inv.crossMaintenance")}{" "}
                  <span className="tabular-nums text-foreground">{nf(state.cross.maintenance)}</span>
                </span>
                <span className="text-muted-foreground">
                  {t("inv.crossEscrow")}{" "}
                  <span className="tabular-nums text-foreground">{nf(state.cross.escrow)}</span>
                </span>
                <span className="text-muted-foreground">
                  {t("inv.crossShortfall")}{" "}
                  <span className="tabular-nums text-amber-600 dark:text-amber-400">
                    {nf(state.cross.shortfall)}
                  </span>
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
                {t("inv.crossExplain")}
              </p>
            </div>
          )}
          {state.me.positions.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">{t("inv.noPositions")}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{t("inv.noPositionsDesc")}</p>
            </div>
          ) : (
            <div className="divide-y">
              {state.me.positions.map((p) => (
                <PositionRow
                  key={p.id}
                  p={p}
                  feeCloseBps={state.config.feeCloseBps}
                  busy={closingId === p.id}
                  onClose={() => void doClose(p)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- 记录 / 榜 ---- */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <div className="flex items-center gap-1">
            {(["trades", "board"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm transition-colors",
                  tab === k
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
              >
                {k === "trades" ? t("inv.trades") : t("inv.leaderboard")}
              </button>
            ))}
          </div>
          {tab === "board" && (
            <div className="flex items-center gap-1">
              {(["today", "week", "all"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs transition-colors",
                    range === r
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/60"
                  )}
                >
                  {t(`inv.range.${r}`)}
                </button>
              ))}
            </div>
          )}
        </div>
        <CardContent className="p-0">
          {tab === "trades" ? (
            roundTrips.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t("inv.noTrades")}
              </p>
            ) : (
              <div className="divide-y">
                {roundTrips.map((rt) => (
                  <TradeRow
                    key={rt.key}
                    rt={rt}
                    feeCloseBps={state.config.feeCloseBps}
                    live={state.me.positions.find((p) => p.id === rt.positionId)}
                  />
                ))}
              </div>
            )
          ) : board.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t("inv.leaderboardEmpty")}
            </p>
          ) : (
            <div className="divide-y">
              {board.map((it) => (
                <div
                  key={it.username}
                  className={cn(
                    "flex items-center justify-between gap-3 px-4 py-2 text-sm",
                    it.isMe && "bg-accent/40"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {it.rank}
                    </span>
                    <span className="truncate">{it.nickname || it.username}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-4 tabular-nums">
                    <span className="text-xs text-muted-foreground">
                      {it.trades} {t("inv.tradeCount")}
                    </span>
                    <span
                      className={cn(
                        "font-medium",
                        it.profit >= 0 ? "text-emerald-500" : "text-rose-500"
                      )}
                    >
                      {signed(it.profit)}
                    </span>
                  </span>
                </div>
              ))}
              {boardMe && !board.some((b) => b.isMe) && (
                <div className="flex items-center justify-between gap-3 bg-accent/40 px-4 py-2 text-sm">
                  <span className="text-muted-foreground">
                    {t("inv.myRank").replace("{n}", String(boardMe.rank))}
                  </span>
                  <span
                    className={cn("font-medium", boardMe.profit >= 0 ? "text-emerald-500" : "text-rose-500")}
                  >
                    {signed(boardMe.profit)}
                  </span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="px-1 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        {t("inv.hintFlow")}
      </p>

      {/* 性能 HUD：只在 URL 带 ?perf=1 时出现（见 PerfHud 的说明） */}
      <PerfHud />
    </div>
  )
}

/**
 * 性能 HUD（仅在 `?perf=1` 时挂载）。
 *
 * 为什么要有它：站长反馈「拖动时一松手卡死几秒」，而我在**开发机/无头浏览器里
 * 怎么都复现不出来**（松手前后 0 个 long task、最大帧间隔 7ms，有头真实 GPU 也一样）。
 * 与其继续远程猜，不如把测量器做到页面上：站长在浏览器地址后面加 `?perf=1`，
 * 照常拖动几下，角上那行字就会告诉他**卡在哪一层**：
 *
 *   · 长任务（longTask）很多/很长 ⇒ **主线程 JS** 卡（我的代码 / React / 站点脚本）
 *   · 长任务为 0 但「最差帧」很大 ⇒ 主线程是闲的，卡在**合成/GPU**（大遮罩、模糊、玻璃卡片）
 *   · 两者都很小却仍然感觉卡 ⇒ 问题不在这个页面（浏览器/系统/扩展），
 *     那时候要么是别的标签页，要么是显卡驱动层面
 *
 * 它还会单独记录「松手那一下」之后的帧间隔 —— 正对着站长描述的那个瞬间。
 * 只在带参数时渲染，对正常玩家零影响。
 */
function PerfHud() {
  const enabled = React.useMemo(() => {
    if (typeof window === "undefined") return false
    return new URLSearchParams(window.location.search).has("perf")
  }, [])
  // 诊断浮层：文案刻意用 ASCII —— 它是开发者工具（只有 ?perf=1 才出现），
  // 且项目护栏要求 src/** 里不出现未国际化的中文。
  const [text, setText] = React.useState("measuring...")

  React.useEffect(() => {
    if (!enabled) return
    const gaps: number[] = []
    const longTasks: string[] = []
    let last = performance.now()
    let raf = 0
    let releasing: number | null = null
    let worstRelease = 0

    const onUp = () => {
      releasing = performance.now()
    }
    window.addEventListener("pointerup", onUp, true)

    let obs: PerformanceObserver | null = null
    /** 把 sourceURL 缩成一眼能认出来的形式（保留最后一段文件 + 名字） */
    const shortUrl = (u?: string) => {
      if (!u) return "?"
      const clean = u.split("?")[0]
      const parts = clean.split("/")
      return parts.slice(-2).join("/").slice(0, 48)
    }
    try {
      /**
       * ⚠️ 用 `long-animation-frame`（LoAF，Chrome/Edge 123+）而不是 `longtask`：
       * `longtask` 只告诉你「卡了 100ms」，归因最多指到 window，**查不出是哪个脚本**；
       * LoAF 会给出这一帧里各个脚本的 **sourceURL / 函数名 / invoker / 各自耗时** ——
       * 这正是「松手卡 100ms」需要的证据（站长实测 longTask 5 个 ~100ms，全是 @window）。
       * 浏览器不支持就退回 longtask（没有脚本信息，但至少知道时长）。
       */
      obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const loaf = e as PerformanceEntry & {
            scripts?: Array<{
              sourceURL?: string
              sourceFunctionName?: string
              invoker?: string
              duration?: number
            }>
          }
          const scripts = loaf.scripts ?? []
          if (scripts.length === 0) {
            const anyE = e as PerformanceEntry & {
              attribution?: Array<{ containerType?: string }>
            }
            const a = anyE.attribution?.[0] ?? {}
            longTasks.push(`${Math.round(e.duration)}ms${a.containerType ? `@${a.containerType}` : ""}`)
          } else {
            const top = scripts
              .slice()
              .sort((x, y) => (y.duration ?? 0) - (x.duration ?? 0))
              .slice(0, 2)
              .map(
                (s) =>
                  `${Math.round(s.duration ?? 0)}ms:${shortUrl(s.sourceURL)}${
                    s.sourceFunctionName ? `#${s.sourceFunctionName}` : ""
                  }${s.invoker && s.invoker !== "?" ? `<${s.invoker}>` : ""}`
              )
            longTasks.push(`${Math.round(e.duration)}ms[${top.join(" + ")}]`)
          }
          if (longTasks.length > 3) longTasks.shift()
        }
      })
      obs.observe({ entryTypes: ["long-animation-frame"] })
    } catch {
      try {
        obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            longTasks.push(`${Math.round(e.duration)}ms`)
            if (longTasks.length > 3) longTasks.shift()
          }
        })
        obs.observe({ entryTypes: ["longtask"] })
      } catch {
        /* 都不支持就算了 */
      }
    }

    const loop = (t: number) => {
      const g = t - last
      last = t
      gaps.push(g)
      if (gaps.length > 400) gaps.shift()
      // 松手后 1.5 秒内的最大帧间隔 —— 就是站长说的「一松手卡死」
      if (releasing !== null) {
        if (t - releasing < 1500) worstRelease = Math.max(worstRelease, g)
        else releasing = null
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const timer = window.setInterval(() => {
      const recent = gaps.slice(-180) // 约 3 秒
      const worst = recent.length ? Math.max(...recent) : 0
      const avg = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0
      setText(
        `fps ${gaps.length > 0 ? Math.round(1000 / Math.max(avg, 0.001)) : 0}` +
          ` · worst-3s ${Math.round(worst)}ms` +
          ` · worst-after-release ${Math.round(worstRelease)}ms` +
          ` · long-frames ${longTasks.length}${
            longTasks.length ? ` -> ${longTasks.join(" | ")}` : ""
          }`
      )
    }, 500)

    return () => {
      window.removeEventListener("pointerup", onUp, true)
      cancelAnimationFrame(raf)
      window.clearInterval(timer)
      obs?.disconnect()
    }
  }, [enabled])

  if (!enabled) return null
  return (
    <div className="pointer-events-none fixed bottom-2 left-2 z-[100] max-w-[92vw] whitespace-pre-wrap break-all rounded-md border bg-background/95 px-2 py-1 font-mono text-[10px] tabular-nums text-foreground shadow-sm">
      {text}
    </div>
  )
}


/** 顶部返回条：全屏插件形态下没有侧边栏，必须自带回造物典藏的入口 */
function BackBar() {
  const { t } = useT()
  return (
    <div className="flex items-center gap-2 px-1">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/dashboard/gallery/collection">
          <ArrowLeft className="h-4 w-4" />
          {t("col.tab.hall")}
        </Link>
      </Button>
      <span className="text-sm font-medium">{t("inv.title")}</span>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "long" | "short" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tabular-nums",
          tone === "long" && "text-emerald-600 dark:text-emerald-400",
          tone === "short" && "text-rose-600 dark:text-rose-400"
        )}
      >
        {value}
      </span>
    </div>
  )
}

/** 一轮「开仓 + 平仓」；未平仓时 closed 为 null */
interface RoundTrip {
  key: string
  positionId: string
  /**
   * 这一轮的所有开仓腿。
   *
   * ⚠️ 加仓会合并进同一行仓位（算加权均价），所以**一次平仓可能对应多次开仓** ——
   *    只留第一条的话，用户看不到自己加过仓，名义/保证金/手续费也全都对不上。
   */
  opens: GameTrade[]
  closed: GameTrade | null
}

/** 时间：短格式（月/日 时:分） */
function shortTime(iso: string, locale: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * 一条交易记录 = 一轮来回，占同一横排：
 *
 *   ┌─────────── 开仓信息 ───────────┬─────────── 平仓信息 ───────────┬ 盈亏 ┐
 *   │ 方向 5x · 开仓价 · 名义 · 手续费 · 时间 │ 平仓价 · 手续费 · 时间（强平标记） │ +12 │
 *   └───────────────────────────────┴───────────────────────────────┴──────┘
 *
 * 还没平仓的那一轮，右半部分显示「持仓中」，最右边显示**浮动盈亏**（拿当前持仓算），
 * 这样用户一眼能分清「已经落袋的」和「还在浮动的」。
 *
 * 加过仓的那一轮，左半显示的是**加权均价 + 累计名义/保证金/手续费**，并标注「加仓 N 次」——
 * 合并后整仓只有一个成本价，逐笔列出来反而跟总账对不上。
 */
function TradeRow({
  rt,
  feeCloseBps,
  live,
}: {
  rt: RoundTrip
  feeCloseBps: number
  /** 若这一轮还没平仓，这是它当前的持仓（用来算浮动盈亏与平衡价） */
  live?: GamePosition
}) {
  const { t, lang } = useT()
  const locale = localeOf(lang)
  const opened = rt.opens[0] ?? null
  const close = rt.closed
  const side = (opened?.side ?? close?.side ?? "long") === "long" ? "long" : "short"
  const long = side === "long"
  const liquidated = close?.kind === "liquidate"

  // 加仓合并后：名义/保证金/手续费**累加**，成本价**按规模加权**
  const openSize = rt.opens.reduce((s, o) => s + o.size, 0)
  const totalCost = rt.opens.reduce((s, o) => s + o.size * o.price, 0)
  const size = live?.size ?? (openSize || close?.size || 0)
  const margin = live?.margin ?? (rt.opens.reduce((s, o) => s + o.margin, 0) || close?.margin || 0)
  const entry = live?.entryPrice ?? (openSize > 0 ? totalCost / openSize : (close?.price ?? 0))
  const leverage = live?.leverage ?? opened?.leverage ?? close?.leverage ?? 1
  const adds = Math.max(0, rt.opens.length - 1)

  // 已落袋盈亏：以平仓那一腿为准（开仓腿的 pnl 恒为 0）
  const realized = close ? close.pnl : null
  const floating = !close && live ? live.unrealizedPnl : null
  const shown = realized ?? floating
  const win = (shown ?? 0) >= 0

  /** 这一轮的总手续费 = 开仓费合计 + 平仓费（未平仓时平仓费按当前名义预估） */
  const feeOpen = rt.opens.reduce((s, o) => s + o.fee, 0)
  const feeClose = close?.fee ?? (size > 0 ? estimateFee(size, feeCloseBps) : 0)
  const breakEven = entry > 0 && size > 0 ? estimateBreakEven(side, entry, size, feeOpen + feeClose) : 0

  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-xs sm:grid-cols-[1fr_1fr_5.5rem]">
      {/* ---------- 左：开仓 ---------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge
          variant="outline"
          className={cn(
            "font-normal",
            long
              ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
              : "border-rose-500/50 text-rose-600 dark:text-rose-400"
          )}
        >
          {long ? t("inv.sideLong") : t("inv.sideShort")} {formatLeverage(leverage)}x
        </Badge>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          {t("inv.openLeg")}
        </span>
        {opened ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground">
            <span>
              {t("inv.priceAt", { p: formatPrice(entry) })}
            </span>
            <span>
              {t("inv.size")} {formatNum(size, locale)}
            </span>
            <span>
              {t("inv.margin")} {formatNum(margin, locale)}
            </span>
            <span title={t("inv.openFeeHint")}>
              {t("inv.feeShort")} {formatNum(opened.fee, locale)}
            </span>
            {adds > 0 && (
              <span className="text-[10px] text-muted-foreground/70">
                {t("inv.addedTimes", { n: adds })}
              </span>
            )}
            <span className="text-muted-foreground/70">{shortTime(opened.createdAt, locale)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/60">{t("inv.legMissing")}</span>
        )}
      </div>

      {/* ---------- 右：平仓 ---------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-1.5 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
        <span className="flex items-center gap-1.5">
          {/* ⚠️ 还没平仓的那一轮不要先写「平仓」再写「持仓中」—— 自相矛盾。
              这种情况直接把标签换成「持仓中」。 */}
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
            {close ? (liquidated ? t("inv.liquidatedLeg") : t("inv.closeLeg")) : t("inv.holding")}
          </span>
          {liquidated && (
            <Badge variant="outline" className="border-rose-500/50 font-normal text-rose-600 dark:text-rose-400">
              {t("inv.kind.liquidate")}
            </Badge>
          )}
        </span>
        {close ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground">
            <span>{t("inv.priceAt", { p: formatPrice(close.price) })}</span>
            <span title={t("inv.closeFeeHint")}>
              {t("inv.feeShort")} {formatNum(close.fee, locale)}
            </span>
            {breakEven > 0 && (
              <span title={t("inv.breakEvenHint")}>
                {t("inv.breakEven")} {breakEven.toFixed(4)}
              </span>
            )}
            <span className="text-muted-foreground/70">{shortTime(close.createdAt, locale)}</span>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
            {/* 标签已经是「持仓中」了，这里只需要补上当前的平衡价 */}
            {live && (
              <span className="tabular-nums" title={t("inv.breakEvenHint")}>
                {t("inv.breakEven")} {breakEven.toFixed(4)}
              </span>
            )}
          </span>
        )}
      </div>

      {/* ---------- 最右一点点：盈亏 ---------- */}
      <div className="text-left sm:text-right">
        <span
          className={cn(
            "block font-medium tabular-nums",
            win ? "text-emerald-500" : "text-rose-500"
          )}
        >
          {shown === null ? "—" : formatSigned(shown, locale)}
        </span>
        <span className="block text-[10px] text-muted-foreground/60">
          {close ? t("inv.realizedPnl") : floating !== null ? t("inv.floatingPnl") : ""}
        </span>
      </div>
    </div>
  )
}

function PositionRow({
  p,
  feeCloseBps,
  busy,
  onClose,
}: {
  p: GamePosition
  /** 平仓费率（bps）：算「盈亏平衡价」要用到「预估平仓手续费」 */
  feeCloseBps: number
  busy: boolean
  onClose: () => void
}) {
  const { t } = useT()
  const long = p.side === "long"
  const profit = p.unrealizedPnl >= 0
  /**
   * 这一趟来回的总手续费 = 已扣的开仓费 + 预估平仓费。
   * 分开显示两者，用户才知道「手续费」不是一个已经付掉的固定数字（平仓那半还没发生）。
   */
  const feeCloseEst = estimateFee(p.size, feeCloseBps)
  const feeTotal = p.feeOpen + feeCloseEst
  const breakEven = estimateBreakEven(p.side, p.entryPrice, p.size, feeTotal)
  /** 标记价是否还没回到平衡价（含手续费仍然浮亏）—— 这时候把平衡价标红提示 */
  const underWater = long ? p.markPrice < breakEven : p.markPrice > breakEven
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 text-xs">
      <span className="flex w-24 shrink-0 items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn(
            "font-normal",
            long ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-rose-500/50 text-rose-600 dark:text-rose-400"
          )}
        >
          {long ? t("inv.sideLong") : t("inv.sideShort")} {formatLeverage(p.leverage)}x
        </Badge>
        {/* 逐仓/全仓必须显示出来：两者的爆仓含义完全不同（全仓会动到余额） */}
        <span
          className={cn(
            "text-[10px]",
            p.marginMode === "cross"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground/60"
          )}
          title={p.marginMode === "cross" ? t("inv.modeCrossDesc") : t("inv.modeIsolatedDesc")}
        >
          {p.marginMode === "cross" ? t("inv.modeCross") : t("inv.modeIsolated")}
        </span>
      </span>

      <Cell label={t("inv.margin")} value={`${p.margin}`} />
      <Cell label={t("inv.entry")} value={p.entryPrice.toFixed(4)} />
      <Cell label={t("inv.mark")} value={p.markPrice.toFixed(4)} />
      <Cell
        label={t("inv.feeShort")}
        value={`${feeTotal}`}
        note={`${p.feeOpen}+${feeCloseEst}`}
        hint={t("inv.feeHint", { a: p.feeOpen, b: feeCloseEst })}
      />
      <Cell
        label={t("inv.breakEven")}
        value={breakEven.toFixed(4)}
        tone={underWater ? "warn" : undefined}
        hint={t("inv.breakEvenHint")}
      />
      <Cell label={t("inv.liq")} value={p.liqPrice.toFixed(4)} />
      <Cell
        label={t("inv.liqDistance")}
        value={`${p.liqDistancePct.toFixed(2)}%`}
        tone={p.liqDistancePct < 3 ? "warn" : undefined}
      />

      <span className="ml-auto flex items-center gap-3">
        <span className="text-right">
          <span className={cn("block font-medium tabular-nums", profit ? "text-emerald-500" : "text-rose-500")}>
            {profit ? "+" : ""}
            {p.unrealizedPnl}
          </span>
          <span
            className={cn(
              "block text-[11px] tabular-nums",
              profit ? "text-emerald-500/80" : "text-rose-500/80"
            )}
          >
            {profit ? "+" : ""}
            {p.roePct.toFixed(2)}% {t("inv.roe")}
          </span>
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? t("inv.closing") : t("inv.close")}
        </Button>
      </span>
    </div>
  )
}

function Cell({
  label,
  value,
  tone,
  hint,
  note,
}: {
  label: string
  value: string
  tone?: "warn"
  /** 鼠标悬停的解释（例如「开仓 1 + 预估平仓 1」）—— 数字缩写时靠它讲清楚 */
  hint?: string
  /**
   * 数值后面的小注（例如手续费的「1+10」）。
   *
   * ⚠️ 不能用 title 代替它：手机上没有悬停，用户永远看不到解释 ——
   *    而「手续费 11」如果不写清「开仓 1 + 预估平仓 10」，很容易被读成「已经扣了 11」。
   */
  note?: string
}) {
  return (
    <span className="shrink-0" title={hint}>
      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground/60">
        {label}
      </span>
      <span
        className={cn(
          "block tabular-nums",
          tone === "warn" && "text-amber-600 dark:text-amber-400"
        )}
      >
        {value}
        {note && <span className="ml-1 text-[10px] text-muted-foreground/60">{note}</span>}
      </span>
    </span>
  )
}
