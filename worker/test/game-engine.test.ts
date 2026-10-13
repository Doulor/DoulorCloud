// 造物典藏「在线投资」——**价格与结算引擎的纯函数测试**。
//
// 这个文件不碰 D1、不碰 HTTP，只验数学。四类重点：
//   1. 确定性随机：同一个 tick 重算结果必须完全一致（否则行情不可复盘、
//      并发下两个请求算出的价格会不一样，而库里只存得下一个）；
//   2. 价格的三个来源（订单流冲击 / 噪声 / 均值回复）各自的方向与量级；
//   3. 爆仓价与盈亏的公式（错了会让玩家凭空赚钱或凭空爆仓）；
//   4. **结算守恒**：`用户到账 + 池子变化 === 释放的保证金`。
//      这一条是全游戏「不凭空增发站内积分」的最后一道防线，
//      用批量随机输入做性质测试（property test），而不是只挑几个用例。
import { describe, it, expect } from "vitest"
import {
  MAX_PRICE,
  MIN_PRICE,
  applyImpactBps,
  candleOpenAt,
  clamp,
  clampPrice,
  computeFee,
  computePnl,
  gaussianUnit,
  hashUnit,
  liquidationPrice,
  mergeInto,
  newCandle,
  orderImpactBps,
  quoteOpen,
  sanitizeGameParams,
  settlePosition,
  stepPrice,
  type GameParams,
} from "../src/game-engine"

/** 一套「安静」的参数：噪声 0、无回复、锚固定 ⇒ 价格只受显式订单流影响 */
function quietParams(over: Partial<GameParams> = {}): GameParams {
  return {
    enabled: true,
    tickMs: 5000,
    candleMs: 60_000,
    maxLeverage: 20,
    minMargin: 10,
    feeOpenBps: 5,
    feeCloseBps: 5,
    maintenanceBps: 50,
    noiseBps: 0,
    impactBps: 500,
    meanReversionBps: 0,
    // 单测里默认**不给死区**：下面那些「均值回复」用例想验的是纯公式本身，
    // 死区行为另有专门用例（见「均值回复死区」那一组）。
    reversionDeadbandBps: 0,
    anchorFollowBps: 0,
    maxImpactBps: 300,
    basePrice: 100,
    ...over,
  }
}

describe("确定性随机", () => {
  it("同一 (seed, n) 永远给出同一个值", () => {
    const a = hashUnit("seed-abc", 12)
    const b = hashUnit("seed-abc", 12)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
  })

  it("不同 n / 不同 seed 会散开（不是常数）", () => {
    const values = new Set<number>()
    for (let i = 0; i < 64; i++) values.add(hashUnit("seed-abc", i))
    // 64 个样本里出现重复说明散列质量有问题
    expect(values.size).toBeGreaterThan(60)
    expect(hashUnit("seed-abc", 7)).not.toBe(hashUnit("seed-xyz", 7))
  })

  it("连续序号不呈线性（低位条纹会毁掉行情观感）", () => {
    // 相邻两个样本的差值如果高度规律（比如恒定），K 线会变成锯齿波
    const diffs: number[] = []
    for (let i = 0; i < 32; i++) {
      diffs.push(Math.abs(hashUnit("s", i + 1) - hashUnit("s", i)))
    }
    const uniq = new Set(diffs.map((d) => d.toFixed(6)))
    expect(uniq.size).toBeGreaterThan(25)
  })

  it("正态随机被截断在 ±4σ（防一次噪声打掉三成价格）", () => {
    let sawSpread = false
    for (let i = 0; i < 500; i++) {
      const z = gaussianUnit("g", i)
      expect(z).toBeGreaterThanOrEqual(-4)
      expect(z).toBeLessThanOrEqual(4)
      if (Math.abs(z) > 1) sawSpread = true
    }
    expect(sawSpread).toBe(true)
  })
})

describe("价格收口与时间对齐", () => {
  it("clampPrice 挡住 NaN / 溢出 / 负值", () => {
    expect(clampPrice(Number.NaN, 42)).toBe(42)
    expect(clampPrice(Number.POSITIVE_INFINITY, 42)).toBe(42)
    expect(clampPrice(-5)).toBe(MIN_PRICE)
    expect(clampPrice(1e12)).toBe(MAX_PRICE)
    expect(clampPrice(123.5)).toBe(123.5)
  })

  it("clamp 是闭区间", () => {
    expect(clamp(5, 1, 3)).toBe(3)
    expect(clamp(0, 1, 3)).toBe(1)
    expect(clamp(2, 1, 3)).toBe(2)
  })

  it("K 线开盘时刻按周期向下对齐", () => {
    const t = Date.parse("2026-10-11T12:34:56.789Z")
    expect(candleOpenAt(t, 60_000)).toBe("2026-10-11T12:34:00.000Z")
    expect(candleOpenAt(t, 300_000)).toBe("2026-10-11T12:30:00.000Z")
    expect(candleOpenAt(t, 15_000)).toBe("2026-10-11T12:34:45.000Z")
  })
})

describe("订单流冲击（玩家推价）", () => {
  it("净买入推高、净卖出压低，方向不能反", () => {
    const p = quietParams()
    expect(orderImpactBps(1000, 10_000, p)).toBeGreaterThan(0)
    expect(orderImpactBps(-1000, 10_000, p)).toBeLessThan(0)
    expect(orderImpactBps(0, 10_000, p)).toBe(0)
  })

  it("池子越空，同样资金推动越大（滑点自动放大 = 天然风控）", () => {
    const p = quietParams()
    const deep = orderImpactBps(500, 100_000, p)
    const thin = orderImpactBps(500, 1000, p)
    expect(thin).toBeGreaterThan(deep)
  })

  it("单笔冲击有硬顶（防一笔巨单把价格打穿）", () => {
    const p = quietParams({ maxImpactBps: 300 })
    expect(orderImpactBps(1e9, 100, p)).toBe(300)
    expect(orderImpactBps(-1e9, 100, p)).toBe(-300)
  })

  it("池子余额为 0 时用深度下限兜住，不会除零炸出天文数字", () => {
    const p = quietParams({ maxImpactBps: 300 })
    const bps = orderImpactBps(10_000, 0, p)
    expect(Number.isFinite(bps)).toBe(true)
    expect(Math.abs(bps)).toBeLessThanOrEqual(300)
  })

  it("applyImpactBps 与 bps 同向且按比例", () => {
    expect(applyImpactBps(100, 100)).toBeCloseTo(101, 6)
    expect(applyImpactBps(100, -100)).toBeCloseTo(99, 6)
    expect(applyImpactBps(100, 0)).toBe(100)
  })
})

describe("tick 演化", () => {
  it("噪声为 0 且无订单流时价格纹丝不动", () => {
    const p = quietParams()
    const r = stepPrice({ price: 100, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p })
    expect(r.price).toBe(100)
  })

  it("有噪声时价格会动，且同一个 tick 可复现", () => {
    const p = quietParams({ noiseBps: 20 })
    const args = { price: 100, anchor: 100, pool: 10_000, seq: 7, seed: "s", params: p }
    const a = stepPrice(args)
    const b = stepPrice(args)
    expect(a.price).toBe(b.price)
    expect(a.price).not.toBe(100)
  })

  it("正的订单流把价格推上去", () => {
    const p = quietParams()
    const r = stepPrice({
      price: 100, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p, signedFlow: 2000,
    })
    expect(r.price).toBeGreaterThan(100)
  })

  it("均值回复把偏离锚的价格拉回来，且不会越过锚", () => {
    const p = quietParams({ meanReversionBps: 500 })
    const above = stepPrice({ price: 120, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p })
    expect(above.price).toBeLessThan(120)
    expect(above.price).toBeGreaterThan(100)

    const below = stepPrice({ price: 80, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p })
    expect(below.price).toBeGreaterThan(80)
    expect(below.price).toBeLessThan(100)
  })

  it("锚跟随价格（慢），但不会瞬间重合", () => {
    const p = quietParams({ anchorFollowBps: 100 })
    const r = stepPrice({ price: 120, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p })
    expect(r.anchor).toBeGreaterThan(100)
    expect(r.anchor).toBeLessThan(120)
  })

  describe("均值回复死区（站长反馈：没人交易不该自己慢慢跌）", () => {
    /**
     * 这一段守着「静默期必须是直线」这条**产品承诺**。
     *
     * 踩过的坑：原来均值回复是按偏离比例**全额**收的，于是一笔单把价格推到 105
     * 之后，即使没有任何人再下单，价格也会每个 tick 被拉回锚一点 ——
     * 30 秒 tick + 50 bps 强度下约 −0.01%/分钟，在 1% 高度的图上肉眼可见，
     * 站长直接来问「为什么没人开仓它自己慢慢跌」。
     */
    it("偏离在死区内：**价格一动不动**（一个 tick 都不动）", () => {
      // 1.5% 的死区，1% 的偏离 ⇒ 回复量为 0
      const p = quietParams({ meanReversionBps: 500, reversionDeadbandBps: 150 })
      let price = 101
      const anchor = 100
      for (let i = 1; i <= 50; i++) {
        price = stepPrice({ price, anchor, pool: 10_000, seq: i, seed: "s", params: p }).price
      }
      expect(price).toBe(101)
    })

    it("边界上（正好等于死区）也不收", () => {
      const p = quietParams({ meanReversionBps: 500, reversionDeadbandBps: 150 })
      const r = stepPrice({ price: 101.5, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p })
      expect(r.price).toBe(101.5)
    })

    it("超出死区：只对**超出的部分**做回复，且不会掉进死区里", () => {
      const p = quietParams({ meanReversionBps: 500, reversionDeadbandBps: 100 })
      // 偏离 20%，死区 1% ⇒ 只对超出的 19% 收 500bps×19% = 95bps ⇒ 120 → 118.86
      const r = stepPrice({ price: 120, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p })
      expect(r.price).toBeCloseTo(118.86, 4)
      expect(r.price).toBeGreaterThan(101) // 仍然在死区之上
      expect(r.price).toBeLessThan(120)
    })

    it("死区为 0 时退回原来的行为（逐比例全额回复）", () => {
      const p = quietParams({ meanReversionBps: 500, reversionDeadbandBps: 0 })
      const r = stepPrice({ price: 120, anchor: 100, pool: 10_000, seq: 1, seed: "s", params: p })
      // 20% 偏离 × 5% = 1% ⇒ 120 → 118.8
      expect(r.price).toBeCloseTo(118.8, 4)
    })
  })

  it("价格永远不会越过上下限（长期单边也不会溢出）", () => {
    const p = quietParams({ noiseBps: 300, impactBps: 100_000, maxImpactBps: 3000 })
    let price = 100
    let anchor = 100
    for (let i = 1; i <= 3000; i++) {
      const r = stepPrice({
        price, anchor, pool: 50, seq: i, seed: "run", params: p, signedFlow: 500,
      })
      price = r.price
      anchor = r.anchor
      expect(Number.isFinite(price)).toBe(true)
      expect(price).toBeGreaterThanOrEqual(MIN_PRICE)
      expect(price).toBeLessThanOrEqual(MAX_PRICE)
    }
  })
})

describe("交易数学", () => {
  it("爆仓价：1 倍多单几乎跌光才爆，20 倍多单跌 4.5% 就爆", () => {
    const one = liquidationPrice("long", 100, 1, 50)
    expect(one).toBeCloseTo(0.5, 6)
    const twenty = liquidationPrice("long", 100, 20, 50)
    // 1/20 - 0.5% = 4.5%
    expect(twenty).toBeCloseTo(95.5, 6)
  })

  it("空单爆仓价在开仓价之上，且与多单对称", () => {
    const long = liquidationPrice("long", 100, 10, 50)
    const short = liquidationPrice("short", 100, 10, 50)
    expect(short).toBeGreaterThan(100)
    expect(100 - long).toBeCloseTo(short - 100, 6)
  })

  it("爆仓价永不为负（1 倍以上都成立）", () => {
    for (let lev = 1; lev <= 100; lev++) {
      expect(liquidationPrice("long", 100, lev, 50)).toBeGreaterThan(0)
    }
  })

  it("盈亏方向不能反：多单涨赚、空单涨亏", () => {
    expect(computePnl("long", 100, 110, 1000)).toBe(100)
    expect(computePnl("short", 100, 110, 1000)).toBe(-100)
    expect(computePnl("long", 100, 90, 1000)).toBe(-100)
    expect(computePnl("short", 100, 90, 1000)).toBe(100)
  })

  it("盈亏按名义规模算（杠杆放大的是盈亏），并取整到积分", () => {
    // margin 100 × 10 倍 = size 1000；涨 0.5% ⇒ 5 积分
    expect(computePnl("long", 100, 100.5, 1000)).toBe(5)
    // 0.05% ⇒ 0.5 ⇒ 四舍五入到 1
    expect(computePnl("long", 1000, 1000.5, 1000)).toBe(1)
  })

  it("脏输入不产生 NaN（金额为 0 或价格非法时返回 0）", () => {
    expect(computePnl("long", 0, 110, 1000)).toBe(0)
    expect(computePnl("long", 100, 110, 0)).toBe(0)
    expect(computePnl("long", 100, Number.NaN, 1000)).toBe(0)
  })

  it("手续费最小 1 积分 —— 否则粉尘单可以免费刷量", () => {
    // 200 名义 × 5bps = 0.1 → 不足 1，仍收 1
    expect(computeFee(200, 5)).toBe(1)
    expect(computeFee(100_000, 5)).toBe(50)
    expect(computeFee(0, 5)).toBe(0)
    expect(computeFee(1000, 0)).toBe(0)
  })
})

describe("开仓报价校验", () => {
  const p = quietParams()

  it("合法输入给出正确的报价", () => {
    const r = quoteOpen("long", 100, 10, 100, p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.quote.size).toBe(1000)
    expect(r.quote.entryPrice).toBe(100)
    expect(r.quote.liqPrice).toBeCloseTo(liquidationPrice("long", 100, 10, 50), 6)
    expect(r.quote.fee).toBe(computeFee(1000, 5))
  })

  it("低于最小保证金 / 杠杆越界 / 非法数字都被拒", () => {
    expect(quoteOpen("long", 5, 10, 100, p).ok).toBe(false)
    expect(quoteOpen("long", 100, 0, 100, p).ok).toBe(false)
    expect(quoteOpen("long", 100, 21, 100, p).ok).toBe(false)
    expect(quoteOpen("long", Number.NaN, 10, 100, p).ok).toBe(false)
    expect(quoteOpen("long", 100, 10, 0, p).ok).toBe(false)
  })

  it("保证金取整（不允许小数积分）", () => {
    const r = quoteOpen("long", 100.9, 10, 100, p)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.quote.margin).toBe(100)
  })
})

describe("结算守恒（本游戏不凭空增发积分的最后一道防线）", () => {
  it("正常盈利：到账 + 池子变化 === 释放的保证金", () => {
    const s = settlePosition({
      side: "long", entryPrice: 100, exitPrice: 105, size: 1000, margin: 100,
      feeCloseBps: 5, poolBalance: 10_000,
    })
    expect(s.rawPnl).toBe(50)
    expect(s.paidPnl).toBe(50)
    expect(s.capped).toBe(false)
    // 用户：拿回 100 保证金 + 50 盈利 − 手续费；池子：付出 50 但收手续费
    expect(s.credit + s.poolDelta).toBe(100)
  })

  it("正常亏损：亏损进池子，用户拿回剩下的保证金", () => {
    const s = settlePosition({
      side: "long", entryPrice: 100, exitPrice: 95, size: 1000, margin: 100,
      feeCloseBps: 5, poolBalance: 1000,
    })
    expect(s.paidPnl).toBe(-50)
    expect(s.poolDelta).toBeGreaterThan(0)
    expect(s.credit + s.poolDelta).toBe(100)
  })

  it("盈利超过池子余额时被截断，且池子不会被抽成负数", () => {
    const s = settlePosition({
      side: "long", entryPrice: 100, exitPrice: 200, size: 1000, margin: 100,
      feeCloseBps: 5, poolBalance: 300,
    })
    expect(s.capped).toBe(true)
    expect(s.paidPnl).toBe(300)
    expect(s.credit + s.poolDelta).toBe(100)
    // 池子付出 300 收到的只有手续费 ⇒ 剩余不为负
    expect(300 + s.poolDelta).toBeGreaterThanOrEqual(0)
  })

  it("价格跳空使名义亏损超过保证金时，玩家只亏保证金（池子也只收那么多）", () => {
    const s = settlePosition({
      side: "long", entryPrice: 100, exitPrice: 10, size: 1000, margin: 100,
      feeCloseBps: 5, poolBalance: 1000,
    })
    expect(s.paidPnl).toBe(-100) // 被限制在 −margin
    expect(s.credit).toBe(0)
    expect(s.poolDelta).toBe(100) // 手续费不再从别处扣 ⇒ 池子恰好收走保证金
    expect(s.credit + s.poolDelta).toBe(100)
  })

  it("保证金亏光时手续费不再收取（否则账对不上）", () => {
    const s = settlePosition({
      side: "long", entryPrice: 100, exitPrice: 10, size: 1000, margin: 100,
      feeCloseBps: 50, poolBalance: 1000,
    })
    expect(s.credit).toBe(0)
    expect(s.credit + s.poolDelta).toBe(100)
  })

  it("池子为空时最多只能赔 0（用户拿回保证金，手续费照常可能为 0）", () => {
    const s = settlePosition({
      side: "long", entryPrice: 100, exitPrice: 150, size: 1000, margin: 100,
      feeCloseBps: 5, poolBalance: 0,
    })
    expect(s.paidPnl).toBe(0)
    expect(s.capped).toBe(true)
    expect(s.credit + s.poolDelta).toBe(100)
  })

  it("性质测试：400 组随机输入下 credit + poolDelta 恒等于 margin，池子变化不会让池子变负", () => {
    // 用确定性伪随机（不依赖 Math.random），失败时可复现
    let x = 12345
    const rnd = () => {
      x = (x * 1103515245 + 12345) % 2147483648
      return x / 2147483648
    }
    for (let i = 0; i < 400; i++) {
      const margin = 1 + Math.floor(rnd() * 5000)
      const leverage = 1 + Math.floor(rnd() * 20)
      const size = margin * leverage
      const entry = 10 + rnd() * 990
      // 让价格能大幅波动（含穿价与暴涨），覆盖 capped 与跳空两个分支
      const exit = entry * (0.2 + rnd() * 2.6)
      const pool = Math.floor(rnd() * 20_000)
      const s = settlePosition({
        side: rnd() < 0.5 ? "long" : "short",
        entryPrice: entry,
        exitPrice: exit,
        size,
        margin,
        feeCloseBps: Math.floor(rnd() * 40),
        poolBalance: pool,
      })
      expect(s.credit).toBeGreaterThanOrEqual(0)
      expect(s.credit + s.poolDelta).toBe(margin)
      if (s.poolDelta < 0) {
        // 池子付出（赔付）时不能超过它自己的余额
        expect(-s.poolDelta).toBeLessThanOrEqual(pool)
      }
    }
  })
})

describe("K 线合并", () => {
  it("合并更新高低收与成交量，开盘价不变", () => {
    const c = newCandle("2026-10-11T00:00:00.000Z", 100)
    const after = mergeInto(c, 105, 10, 1)
    expect(after.openPrice).toBe(100)
    expect(after.highPrice).toBe(105)
    expect(after.lowPrice).toBe(100)
    expect(after.closePrice).toBe(105)
    expect(after.volume).toBe(10)
    expect(after.trades).toBe(1)

    const down = mergeInto(after, 95, 5, 1)
    expect(down.highPrice).toBe(105)
    expect(down.lowPrice).toBe(95)
    expect(down.closePrice).toBe(95)
    expect(down.volume).toBe(15)
  })

  it("成交量不接受负数", () => {
    const c = mergeInto(newCandle("t", 100), 100, -5, -3)
    expect(c.volume).toBe(0)
    expect(c.trades).toBe(0)
  })
})

describe("参数清洗", () => {
  const good = {
    enabled: "1", tickSeconds: "5", candleSeconds: "60", maxLeverage: "20",
    minMargin: "10", feeOpenBps: "5", feeCloseBps: "5", maintenanceBps: "50",
    noiseBps: "4", impactBps: "500", meanReversionBps: "50", anchorFollowBps: "5",
    maxImpactBps: "300", basePrice: "100",
  }

  it("正常值原样通过", () => {
    const p = sanitizeGameParams(good)
    expect(p.enabled).toBe(true)
    expect(p.tickMs).toBe(5000)
    expect(p.candleMs).toBe(60_000)
    expect(p.maxLeverage).toBe(20)
    expect(p.basePrice).toBe(100)
  })

  it("布尔口径与 getSettingBool 一致（1 / true 都算开）", () => {
    expect(sanitizeGameParams({ ...good, enabled: "0" }).enabled).toBe(false)
    expect(sanitizeGameParams({ ...good, enabled: "true" }).enabled).toBe(true)
    expect(sanitizeGameParams({ ...good, enabled: true }).enabled).toBe(true)
    expect(sanitizeGameParams({ ...good, enabled: null }).enabled).toBe(false)
  })

  it("离谱的值被收进合法区间（手滑多打两个 0 不会炸行情）", () => {
    const p = sanitizeGameParams({ ...good, maxLeverage: "100000", noiseBps: "-5", feeOpenBps: "99999" })
    expect(p.maxLeverage).toBe(100)
    expect(p.noiseBps).toBe(0)
    expect(p.feeOpenBps).toBe(1000)
  })

  it("脏值（NaN / 空串 / 乱码）回落到默认", () => {
    const p = sanitizeGameParams({
      ...good, tickSeconds: "abc", basePrice: "", maxLeverage: undefined,
    })
    expect(p.tickMs).toBe(5000)
    expect(p.basePrice).toBe(100)
    expect(p.maxLeverage).toBe(20)
  })

  it("一根 K 线至少装得下两个 tick（否则会出现空 K 线与边界怪象）", () => {
    const p = sanitizeGameParams({ ...good, tickSeconds: "60", candleSeconds: "10" })
    expect(p.candleMs).toBeGreaterThanOrEqual(p.tickMs * 2)
  })
})
