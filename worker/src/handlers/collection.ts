/**
 * 造物典藏 —— 插件清单 + 「在线投资」的玩家侧接口。
 *
 * 路由（都在 `worker/src/index.ts` 里登记，路径相对 `/api`）：
 *   GET  /collection/plugins                        大厅插件清单
 *   GET  /collection/invest/state                    行情 + 我的持仓（3 秒轮询）
 *   GET  /collection/invest/candles                  K 线
 *   POST /collection/invest/open                     开仓
 *   POST /collection/invest/close                    平仓
 *   GET  /collection/invest/history                  我的成交流水
 *   GET  /collection/invest/leaderboard              盈亏榜
 *
 * 管理端在 `handlers/collection-admin.ts`（典藏设置页）。
 *
 * ⚠️ 所有路径都刻意用**固定路径 + body/query 传参**，不用 `/xxx/:id`：
 *    这个项目的 `check-api-paths.mjs` 靠静态分析比对前后端路径，
 *    动态段多了容易误判成缺口（且固定路径没有额外成本）。
 */
import { ApiError, json } from "../http"
import { isAnyAdmin, requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import {
  advanceAndSweep,
  claimTestCoins,
  closePosition,
  gameBalance,
  gameLeaderboard,
  listCandles,
  consolidateUserBuckets,
  listMyPositions,
  listMyTrades,
  loadGameParams,
  openPosition,
  testCoinInfo,
  type MarketRow,
  type PositionRow,
} from "../game-market"
import {
  crossAccount,
  crossLiqPrice,
  computePnl,
  GAME_QUOTE,
  GAME_SYMBOL,
  normalizeMarginMode,
  type GameParams,
} from "../game-engine"
import { listAllPlugins, listPublishedPlugins, toPublicPlugin } from "../collection-plugins"
import type { Env } from "../env"

/** 轮询间隔由前端控制（3 秒）；这里只限「别被脚本打成洪水」 */
const OPEN_LIMIT_PER_MINUTE = 30
const CLOSE_LIMIT_PER_MINUTE = 60

// ---------------------------------------------------------------------------
// 大厅清单
// ---------------------------------------------------------------------------

/**
 * GET /api/collection/plugins
 *
 * 管理员额外拿到**未上架**的插件与它们的 config（这样他能在典藏设置里
 * 处理「已下架」的游戏）；普通用户只看得到已上架的。
 */
export async function listPlugins(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const manage = isAnyAdmin(user.role)
  const rows = manage ? await listAllPlugins(env) : await listPublishedPlugins(env)
  return json({
    plugins: rows.map((r) => toPublicPlugin(r, manage)),
    canManage: manage,
  })
}

// ---------------------------------------------------------------------------
// 行情
// ---------------------------------------------------------------------------

/** 把行情行转成前端用的形状 */
function publicMarket(m: MarketRow, params: GameParams) {
  const changeAbs = m.price - m.day_open
  const changePct = m.day_open > 0 ? (changeAbs / m.day_open) * 100 : 0
  return {
    symbol: GAME_SYMBOL,
    quote: GAME_QUOTE,
    price: m.price,
    anchor: m.anchor,
    /** 正在走的那根 K 线（前端把它拼在历史 K 线之后） */
    candle: {
      openAt: m.candle_open_at,
      openPrice: m.candle_open,
      highPrice: m.candle_high,
      lowPrice: m.candle_low,
      closePrice: m.candle_close,
      volume: m.candle_volume,
      trades: m.candle_trades,
    },
    dayOpen: m.day_open,
    dayHigh: m.day_high,
    dayLow: m.day_low,
    change24hAbs: changeAbs,
    change24hPct: changePct,
    tickSeq: m.tick_seq,
    lastTickAt: m.last_tick_at,
    /** 基础 K 线周期（秒），前端切换周期时用它判断要不要重新拉 */
    baseIntervalSeconds: Math.round(params.candleMs / 1000),
  }
}

/**
 * 持仓 DTO：补上浮盈、回报率、离爆仓的距离 —— 前端不用自己算一遍。
 *
 * ⚠️ 全仓的爆仓价必须**按当前可用余额实时算**：全仓是「余额 + 保证金」共同担保，
 *    余额一变（平掉别的仓、入金）爆仓价就跟着变。库里那个 `liq_price` 只是
 *    开/加仓当时的快照，拿它显示会越用越不准（逐仓没这个问题，逐仓只跟价格有关）。
 */
function publicPosition(
  p: PositionRow,
  markPrice: number,
  availableBalance: number,
  maintenanceBps: number
) {
  const side = p.side === "short" ? "short" : "long"
  const marginMode = normalizeMarginMode(p.margin_mode)
  const unrealized = computePnl(side, p.entry_price, markPrice, p.size)
  const roe = p.margin > 0 ? (unrealized / p.margin) * 100 : 0
  const liqPrice =
    marginMode === "cross"
      ? crossLiqPrice(side, p.entry_price, p.size, p.margin, availableBalance, maintenanceBps)
      : p.liq_price
  const liqDistance =
    liqPrice > 0 ? ((markPrice - liqPrice) / markPrice) * 100 : 0
  return {
    id: p.id,
    side,
    marginMode,
    leverage: p.leverage,
    margin: p.margin,
    entryPrice: p.entry_price,
    size: p.size,
    liqPrice,
    openedAt: p.opened_at,
    markPrice,
    unrealizedPnl: unrealized,
    roePct: roe,
    /** 标记价离爆仓价还有多少百分比（负数表示已经穿过，正常情况下会被强平扫掉） */
    liqDistancePct: side === "long" ? liqDistance : -liqDistance,
    feeOpen: p.fee_open,
  }
}

/**
 * GET /api/collection/invest/state
 *
 * 这个接口是**所有行情读写的入口** —— 它内部会推进行情并顺手强平
 * （`advanceAndSweep`）。只推进不强平的话，价格穿过爆仓价之后
 * 用户可以自己点平仓把损失止在穿价那一点，等于变相套利。
 */
export async function investState(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const params = await loadGameParams(env)

  /**
   * 懒迁移：老版本允许同一方向开多行，现在改成「同方向同模式只留一行、算均价」。
   * 打开页面时顺手合并一次，站长看到的持仓立刻就是合并后的样子 ——
   * 比在生产库上跑一段手工 SQL 安全得多（走的是同一套已测的合并逻辑）。
   */
  await consolidateUserBuckets(env, user.id, params.maintenanceBps)

  const { market, liquidated } = await advanceAndSweep(env, params)

  const positions = await listMyPositions(env, user.id)
  /**
   * ⚠️ 余额与池子都要**按当前货币**取：
   *    · points → 站内真积分 `user_points` / 真池子 `pool_balance`
   *    · test   → 测试币 `game_test_balances` / 测试池 `pool_test_balance`
   *    混用会出现「用测试币玩、却扣了真积分」这种最不能接受的结果。
   */
  const balance = await gameBalance(env, params.currency, user.id)
  const poolBalance =
    params.currency === "test"
      ? Number(market.pool_test_balance ?? 0)
      : Number(market.pool_balance)
  const coin = params.currency === "test" ? await testCoinInfo(env, user.id) : null

  return json({
    enabled: params.enabled,
    /** 当前货币：前端据此把「积分」显示成「测试币」 */
    currency: params.currency,
    /** 测试币首次领取额度（前端按钮文案用） */
    testGrant: params.testGrant,
    /** 还能不能领测试币（每人一次） */
    canClaimTest: params.currency === "test" && !(coin?.granted ?? true),
    market: publicMarket(market, params),
    pool: {
      /** 对手盘余额 = 全服可赚取的总量上限 */
      balance: poolBalance,
      /** 池子为空时禁止开仓（赔付上限为 0，开了也白开） */
      canOpen: poolBalance > 0,
      /** 这一单最多能赚多少（= 池子余额）。下单面板直接展示它，避免「赚了拿不到」 */
      maxPayout: poolBalance,
    },
    config: {
      maxLeverage: params.maxLeverage,
      minMargin: params.minMargin,
      feeOpenBps: params.feeOpenBps,
      feeCloseBps: params.feeCloseBps,
      maintenanceBps: params.maintenanceBps,
      /**
       * 冲击参数也下发：下单面板要用它算「预估成交价」——
       * **成交价含你自己的冲击**（见 game-market.ts 的 applyOrderImpact），
       * 不告诉前端的话，用户看到的预估爆仓价会比真实值差一截。
       */
      impactBps: params.impactBps,
      maxImpactBps: params.maxImpactBps,
      tickMs: params.tickMs,
      candleMs: params.candleMs,
      baseIntervalSeconds: Math.round(params.candleMs / 1000),
    },
    /**
     * 全仓账户汇总。
     *
     * 全仓的强平判据是**账户级**的（权益 < 维持保证金），不是单看某个仓位的价格 ——
     * 所以前端必须拿到这三个数才讲得清「离强平还有多远」：
     * 逐仓仓位不参与这个口径（它们的风险只跟自己的价格有关）。
     */
    cross: (() => {
      const list = positions.filter((p) => normalizeMarginMode(p.margin_mode) === "cross")
      const acct = crossAccount(
        list.map((p) => ({
          side: p.side === "short" ? ("short" as const) : ("long" as const),
          entryPrice: p.entry_price,
          size: p.size,
          margin: p.margin,
        })),
        balance,
        market.price,
        params.maintenanceBps
      )
      return {
        positions: list.length,
        escrow: acct.escrow,
        pnl: acct.pnl,
        maintenance: acct.maintenance,
        equity: acct.equity,
        liquidatable: acct.liquidatable,
        /** 触发强平时会从可用余额里追缴多少（余额不足时以余额为限） */
        shortfall: Math.min(acct.shortfall, Math.max(0, balance)),
      }
    })(),
    me: {
      balance,
      positions: positions.map((p) =>
        publicPosition(p, market.price, balance, params.maintenanceBps)
      ),
      unrealizedTotal: positions.reduce(
        (sum, p) =>
          sum +
          computePnl(p.side === "short" ? "short" : "long", p.entry_price, market.price, p.size),
        0
      ),
    },
    /** 本次请求顺手强平掉的仓位数（前端弹一条提示，比静默消失好） */
    liquidatedInThisPoll: liquidated,
  })
}

/**
 * POST /api/collection/invest/claim-test —— 领取测试币（每人一次）。
 *
 * 只在测试币模式下有意义：`claimTestCoins` 会用 `granted_at IS NULL` 做条件更新，
 * 并发点两次也只会到账一次。
 */
export async function investClaimTest(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  return json(await claimTestCoins(env, user))
}

/**
 * GET /api/collection/invest/candles?interval=1m|5m|15m&limit=300
 *
 * 库里只存基础周期，更大的周期在这里聚合。请求的周期不是基础周期的整数倍时，
 * 返回的是基础周期，并在 `interval` 字段里**如实回报**（前端据此更正图例）。
 */
export async function investCandles(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)
  const params = await loadGameParams(env)
  const url = new URL(request.url)
  const interval = url.searchParams.get("interval") ?? "1m"
  const limit = Number(url.searchParams.get("limit") ?? 300)
  const res = await listCandles(env, params, interval, Number.isFinite(limit) ? limit : 300)
  return json(res)
}

// ---------------------------------------------------------------------------
// 交易
// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object")
    }
    return body as Record<string, unknown>
  } catch {
    throw new ApiError(400, "请求体格式错误", "INVALID_INPUT")
  }
}

/** POST /api/collection/invest/open  { side, leverage, margin, orderNo? } */
export async function investOpen(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(
    env,
    `game-open:${user.id}`,
    OPEN_LIMIT_PER_MINUTE,
    60,
    "下单太频繁了"
  )
  const body = await readJson(request)
  const side = body.side === "short" ? "short" : "long"
  const result = await openPosition(env, user, {
    side,
    leverage: body.leverage,
    margin: body.margin,
    orderNo: typeof body.orderNo === "string" ? body.orderNo : undefined,
    /** 保证金模式：缺省逐仓（风险更小的那个）。前端在 order panel 上给切换 */
    marginMode: typeof body.marginMode === "string" ? body.marginMode : undefined,
  })

  const params = await loadGameParams(env)
  return json({
    position: publicPosition(result.position, result.price, result.balance, params.maintenanceBps),
    price: result.price,
    /** 幂等命中（重放同一下单号）时为 true —— 前端不要重复提示「开仓成功」 */
    duplicated: result.duplicated,
    balance: result.balance,
    leverageCap: params.maxLeverage,
  })
}

/** POST /api/collection/invest/close  { positionId } */
export async function investClose(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(
    env,
    `game-close:${user.id}`,
    CLOSE_LIMIT_PER_MINUTE,
    60,
    "操作太频繁了"
  )
  const body = await readJson(request)
  const positionId = typeof body.positionId === "string" ? body.positionId.trim() : ""
  if (!positionId) throw new ApiError(400, "缺少持仓 id", "INVALID_INPUT")

  const res = await closePosition(env, user, positionId)
  return json({
    position: {
      id: res.position.id,
      side: res.position.side,
      leverage: res.position.leverage,
      margin: res.position.margin,
      entryPrice: res.position.entry_price,
      size: res.position.size,
      liqPrice: res.position.liq_price,
      status: res.position.status,
      pnl: res.position.pnl,
      closePrice: res.position.close_price,
      closedAt: res.position.closed_at,
      note: res.position.note,
    },
    credit: res.credit,
    fee: res.fee,
    pnl: res.pnl,
    /** 盈利受对手盘上限限制（没赔满）—— 前端要明确告诉用户 */
    capped: res.capped,
    balance: res.balance,
    alreadyClosed: res.alreadyClosed,
  })
}

/** GET /api/collection/invest/history?limit=50 */
export async function investHistory(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const rows = await listMyTrades(env, user.id, Number.isFinite(limit) ? limit : 50)
  return json({
    trades: rows.map((t) => ({
      id: String(t.id),
      kind: String(t.kind),
      /**
       * 所属仓位 id —— 前端要拿它把「一次开仓」和「一次平仓」配成同一条记录
       * （站长要求：一条记录占同一横排，左边开仓、右边平仓、最右边盈亏）。
       * 一次开仓只会有一条 open 流水，对应最多一条 close/liquidate 流水。
       */
      positionId: String(t.position_id ?? ""),
      side: String(t.side),
      leverage: Number(t.leverage ?? 1),
      price: Number(t.price ?? 0),
      size: Number(t.size ?? 0),
      margin: Number(t.margin ?? 0),
      fee: Number(t.fee ?? 0),
      pnl: Number(t.pnl ?? 0),
      balanceAfter: t.balance_after === null ? null : Number(t.balance_after),
      createdAt: String(t.created_at),
    })),
  })
}

/** GET /api/collection/invest/leaderboard?range=today|week|all */
export async function investLeaderboard(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const raw = url.searchParams.get("range")
  const range: "today" | "week" | "all" =
    raw === "today" || raw === "week" ? raw : "all"
  const res = await gameLeaderboard(env, user.id, range)
  return json({
    range,
    items: res.rows.map((r, i) => ({
      rank: i + 1,
      username: r.username,
      nickname: r.nickname,
      hasAvatar: r.hasAvatar,
      profit: r.profit,
      trades: r.trades,
      isMe: r.username === user.username,
    })),
    me: res.me,
  })
}
