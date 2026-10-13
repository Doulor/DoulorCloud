/**
 * 造物典藏 ·「在线投资」—— **行情状态机与交易结算**。
 *
 * 纯数学在 `game-engine.ts`；这个文件负责：读设置、推进行情、开平仓、强平、
 * 池子记账、排行榜。以及最重要的一条 —— **积分守恒**。
 *
 * ---------------------------------------------------------------------------
 * 一、对手盘 = 做市池（game_market.pool_balance 一个整数）
 * ---------------------------------------------------------------------------
 * 池子里的钱只有两个来源：玩家亏损 + 手续费；只有一个出口：赔付玩家盈利。
 * 唯一的「注入」是站长在典藏设置里**划拨垫本**（从他自己的账户扣、池子加，
 * 全站积分总量分毫不变）。
 *
 * 守恒等式（`test/game-market.test.ts` 用随机模拟验证）：
 *
 *     Σ 用户积分余额 + pool_balance + Σ(在仓保证金) = 常量
 *
 * 两条硬约束保证它成立，**任何一条都不能放松**：
 *   1. 池子余额永不为负 —— 所有减法走 `MAX(0, pool_balance + ?)`（SQLite 的双参 MAX）
 *      或带 `AND pool_balance >= ?` 的条件更新；
 *   2. 赔付以池子余额为上限 —— 见 `settlePosition()`。不够就按池子里现有的赔，
 *      并把 `capped` 告诉用户（前端提示「受对手盘上限限制」）。
 *
 * 于是这个游戏**永远不会凭空增发站内积分**：玩家整体净亏 → 池子变厚；
 * 玩家整体净赚 → 池子被抽干 → 自动限制开仓（池子 ≤ 0 时禁止开新仓）。
 *
 * ---------------------------------------------------------------------------
 * 二、并发：没有 Durable Object，靠「乐观锁 + 幂等键」串行化
 * ---------------------------------------------------------------------------
 * Cloudflare Worker 是无状态的，同一个 tick 可能被两个并发请求同时推进。
 * 三个手段合起来才是安全的：
 *
 *   · **行情推进**：`UPDATE ... WHERE tick_seq = ?`，抢输的一方重读重试
 *     （tick_seq 既是序号也是版本号）；
 *   · **开仓**：`applyPoints` 的 `dedupKey` + `game_positions.order_no` 唯一索引。
 *     重放同一个下单号不会扣两次积分，也不会开出两个仓；
 *   · **平仓/强平**：`UPDATE ... WHERE id = ? AND status = 'open'` —— 只有一个赢家，
 *     抢输的直接返回当前状态，绝不重复结算。
 *
 * ---------------------------------------------------------------------------
 * 三、已知的取舍（写在这里免得后人当成 bug）
 * ---------------------------------------------------------------------------
 *   · 平仓是「先 CAS 占位 → 再记池子 → 再给用户到账」三步，中间没有分布式事务。
 *     Worker 在中间被打断的概率极低，但一旦发生就是「仓位关了、钱没到」。
 *     补偿手段是幂等键（`game:close:<持仓id>`）—— 重放同一笔结算不会重复给钱，
 *     所以人工补一次即可，不会算错账。真正的自动补单留作 TODO（YAGNI）。
 *   · 强平扫描一次最多 200 个仓位（`LIKE_LIMIT`）。仓位规模到那个量级时
 *     需要改成增量扫描 + 定时任务分片，届时会有仓位「迟一个 tick 才被强平」。
 *   · 排行榜直接扫 `game_trades`（这张表本来就要给用户看流水），不额外建汇总表。
 */
import { ApiError } from "./http"
import { uuid } from "./crypto"
import { applyPoints, getPointsBalance } from "./points"
import {
  audit,
  getSettings,
  siteOffsetHours,
} from "./settings"
import {
  MAX_CATCHUP_TICKS,
  averageEntryPrice,
  candleOpenAt,
  clampPrice,
  crossAccount,
  crossLiqPrice,
  intervalMs,
  liquidationPrice,
  mergeInto,
  newCandle,
  normalizeMarginMode,
  orderImpactBps,
  applyImpactBps,
  quoteOpen,
  sanitizeGameParams,
  settlePosition,
  stepPrice,
  type Candle,
  type GameParams,
  type MarginMode,
  type Side,
} from "./game-engine"
import type { Env } from "./env"
import type { UserRow } from "./auth"

/** 一次强平扫描最多处理多少个仓位（见文件头「已知的取舍」） */
const LIQUIDATE_LIMIT = 200

/** 行情行（与 D1 列一一对应，保持 snake_case 以免来回映射出错） */
export interface MarketRow {
  id: number
  price: number
  anchor: number
  pool_balance: number
  /** 测试币池子（迁移 0151）。与真积分池完全隔离。 */
  pool_test_balance?: number
  /** 货币切换时刻（迁移 0151）：排行榜只统计它之后的成交 */
  currency_since?: string | null
  tick_seq: number
  last_tick_at: string
  seed: string
  candle_open_at: string
  candle_open: number
  candle_high: number
  candle_low: number
  candle_close: number
  candle_volume: number
  candle_trades: number
  /** 当前这根 K 线里已经落了几个 tick（跨调用累积，见 advanceMarket 的注释） */
  candle_ticks: number
  day_open_at: string
  day_open: number
  day_high: number
  day_low: number
  updated_at: string
}

export interface PositionRow {
  id: string
  user_id: string
  side: string
  leverage: number
  margin: number
  entry_price: number
  size: number
  liq_price: number
  status: string
  opened_at: string
  open_tick: number
  closed_at: string | null
  close_price: number | null
  pnl: number | null
  fee_open: number
  fee_close: number
  order_no: string
  note: string | null
  /**
   * 'isolated' 逐仓 / 'cross' 全仓。
   *
   * 它是**合并键的一部分**：同一人同一方向，逐仓与全仓各留一行、各自独立强平 ——
   * 两者的强平价与最大亏损完全不同，混在一起就没法算了。
   */
  margin_mode: string
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/**
 * 管理端操作用到的最小用户字段。
 *
 * 刻意**不写成 `UserRow`**：管理端拿到的是 `AdminUserRow`（`handlers/admin.ts` 里
 * 另一套结构，`email_verified` 是 `number | null | undefined`），
 * 与 `UserRow` 结构不兼容 —— 直接收 `UserRow` 会编译不过，
 * 而在调用点强转又会掩盖真正的类型问题。这里只声明真正用到的两个字段。
 */
export interface GameAdminActor {
  id: string
  username: string
}

/**
 * 读出引擎运行参数。
 *
 * ⚠️ **14 个设置项全部在这里被读到** —— `check-settings.mjs` 会守护
 *    「SETTING_DEFAULTS 里声明了的键必须真的被消费一次，且读取点不在 settings.ts 里」。
 *    新增玩法参数时：先在 settings.ts 加默认值，再在这里加一行读取，
 *    否则护栏会红（那正是它存在的意义 —— 防「假开关」）。
 *
 * ⚠️ 用 `getSettings()` **一次读全表**，而不是 14 次 `getSettingNumber`：
 *    这个函数在两条热路径上（玩家每 3 秒轮询行情、每分钟 cron 推进行情），
 *    14 次 D1 往返会直接变成 14 倍的查询量。设置项在库里都是字符串，
 *    交给 `sanitizeGameParams` 统一解析与收口（解析失败自动回落默认值）。
 */
export async function loadGameParams(env: Env): Promise<GameParams> {
  const s = await getSettings(env)
  return sanitizeGameParams({
    // 布尔口径与 getSettingBool 保持一致（"1" / "true" 都算开）
    enabled: s.game_enabled === "1" || s.game_enabled.toLowerCase() === "true",
    tickSeconds: s.game_tick_seconds,
    candleSeconds: s.game_candle_seconds,
    maxLeverage: s.game_max_leverage,
    minMargin: s.game_min_margin,
    feeOpenBps: s.game_fee_open_bps,
    feeCloseBps: s.game_fee_close_bps,
    maintenanceBps: s.game_maintenance_bps,
    noiseBps: s.game_noise_bps,
    impactBps: s.game_impact_bps,
    meanReversionBps: s.game_mean_reversion_bps,
    reversionDeadbandBps: s.game_reversion_deadband_bps,
    currency: s.game_currency === "test" ? "test" : "points",
    testGrant: Number(s.game_test_grant) || 0,
    anchorFollowBps: s.game_anchor_follow_bps,
    maxImpactBps: s.game_max_impact_bps,
    basePrice: s.game_base_price,
  })
}

/** 基础 K 线的周期标签（跟着 candleMs 走，所以站长改成 30 秒也不会写错标签） */
export function baseIntervalLabel(params: GameParams): string {
  return `${Math.round(params.candleMs / 1000)}s`
}

// ---------------------------------------------------------------------------
// 行情读写
// ---------------------------------------------------------------------------

function randomSeed(): string {
  const buf = new Uint8Array(8)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function loadMarket(env: Env): Promise<MarketRow | null> {
  return await env.DB.prepare("SELECT * FROM game_market WHERE id = 1").first<MarketRow>()
}

/**
 * 取行情；**没有就按当前参数创建**（懒初始化）。
 *
 * 为什么不把初始行写进迁移：seed 是随机数，SQL 里生成不了。
 * 懒创建还有一个好处 —— 测试环境不用额外造数。
 *
 * `INSERT OR IGNORE` 保证并发下只会有一行（`id INTEGER PRIMARY KEY CHECK (id = 1)`）。
 */
export async function ensureMarket(env: Env, params: GameParams): Promise<MarketRow> {
  const existing = await loadMarket(env)
  if (existing) return existing

  const now = Date.now()
  const iso = new Date(now).toISOString()
  const openAt = candleOpenAt(now, params.candleMs)
  const price = clampPrice(params.basePrice, 100)

  await env.DB.prepare(
    `INSERT OR IGNORE INTO game_market (
       id, price, anchor, pool_balance, tick_seq, last_tick_at, seed,
       candle_open_at, candle_open, candle_high, candle_low, candle_close,
       candle_volume, candle_trades, candle_ticks,
       day_open_at, day_open, day_high, day_low, updated_at
     ) VALUES (1, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`
  )
    .bind(
      price, price, iso, randomSeed(),
      openAt, price, price, price, price,
      openAt, price, price, price, iso
    )
    .run()

  const created = await loadMarket(env)
  if (!created) {
    throw new ApiError(500, "行情初始化失败", "MARKET_INIT_FAILED")
  }
  return created
}

/** 把 MarketRow 的 candle_* 列读成引擎的 Candle 形状 */
function candleOf(m: MarketRow): Candle {
  return {
    openAt: m.candle_open_at,
    openPrice: m.candle_open,
    highPrice: m.candle_high,
    lowPrice: m.candle_low,
    closePrice: m.candle_close,
    volume: m.candle_volume,
    trades: m.candle_trades,
  }
}

/** 落库一批已封闭的 K 线。ON CONFLICT 兜住「同一根被写两次」的边界情况 */
async function flushCandles(env: Env, label: string, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return
  const stmt = env.DB.prepare(
    `INSERT INTO game_candles
       (interval, open_at, open_price, high_price, low_price, close_price, volume, trades)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(interval, open_at) DO UPDATE SET
       high_price  = MAX(high_price, excluded.high_price),
       low_price   = MIN(low_price,  excluded.low_price),
       close_price = excluded.close_price,
       volume      = volume + excluded.volume,
       trades      = trades + excluded.trades`
  )
  await env.DB.batch(
    candles.map((c) =>
      stmt.bind(
        label, c.openAt, c.openPrice, c.highPrice, c.lowPrice, c.closePrice, c.volume, c.trades
      )
    )
  )
}

/**
 * 把行情推进到 `now`（或给定的时刻）。
 *
 * 算法：
 *   1. 算出从 `last_tick_at` 到现在应该走多少个 tick；
 *   2. 逐个 tick 用 `stepPrice` 演化（确定性 PRNG，同一 tick 重算结果一致）；
 *   3. 跨分钟的 tick 会把上一根 K 线封存、开一根新的；
 *   4. 用 `WHERE tick_seq = ?` 乐观锁写回，抢输就重读重试。
 *
 * **补算上限**（`MAX_CATCHUP_TICKS`）：长期没人访问时，只补最后那一段
 * 并把时间对齐到当前 —— 价格保持连续（不跳空），代价是 K 线上少一段历史。
 * 老实补完的话单次请求要跑几十万步，必然超时，而且补出来的行情也没人看到。
 */
export async function advanceMarket(
  env: Env,
  params: GameParams,
  now = Date.now()
): Promise<MarketRow> {
  let market = await ensureMarket(env, params)

  for (let attempt = 0; attempt < 5; attempt++) {
    const lastMs = Date.parse(market.last_tick_at)
    if (!Number.isFinite(lastMs)) {
      // 脏数据（手改库把 last_tick_at 写坏了）：直接把时间对齐到当前，别再往下传
      const iso = new Date(now).toISOString()
      await env.DB.prepare("UPDATE game_market SET last_tick_at = ?, updated_at = ? WHERE id = 1")
        .bind(iso, iso)
        .run()
      market = (await loadMarket(env)) ?? market
      return market
    }

    const elapsed = now - lastMs
    const totalSteps = Math.floor(elapsed / params.tickMs)
    if (totalSteps < 1) return market

    const steps = Math.min(totalSteps, MAX_CATCHUP_TICKS)
    // 超出上限时**跳过**最前面那段（对齐到最近的一段行情），而不是从头补
    const skipped = totalSteps - steps
    const simStart = lastMs + skipped * params.tickMs
    const seqBase = market.tick_seq + skipped

    let price = market.price
    let anchor = market.anchor
    let candle = candleOf(market)
    /**
     * 这根 K 线里已经落了几个 tick —— **必须跟着行情行持久化**，不能用局部变量。
     *
     * ⚠️ 2026-10-11 生产环境实测踩到的真 bug：
     *    原来这里是一个函数内的 `dirty = false`。而线上行情是**每分钟被 cron 推一次、
     *    每次正好 60 秒（12 个 tick）**，于是「跨分钟的那一步」永远发生在
     *    **某次调用的第一个 tick** —— 那一刻 `dirty` 刚被重置回 false，
     *    上一轮攒下的那根 K 线就被当成空线丢掉了。结果 `game_candles` 一行不写，
     *    图表上永远只有「正在走的那一根」。
     *
     *    单测没抓到是因为测试里一次推进 60 个 tick（一次调用跨多根边界），
     *    恰好绕开了「K 线跨调用」这个真实场景。现在有专门的用例守着它。
     *
     * 判据是「有 tick **或** 有玩家成交」：一个只在玩家下单时被碰到的 K 线
     * （那一分钟没走到 tick）同样有内容，也得落库。
     */
    let ticksInCandle = market.candle_ticks ?? 0
    const closed: Candle[] = []

    for (let i = 1; i <= steps; i++) {
      const seq = seqBase + i
      const next = stepPrice({
        price,
        anchor,
        pool: activePool(market, params),
        seq,
        seed: market.seed,
        params,
      })
      price = next.price
      anchor = next.anchor

      const at = candleOpenAt(simStart + i * params.tickMs, params.candleMs)
      if (at !== candle.openAt) {
        // 旧 K 线有内容才落库（空的那根属于「被跳过的一段」，不该写进历史）
        if (ticksInCandle > 0 || candle.trades > 0) closed.push(candle)
        candle = newCandle(at, price)
        ticksInCandle = 1
      } else {
        candle = mergeInto(candle, price)
        ticksInCandle += 1
      }
    }

    const endMs = simStart + steps * params.tickMs
    const iso = new Date(endMs).toISOString()

    // 当日 OHLC：滚动 24 小时窗口（不是自然日）—— 与前端顶栏的「24h 涨跌」同一口径，
    // 也省掉「按站点时区切日」这一套（那个口径对本游戏没有意义）。
    const dayMs = Date.parse(market.day_open_at)
    const dayReset = !Number.isFinite(dayMs) || endMs - dayMs >= 24 * 3600_000
    const dayOpenAt = dayReset ? iso : market.day_open_at
    const dayOpen = dayReset ? price : market.day_open
    const dayHigh = dayReset ? price : Math.max(market.day_high, price)
    const dayLow = dayReset ? price : Math.min(market.day_low, price)

    const res = await env.DB.prepare(
      `UPDATE game_market SET
         price = ?, anchor = ?, tick_seq = ?, last_tick_at = ?,
         candle_open_at = ?, candle_open = ?, candle_high = ?, candle_low = ?,
         candle_close = ?, candle_volume = ?, candle_trades = ?, candle_ticks = ?,
         day_open_at = ?, day_open = ?, day_high = ?, day_low = ?,
         updated_at = ?
       WHERE id = 1 AND tick_seq = ?`
    )
      .bind(
        price, anchor, seqBase + steps, iso,
        candle.openAt, candle.openPrice, candle.highPrice, candle.lowPrice,
        candle.closePrice, candle.volume, candle.trades, ticksInCandle,
        dayOpenAt, dayOpen, dayHigh, dayLow,
        new Date(now).toISOString(), market.tick_seq
      )
      .run()

    if ((res.meta?.changes ?? 0) === 1) {
      await flushCandles(env, baseIntervalLabel(params), closed)
      const fresh = await loadMarket(env)
      return fresh ?? market
    }

    // 抢输了：别人推进过，重读后重试
    const reread = await loadMarket(env)
    if (!reread) return market
    market = reread
  }

  return market
}

// ---------------------------------------------------------------------------
// 池子记账
// ---------------------------------------------------------------------------

/**
 * 本游戏使用的两种货币。
 *
 * · `points` —— 站内真积分（`user_points`）。**动的是真钱**。
 * · `test`   —— 游戏专用测试币（`game_test_balances`）。与积分**完全隔离**：
 *              测试币的任何加减都不会碰 `user_points`，反之亦然。
 *
 * 由设置 `game_currency` 决定当前用哪种；管理面板可切换。
 * ⚠️ 兜底方向是 `points`（见 sanitizeGameParams）：值写错时宁可走真积分，
 *    也不能把测试币当积分发出去。
 */
export type GameCurrency = "points" | "test"

/** 当前货币下读取某个用户的余额 */
export async function gameBalance(
  env: Env,
  currency: GameCurrency,
  userId: string
): Promise<number> {
  if (currency === "points") return getPointsBalance(env, userId)
  const row = await env.DB.prepare(
    "SELECT balance FROM game_test_balances WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ balance: number }>()
  return Number(row?.balance ?? 0)
}

/**
 * 当前货币下的加减。返回 `applied=false` 表示没扣成（余额不足等）。
 *
 * 真积分走 `applyPoints`（带 dedup 幂等键与条件 UPDATE，绝不允许负余额）；
 * 测试币走 `game_test_balances` 的条件 UPDATE，同样不允许透支 ——
 * 测试币虽然是游戏币，但「余额变成负数」会让所有均价/强平计算失去意义。
 */
async function gameApply(
  env: Env,
  currency: GameCurrency,
  input: Parameters<typeof applyPoints>[1]
): Promise<{ applied: boolean; balance: number; reason?: string }> {
  if (currency === "points") {
    const res = await applyPoints(env, input)
    return { applied: res.applied, balance: res.balance, reason: res.reason }
  }
  const now = new Date().toISOString()
  // 先确保有这一行（新玩家第一次进游戏）
  await env.DB.prepare(
    "INSERT OR IGNORE INTO game_test_balances (user_id, balance, updated_at) VALUES (?, 0, ?)"
  )
    .bind(input.userId, now)
    .run()
  if (input.delta === 0) {
    return { applied: false, balance: await gameBalance(env, currency, input.userId), reason: "zero" }
  }
  const res = await env.DB.prepare(
    "UPDATE game_test_balances SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND balance + ? >= 0"
  )
    .bind(input.delta, now, input.userId, input.delta)
    .run()
  if ((res.meta?.changes ?? 0) !== 1) {
    return {
      applied: false,
      balance: await gameBalance(env, currency, input.userId),
      reason: "insufficient",
    }
  }
  return { applied: true, balance: await gameBalance(env, currency, input.userId) }
}

/**
 * 测试币状态：余额 + 是否已经领过（决定要不要显示「领取测试币」按钮）。
 */
export async function testCoinInfo(
  env: Env,
  userId: string
): Promise<{ balance: number; granted: boolean }> {
  const row = await env.DB.prepare(
    "SELECT balance, granted_at FROM game_test_balances WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ balance: number; granted_at: string | null }>()
  return { balance: Number(row?.balance ?? 0), granted: row?.granted_at != null }
}

/**
 * 领取测试币（每人一次）。
 *
 * 只在测试币模式下有意义。用 `granted_at IS NULL` 做「只能领一次」的条件更新，
 * 并发下也只会有一个请求拿到钱。
 */
export async function claimTestCoins(
  env: Env,
  user: UserRow
): Promise<{ granted: number; balance: number }> {
  const params = await loadGameParams(env)
  if (params.currency !== "test") {
    throw new ApiError(400, "当前不是测试币模式", "WRONG_CURRENCY")
  }
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT OR IGNORE INTO game_test_balances (user_id, balance, updated_at) VALUES (?, 0, ?)"
  )
    .bind(user.id, now)
    .run()
  const res = await env.DB.prepare(
    `UPDATE game_test_balances SET balance = balance + ?, granted_at = ?, updated_at = ?
      WHERE user_id = ? AND granted_at IS NULL`
  )
    .bind(params.testGrant, now, now, user.id)
    .run()
  const balance = await gameBalance(env, "test", user.id)
  return { granted: (res.meta?.changes ?? 0) === 1 ? params.testGrant : 0, balance }
}
/**
 * 池子余额变更（原子算术 + 不为负）+ 写审计流水。
 *
 * `MAX(0, ...)` 是双参标量函数（SQLite 里 MAX 既是聚合函数也是标量函数）——
 * 用它在 SQL 层一次性保证「池子永不为负」，而不是读出来判断再写回（那就有竞态）。
 * 需要**严格拒绝**而不是默默截断的场景（抽回资金）用 `takeFromPool`。
 */
async function addPool(
  env: Env,
  currency: GameCurrency,
  delta: number,
  kind: string,
  userId: string | null,
  ref: string | null,
  note: string | null
): Promise<number> {
  const now = new Date().toISOString()
  /**
   * ⚠️ 两种货币**各有各的池子列**：真积分走 `pool_balance`，测试币走 `pool_test_balance`。
   *    列名是代码里拼的（不是用户输入），两个取值都是常量，不存在注入问题。
   */
  const col = currency === "test" ? "pool_test_balance" : "pool_balance"
  const res = await env.DB.prepare(
    `UPDATE game_market SET ${col} = MAX(0, ${col} + ?), updated_at = ? WHERE id = 1`
  )
    .bind(delta, now)
    .run()
  /**
   * ⚠️ **必须确认真的写到了那一行**。
   *
   * `UPDATE ... WHERE id = 1` 在行情行不存在时**影响 0 行且不报错** ——
   * 于是「玩家开仓的手续费」或「站长划拨的垫本」会在无声无息中消失，
   * 表现为守恒等式对不上且极难定位（钱从用户账上扣了，池子里没有）。
   * 所有调用方都会在 ensureMarket 之后执行，所以这里命中就说明状态坏了，
   * 直接抛出比默默记账正确得多。
   */
  if ((res.meta?.changes ?? 0) !== 1) {
    throw new ApiError(500, "行情数据缺失，本次资金变动已放弃", "MARKET_MISSING")
  }
  const row = await env.DB.prepare(
    `SELECT ${col} AS bal FROM game_market WHERE id = 1`
  ).first<{ bal: number }>()
  const balance = Number(row?.bal ?? 0)
  await env.DB.prepare(
    `INSERT INTO game_pool_ledger (id, delta, balance_after, kind, user_id, ref, note, created_at, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(uuid(), delta, balance, kind, userId, ref, note, now, currency)
    .run()
  return balance
}

/**
 * 从池子里**严格**取出 amount（不够就失败，不截断）。
 *
 * 为什么不用 addPool 的 MAX(0,…)：那会把「不够」静默变成「有多少给多少」，
 * 而调用方（站长抽回资金）随后会往自己账户加满 amount —— 凭空多出一笔积分。
 * 条件更新 `AND pool_balance >= ?` 把这个竞态堵死在 SQL 层。
 */
async function takeFromPool(
  env: Env,
  currency: GameCurrency,
  amount: number,
  kind: string,
  userId: string | null,
  ref: string | null,
  note: string | null
): Promise<number> {
  const now = new Date().toISOString()
  const col = currency === "test" ? "pool_test_balance" : "pool_balance"
  const res = await env.DB.prepare(
    `UPDATE game_market SET ${col} = ${col} - ?, updated_at = ?
      WHERE id = 1 AND ${col} >= ?`
  )
    .bind(amount, now, amount)
    .run()
  if ((res.meta?.changes ?? 0) !== 1) {
    throw new ApiError(400, "做市池余额不足，无法取出这么多", "POOL_INSUFFICIENT")
  }
  const row = await env.DB.prepare(
    `SELECT ${col} AS bal FROM game_market WHERE id = 1`
  ).first<{ bal: number }>()
  const balance = Number(row?.bal ?? 0)
  await env.DB.prepare(
    `INSERT INTO game_pool_ledger (id, delta, balance_after, kind, user_id, ref, note, created_at, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(uuid(), -amount, balance, kind, userId, ref, note, now, currency)
    .run()
  return balance
}

/**
 * 站长的垫本划拨：从**他自己的账户**扣，池子加。
 *
 * 这是全游戏唯一的「注入资金」入口，也是**积分总量守恒**的关键一步：
 * 扣与加金额相同，全站积分一分不多一分不少。所以它随时可以反向操作（抽回）。
 */
export async function depositToPool(
  env: Env,
  admin: GameAdminActor,
  amount: number
): Promise<{ pool: number; balance: number }> {
  const value = Math.floor(amount)
  if (!Number.isFinite(value) || value < 1) {
    throw new ApiError(400, "划拨数量必须是不小于 1 的整数", "INVALID_INPUT")
  }
  // 行情行必须先存在：addPool 的 UPDATE 在缺行时影响 0 行，
  // 而「站长的积分已经扣了、池子却没收到」是最不能接受的一种状态。
  const params = await loadGameParams(env)
  await ensureMarket(env, params)
  const res = await gameApply(env, params.currency, {
    userId: admin.id,
    delta: -value,
    reason: "game_pool",
    detail: `划拨做市池垫本 ${value} 积分`,
  })
  if (!res.applied) {
    if (res.reason === "insufficient") {
      throw new ApiError(400, "你的积分不足，无法划拨这么多", "INSUFFICIENT_POINTS")
    }
    throw new ApiError(409, "重复操作", "DUPLICATED")
  }

  let pool: number
  try {
    pool = await addPool(env, params.currency, value, "seed_deposit", admin.id, null, "站长划拨垫本")
  } catch (err) {
    // 池子写失败就把钱退回站长账户（同一幂等键路径：用补偿流水，金额相同）
    await gameApply(env, params.currency, {
      userId: admin.id,
      delta: value,
      reason: "game_pool",
      detail: `划拨失败退回 ${value} 积分`,
    })
    throw err
  }

  await audit(env, admin.id, "collection.game.pool_deposit", `${admin.username} 划拨 ${value} 积分进做市池`)
  return { pool, balance: res.balance }
}

/** 站长抽回资金：池子**严格**扣，成功后才往他账户加（顺序不能反） */
export async function withdrawFromPool(
  env: Env,
  admin: GameAdminActor,
  amount: number
): Promise<{ pool: number; balance: number }> {
  const value = Math.floor(amount)
  if (!Number.isFinite(value) || value < 1) {
    throw new ApiError(400, "取出数量必须是不小于 1 的整数", "INVALID_INPUT")
  }
  // 同 depositToPool：先保证行情行存在，否则「池子里明明有钱却扣不动」
  const params = await loadGameParams(env)
  await ensureMarket(env, params)
  const pool = await takeFromPool(env, params.currency, value, "withdraw", admin.id, null, "站长抽回资金")
  const res = await gameApply(env, params.currency, {
    userId: admin.id,
    delta: value,
    reason: "game_pool",
    detail: `从做市池取回 ${value} 积分`,
  })
  if (!res.applied && res.reason !== "duplicated") {
    // 到账失败：把池子的钱放回去，并记一条反向流水（不留「钱不见了」的状态）
    await addPool(env, params.currency, value, "adjust", admin.id, null, "取回失败回滚")
    throw new ApiError(500, "取回到账失败，已回滚", "WITHDRAW_FAILED")
  }
  await audit(env, admin.id, "collection.game.pool_withdraw", `${admin.username} 从做市池取回 ${value} 积分`)
  return { pool, balance: res.balance }
}

/**
 * 池子能不能接单。
 *
 * 池子为 0 意味着「上一批玩家把对手盘赢光了」—— 此时再开仓，赢了也赔不出来
 * （`settlePosition` 会把赔付封顶到 0，用户会看到「赚了但没到账」）。
 * 与其让人白玩，不如直接拒绝开仓并说明原因。
 */
/**
 * 当前货币对应的对手盘余额。
 *
 * ⚠️ 两种货币**各有各的池子**：真积分池 `pool_balance`、测试币池 `pool_test_balance`。
 *    所有「池子够不够赔付 / 市场深度是多少」的判断都必须走这里 ——
 *    否则切到测试币后，真积分池剩余的那点钱会变成测试币的市场深度（滑点算错）。
 */
function activePool(market: MarketRow, params: GameParams): number {
  return params.currency === "test"
    ? Number(market.pool_test_balance ?? 0)
    : Number(market.pool_balance ?? 0)
}

function assertPoolCanQuote(market: MarketRow, params: GameParams): void {
  if (activePool(market, params) <= 0) {
    throw new ApiError(
      409,
      "对手盘资金已见底，暂时无法开仓（等对手盘补充后再来，或先平掉已有持仓）",
      "POOL_EMPTY"
    )
  }
}

// ---------------------------------------------------------------------------
// 下单冲击：把玩家行为立刻反映到价格上
// ---------------------------------------------------------------------------

/**
 * 施加一次**瞬时**价格冲击（开仓/平仓是主动成交，理应立刻推价）。
 *
 * **返回施加之后的市价 —— 它就是这笔单的成交价**（调用方拿它当 entry_price）。
 * 这是本游戏定价模型的核心一句：**你吃掉了自己的冲击**。
 * 买入的成交价 = 被你自己推高后的价，卖出的成交价 = 被你自己压低后的价。
 * 于是「开多 → 立刻平多」只会亏掉手续费与来回滑点，而不是凭空赚一笔
 * （2026-10-11 实测：不这么做的话一进一出白赚 40 积分，可从池子里无限刷）。
 *
 * 用 `WHERE tick_seq = ?` 抢一次写权；抢输了就重读重算。
 * 冲击**允许丢失**（最多重试几次后放弃）—— 它只影响手感，不影响积分守恒；
 * 而池子手续费那种「必须落账」的写入走的是独立的原子 UPDATE（见 addPool）。
 */
async function applyOrderImpact(
  env: Env,
  params: GameParams,
  signedNotional: number,
  volume: number,
  now = Date.now()
): Promise<number> {
  let lastPrice = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    const market = await ensureMarket(env, params)
    lastPrice = market.price
    // 当前 K 线已经过期（跨分钟但还没推进）⇒ 先推进，保证冲击落进正确的那根 K 线
    if (candleOpenAt(now, params.candleMs) !== market.candle_open_at) {
      await advanceMarket(env, params, now)
      continue
    }

    const bps = orderImpactBps(signedNotional, activePool(market, params), params)
    if (bps === 0) return market.price
    const price = applyImpactBps(market.price, bps)
    const candle = mergeInto(candleOf(market), price, volume, 1)
    const iso = new Date(now).toISOString()

    const res = await env.DB.prepare(
      `UPDATE game_market SET
         price = ?, candle_high = ?, candle_low = ?, candle_close = ?,
         candle_volume = ?, candle_trades = ?,
         day_high = MAX(day_high, ?), day_low = MIN(day_low, ?),
         updated_at = ?
       WHERE id = 1 AND tick_seq = ?`
    )
      .bind(
        price, candle.highPrice, candle.lowPrice, candle.closePrice,
        candle.volume, candle.trades,
        price, price, iso, market.tick_seq
      )
      .run()

    if ((res.meta?.changes ?? 0) === 1) return price
  }
  // 几次都抢输：不再动市价，但成交必须按**当前真实价**撮合（宁可少赚也不能凭空给价）
  return lastPrice || (await ensureMarket(env, params)).price
}

// ---------------------------------------------------------------------------
// 开仓
// ---------------------------------------------------------------------------

export interface OpenResult {
  position: PositionRow
  price: number
  /** 是否命中幂等（重放同一个下单号） */
  duplicated: boolean
  /** 用户下单后的积分余额 */
  balance: number
}

/**
 * 开仓。
 *
 * 顺序（每一步的位置都有理由，别随意调整）：
 *   1. 推进行情 → 拿到最新价（也是这次成交的价）；
 *   2. 校验池子能不能接单、参数是否合法；
 *   3. **扣积分**（保证金 + 开仓手续费）。保证金离开用户账户进入**托管**
 *      （记在 `game_positions.margin` 上，不属于任何余额）；手续费进池子。
 *      余额不足会在 `applyPoints` 的条件 UPDATE 里直接失败 —— 不存在负余额；
 *   4. 手续费入池（独立原子 UPDATE，必须成功）；
 *   5. 价格冲击（允许失败）；
 *   6. 落持仓行 + 成交流水。
 *
 * 第 6 步失败（比如并发下 order_no 撞唯一索引）会把第 3 步的钱退回去 ——
 * 「扣了钱没拿到东西」是最糟的体验，与积分商城的处理一致。
 */
export async function openPosition(
  env: Env,
  user: UserRow,
  input: {
    side: string
    leverage: unknown
    margin: unknown
    orderNo?: string
    /** 保证金模式：缺省逐仓（风险更小的那个，兜底更安全） */
    marginMode?: string
  }
): Promise<OpenResult> {
  const params = await loadGameParams(env)
  if (!params.enabled) {
    throw new ApiError(403, "造物典藏尚未开放", "GAME_DISABLED")
  }
  const side: Side = input.side === "short" ? "short" : "long"
  const marginMode = normalizeMarginMode(input.marginMode)

  const market = await advanceMarket(env, params)
  assertPoolCanQuote(market, params)

  const quote = quoteOpen(side, Number(input.margin), Number(input.leverage), market.price, params)
  if (!quote.ok) throw new ApiError(400, quote.error, "INVALID_INPUT")
  const q = quote.quote

  // 下单号：前端每次下单生成一个（幂等键）。长度限一下，避免被塞进超长字符串
  const orderNo = String(input.orderNo ?? "").trim().slice(0, 64) || uuid()

  const existing = await env.DB.prepare("SELECT * FROM game_positions WHERE order_no = ?")
    .bind(orderNo)
    .first<PositionRow>()
  if (existing) {
    if (existing.user_id !== user.id) {
      throw new ApiError(409, "下单号已被占用，请重试", "ORDER_CONFLICT")
    }
    return {
      position: existing,
      price: existing.entry_price,
      duplicated: true,
      balance: await gameBalance(env, params.currency, user.id),
    }
  }

  const total = q.margin + q.fee
  const deducted = await gameApply(env, params.currency, {
    userId: user.id,
    delta: -total,
    reason: "game_open",
    detail:
      `开${side === "long" ? "多" : "空"} ${q.leverage}x：保证金 ${q.margin} + 手续费 ${q.fee}`,
    dedupKey: `game:open:${orderNo}`,
  })
  if (!deducted.applied) {
    if (deducted.reason === "duplicated") {
      // 同一下单号的积分已经扣过（并发重放）—— 走到下面读已有持仓
      const raced = await env.DB.prepare("SELECT * FROM game_positions WHERE order_no = ?")
        .bind(orderNo)
        .first<PositionRow>()
      if (raced) {
        return {
          position: raced,
          price: raced.entry_price,
          duplicated: true,
          balance: await gameBalance(env, params.currency, user.id),
        }
      }
    }
    throw new ApiError(400, "积分不足，无法开仓", "INSUFFICIENT_POINTS")
  }

  // 手续费入池（必须成功：这是守恒等式的收入项）
  await addPool(env, params.currency, q.fee, "fee", user.id, orderNo, "开仓手续费")

  /**
   * 价格冲击 —— **必须在记 entry_price 之前施加**。
   *
   * `applyOrderImpact` 返回施加后的市价，**那就是这笔单的成交价**：
   * 买入成交在「被自己推高后」的价、卖出成交在「被自己压低后」的价。
   * 反过来写（先记旧价再推价）会让仓位一建立就浮盈，玩家立刻平仓就能把
   * 这笔钱从做市池里取走，反复「开多→平→开空→平」= 无风险刷池子
   * （2026-10-11 实测：一进一出白赚 40 积分；已有专门用例守着）。
   */
  const signed = side === "long" ? q.size : -q.size
  const fillPrice = await applyOrderImpact(env, params, signed, q.size)

  const now = new Date().toISOString()
  /**
   * 落仓：**同一人 + 同一方向 + 同一保证金模式只保留一行**（加仓算均价）。
   *
   * 站长 2026-10-11：「现在可以开多个仓位并且仓位之间价格独立，改为算平均价」。
   *   · 合并后的开仓价 = 按 **规模加权** 的平均（`averageEntryPrice`）；
   *   · size / margin / fee_open 累加；`leverage` 记**有效杠杆** = size / margin
   *     （两笔杠杆不同时也能自洽，爆仓价就是按它推的）；
   *   · 爆仓价按新均价重算 —— 止损线必须跟着真实成本走。
   *
   * ⚠️ 历史遗留：老版本允许同一方向开多行。这里会把查到的**所有**同桶在仓
   *    并进其中最早的那一行（保留它的 id），并把被并掉的行的**开仓流水**
   *    改挂到这一行上 —— 否则那些流水会永远显示「持仓中」（它们没有对应的平仓行）。
   *    并完删掉空壳行：保证金已经挪进目标行，托管总额不变，守恒等式不受影响。
   */
  let positionId: string
  try {
    positionId = await mergeOrCreatePosition(env, {
      userId: user.id,
      side,
      marginMode,
      leverage: q.leverage,
      addSize: q.size,
      addMargin: q.margin,
      addFee: q.fee,
      fillPrice,
      now,
      tickSeq: market.tick_seq,
      orderNo,
      maintenanceBps: params.maintenanceBps,
    })
  } catch (err) {
    // 落库失败 ⇒ 退回保证金 + 手续费，并从池子里扣回那笔手续费（不能白赚）
    await gameApply(env, params.currency, {
      userId: user.id,
      delta: total,
      reason: "game_settle",
      detail: `开仓失败退回 ${total} 积分`,
      dedupKey: `game:open-refund:${orderNo}`,
    })
    await addPool(env, params.currency, -q.fee, "adjust", user.id, orderNo, "开仓失败退回手续费")
    const raced = await env.DB.prepare("SELECT * FROM game_positions WHERE order_no = ?")
      .bind(orderNo)
      .first<PositionRow>()
    if (raced && raced.user_id === user.id) {
      return {
        position: raced,
        price: raced.entry_price,
        duplicated: true,
        balance: await gameBalance(env, params.currency, user.id),
      }
    }
    throw err
  }

  await env.DB.prepare(
    `INSERT INTO game_trades
       (id, user_id, position_id, kind, side, leverage, price, size, margin, fee, pnl,
        balance_after, created_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  )
    .bind(uuid(), user.id, positionId, side, q.leverage, fillPrice, q.size, q.margin, q.fee, deducted.balance, now)
    .run()

  await audit(
    env,
    user.id,
    "collection.game.open",
    `${user.username} 开${side === "long" ? "多" : "空"} ${q.leverage}x` +
      `（${marginMode === "cross" ? "全仓" : "逐仓"}），保证金 ${q.margin}，成交价 ${fillPrice.toFixed(4)}`
  )

  const position = await env.DB.prepare("SELECT * FROM game_positions WHERE id = ?")
    .bind(positionId)
    .first<PositionRow>()
  if (!position) throw new ApiError(500, "开仓落库异常", "POSITION_MISSING")

  return { position, price: fillPrice, duplicated: false, balance: deducted.balance }
}

// ---------------------------------------------------------------------------
// 开仓：合并（加仓算均价）
// ---------------------------------------------------------------------------

/**
 * 找出「同一人 + 同一方向 + 同一保证金模式」的所有在仓，按开仓时间升序。
 *
 * 用 `opened_at` 升序是为了让**最早那一行**当合并目标 —— 它的 id 已经写在
 * 历史流水里了，保留它，用户的交易记录才不会出现「无开仓记录」的断档。
 */
async function findOpenBucket(
  env: Env,
  userId: string,
  side: Side,
  marginMode: MarginMode
): Promise<PositionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM game_positions
      WHERE user_id = ? AND side = ? AND margin_mode = ? AND status = 'open'
      ORDER BY opened_at ASC, id ASC`
  )
    .bind(userId, side, marginMode)
    .all<PositionRow>()
  return rows.results ?? []
}

interface MergeInput {
  userId: string
  side: Side
  marginMode: MarginMode
  /** 本笔的杠杆（仅新开行用；合并时记有效杠杆 = size/margin） */
  leverage: number
  addSize: number
  addMargin: number
  addFee: number
  fillPrice: number
  now: string
  tickSeq: number
  orderNo: string
  maintenanceBps: number
}

/**
 * 落仓：没有同桶在仓就新建一行，有就**并进去**（加仓算均价）。
 *
 * 返回最终持仓的 id（新开时是新行，合并时是最早那一行的 id）。
 *
 * ⚠️ 并发：加仓是「读—算—条件写」。条件里带上读到的 `size`/`margin`，
 *    抢输的一方 `changes === 0`，重读重算 —— 否则两笔同时加仓会算丢一笔。
 *    重试若干次仍失败就抛错，让上层走「退款」路径（宁可让用户重试，
 *    也不能把保证金记成错的数）。
 */
async function mergeOrCreatePosition(env: Env, input: MergeInput): Promise<string> {
  const { userId, side, marginMode, maintenanceBps } = input

  for (let attempt = 0; attempt < 4; attempt++) {
    const bucket = await findOpenBucket(env, userId, side, marginMode)

    // ---- 没有同桶在仓：新建 ----
    if (bucket.length === 0) {
      const id = uuid()
      // 全仓的 liq_price 只是「本仓估算值」，真正的判据在强平扫描里按账户算；
      // 逐仓则是权威值（SQL 直接按它筛）。
      const liq =
        marginMode === "cross"
          ? crossLiqPrice(side, input.fillPrice, input.addSize, input.addMargin, 0, maintenanceBps)
          : liquidationPrice(side, input.fillPrice, input.leverage, maintenanceBps)
      await env.DB.prepare(
        `INSERT INTO game_positions
           (id, user_id, side, leverage, margin, entry_price, size, liq_price, status,
            opened_at, open_tick, fee_open, order_no, margin_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`
      )
        .bind(
          id, userId, side, input.leverage, input.addMargin, input.fillPrice, input.addSize, liq,
          input.now, input.tickSeq, input.addFee, input.orderNo, marginMode
        )
        .run()
      return id
    }

    // ---- 有在仓：并进最早的那一行 ----
    const target = bucket[0]
    const oldSize = bucket.reduce((s, p) => s + p.size, 0)
    const oldMargin = bucket.reduce((s, p) => s + p.margin, 0)
    const oldFee = bucket.reduce((s, p) => s + p.fee_open, 0)
    const oldCost = bucket.reduce((s, p) => s + p.size * p.entry_price, 0)

    const newSize = oldSize + input.addSize
    const newMargin = oldMargin + input.addMargin
    const newFee = oldFee + input.addFee
    // 规模加权均价：新均价 = (旧总成本 + 本笔名义×成交价) / 新总规模
    const newEntry = averageEntryPrice(oldSize, oldCost / Math.max(oldSize, 1e-9), input.addSize, input.fillPrice)
    const newLeverage = newMargin > 0 ? newSize / newMargin : input.leverage
    const newLiq =
      marginMode === "cross"
        ? crossLiqPrice(side, newEntry, newSize, newMargin, 0, maintenanceBps)
        : liquidationPrice(side, newEntry, newLeverage, maintenanceBps)

    // 条件写：带上读到的 size/margin，抢输就重试
    const res = await env.DB.prepare(
      `UPDATE game_positions SET
         size = ?, margin = ?, entry_price = ?, leverage = ?, liq_price = ?,
         fee_open = ?, order_no = COALESCE(order_no, ?)
       WHERE id = ? AND status = 'open' AND size = ? AND margin = ?`
    )
      .bind(
        newSize, newMargin, newEntry, newLeverage, newLiq,
        newFee, input.orderNo,
        target.id, target.size, target.margin
      )
      .run()
    if ((res.meta?.changes ?? 0) !== 1) continue // 有人同时加仓 ⇒ 重读重算

    // 把被并掉的那些空壳行清掉，并把它们的**开仓流水**改挂到目标行
    for (const dup of bucket.slice(1)) {
      await env.DB.prepare(
        "UPDATE game_trades SET position_id = ? WHERE position_id = ? AND kind = 'open'"
      )
        .bind(target.id, dup.id)
        .run()
      await env.DB.prepare("DELETE FROM game_positions WHERE id = ? AND status = 'open'")
        .bind(dup.id)
        .run()
    }
    return target.id
  }

  throw new ApiError(409, "下单冲突，请重试", "ORDER_CONFLICT")
}

/**
 * 把「同一人 + 同一方向 + 同一模式」的重复在仓合并成一行（**不含新成交**的纯合并）。
 *
 * 用途是**懒迁移**：老版本允许多行并存，那些行不会自己消失，站长打开页面时
 * 看到的还是「好几个独立仓位」。与其写一段有风险的生产 SQL 去改真实持仓，
 * 不如在每次读 `/state` 时顺手检查 —— 有重复桶就按与加仓**同一套逻辑**合并，
 * 走的是已经在单测里跑过的代码路径，也不需要人工介入。
 *
 * 返回合并掉的**行数**（0 表示没有重复）。
 */
export async function consolidateUserBuckets(
  env: Env,
  userId: string,
  maintenanceBps: number
): Promise<number> {
  const dup = await env.DB.prepare(
    `SELECT side, margin_mode FROM game_positions
      WHERE user_id = ? AND status = 'open'
      GROUP BY side, margin_mode HAVING COUNT(*) > 1`
  )
    .bind(userId)
    .all<{ side: string; margin_mode: string }>()

  let merged = 0
  for (const b of dup.results ?? []) {
    merged += await consolidateBucket(
      env,
      userId,
      b.side === "short" ? "short" : "long",
      normalizeMarginMode(b.margin_mode),
      maintenanceBps
    )
  }
  return merged
}

/** 单个桶的纯合并（见 `consolidateUserBuckets` 的说明） */
async function consolidateBucket(
  env: Env,
  userId: string,
  side: Side,
  marginMode: MarginMode,
  maintenanceBps: number
): Promise<number> {
  const bucket = await findOpenBucket(env, userId, side, marginMode)
  if (bucket.length <= 1) return 0

  const target = bucket[0]
  const size = bucket.reduce((s, p) => s + p.size, 0)
  const margin = bucket.reduce((s, p) => s + p.margin, 0)
  const fee = bucket.reduce((s, p) => s + p.fee_open, 0)
  const cost = bucket.reduce((s, p) => s + p.size * p.entry_price, 0)
  const entry = size > 0 ? cost / size : target.entry_price
  const leverage = margin > 0 ? size / margin : target.leverage
  const liq =
    marginMode === "cross"
      ? crossLiqPrice(side, entry, size, margin, 0, maintenanceBps)
      : liquidationPrice(side, entry, leverage, maintenanceBps)

  const res = await env.DB.prepare(
    `UPDATE game_positions SET
       size = ?, margin = ?, entry_price = ?, leverage = ?, liq_price = ?, fee_open = ?
     WHERE id = ? AND status = 'open' AND size = ? AND margin = ?`
  )
    .bind(size, margin, entry, leverage, liq, fee, target.id, target.size, target.margin)
    .run()
  if ((res.meta?.changes ?? 0) !== 1) return 0

  for (const dupRow of bucket.slice(1)) {
    await env.DB.prepare(
      "UPDATE game_trades SET position_id = ? WHERE position_id = ? AND kind = 'open'"
    )
      .bind(target.id, dupRow.id)
      .run()
    await env.DB.prepare("DELETE FROM game_positions WHERE id = ? AND status = 'open'")
      .bind(dupRow.id)
      .run()
  }
  return bucket.length - 1
}

// ---------------------------------------------------------------------------
// 平仓
// ---------------------------------------------------------------------------

export interface CloseResult {
  position: PositionRow
  /** 本次到账（含返还的保证金，已扣平仓手续费） */
  credit: number
  fee: number
  pnl: number
  /** 是否因为池子余额不足而没赔满 */
  capped: boolean
  balance: number
  /** 调用前该仓位就已经不是 open 状态（幂等 / 已被强平） */
  alreadyClosed: boolean
}

/**
 * 平仓（用户主动）。
 *
 * 顺序：**先 CAS 占位（status: open → closed）再结算**。
 * 抢输的一方（并发点两次、或刚好同时被强平）直接返回当前状态，
 * 绝不会重复给钱。结算本身也带幂等键（`game:close:<持仓id>`），
 * 所以即使中间被打断、人工重放一次，也不会多给。
 */
export async function closePosition(
  env: Env,
  user: UserRow,
  positionId: string
): Promise<CloseResult> {
  const params = await loadGameParams(env)
  const market = await advanceMarket(env, params)

  const pos = await env.DB.prepare("SELECT * FROM game_positions WHERE id = ?")
    .bind(positionId)
    .first<PositionRow>()
  // 不区分「不存在」与「不是你的」：后者会泄露他人持仓的存在性
  if (!pos || pos.user_id !== user.id) {
    throw new ApiError(404, "持仓不存在", "NOT_FOUND")
  }

  if (pos.status !== "open") {
    return {
      position: pos,
      credit: 0,
      fee: pos.fee_close,
      pnl: pos.pnl ?? 0,
      capped: false,
      balance: await gameBalance(env, params.currency, user.id),
      alreadyClosed: true,
    }
  }

  /**
   * 平仓也是**市价单**：成交价必须含本次冲击。
   *
   * 平多 = 卖出 ⇒ 冲击为负 ⇒ 成交价低于盘口；平空反之。
   * 与开仓合起来就构成了完整的滑点模型：**一进一出必然亏掉「开仓冲击 + 平仓冲击」**，
   * 这笔钱进做市池 —— 这正是池子能长期赔付的来源，也是「来回刷单白拿钱」的封堵点
   * （只修开仓那一半的话，玩家仍能靠「平仓不滑点」把开仓冲击赚回来）。
   *
   * ⚠️ 结算用的是**这里预先算出的成交价**，市价的实际改动放在 CAS 抢到之后做 ——
   *    抢输的一方绝不能动价格。
   */
  const closeSigned = pos.side === "long" ? -pos.size : pos.size
  const exitPrice = applyImpactBps(
    market.price,
    orderImpactBps(closeSigned, activePool(market, params), params)
  )

  // 行情可能在推进过程中已经把它强平了，这里再判一次（读的是刚推进后的价格）
  const settled = settlePosition({
    side: pos.side === "short" ? "short" : "long",
    entryPrice: pos.entry_price,
    exitPrice,
    size: pos.size,
    margin: pos.margin,
    feeCloseBps: params.feeCloseBps,
    poolBalance: activePool(market, params),
  })

  const now = new Date().toISOString()
  const note = settled.capped
    ? "盈利受对手盘余额上限限制，未足额赔付"
    : null

  const claim = await env.DB.prepare(
    `UPDATE game_positions SET
       status = 'closed', closed_at = ?, close_price = ?, pnl = ?, fee_close = ?, note = ?
     WHERE id = ? AND status = 'open'`
  )
    .bind(now, exitPrice, settled.paidPnl, settled.fee, note, positionId)
    .run()

  if ((claim.meta?.changes ?? 0) !== 1) {
    // 被并发（另一路平仓 / 强平扫描）抢先了 —— 读最新状态返回，不做任何结算
    const fresh = await env.DB.prepare("SELECT * FROM game_positions WHERE id = ?")
      .bind(positionId)
      .first<PositionRow>()
    return {
      position: fresh ?? pos,
      credit: 0,
      fee: fresh?.fee_close ?? 0,
      pnl: fresh?.pnl ?? 0,
      capped: false,
      balance: await gameBalance(env, params.currency, user.id),
      alreadyClosed: true,
    }
  }

  // 抢到了才动市价：这一笔卖出/买入把价格推走
  await applyOrderImpact(env, params, closeSigned, pos.size)

  // 池子先记账（含收入与赔付；负值也会被 MAX(0,…) 兜住不会透支）
  await addPool(
    env,
    params.currency,
    settled.poolDelta,
    settled.poolDelta >= 0 ? "intake" : "payout",
    user.id,
    positionId,
    note ?? (settled.poolDelta >= 0 ? "玩家平仓亏损" : "赔付玩家盈利")
  )

  // 再给用户到账。delta 为 0 时 applyPoints 会拒绝（「积分变动值无效」），
  // 那种情况说明保证金刚好亏光 —— 本来就没有钱可给。
  let balance = await gameBalance(env, params.currency, user.id)
  if (settled.credit > 0) {
    const credited = await gameApply(env, params.currency, {
      userId: user.id,
      delta: settled.credit,
      reason: "game_settle",
      detail:
        `平${pos.side === "long" ? "多" : "空"} ${pos.leverage}x 结算：` +
        `盈亏 ${settled.paidPnl >= 0 ? "+" : ""}${settled.paidPnl}，手续费 ${settled.fee}`,
      dedupKey: `game:close:${positionId}`,
    })
    balance = credited.balance
  }

  await env.DB.prepare(
    `INSERT INTO game_trades
       (id, user_id, position_id, kind, side, leverage, price, size, margin, fee, pnl,
        balance_after, created_at)
     VALUES (?, ?, ?, 'close', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      uuid(), user.id, positionId, pos.side, pos.leverage, exitPrice, pos.size,
      pos.margin, settled.fee, settled.paidPnl, balance, now
    )
    .run()

  await audit(
    env,
    user.id,
    "collection.game.close",
    `${user.username} 平仓 ${positionId}，盈亏 ${settled.paidPnl}，成交价 ${exitPrice.toFixed(4)}`
  )

  const position = await env.DB.prepare("SELECT * FROM game_positions WHERE id = ?")
    .bind(positionId)
    .first<PositionRow>()

  return {
    position: position ?? pos,
    credit: settled.credit,
    fee: settled.fee,
    pnl: settled.paidPnl,
    capped: settled.capped,
    balance,
    alreadyClosed: false,
  }
}

// ---------------------------------------------------------------------------
// 强平
// ---------------------------------------------------------------------------

export interface LiquidationSweep {
  liquidated: PositionRow[]
  /** 强平造成的价格冲击（bps），正=向上 */
  impactBps: number
}

/**
 * 扫描并强平所有触及爆仓价的仓位。
 *
 * 强平本身也是**市价单**（系统在砸/拉盘），所以它会推价 ——
 * 这带来一个有意思的连锁反应：一轮急跌会引爆多单，强平又进一步压低价格。
 * 冲击在扫描结束后**一次性**施加（而不是逐个施加），避免扫到一半价格变化
 * 导致同一次扫描里的判定基准不一致。
 *
 * 一次最多 `LIQUIDATE_LIMIT` 个（仓位规模到那个量级要改成增量扫描，见文件头）。
 * 顺序按 id：稳定、可复现，且不会因为排序抖动而每次都扫到同一批。
 */
export async function sweepLiquidations(
  env: Env,
  params: GameParams,
  market: MarketRow
): Promise<LiquidationSweep> {
  const price = market.price
  /**
   * ⚠️ 这里只扫**逐仓**：逐仓的强平判据是「价格穿过自己的爆仓价」，
   *    一句话就能写成 SQL 条件，交给数据库筛最快。
   *    全仓的判据是**账户级**的（权益 < 维持保证金），SQL 写不出来，
   *    走下面的 `sweepCrossAccounts`。
   */
  const rows = await env.DB.prepare(
    `SELECT * FROM game_positions
      WHERE status = 'open' AND margin_mode = 'isolated'
        AND ((side = 'long'  AND liq_price >= ?)
          OR (side = 'short' AND liq_price <= ?))
      ORDER BY id
      LIMIT ?`
  )
    .bind(price, price, LIQUIDATE_LIMIT)
    .all<PositionRow>()

  const list = rows.results ?? []
  const cross = await sweepCrossAccounts(env, params, market, Math.max(0, LIQUIDATE_LIMIT - list.length))
  if (list.length === 0 && cross.positions.length === 0) {
    return { liquidated: [], impactBps: 0 }
  }

  const now = new Date().toISOString()
  const done: PositionRow[] = []
  let signedNotional = 0

  for (const pos of list) {
    const claim = await env.DB.prepare(
      `UPDATE game_positions SET
         status = 'liquidated', closed_at = ?, close_price = ?, pnl = ?, fee_close = 0,
         note = '触发强平，保证金全额损失'
       WHERE id = ? AND status = 'open'`
    )
      .bind(now, price, -pos.margin, pos.id)
      .run()
    if ((claim.meta?.changes ?? 0) !== 1) continue

    // 强平：保证金全额归池（玩家拿不到任何返还）
    await addPool(env, params.currency, pos.margin, "intake", pos.user_id, pos.id, "强平保证金归池")

    await env.DB.prepare(
      `INSERT INTO game_trades
         (id, user_id, position_id, kind, side, leverage, price, size, margin, fee, pnl,
          balance_after, created_at)
       VALUES (?, ?, ?, 'liquidate', ?, ?, ?, ?, ?, 0, ?, NULL, ?)`
    )
      .bind(uuid(), pos.user_id, pos.id, pos.side, pos.leverage, price, pos.size, pos.margin, -pos.margin, now)
      .run()

    // 强平是反方向的市价单：多单被强平 = 卖出
    signedNotional += pos.side === "long" ? -pos.size : pos.size
    done.push({ ...pos, status: "liquidated", closed_at: now, close_price: price, pnl: -pos.margin })
  }

  // 全仓那批已经被 sweepCrossAccounts 标记完了，这里统一算它们的价格冲击
  for (const pos of cross.positions) {
    signedNotional += pos.side === "long" ? -pos.size : pos.size
    done.push(pos)
  }

  let impactBps = 0
  if (done.length > 0 && signedNotional !== 0) {
    impactBps = orderImpactBps(signedNotional, activePool(market, params), params)
    if (impactBps !== 0) {
      await applyOrderImpact(env, params, signedNotional, 0)
    }
  }

  return { liquidated: done, impactBps }
}

/**
 * 全仓强平扫描：按**用户**把全仓仓位当成一个账户来判。
 *
 * 判据（`crossAccount`）：`可用余额 + Σ(保证金 + 浮盈) < Σ 维持保证金` ⇒ 整组强平。
 * 这与逐仓有两点本质区别，也是「全仓」这个名字的含义：
 *   1. **可用余额为整组仓位担保** —— 所以余额越厚，爆仓价越远；
 *   2. 强平点上的亏损**可以超过某一行自己的保证金**，差额从余额追缴
 *      （`CrossAccount.shortfall` = 余额 − 维持保证金；恒 ≤ 余额，所以追得回来，
 *       不会出现「玩家欠站点钱」的穿仓）。
 *
 * 资金动作（每一步都成对，守恒等式不变）：
 *   · 每行保证金 → 池子（和逐仓一样记 'intake'）；
 *   · 追缴额：用户余额 → 池子（单独记一条，方便对账）。
 */
async function sweepCrossAccounts(
  env: Env,
  params: GameParams,
  market: MarketRow,
  limit: number
): Promise<{ positions: PositionRow[] }> {
  if (limit <= 0) return { positions: [] }
  const rows = await env.DB.prepare(
    `SELECT * FROM game_positions
      WHERE status = 'open' AND margin_mode = 'cross'
      ORDER BY user_id, opened_at
      LIMIT ?`
  )
    .bind(limit)
    .all<PositionRow>()
  const all = rows.results ?? []
  if (all.length === 0) return { positions: [] }

  // 按用户分组：一次查出该用户的全仓仓位（上面 LIMIT 可能截断，这里按组补齐）
  const byUser = new Map<string, PositionRow[]>()
  for (const p of all) {
    const list = byUser.get(p.user_id) ?? []
    list.push(p)
    byUser.set(p.user_id, list)
  }

  const now = new Date().toISOString()
  const done: PositionRow[] = []

  for (const userId of byUser.keys()) {
    // 补全该用户的全部全仓仓位（避免 LIMIT 截断导致少算维持保证金）
    const full = await env.DB.prepare(
      `SELECT * FROM game_positions
        WHERE user_id = ? AND status = 'open' AND margin_mode = 'cross'`
    )
      .bind(userId)
      .all<PositionRow>()
    const positions = full.results ?? []
    if (positions.length === 0) continue

    const balance = await gameBalance(env, params.currency, userId)
    const acct = crossAccount(
      positions.map((p) => ({
        side: p.side === "short" ? ("short" as Side) : ("long" as Side),
        entryPrice: p.entry_price,
        size: p.size,
        margin: p.margin,
      })),
      balance,
      market.price,
      params.maintenanceBps
    )
    if (!acct.liquidatable) continue

    // ---- 整组强平 ----
    // 先把追缴额从余额划走（余额不足时按实际余额兜底，绝不出现负余额）
    const shortfall = Math.min(acct.shortfall, balance)
    if (shortfall > 0) {
      const taken = await gameApply(env, params.currency, {
        userId,
        delta: -shortfall,
        reason: "game_settle",
        detail: `全仓强平追缴 ${shortfall} 积分（保证金不足抵扣）`,
        dedupKey: `game:cross-liq:${userId}:${market.tick_seq}`,
      })
      if (taken.applied) {
        await addPool(env, params.currency, shortfall, "intake", userId, null, "全仓强平追缴")
      }
    }

    for (const pos of positions) {
      const claim = await env.DB.prepare(
        `UPDATE game_positions SET
           status = 'liquidated', closed_at = ?, close_price = ?, pnl = ?, fee_close = 0,
           note = '全仓权益跌破维持保证金，整组强平'
         WHERE id = ? AND status = 'open'`
      )
        .bind(now, market.price, -pos.margin, pos.id)
        .run()
      if ((claim.meta?.changes ?? 0) !== 1) continue

      await addPool(env, params.currency, pos.margin, "intake", userId, pos.id, "全仓强平保证金归池")
      await env.DB.prepare(
        `INSERT INTO game_trades
           (id, user_id, position_id, kind, side, leverage, price, size, margin, fee, pnl,
            balance_after, created_at)
         VALUES (?, ?, ?, 'liquidate', ?, ?, ?, ?, ?, 0, ?, NULL, ?)`
      )
        .bind(uuid(), userId, pos.id, pos.side, pos.leverage, market.price, pos.size, pos.margin, -pos.margin, now)
        .run()

      done.push({ ...pos, status: "liquidated", closed_at: now, close_price: market.price, pnl: -pos.margin })
    }

    await audit(
      env,
      userId,
      "collection.game.cross-liquidate",
      `${positions.length} 个全仓仓位被强平（权益 ${acct.equity.toFixed(2)} < 维持 ${acct.maintenance.toFixed(2)}，追缴 ${shortfall}）`
    )
  }

  return { positions: done }
}

/**
 * 推进一次行情并顺手强平 —— **所有读写行情的地方都该走这个入口**。
 *
 * 只推进不强平的话，会出现「价格已经穿过爆仓价，但那个仓位还躺在 open 状态」：
 * 用户可以自己点平仓把损失止在穿价的那一点（比强平更划算），等于变相套利。
 */
export async function advanceAndSweep(
  env: Env,
  params: GameParams,
  now = Date.now()
): Promise<{ market: MarketRow; liquidated: number }> {
  let market = await advanceMarket(env, params, now)
  const sweep = await sweepLiquidations(env, params, market)
  if (sweep.liquidated.length > 0) {
    // 强平可能推了价，重读一次保证返回给前端的价格与库里一致
    market = (await loadMarket(env)) ?? market
  }
  return { market, liquidated: sweep.liquidated.length }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 我当前的持仓（只返回 open，按开仓时间倒序） */
export async function listMyPositions(env: Env, userId: string): Promise<PositionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM game_positions WHERE user_id = ? AND status = 'open'
      ORDER BY opened_at DESC LIMIT 100`
  )
    .bind(userId)
    .all<PositionRow>()
  return rows.results ?? []
}

/** 我的成交流水 */
export async function listMyTrades(
  env: Env,
  userId: string,
  limit = 50
): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM game_trades WHERE user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(userId, Math.min(Math.max(1, limit), 200))
    .all<Record<string, unknown>>()
  return rows.results ?? []
}

/**
 * K 线。
 *
 * 库里只存**基础周期**（默认 1 分钟的 `60s`）。请求更大的周期时在这里聚合：
 * 取回基础 K 线后在 JS 里分桶 —— 因为「桶的开盘价 = 第一根的开盘价、
 * 收盘价 = 最后一根的收盘价」在 SQL 里要写相关子查询，而 JS 里就是取首尾。
 *
 * ⚠️ 只取 `limit × 每桶根数` 行，上限 4000 行。等这个游戏攒够几周历史、
 *    15 分钟图需要几万行时，要改成 SQL 侧聚合（`strftime('%s', open_at)` 分桶）——
 *    现在做属于过早优化（游戏刚上线，历史只有几小时）。
 */
export async function listCandles(
  env: Env,
  params: GameParams,
  interval: string,
  limit: number
): Promise<{ interval: string; candles: Candle[] }> {
  const base = baseIntervalLabel(params)
  const baseMs = params.candleMs
  const wantMs = intervalMs(interval)
  const take = Math.min(Math.max(1, limit), 500)

  // 请求的周期比基础周期还小（或不是整数倍）⇒ 只能给基础周期，如实回报
  const bucketMs = wantMs && wantMs >= baseMs && wantMs % baseMs === 0 ? wantMs : baseMs
  const perBucket = Math.round(bucketMs / baseMs)
  const rowCap = 4000
  const wantRows = Math.min(take * perBucket, rowCap)

  const rows = await env.DB.prepare(
    `SELECT open_at, open_price, high_price, low_price, close_price, volume, trades
       FROM game_candles WHERE interval = ?
      ORDER BY open_at DESC LIMIT ?`
  )
    .bind(base, wantRows)
    .all<{
      open_at: string
      open_price: number
      high_price: number
      low_price: number
      close_price: number
      volume: number
      trades: number
    }>()

  // 查询是倒序取的（拿最近 N 根），聚合前翻回正序
  const asc = (rows.results ?? []).slice().reverse()

  if (perBucket <= 1) {
    return {
      interval: base,
      candles: asc.map((r) => ({
        openAt: r.open_at,
        openPrice: r.open_price,
        highPrice: r.high_price,
        lowPrice: r.low_price,
        closePrice: r.close_price,
        volume: r.volume,
        trades: r.trades,
      })),
    }
  }

  const out: Candle[] = []
  for (const r of asc) {
    const bucketAt = new Date(
      Math.floor(Date.parse(r.open_at) / bucketMs) * bucketMs
    ).toISOString()
    const last = out[out.length - 1]
    if (last && last.openAt === bucketAt) {
      last.highPrice = Math.max(last.highPrice, r.high_price)
      last.lowPrice = Math.min(last.lowPrice, r.low_price)
      last.closePrice = r.close_price
      last.volume += r.volume
      last.trades += r.trades
    } else {
      out.push({
        openAt: bucketAt,
        openPrice: r.open_price,
        highPrice: r.high_price,
        lowPrice: r.low_price,
        closePrice: r.close_price,
        volume: r.volume,
        trades: r.trades,
      })
    }
  }

  return {
    interval: `${Math.round(bucketMs / 1000)}s`,
    candles: out.slice(-take),
  }
}

export interface LeaderRow {
  username: string
  nickname: string | null
  hasAvatar: boolean
  profit: number
  trades: number
  isMe: boolean
}

/**
 * 盈亏榜。
 *
 * 口径：只统计**已了结**的仓位（close / liquidate）的已实现盈亏之和 ——
 * 在仓浮盈不算，否则「开一个大仓放着」就能霸榜，而且数值每两秒变一次。
 *
 * 时间窗口按**中国时区**切（与排行榜模块同一套 `siteOffsetHours` 口径）。
 */
export async function gameLeaderboard(
  env: Env,
  meId: string,
  range: "today" | "week" | "all"
): Promise<{ rows: LeaderRow[]; me: { rank: number; profit: number; trades: number } | null }> {
  let since: string | null = null
  if (range !== "all") {
    const offset = await siteOffsetHours(env)
    const c = new Date(Date.now() + offset * 3600_000)
    if (range === "today") {
      c.setHours(0, 0, 0, 0)
    } else {
      const daysSinceMonday = (c.getDay() + 6) % 7
      c.setDate(c.getDate() - daysSinceMonday)
      c.setHours(0, 0, 0, 0)
    }
    since = new Date(c.getTime() - offset * 3600_000).toISOString()
  }

  /**
   * ⚠️ 只统计**当前货币生效之后**的成交。
   * 切换货币时 `game_market.currency_since` 会被写成切换时刻，
   * 于是「真积分时代的盈亏」和「测试币时代的盈亏」不会混在一张榜上 ——
   * 两种货币的 1 分不是一回事，混着比毫无意义。
   */
  const marketRow = await loadMarket(env)
  const currencySince = marketRow?.currency_since ?? null
  if (currencySince && (!since || currencySince > since)) since = currencySince
  const where = since ? "AND t.created_at >= ?" : ""
  const params = since ? [since] : []

  const rows = await env.DB.prepare(
    `SELECT u.username AS username, u.nickname AS nickname, u.avatar_key AS avatar_key,
            SUM(t.pnl) AS profit, COUNT(*) AS trades
       FROM game_trades t JOIN users u ON u.id = t.user_id
      WHERE t.kind IN ('close','liquidate') AND u.status = 'active' ${where}
      GROUP BY t.user_id
      ORDER BY profit DESC, u.username ASC
      LIMIT 50`
  )
    .bind(...params)
    .all<{
      username: string
      nickname: string | null
      avatar_key: string | null
      profit: number
      trades: number
    }>()

  const mine = await env.DB.prepare(
    `SELECT COALESCE(SUM(t.pnl), 0) AS profit, COUNT(*) AS trades
       FROM game_trades t
      WHERE t.user_id = ? AND t.kind IN ('close','liquidate') ${where}`
  )
    .bind(meId, ...params)
    .first<{ profit: number; trades: number }>()

  const list = rows.results ?? []
  const myProfit = Number(mine?.profit ?? 0)
  const myTrades = Number(mine?.trades ?? 0)

  // 我的名次：比我赚得多的人 + 1（同分并列）
  let me: { rank: number; profit: number; trades: number } | null = null
  if (myTrades > 0) {
    const ahead = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT t.user_id, SUM(t.pnl) AS profit
           FROM game_trades t JOIN users u ON u.id = t.user_id
          WHERE t.kind IN ('close','liquidate') AND u.status = 'active' ${where}
          GROUP BY t.user_id
       ) WHERE profit > ?`
    )
      .bind(...params, myProfit)
      .first<{ c: number }>()
    me = { rank: Number(ahead?.c ?? 0) + 1, profit: myProfit, trades: myTrades }
  }

  return {
    rows: list.map((r) => ({
      username: r.username,
      nickname: r.nickname,
      hasAvatar: Boolean(r.avatar_key),
      profit: Number(r.profit ?? 0),
      trades: Number(r.trades ?? 0),
      isMe: false, // 由 handler 填（这里不知道用户名 → id 的映射）
    })),
    me,
  }
}

/** 池子审计流水 */
export async function poolLedger(env: Env, limit = 50): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    `SELECT l.*, u.username AS username FROM game_pool_ledger l
       LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC, l.id DESC LIMIT ?`
  )
    .bind(Math.min(Math.max(1, limit), 200))
    .all<Record<string, unknown>>()
  return rows.results ?? []
}

/** 全服统计（典藏设置页顶部） */
export async function gameStats(env: Env): Promise<Record<string, number>> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM game_positions WHERE status = 'open') AS openPositions,
       (SELECT COALESCE(SUM(margin), 0) FROM game_positions WHERE status = 'open') AS openMargin,
       (SELECT COALESCE(SUM(size), 0) FROM game_positions WHERE status = 'open') AS openSize,
       (SELECT COALESCE(SUM(size), 0) FROM game_positions WHERE status = 'open' AND side = 'long') AS longSize,
       (SELECT COALESCE(SUM(size), 0) FROM game_positions WHERE status = 'open' AND side = 'short') AS shortSize,
       (SELECT COUNT(*) FROM game_positions) AS totalPositions,
       (SELECT COUNT(*) FROM game_positions WHERE status = 'liquidated') AS liquidated,
       (SELECT COUNT(*) FROM game_positions WHERE status = 'closed') AS closed,
       (SELECT COUNT(*) FROM game_trades) AS totalTrades,
       (SELECT COUNT(*) FROM game_candles) AS candleCount`
  ).first<Record<string, number>>()
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(row ?? {})) {
    out[k] = Number(v ?? 0)
  }
  return out
}

// ---------------------------------------------------------------------------
// 重置行情（危险操作）
// ---------------------------------------------------------------------------

/**
 * 重置行情：价格回到初始价、锚归位、K 线清空、换一个新种子。
 *
 * ⚠️ **有在仓持仓时直接拒绝**。重置价格等于对所有人立刻重新定价：
 *    多单可能在「价格回到 100」的瞬间全部爆仓（或全部浮盈），
 *    那不是重置行情，那是凭空清算。必须先让仓位了结。
 *    （管理员可以用「暂停开仓」+ 等待，或手工把仓位平掉。）
 */
export async function resetMarket(
  env: Env,
  admin: GameAdminActor,
  params: GameParams
): Promise<MarketRow> {
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM game_positions WHERE status = 'open'"
  ).first<{ c: number }>()
  const count = Number(open?.c ?? 0)
  if (count > 0) {
    throw new ApiError(
      409,
      `还有 ${count} 个在仓持仓，重置行情会让它们瞬间被重新定价。请先等它们平仓或强平。`,
      "POSITIONS_OPEN"
    )
  }

  const now = Date.now()
  const iso = new Date(now).toISOString()
  const openAt = candleOpenAt(now, params.candleMs)
  const price = clampPrice(params.basePrice, 100)

  await env.DB.prepare("DELETE FROM game_candles").run()
  await env.DB.prepare(
    `UPDATE game_market SET
       price = ?, anchor = ?, tick_seq = 0, last_tick_at = ?, seed = ?,
       candle_open_at = ?, candle_open = ?, candle_high = ?, candle_low = ?, candle_close = ?,
       candle_volume = 0, candle_trades = 0, candle_ticks = 0,
       day_open_at = ?, day_open = ?, day_high = ?, day_low = ?, updated_at = ?
     WHERE id = 1`
  )
    .bind(
      price, price, iso, randomSeed(),
      openAt, price, price, price, price,
      openAt, price, price, price, iso
    )
    .run()

  await addPool(env, params.currency, 0, "adjust", admin.id, null, "重置行情")
  await audit(env, admin.id, "collection.game.reset", `${admin.username} 重置了在线投资行情`)

  const market = await loadMarket(env)
  if (!market) throw new ApiError(500, "重置后读取行情失败", "MARKET_MISSING")
  return market
}

export type { Side }
