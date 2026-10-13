/**
 * 造物典藏 ·「在线投资」K 线合约 —— **价格与结算引擎（纯函数）**。
 *
 * 这个文件里**没有任何 IO**：不碰 D1、不碰 Request、不读设置。
 * 所有随机性都来自「种子 + 序号」的确定性哈希，所以：
 *   · 同一个 tick 重算一百次结果都一样（可测试、可审计、可复盘）；
 *   · 不依赖 Math.random，测试里不需要打桩。
 *
 * 状态机与落库在 `game-market.ts`，HTTP 在 `handlers/collection.ts`。
 *
 * ---------------------------------------------------------------------------
 * 价格是怎么动的（每个 tick 三项相加）
 * ---------------------------------------------------------------------------
 *   1. **订单流冲击** —— 玩家的净主动成交推动价格，这是「多人对抗」的载体。
 *      冲击大小 = 冲击系数 × 净名义额 / 深度，深度取做市池余额：
 *      **池子越空，同样资金推动越大**（滑点自动变大，这是天然风控）。
 *      下单时**立即**结算这一次冲击（见 orderImpactBps），不等下一个 tick，
 *      所以「我一买它就涨」是真的，而不是延迟一两秒的假手感。
 *   2. **随机噪声** —— 保证没人在线时 K 线也在走。没有它，休眠市场里开仓等于必输
 *      （等不到别人来推价）。
 *   3. **均值回复 + 慢锚定** —— 把 (price − anchor) 按比例收回，anchor 自身极慢跟随。
 *      防止单边行情无限上涨或砸到归零。
 *
 * 冲击与噪声都换算成 bps（万分之一）后叠加，最后一次性乘到价格上 ——
 * 避免「先乘噪声再乘冲击」这种顺序依赖（会让重算结果依赖实现细节）。
 *
 * ---------------------------------------------------------------------------
 * 结算与**积分守恒**
 * ---------------------------------------------------------------------------
 * 逐仓保证金模型：玩家最多亏掉自己的保证金，盈利受**做市池余额**封顶。
 * `settlePosition()` 的返回被设计成「用户到账 / 池子变化」之和恒等于零，
 * 这是全游戏「不凭空增发站内积分」的落点，`worker/test/game-market.test.ts`
 * 用随机模拟验证 `Σ用户余额 + pool_balance + Σ在仓保证金 = 常量`。
 */

/** 引擎运行参数（由 settings.ts 的 game_* 设置项读出，见 game-market.ts 的 loadGameParams） */
export interface GameParams {
  enabled: boolean
  /** 一个 tick 多少毫秒 */
  tickMs: number
  /** 一根 K 线多少毫秒 */
  candleMs: number
  maxLeverage: number
  minMargin: number
  feeOpenBps: number
  feeCloseBps: number
  maintenanceBps: number
  noiseBps: number
  impactBps: number
  /** 货币模式：points = 真积分（走 user_points）/ test = 测试币（走 game_test_balances） */
  currency: "points" | "test"
  /** 测试币首次领取额度（测试币是游戏内货币，不涉及真实积分） */
  testGrant: number
  meanReversionBps: number
  /**
   * 均值回复**死区**（bps）：偏离锚在这个范围内时完全不回收。
   *
   * 这是「没人交易就是一条直线」的实现方式：价格被一笔单推到 +1% 之后，
   * 只要还在死区里，就不会自己慢慢往回爬（那正是站长看到的「自己往下掉」）。
   */
  reversionDeadbandBps: number
  anchorFollowBps: number
  maxImpactBps: number
  basePrice: number
}

/** 价格上下限：防止浮点溢出 / 归零后无法恢复（0.01 ~ 100 万） */
export const MIN_PRICE = 0.01
export const MAX_PRICE = 1_000_000

/**
 * 冲击计算的**深度下限**。
 *
 * 池子余额理论上可以到 0（被玩家赚光）。此时 `净额 / 深度` 会除零，
 * 而用一个极小的深度会让一次小额下单产生天文数字的冲击。
 * 取一个固定下限，让「池子空了」的时候冲击封顶在 maxImpactBps 上，
 * 行为可预期（而不是靠浮点运气）。
 */
export const MIN_DEPTH = 100

/**
 * 单次推进最多补算多少个 tick（默认 240 步 ≈ 5 秒粒度下的 20 分钟）。
 *
 * 超过就**放弃补算并直接把时间对齐到当前**：长期没人访问（比如 cron 挂了半天）
 * 之后如果老老实实补完，单次请求要跑几十万步 —— 必然超时，而且补出来的
 * 那段行情也没人看到。对齐后价格连续（不跳空），代价是 K 线上少一段历史。
 */
export const MAX_CATCHUP_TICKS = 240

/** 交易对展示名（币种就叫 Doulor 币，计价单位是站内积分） */
export const GAME_SYMBOL = "DOULOR"
export const GAME_QUOTE = "积分"

// ---------------------------------------------------------------------------
// 确定性随机
// ---------------------------------------------------------------------------

/** FNV-1a + 两轮雪崩混合：把任意字符串压成 32 位无符号整数 */
function hash32(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  // ⚠️ 必须再搅两轮。FNV 的低位分布不好，直接拿去当 [0,1) 会看出明显的条纹
  //    （价格会以肉眼可见的周期抖动），这里用 murmur3 的终混函数。
  h ^= h >>> 16
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 3266489909) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** 确定性均匀随机数 ∈ [0, 1) */
export function hashUnit(seed: string, n: number): number {
  return hash32(`${seed}#${n}`) / 4294967296
}

/**
 * 确定性标准正态随机数（Box-Muller），截断到 ±4σ。
 *
 * 截断是必要的：正态分布理论上能掷出 8σ，在 5 秒一个 tick 的频率下
 * 「一次噪声把价格打掉 30%」这种事迟早会发生，而那既不像行情也很难解释。
 */
export function gaussianUnit(seed: string, seq: number): number {
  // u1 不能取 0（log(0) = -Infinity）；实际取值空间是 2^-32 步进，撞到 0 概率极低，
  // 但这是「概率极低但一旦发生就毁掉一整段行情」的位置，所以显式兜住。
  const u1 = Math.max(1e-9, hashUnit(seed, seq * 2))
  const u2 = hashUnit(seed, seq * 2 + 1)
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(-4, Math.min(4, z))
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** 价格收口：非有限值（NaN/Infinity）一律按锚价兜底，绝不让脏价格落库 */
export function clampPrice(p: number, fallback = MIN_PRICE): number {
  if (!Number.isFinite(p)) return fallback
  return clamp(p, MIN_PRICE, MAX_PRICE)
}

/** 把时间戳对齐到 K 线开盘时刻（ISO 字符串，UTC 整分/整刻） */
export function candleOpenAt(ts: number, candleMs: number): string {
  return new Date(Math.floor(ts / candleMs) * candleMs).toISOString()
}

/** 周期名 → 毫秒。5m / 15m 由 1m 的 K 线聚合得到，不单独落库 */
export const CANDLE_INTERVALS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
}

export function intervalMs(interval: string): number | null {
  return CANDLE_INTERVALS[interval] ?? null
}

// ---------------------------------------------------------------------------
// 价格演化
// ---------------------------------------------------------------------------

export interface StepInput {
  price: number
  anchor: number
  /** 做市池余额（冲击公式里的「深度」） */
  pool: number
  /** tick 序号（也是确定性随机的输入） */
  seq: number
  seed: string
  params: GameParams
  /** 本 tick 要额外叠加的净订单流（一般只有下单瞬间用，见 orderImpactBps） */
  signedFlow?: number
}

/**
 * 推进一个 tick，返回新的价格与锚。
 *
 * **静默期必须是一条直线**（站长 2026-10-11 反馈：「没人开仓它会慢慢的跌」）。
 * 原来的均值回复是**按偏离比例全额收**的：
 *   `revertBps = -meanReversionBps × (price − anchor) / anchor`
 * 于是一笔单把价格推到 105、锚还留在 104 时，**没有任何人交易**，价格也会每个 tick
 * 被拉回去一点 —— 30 秒一个 tick、50 bps 的强度下约 −0.01%/分钟，
 * 在 1% 高度的图上肉眼可见，看起来就是「自己在往下掉」。
 *
 * 现在加一条**死区**（`reversionDeadbandBps`）：
 *   · 偏离在死区内 ⇒ **回复量为 0**，价格纹丝不动（没人交易就是直线）；
 *   · 偏离超出死区 ⇒ 只对**超出的部分**做回复，把价格慢慢拉回死区边缘。
 *
 * 为什么死区外仍要回复：池子是对手盘，价格被极端推走且永久不回的话，
 * 停在极值上的时间越长，越有人能慢慢把差价从池子里兑走。
 * 「正常波动永久有效、极端偏离会被拉回」——两者都要。
 */
export function stepPrice(input: StepInput): { price: number; anchor: number } {
  const { price, anchor, pool, seq, seed, params } = input

  const noiseBps = gaussianUnit(seed, seq) * params.noiseBps
  const impactBps = orderImpactBps(input.signedFlow ?? 0, pool, params)
  const devFrac = anchor > 0 ? (price - anchor) / anchor : 0
  // `|| 0`：手工拼 params 的调用方（单测）可能没带这个字段 —— 缺省按「无死区」处理，
  // 与加死区之前的行为一致，不会因为漏传字段就整条公式变 NaN。
  const deadband = Math.max(0, params.reversionDeadbandBps || 0) / 10_000
  const excess =
    Math.abs(devFrac) <= deadband ? 0 : devFrac - Math.sign(devFrac) * deadband
  const revertBps = -params.meanReversionBps * excess

  const totalBps = noiseBps + impactBps + revertBps
  const nextPrice = clampPrice(price * (1 + totalBps / 10_000), price)

  // 锚极慢跟随（默认 5 bps/tick ≈ 时间常数 2000 tick ≈ 2.8 小时）。
  // 比回复速度慢一个量级 ⇒「偏离会被收回」这条性质保持成立。
  const nextAnchor = clampPrice(
    anchor + (nextPrice - anchor) * (params.anchorFollowBps / 10_000),
    anchor
  )

  return { price: nextPrice, anchor: nextAnchor }
}

/**
 * 净主动成交额造成的**瞬时**价格冲击（bps）。
 *
 * `signedNotional` 的符号即方向：正 = 净买入（开多 / 平空），负 = 净卖出。
 * 公式与 stepPrice 里的 impactBps 完全一致 —— 下单是「立刻走一步」，
 * 而不是等下一个 tick，这样手感才是实时的。
 */
export function orderImpactBps(
  signedNotional: number,
  pool: number,
  params: GameParams
): number {
  if (!Number.isFinite(signedNotional) || signedNotional === 0) return 0
  const depth = Math.max(pool, MIN_DEPTH)
  const raw = (params.impactBps * signedNotional) / depth
  return clamp(raw, -params.maxImpactBps, params.maxImpactBps)
}

/** 把 bps 冲击施加到价格上 */
export function applyImpactBps(price: number, bps: number): number {
  return clampPrice(price * (1 + bps / 10_000), price)
}

// ---------------------------------------------------------------------------
// 交易数学
// ---------------------------------------------------------------------------

export type Side = "long" | "short"

/**
 * 逐仓爆仓价。
 *
 * 逐仓下保证金 = size / leverage，亏损吃掉「保证金 − 维持保证金」时强平：
 *   多：entry − price = margin/size − mm ⇒ price = entry × (1 − 1/lev + mm)
 *   空：price − entry = margin/size − mm ⇒ price = entry × (1 + 1/lev − mm)
 *
 * 1 倍杠杆多单的爆仓价 = entry × 0.5%（要跌 99.5% 才爆），符合直觉。
 */
export function liquidationPrice(
  side: Side,
  entry: number,
  leverage: number,
  maintenanceBps: number
): number {
  const lev = clamp(Math.round(leverage), 1, 100)
  const mm = maintenanceBps / 10_000
  const ratio = 1 / lev - mm
  const p = side === "long" ? entry * (1 - ratio) : entry * (1 + ratio)
  return clampPrice(p, entry)
}

// ---------------------------------------------------------------------------
// 均价（加仓合并）与全仓保证金
// ---------------------------------------------------------------------------

/**
 * 保证金模式。
 *
 * · `isolated` 逐仓：亏损上限 = 该仓自己那笔保证金，价格穿过爆仓价就强平。
 * · `cross` 全仓：该仓和账户**可用余额**共同担保，只有账户权益跌破维持保证金才强平；
 *   亏损可以超过该仓保证金（差额从余额追缴）。
 *
 * 两者**不能混进同一行**：强平价与最大亏损完全不同。所以「同一人同一方向」
 * 会按模式各留一行，各自独立强平。
 */
export type MarginMode = "isolated" | "cross"

/** 归一化外部传入的模式（非法值一律当逐仓 —— 逐仓是风险更小的那个，兜底更安全） */
export function normalizeMarginMode(raw: unknown): MarginMode {
  return raw === "cross" ? "cross" : "isolated"
}

/** 维持保证金（名义规模 × 维持保证金率） */
export function maintenanceMargin(size: number, maintenanceBps: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0
  if (!Number.isFinite(maintenanceBps) || maintenanceBps <= 0) return 0
  return (size * maintenanceBps) / 10_000
}

/**
 * 加仓后的开仓均价 —— **按规模加权**（不是简单算术平均）。
 *
 * 这是交易所的通行口径：一笔 1000 名义 + 一笔 10 名义的加仓，
 * 均价当然应该由那 1000 主导。用算术平均会让一笔小额单把均价拽偏，
 * 那样加仓就变成了「用 10 积分撬动整仓成本」的操纵手法。
 */
export function averageEntryPrice(
  oldSize: number,
  oldEntry: number,
  addSize: number,
  addPrice: number
): number {
  const total = oldSize + addSize
  if (!(total > 0)) return addPrice
  if (!(oldSize > 0)) return addPrice
  return (oldSize * oldEntry + addSize * addPrice) / total
}

/**
 * 全仓的**本仓估算爆仓价**（把其它全仓仓位的浮盈浮亏当作不动）。
 *
 * 推导：账户权益 = 可用余额 + Σ(保证金 + 浮盈)，
 *       本仓亏损吃掉「保证金 + 可用余额 − 维持保证金」时触发。
 *       ⇒ ratio = (margin + balance − maint) / size，多单 price = entry×(1−ratio)。
 *
 * ⚠️ 全仓真正的强平判据是**账户级**的（`crossAccount().liquidatable`），
 *    这个函数只用于给用户看「离爆仓还有多远」，多仓/对冲时它是个估算值。
 *    已经不够维持（buffer ≤ 0）时返回极值价 —— 表示「马上就强平」，而不是编一个数。
 */
export function crossLiqPrice(
  side: Side,
  entry: number,
  size: number,
  margin: number,
  availableBalance: number,
  maintenanceBps: number
): number {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(size) || size <= 0) return 0
  const buffer = margin + Math.max(0, availableBalance) - maintenanceMargin(size, maintenanceBps)
  if (buffer <= 0) return side === "long" ? MIN_PRICE : MAX_PRICE
  const ratio = buffer / size
  const p = side === "long" ? entry * (1 - ratio) : entry * (1 + ratio)
  return clampPrice(p, MIN_PRICE)
}

/** 参与全仓账户计算的仓位（只要这几个字段，便于纯函数单测） */
export interface CrossPositionLike {
  side: Side
  entryPrice: number
  size: number
  margin: number
}

export interface CrossAccount {
  /** 已托管保证金合计 */
  escrow: number
  /** 浮动盈亏合计 */
  pnl: number
  /** 维持保证金合计 */
  maintenance: number
  /** 账户权益 = 可用余额 + 托管保证金 + 浮动盈亏 */
  equity: number
  /** 是否触发强平（权益 < 维持保证金）。空仓永不触发 */
  liquidatable: boolean
  /**
   * 触发强平时要从**可用余额**追缴的金额。
   *
   * 推导：强平点上 权益 = 维持保证金 ⇒ 总亏损 = 托管 + 余额 − 维持，
   * 托管那部分由「保证金归池」覆盖，差额就是这个追缴额。
   * 恒有 `shortfall ≤ 余额`（因为维持 ≥ 0），所以一定追得回来 —— 这是全仓不会穿仓的原因。
   */
  shortfall: number
}

/**
 * 全仓账户视图（纯函数）。
 *
 * 全仓的强平判据是**整组仓位 + 可用余额**：权益跌破维持保证金才强平。
 * 逐仓不用它（逐仓看每个仓位自己的价格）。
 */
export function crossAccount(
  positions: CrossPositionLike[],
  availableBalance: number,
  markPrice: number,
  maintenanceBps: number
): CrossAccount {
  let escrow = 0
  let pnl = 0
  let maintenance = 0
  for (const p of positions) {
    escrow += p.margin
    pnl += computePnl(p.side, p.entryPrice, markPrice, p.size)
    maintenance += maintenanceMargin(p.size, maintenanceBps)
  }
  const equity = Math.max(0, availableBalance) + escrow + pnl
  const liquidatable = positions.length > 0 && equity < maintenance
  // 追缴额 = 余额 − 维持保证金（不是「权益 − 维持」——托管保证金由「保证金归池」覆盖，
  // 再按权益算就重复扣了一遍）。恒有 shortfall ≤ 余额，因为维持保证金 ≥ 0。
  const shortfall = liquidatable
    ? Math.max(0, Math.max(0, availableBalance) - maintenance)
    : 0
  return { escrow, pnl, maintenance, equity, liquidatable, shortfall }
}

/**
 * 已实现盈亏（积分，四舍五入到整数）。
 *
 * 盈亏按**名义规模**算：`size × (exit − entry) / entry`。
 * `size = margin × leverage`，所以杠杆放大的是盈亏而不是本金。
 */
export function computePnl(side: Side, entry: number, exit: number, size: number): number {
  if (entry <= 0 || size <= 0) return 0
  const ratio = (exit - entry) / entry
  const raw = side === "long" ? size * ratio : -size * ratio
  if (!Number.isFinite(raw)) return 0
  return Math.round(raw)
}

/**
 * 手续费（积分）。
 *
 * ⚠️ **最小 1 积分**：5 bps 下 200 积分的名义额只有 0.1 分，四舍五入成 0
 * 就等于「小额交易完全免费」，可以拿它刷成交量与排行榜。
 * 1 积分的下限让粉尘单变得不划算（这也是 minMargin 存在的第二个理由）。
 */
export function computeFee(notional: number, bps: number): number {
  if (!Number.isFinite(notional) || notional <= 0) return 0
  if (!Number.isFinite(bps) || bps <= 0) return 0
  return Math.max(1, Math.round((notional * bps) / 10_000))
}

export interface OpenQuote {
  /** 保证金（用户输入，正整数） */
  margin: number
  leverage: number
  /** 名义规模 = margin × leverage */
  size: number
  entryPrice: number
  liqPrice: number
  fee: number
}

/**
 * 开仓报价。校验失败返回原因字符串（调用方转成 ApiError）。
 *
 * 纯函数 ⇒ 前端可以用同一份逻辑做「预估爆仓价 / 预估手续费」的实时展示，
 * 不会出现「面板显示的爆仓价与服务端算的不一致」。
 */
export function quoteOpen(
  side: Side,
  marginRaw: number,
  leverageRaw: number,
  price: number,
  params: GameParams
): { ok: true; quote: OpenQuote } | { ok: false; error: string } {
  const margin = Math.floor(marginRaw)
  const leverage = Math.floor(leverageRaw)

  if (!Number.isFinite(margin) || margin <= 0) return { ok: false, error: "保证金必须是正整数" }
  if (margin < params.minMargin) {
    return { ok: false, error: `单笔保证金不能少于 ${params.minMargin} 积分` }
  }
  if (!Number.isFinite(leverage) || leverage < 1) return { ok: false, error: "杠杆至少 1 倍" }
  if (leverage > params.maxLeverage) {
    return { ok: false, error: `杠杆最多 ${params.maxLeverage} 倍` }
  }
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "行情尚未就绪" }

  const size = margin * leverage
  return {
    ok: true,
    quote: {
      margin,
      leverage,
      size,
      entryPrice: price,
      liqPrice: liquidationPrice(side, price, leverage, params.maintenanceBps),
      fee: computeFee(size, params.feeOpenBps),
    },
  }
}

export interface SettlementInput {
  side: Side
  entryPrice: number
  exitPrice: number
  size: number
  margin: number
  feeCloseBps: number
  /** 平仓时的做市池余额（决定赔付上限） */
  poolBalance: number
}

export interface SettlementResult {
  /** 用户到账（积分，含返还的保证金；已扣平仓手续费） */
  credit: number
  /** 平仓手续费（实际收取额，受「最多只能从返还额里扣」限制） */
  fee: number
  /** 玩家盈亏（未受池子上限影响的名义值，可能为负） */
  rawPnl: number
  /** 实际结算给玩家的盈亏（受池子上限与「最多亏光保证金」约束后） */
  paidPnl: number
  /** 池子余额变化（不含开仓时已收取的手续费） */
  poolDelta: number
  /** 是否因为池子不够而没赔满 */
  capped: boolean
}

/**
 * 平仓结算。**积分守恒的落点**。
 *
 * 三条约束，任何一条放松都会破坏守恒等式（或被玩家套利）：
 *
 *   1. **玩家最多亏光自己的保证金**（逐仓）。价格跳空穿价时名义亏损可能超过保证金，
 *      超出部分不向用户追讨，池子也就少收那一块 —— 两边同时不认，守恒仍成立。
 *   2. **赔付以池子余额为上限**。池子是全体玩家的亏损累积，它没有第二份钱。
 *      不够就按池子里现有的赔付，并把 `capped` 标出来（前端会提示「受对手盘上限限制」）。
 *   3. **手续费只能从返还额里扣**。保证金亏光时返还额是 0，此时不能再从别处收手续费
 *      （否则凭空从用户账户扣一笔，或者池子记账多出一笔不存在的手续费 ⇒ 账对不上）。
 *
 * 验证：`credit + poolDelta - margin = 0`（用户在平仓这一步的净变化 + 池子变化 = 释放的保证金）。
 */
export function settlePosition(input: SettlementInput): SettlementResult {
  const { side, entryPrice, exitPrice, size, margin, feeCloseBps, poolBalance } = input

  const rawPnl = computePnl(side, entryPrice, exitPrice, size)

  // 约束 1：亏损最多吃掉保证金
  let paidPnl = Math.max(rawPnl, -margin)

  // 约束 2：盈利最多吃掉池子余额
  let capped = false
  if (paidPnl > 0 && paidPnl > poolBalance) {
    paidPnl = Math.max(0, Math.floor(poolBalance))
    capped = true
  }

  const payout = Math.max(0, margin + paidPnl)
  // 约束 3：手续费从返还额里扣
  const fee = Math.max(0, Math.min(computeFee(size, feeCloseBps), payout))
  const credit = payout - fee

  // 池子：付给玩家的盈利（paidPnl 为负时即收入玩家的亏损）+ 手续费
  const poolDelta = -paidPnl + fee

  return { credit, fee, rawPnl, paidPnl, poolDelta, capped }
}

// ---------------------------------------------------------------------------
// K 线
// ---------------------------------------------------------------------------

export interface Candle {
  openAt: string
  openPrice: number
  highPrice: number
  lowPrice: number
  closePrice: number
  volume: number
  trades: number
}

export function newCandle(openAt: string, price: number): Candle {
  return {
    openAt,
    openPrice: price,
    highPrice: price,
    lowPrice: price,
    closePrice: price,
    volume: 0,
    trades: 0,
  }
}

/** 把一笔成交（或一个 tick）合进当前 K 线 */
export function mergeInto(
  candle: Candle,
  price: number,
  volume = 0,
  trades = 0
): Candle {
  return {
    ...candle,
    highPrice: Math.max(candle.highPrice, price),
    lowPrice: Math.min(candle.lowPrice, price),
    closePrice: price,
    volume: candle.volume + Math.max(0, Math.round(volume)),
    trades: candle.trades + Math.max(0, Math.round(trades)),
  }
}

// ---------------------------------------------------------------------------
// 参数清洗
// ---------------------------------------------------------------------------

/**
 * 把（可能来自管理端表单或手改库的）原始值收口成合法参数。
 *
 * 为什么要有它而不是信任 `updateSettings` 的写入校验：
 *   · 设置项在库里就是**字符串**，`getSettingNumber` 解析失败会回落到默认值，
 *     但解析成功却离谱的值（比如 maxLeverage = 100000）会直接进引擎；
 *   · 引擎自己再收一遍，成本是一次函数调用，收益是「任何脏值都炸不了行情」。
 */
export interface RawGameParams {
  enabled: unknown
  tickSeconds: unknown
  candleSeconds: unknown
  maxLeverage: unknown
  minMargin: unknown
  feeOpenBps: unknown
  feeCloseBps: unknown
  maintenanceBps: unknown
  noiseBps: unknown
  impactBps: unknown
  currency: unknown
  testGrant: unknown
  meanReversionBps: unknown
  reversionDeadbandBps: unknown
  anchorFollowBps: unknown
  maxImpactBps: unknown
  basePrice: unknown
}

/** 各参数的合法区间。上下限取「物理上还讲得通」的值，不是审美偏好 */
const PARAM_RANGES = {
  tickSeconds: [1, 3600],
  candleSeconds: [10, 86_400],
  maxLeverage: [1, 100],
  minMargin: [1, 1_000_000],
  feeOpenBps: [0, 1000],
  feeCloseBps: [0, 1000],
  maintenanceBps: [0, 5000],
  noiseBps: [0, 500],
  impactBps: [0, 100_000],
  testGrant: [0, 100_000_000],
  meanReversionBps: [0, 10_000],
  reversionDeadbandBps: [0, 10_000],
  anchorFollowBps: [0, 10_000],
  maxImpactBps: [1, 5000],
  basePrice: [MIN_PRICE, MAX_PRICE],
} as const

function num(raw: unknown, range: readonly [number, number], fallback: number): number {
  // ⚠️ 空串必须当「没填」处理，不能走 Number("") = 0 那条路：
  //    管理端的输入框清空后提交的就是 ""，被当成 0 再 clamp 到区间下限，
  //    会出现「清空价格输入框 ⇒ 初始价变成 0.01」这种莫名其妙的结果。
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === "string" && raw.trim() === "") return fallback
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return clamp(n, range[0], range[1])
}

export function sanitizeGameParams(raw: RawGameParams): GameParams {
  const tickSeconds = Math.round(num(raw.tickSeconds, PARAM_RANGES.tickSeconds, 5))
  // 一根 K 线至少要装得下两个 tick，否则会出现「空 K 线」（open=high=low=close，无成交）
  // 以及「一个 tick 跨两根 K 线」的边界怪象
  const candleSeconds = Math.max(
    Math.round(num(raw.candleSeconds, PARAM_RANGES.candleSeconds, 60)),
    tickSeconds * 2
  )
  const minMargin = Math.round(num(raw.minMargin, PARAM_RANGES.minMargin, 10))
  return {
    // 布尔口径与 settings.ts 的 getSettingBool 保持一致："1" / "true" 都算开
    enabled:
      raw.enabled === true ||
      raw.enabled === 1 ||
      String(raw.enabled ?? "").toLowerCase() === "true" ||
      String(raw.enabled ?? "") === "1",
    tickMs: tickSeconds * 1000,
    candleMs: candleSeconds * 1000,
    maxLeverage: Math.round(num(raw.maxLeverage, PARAM_RANGES.maxLeverage, 20)),
    minMargin,
    feeOpenBps: num(raw.feeOpenBps, PARAM_RANGES.feeOpenBps, 5),
    feeCloseBps: num(raw.feeCloseBps, PARAM_RANGES.feeCloseBps, 5),
    maintenanceBps: num(raw.maintenanceBps, PARAM_RANGES.maintenanceBps, 50),
    noiseBps: num(raw.noiseBps, PARAM_RANGES.noiseBps, 4),
    impactBps: num(raw.impactBps, PARAM_RANGES.impactBps, 500),
    // 货币模式：只认 "test"，其余一律按真积分（**兜底选真积分**：宁可少发游戏币，
    // 也不能因为一个拼错的值就把测试币当成积分发出去）
    currency: raw.currency === "test" ? "test" : "points",
    testGrant: num(raw.testGrant, PARAM_RANGES.testGrant, 10000),
    meanReversionBps: num(raw.meanReversionBps, PARAM_RANGES.meanReversionBps, 50),
    // 默认 150 bps（1.5%）：正常下单推出来的波动永久有效，
    // 只有被推到 1.5% 以上才慢慢往回收。
    reversionDeadbandBps: num(
      raw.reversionDeadbandBps,
      PARAM_RANGES.reversionDeadbandBps,
      150
    ),
    anchorFollowBps: num(raw.anchorFollowBps, PARAM_RANGES.anchorFollowBps, 5),
    maxImpactBps: num(raw.maxImpactBps, PARAM_RANGES.maxImpactBps, 300),
    basePrice: clampPrice(num(raw.basePrice, PARAM_RANGES.basePrice, 100), 100),
  }
}
