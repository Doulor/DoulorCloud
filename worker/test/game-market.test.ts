// 造物典藏「在线投资」——**状态机与记账的集成测试**（真 D1、真表结构）。
//
// 这个文件要守住的是「钱不会算错」这件事。四类重点：
//
//   1. **积分守恒**：随机模拟多个玩家反复开仓 / 平仓 / 强平，断言
//          Σ 用户余额 + 做市池余额 + Σ 在仓保证金 = 常量
//      这是本游戏「不凭空增发站内积分」的总验收。任何一处记账写错都会在这里现形。
//   2. **并发与幂等**：同一下单号重放不能扣两次分、不能开出两个仓；
//      平仓/强平用 `WHERE status='open'` 抢占，只有一个赢家。
//   3. **风控边界**：池子为空禁开仓、余额不足禁开仓、赔付以池子余额封顶
//      （且池子永不为负）。
//   4. **开关语义**：关掉游戏后不能开新仓，但**已有持仓仍可平**（不能把人锁死）。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, setSetting, type TestUser } from "./helpers"
import { applyPoints, getPointsBalance } from "../src/points"
import {
  advanceAndSweep,
  advanceMarket,
  closePosition,
  consolidateUserBuckets,
  depositToPool,
  ensureMarket,
  gameLeaderboard,
  gameStats,
  listCandles,
  listMyPositions,
  loadGameParams,
  loadMarket,
  openPosition,
  resetMarket,
  sweepLiquidations,
  withdrawFromPool,
} from "../src/game-market"
import { getPlugin, listPublishedPlugins } from "../src/collection-plugins"
import type { GameParams } from "../src/game-engine"
import { computeFee, crossAccount, crossLiqPrice, settlePosition } from "../src/game-engine"

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/**
 * 摆好一套确定性的游戏设置。
 *
 * ⚠️ **噪声必须置 0**：默认 4 bps 的随机噪声会让价格随种子漂移，
 * 断言就只能写成「大概」。测试要的是「记账正确」，不是「随机数好看」。
 * 噪声与均值回复的行为在 `game-engine.test.ts` 里单独验。
 */
async function setupGame(over: Record<string, string> = {}): Promise<GameParams> {
  const base: Record<string, string> = {
    game_enabled: "1",
    game_tick_seconds: "5",
    game_candle_seconds: "60",
    game_base_price: "100",
    game_noise_bps: "0",
    game_mean_reversion_bps: "0",
    game_anchor_follow_bps: "0",
    game_impact_bps: "500",
    game_max_impact_bps: "300",
    game_max_leverage: "20",
    game_min_margin: "10",
    game_fee_open_bps: "5",
    game_fee_close_bps: "5",
    game_maintenance_bps: "50",
    ...over,
  }
  for (const [k, v] of Object.entries(base)) await setSetting(k, v)
  return await loadGameParams(env)
}

/** 给用户发分（走唯一入口，保证 user_points 行存在） */
async function fund(userId: string, amount: number): Promise<void> {
  const res = await applyPoints(env, {
    userId,
    delta: amount,
    reason: "admin",
    detail: "测试发分",
  })
  expect(res.applied).toBe(true)
}

/**
 * 守恒量：Σ 用户余额 + 池子余额 + Σ 在仓保证金。
 *
 * 三项缺一不可 —— 保证金从用户余额扣走之后**既不在用户账上也不在池子里**，
 * 而是托管在 `game_positions.margin`（这就是「逐仓」的含义）。
 * 只对前两项求和会得到「一开仓就少钱」的假阳性。
 */
async function conserved(): Promise<number> {
  const users = await env.DB.prepare(
    "SELECT COALESCE(SUM(balance), 0) AS s FROM user_points"
  ).first<{ s: number }>()
  const pool = await env.DB.prepare(
    "SELECT COALESCE(pool_balance, 0) AS s FROM game_market WHERE id = 1"
  ).first<{ s: number }>()
  const escrow = await env.DB.prepare(
    "SELECT COALESCE(SUM(margin), 0) AS s FROM game_positions WHERE status = 'open'"
  ).first<{ s: number }>()
  return Number(users?.s ?? 0) + Number(pool?.s ?? 0) + Number(escrow?.s ?? 0)
}

/**
 * 摆好设置 + 建出行情行 + 站长划拨一笔垫本，返回生效参数。
 *
 * 为什么要合成一个函数：行情行是**懒创建**的（`ensureMarket`），
 * 而 `addPool` / `takeFromPool` 的 SQL 是 `UPDATE ... WHERE id = 1` ——
 * 行不存在时会静默影响 0 行。测试里如果先划拨再建行，就会拿到一个「池子看着有、
 * 其实一分钱没进」的假状态（这个坑在写测试时真实踩到过，也正是 `addPool`
 * 现在会校验 `changes` 的原因）。
 */
async function withPool(
  admin: TestUser,
  amount: number,
  over: Record<string, string> = {}
): Promise<GameParams> {
  const params = await setupGame(over)
  await ensureMarket(env, params)
  await fund(admin.id, amount * 2)
  await depositToPool(env, admin, amount)
  return params
}

/** 站长用户（每个用例重建；游戏表在 beforeEach 里清空） */
let admin: TestUser

// apply-migrations.ts 会在每个用例前清空 app_settings（回落默认值），
// 但**游戏自己的表不在它的清理范围里** —— 同一个文件内的用例共享一个 D1
// （只有跨文件才隔离存储），所以这里必须自己清干净。不清的话上一个用例的
// 持仓会留到下一个，表现为「统计里有 17 个在仓持仓」这类莫名其妙的失败。
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM game_positions"),
    env.DB.prepare("DELETE FROM game_trades"),
    env.DB.prepare("DELETE FROM game_pool_ledger"),
    env.DB.prepare("DELETE FROM game_candles"),
    env.DB.prepare("DELETE FROM game_market"),
    env.DB.prepare("DELETE FROM user_points"),
  ])
  admin = await makeUser({ role: "root", username: `root_${Math.random().toString(36).slice(2, 7)}` })
})

// ---------------------------------------------------------------------------
// 插件清单
// ---------------------------------------------------------------------------

describe("造物典藏插件清单", () => {
  it("内置「在线投资」会被同步进库并出现在大厅里", async () => {
    const list = await listPublishedPlugins(env)
    const invest = list.find((p) => p.slug === "invest")
    expect(invest).toBeTruthy()
    expect(invest?.kind).toBe("builtin")
    expect(invest?.runtime).toBe("react")
    expect(invest?.status).toBe("published")
    // 将来用户插件走沙盒宿主 —— runtime 与 kind 是宿主分流的唯一依据
    expect(invest?.capabilities).toContain("native")
  })

  it("重复读取不会产生重复行（差异同步，只在真变了才写）", async () => {
    await listPublishedPlugins(env)
    await listPublishedPlugins(env)
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM collection_plugins WHERE slug = 'invest'"
    ).first<{ c: number }>()
    expect(Number(count?.c)).toBe(1)
  })

  it("getPlugin 能按 slug 取到，取不到返回 null", async () => {
    expect(await getPlugin(env, "invest")).toBeTruthy()
    expect(await getPlugin(env, "not-exist")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 行情初始化与推进
// ---------------------------------------------------------------------------

describe("行情初始化与推进", () => {
  it("首次读取会按参数懒创建行情（含随机种子）", async () => {
    const params = await setupGame()
    const m = await ensureMarket(env, params)
    expect(m.price).toBe(100)
    expect(m.anchor).toBe(100)
    expect(m.pool_balance).toBe(0)
    expect(m.tick_seq).toBe(0)
    expect(m.seed.length).toBeGreaterThan(0)
    // 单行表：再来一次不会多出一行
    await ensureMarket(env, params)
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM game_market").first<{ c: number }>()
    expect(Number(count?.c)).toBe(1)
  })

  it("不足一个 tick 的间隔不推进（每次请求都推会白烧 D1 写入）", async () => {
    const params = await setupGame()
    const m0 = await ensureMarket(env, params)
    const same = await advanceMarket(env, params, Date.parse(m0.last_tick_at) + 1000)
    expect(same.tick_seq).toBe(0)
  })

  it("按 tick 前进；噪声为 0 且无人下单时价格保持不动", async () => {
    const params = await setupGame()
    const m0 = await ensureMarket(env, params)
    const t0 = Date.parse(m0.last_tick_at)
    const m1 = await advanceMarket(env, params, t0 + 5000 * 12)
    expect(m1.tick_seq).toBe(12)
    expect(m1.price).toBe(100)
    expect(Date.parse(m1.last_tick_at)).toBe(t0 + 60_000)
  })

  it("**出厂默认**下行情是一条直线：噪声关着，价格只由玩家下单推动", async () => {
    // 这个用例刻意**不写任何 game_* 设置**（setup 前 app_settings 已被清空），
    // 验的就是「站长第一次打开游戏看到的那条线」。2026-10-11 站长反馈
    // 「前面的 K 线看着像随机生成的」—— 根因是噪声默认开着。
    // ⚠️ 谁要是把 game_noise_bps 的默认值改回非 0，这个用例会红。
    const params = await loadGameParams(env)
    expect(params.noiseBps).toBe(0)

    const m0 = await ensureMarket(env, params)
    expect(m0.price).toBe(100)
    const m1 = await advanceMarket(env, params, Date.parse(m0.last_tick_at) + 5000 * 30)

    // 30 个 tick 之后价格一动没动
    expect(m1.tick_seq).toBe(30)
    expect(m1.price).toBe(100)

    // 而且这 30 个 tick **真的落了 K 线**（否则「平」只是因为没推进，是假阳性）。
    // 落下来的每一根都必须是 100/100/100/100 —— 也就是一条真正的直线。
    const rows = await env.DB.prepare(
      "SELECT open_price, high_price, low_price, close_price FROM game_candles"
    ).all<{ open_price: number; high_price: number; low_price: number; close_price: number }>()
    const list = rows.results ?? []
    expect(list.length).toBeGreaterThanOrEqual(1)
    for (const r of list) {
      expect([r.open_price, r.high_price, r.low_price, r.close_price]).toEqual([100, 100, 100, 100])
    }
  })

  it("跨过 K 线边界会把上一根封存进 game_candles", async () => {
    const params = await setupGame()
    const m0 = await ensureMarket(env, params)
    const t0 = Date.parse(m0.last_tick_at)
    await advanceMarket(env, params, t0 + 5000 * 60)
    const rows = await env.DB.prepare("SELECT * FROM game_candles ORDER BY open_at ASC")
      .all<{ open_price: number; close_price: number; interval: string }>()
    expect((rows.results ?? []).length).toBeGreaterThanOrEqual(1)
    const first = (rows.results ?? [])[0]
    expect(first.interval).toBe("60s")
    expect(first.open_price).toBe(100)
    expect(first.close_price).toBe(100)
  })

  it("**每分钟推一次**（线上 cron 的真实节奏）也能把 K 线落库", async () => {
    // ⚠️ 这个用例守着一个**只在生产环境暴露**的真 bug（2026-10-11 实测发现）：
    //    线上是每分钟 cron 推一次、每次正好 60 秒 = 12 个 tick ⇒ 「跨分钟」永远发生在
    //    某次调用的**第一个 tick**。而当时的实现用函数内的局部变量判断「这根 K 线
    //    要不要落库」，那个变量在每次调用开始时刚被重置 —— 于是上一轮攒的 K 线
    //    被当空线丢掉，game_candles 一行不写，图表上永远只有「正在走的那根」。
    //
    //    原来的用例一次推进 60 个 tick（一次调用跨多根边界），恰好绕开了跨调用场景。
    //    这里按分钟逐次推进，复现真实节奏。
    const params = await setupGame()
    const m0 = await ensureMarket(env, params)
    let t = Date.parse(m0.last_tick_at)

    for (let i = 1; i <= 5; i++) {
      t += 60_000
      await advanceMarket(env, params, t)
    }

    const rows = await env.DB.prepare(
      "SELECT open_at, open_price, high_price, low_price, close_price FROM game_candles ORDER BY open_at"
    ).all<{ open_at: string; open_price: number; close_price: number }>()
    const list = rows.results ?? []
    // 推进了 5 分钟 ⇒ 至少该封存 4 根（最后一根还在走）
    expect(list.length).toBeGreaterThanOrEqual(4)
    // 默认噪声为 0 ⇒ 每一根都是平线，且价格连续
    for (const c of list) {
      expect(c.open_price).toBe(100)
      expect(c.close_price).toBe(100)
    }
    // 时间必须连续（不能出现「跳过一段」的空洞）
    for (let i = 1; i < list.length; i++) {
      expect(Date.parse(list[i].open_at) - Date.parse(list[i - 1].open_at)).toBe(60_000)
    }
  })

  it("长期无人后跳过补算：只模拟上限步数，价格连续不跳空、时间对齐到当前", async () => {
    const params = await setupGame({ game_noise_bps: "0" })
    const m0 = await ensureMarket(env, params)
    const t0 = Date.parse(m0.last_tick_at)
    // 1 小时 = 720 步，远超 MAX_CATCHUP_TICKS(240)
    const m1 = await advanceMarket(env, params, t0 + 3600_000)
    // tick_seq 反映「过了多少 tick 的时间」（含被跳过的那 480 步）——
    // 它同时是乐观锁的版本号与 PRNG 的序号，必须与墙上时间一致，
    // 否则下一次推进会把同一段时间重算一遍（同样的种子 ⇒ 同样的价格，
    // 表现为行情卡住不动）。被限制的是**模拟步数**，不是这个序号。
    expect(m1.tick_seq).toBe(720)
    // 噪声为 0 且无人下单 ⇒ 跳过一大段也不会跳空
    expect(m1.price).toBe(100)
    // 时间对齐到「现在」，所以下一次不会又欠一小时的账
    expect(Math.abs(Date.parse(m1.last_tick_at) - (t0 + 3600_000))).toBeLessThanOrEqual(5000)
  })

  it("K 线查询：1m 原样返回，5m 由 1m 聚合（开盘取首、收盘取尾、高低取极值）", async () => {
    const params = await setupGame()
    await ensureMarket(env, params)
    const base = Date.parse("2026-10-11T00:00:00.000Z")
    const ins = env.DB.prepare(
      `INSERT INTO game_candles (interval, open_at, open_price, high_price, low_price, close_price, volume, trades)
       VALUES ('60s', ?, ?, ?, ?, ?, ?, 1)`
    )
    await env.DB.batch([
      ins.bind(new Date(base).toISOString(), 100, 105, 99, 104, 10),
      ins.bind(new Date(base + 60_000).toISOString(), 104, 110, 103, 108, 20),
      ins.bind(new Date(base + 120_000).toISOString(), 108, 109, 101, 102, 30),
      ins.bind(new Date(base + 300_000).toISOString(), 102, 103, 101, 103, 40),
    ])

    const one = await listCandles(env, params, "1m", 100)
    expect(one.candles.length).toBe(4)

    const five = await listCandles(env, params, "5m", 100)
    expect(five.interval).toBe("300s")
    expect(five.candles.length).toBe(2)
    expect(five.candles[0].openPrice).toBe(100)
    expect(five.candles[0].highPrice).toBe(110)
    expect(five.candles[0].lowPrice).toBe(99)
    expect(five.candles[0].closePrice).toBe(102)
    expect(five.candles[0].volume).toBe(60)
    expect(five.candles[1].openPrice).toBe(102)
  })
})

// ---------------------------------------------------------------------------
// 垫本与池子
// ---------------------------------------------------------------------------

describe("做市池垫本（唯一的资金注入入口）", () => {
  it("划拨：站长账户扣、池子加，全站积分总量不变", async () => {
    const params = await setupGame()
    await ensureMarket(env, params)
    await fund(admin.id, 5000)
    const before = await conserved()

    const res = await depositToPool(env, admin, 3000)
    expect(res.pool).toBe(3000)
    expect(res.balance).toBe(2000)
    expect(await getPointsBalance(env, admin.id)).toBe(2000)
    expect(await conserved()).toBe(before)

    // 审计流水要留下痕迹（含余额快照，便于二分定位）
    const ledger = await env.DB.prepare(
      "SELECT * FROM game_pool_ledger ORDER BY created_at DESC LIMIT 1"
    ).first<{ kind: string; delta: number; balance_after: number }>()
    expect(ledger?.kind).toBe("seed_deposit")
    expect(Number(ledger?.delta)).toBe(3000)
    expect(Number(ledger?.balance_after)).toBe(3000)
  })

  it("站长积分不够时拒绝划拨（不能靠划拨凭空变出钱）", async () => {
    const params = await setupGame()
    await ensureMarket(env, params)
    await fund(admin.id, 100)
    await expect(depositToPool(env, admin, 500)).rejects.toMatchObject({
      code: "INSUFFICIENT_POINTS",
    })
    expect((await loadMarket(env))?.pool_balance).toBe(0)
  })

  it("抽回：池子扣、站长账户加；池子不够时严格拒绝（不静默截断）", async () => {
    await withPool(admin, 1000)
    expect(await conserved()).toBe(2000)

    const res = await withdrawFromPool(env, admin, 400)
    expect(res.pool).toBe(600)
    expect(res.balance).toBe(1400)

    await expect(withdrawFromPool(env, admin, 10_000)).rejects.toMatchObject({
      code: "POOL_INSUFFICIENT",
    })
    // 被拒绝的那次一分钱都不能动
    expect((await loadMarket(env))?.pool_balance).toBe(600)
    expect(await getPointsBalance(env, admin.id)).toBe(1400)
  })
})

// ---------------------------------------------------------------------------
// 开仓
// ---------------------------------------------------------------------------

describe("开仓", () => {
  it("扣保证金 + 手续费：保证金进托管、手续费进池子、下单立刻推价", async () => {
    const params = await withPool(admin, 1000)
    const user = await makeUser()
    await fund(user.id, 1000)

    const before = await conserved()
    const res = await openPosition(env, user, { side: "long", leverage: 10, margin: 100 })

    // 保证金 100 + 手续费 max(1, 1000×5bps=0.5→1) = 101
    expect(await getPointsBalance(env, user.id)).toBe(899)
    expect(res.position.margin).toBe(100)
    expect(res.position.size).toBe(1000)
    // ⚠️ 成交价 = **被自己推高之后**的价（+3%，见下）—— 不是下单前的 100。
    //    这是「吃掉自己的冲击」那条定价规则，也是防「开完立刻平仓白拿钱」的关键。
    expect(res.position.entry_price).toBeCloseTo(103, 6)
    // 10 倍逐仓：爆仓价 = 成交价 × (1 − 1/10 + 0.5%) = 103 × 0.905
    expect(res.position.liq_price).toBeCloseTo(103 * 0.905, 6)
    expect(res.position.fee_open).toBe(1)

    const m = await loadMarket(env)
    expect(m?.pool_balance).toBe(1001)
    // 500 × 1000 / 1001 ≈ 499 bps，被 maxImpactBps=300 封顶 ⇒ +3%
    expect(m?.price).toBeCloseTo(103, 6)
    // 关键：**盘口价与成交价必须一致**（成交价就是冲击后的市价），
    // 否则又回到「记旧价 + 推新价」的漏洞上去了
    expect(res.position.entry_price).toBeCloseTo(Number(m?.price), 6)

    // 成交流水要落一行（用户「交易记录」的来源）
    const trades = await env.DB.prepare(
      "SELECT * FROM game_trades WHERE user_id = ? AND kind = 'open'"
    )
      .bind(user.id)
      .all<{ fee: number; pnl: number }>()
    expect((trades.results ?? []).length).toBe(1)
    expect(Number((trades.results ?? [])[0].fee)).toBe(1)

    expect(await conserved()).toBe(before)
  })

  it("**开仓那一刻不能凭空产生浮盈**（成交价必须含本次冲击）", async () => {
    // ⚠️ 这个用例守着一种「凭空从做市池拿钱」的漏洞：
    //    如果开仓时把 entry_price 记成**冲击之前**的价，而冲击本身把市价推高了，
    //    那么仓位一建立就已经浮盈 —— 玩家立刻平仓就能把这笔钱从池子里拿走，
    //    反复「开多→平→开空→平」等于无风险刷池子。同理，开空会立刻浮亏。
    //
    //    正确模型是「你吃掉了自己的冲击」：买入的成交价就是被自己推高后的价，
    //    卖出的成交价是被自己压低后的价。这样一进一出只亏手续费与滑点。
    await withPool(admin, 20_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    for (const side of ["long", "short"] as const) {
      const opened = await openPosition(env, user, { side, leverage: 1, margin: 4000 })
      // 立刻按市价平掉：不允许赚钱（最多是零头取整）
      const closed = await closePosition(env, user, opened.position.id)
      expect(closed.alreadyClosed).toBe(false)
      expect(closed.pnl).toBeLessThanOrEqual(0)
    }
  })

  it("**平多把价格压下去、平空把价格抬起来**（平仓也是市价单）", async () => {
    // 站长问「我做多平仓不应该导致价格下跌吗」—— 对，必须跌。
    // 平多 = 卖出，要吃掉买单深度；平空 = 买回，要吃掉卖单深度。
    // 这道题同时也是守恒的一部分：没有它，开仓冲击可以被「零滑点平仓」原价赚回来。
    await withPool(admin, 20_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    const long = await openPosition(env, user, { side: "long", leverage: 1, margin: 500 })
    const afterOpenLong = Number((await loadMarket(env))?.price ?? 0)
    const closedLong = await closePosition(env, user, long.position.id)
    const afterCloseLong = Number((await loadMarket(env))?.price ?? 0)
    expect(afterCloseLong).toBeLessThan(afterOpenLong)
    expect(closedLong.position.close_price).toBeLessThan(afterOpenLong)

    const short = await openPosition(env, user, { side: "short", leverage: 1, margin: 500 })
    const afterOpenShort = Number((await loadMarket(env))?.price ?? 0)
    await closePosition(env, user, short.position.id)
    const afterCloseShort = Number((await loadMarket(env))?.price ?? 0)
    expect(afterCloseShort).toBeGreaterThan(afterOpenShort)
  })
  it("一进一出必然亏给池子（滑点 + 手续费，池子不会凭空失血）", async () => {
    await withPool(admin, 20_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    const poolBefore = Number((await loadMarket(env))?.pool_balance ?? 0)
    const openRes = await openPosition(env, user, { side: "long", leverage: 1, margin: 4000 })
    await closePosition(env, user, openRes.position.id)
    const poolAfter = Number((await loadMarket(env))?.pool_balance ?? 0)

    // 池子必须变厚（赚到手续费 + 来回滑点）。这正是做市池能长期赔付的来源。
    expect(poolAfter).toBeGreaterThan(poolBefore)
  })

  it("空单把价格压下去（方向不能反）", async () => {
    const params = await withPool(admin, 10_000)
    const user = await makeUser()
    await fund(user.id, 1000)

    await openPosition(env, user, { side: "short", leverage: 10, margin: 100 })
    const m = await loadMarket(env)
    expect(m?.price).toBeLessThan(100)
  })

  it("幂等：同一下单号重放不会扣两次分、不会开出两个仓", async () => {
    const params = await withPool(admin, 1000)
    const user = await makeUser()
    await fund(user.id, 1000)

    const orderNo = "order-idem-1"
    const first = await openPosition(env, user, { side: "long", leverage: 5, margin: 100, orderNo })
    const balanceAfterFirst = await getPointsBalance(env, user.id)
    const second = await openPosition(env, user, { side: "long", leverage: 5, margin: 100, orderNo })

    expect(second.duplicated).toBe(true)
    expect(second.position.id).toBe(first.position.id)
    expect(await getPointsBalance(env, user.id)).toBe(balanceAfterFirst)
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM game_positions WHERE order_no = ?")
      .bind(orderNo)
      .first<{ c: number }>()
    expect(Number(count?.c)).toBe(1)
  })

  it("积分不足时拒绝，且余额一分不动", async () => {
    const params = await withPool(admin, 1000)
    const user = await makeUser()
    await fund(user.id, 50)

    await expect(
      openPosition(env, user, { side: "long", leverage: 20, margin: 1000 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_POINTS" })
    expect(await getPointsBalance(env, user.id)).toBe(50)
    expect((await listMyPositions(env, user.id)).length).toBe(0)
  })

  it("参数越界被拒绝（低于最小保证金 / 杠杆超上限）", async () => {
    const params = await withPool(admin, 1000)
    const user = await makeUser()
    await fund(user.id, 1000)

    await expect(openPosition(env, user, { side: "long", leverage: 10, margin: 5 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
    await expect(openPosition(env, user, { side: "long", leverage: 21, margin: 100 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
    expect((await listMyPositions(env, user.id)).length).toBe(0)
  })

  it("池子为空时禁止开仓（开了也赔不出来，不如直接说明原因）", async () => {
    const params = await setupGame()
    await ensureMarket(env, params)
    const user = await makeUser()
    await fund(user.id, 1000)

    const res = await env.DB.prepare("SELECT pool_balance FROM game_market WHERE id = 1").first<{
      pool_balance: number
    }>()
    expect(Number(res?.pool_balance)).toBe(0)
    await expect(openPosition(env, user, { side: "long", leverage: 10, margin: 100 })).rejects.toMatchObject({
      code: "POOL_EMPTY",
    })
  })

  it("游戏关闭时禁止开仓", async () => {
    const params = await withPool(admin, 500, { game_enabled: "0" })
    expect(params.enabled).toBe(false)
    const user = await makeUser()
    await fund(user.id, 1000)

    await expect(openPosition(env, user, { side: "long", leverage: 10, margin: 100 })).rejects.toMatchObject({
      code: "GAME_DISABLED",
    })
  })
})

// ---------------------------------------------------------------------------
// 平仓
// ---------------------------------------------------------------------------

describe("平仓", () => {
  it("盈利：用户拿回保证金 + 盈亏 − 手续费，池子付出对应金额", async () => {
    await withPool(admin, 10_000)
    const user = await makeUser()
    const pusher = await makeUser()
    // ⚠️ 所有「发分」都必须在取守恒基线**之前**做完：
    //    发分本身会让 Σ用户余额增加，基线取在发分之后才谈得上守恒。
    await fund(user.id, 1000)
    await fund(pusher.id, 12_000)

    const opened = await openPosition(env, user, { side: "long", leverage: 10, margin: 100 })
    const balanceAfterOpen = await getPointsBalance(env, user.id)
    const before = await conserved()

    // 让价格涨：另一个玩家开多推价。要推得比自己那一来一回的滑点更大，
    // 否则「买了又卖」只是把滑点交给池子（这本就是应有的代价）。
    await openPosition(env, pusher, { side: "long", leverage: 1, margin: 8000 })

    const market = await loadMarket(env)
    const markPrice = Number(market?.price ?? 0)
    const res = await closePosition(env, user, opened.position.id)

    expect(res.alreadyClosed).toBe(false)
    expect(res.pnl).toBeGreaterThan(0)
    expect(res.position.status).toBe("closed")
    // 平多 = 卖出 ⇒ 成交价含本次冲击，**低于**平仓前的盘口价（滑点归池子）
    expect(res.position.close_price).toBeLessThan(markPrice)
    // 到账 = 保证金 + 盈亏 − 手续费；且 PnL 是整数（积分不做小数）
    expect(res.credit).toBe(100 + res.pnl - res.fee)
    expect(Number.isInteger(res.credit)).toBe(true)
    // 余额 = 开仓后的余额 + 这次到账（不是「等于到账」——开仓已经扣过保证金了）
    expect(await getPointsBalance(env, user.id)).toBe(balanceAfterOpen + res.credit)
    expect(await conserved()).toBe(before)
  })

  it("亏损：亏损进池子，用户拿回剩下的保证金", async () => {
    await withPool(admin, 10_000)
    const user = await makeUser()
    const pusher = await makeUser()
    await fund(user.id, 1000)
    await fund(pusher.id, 10_000)

    const opened = await openPosition(env, user, { side: "long", leverage: 10, margin: 100 })
    const balanceAfterOpen = await getPointsBalance(env, user.id)
    const before = await conserved()

    await openPosition(env, pusher, { side: "short", leverage: 1, margin: 3000 })

    const poolBefore = Number((await loadMarket(env))?.pool_balance ?? 0)
    const res = await closePosition(env, user, opened.position.id)
    expect(res.pnl).toBeLessThan(0)
    expect(await getPointsBalance(env, user.id)).toBe(balanceAfterOpen + res.credit)
    // 亏损让池子变厚
    expect(Number((await loadMarket(env))?.pool_balance ?? 0)).toBeGreaterThan(poolBefore)
    expect(await conserved()).toBe(before)
  })

  it("重复平仓是幂等的（第二次不结算、不给钱）", async () => {
    const params = await withPool(admin, 10_000)
    const user = await makeUser()
    await fund(user.id, 1000)

    const opened = await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })
    const first = await closePosition(env, user, opened.position.id)
    const balanceAfter = await getPointsBalance(env, user.id)
    const second = await closePosition(env, user, opened.position.id)

    expect(second.alreadyClosed).toBe(true)
    expect(second.credit).toBe(0)
    expect(await getPointsBalance(env, user.id)).toBe(balanceAfter)
    expect(first.credit).toBeGreaterThan(0)
  })

  it("不能平别人的仓（且不泄露它是否存在）", async () => {
    const params = await withPool(admin, 10_000)
    const owner = await makeUser()
    const other = await makeUser()
    await fund(owner.id, 1000)
    await fund(other.id, 1000)

    const opened = await openPosition(env, owner, { side: "long", leverage: 5, margin: 100 })
    await expect(closePosition(env, other, opened.position.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect((await listMyPositions(env, owner.id)).length).toBe(1)
  })

  it("游戏关停期间仍可平仓（不能把已有持仓的人锁死在里面）", async () => {
    const params = await withPool(admin, 10_000)
    const user = await makeUser()
    await fund(user.id, 1000)
    const opened = await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })

    // 关掉游戏
    await setSetting("game_enabled", "0")
    const off = await loadGameParams(env)
    expect(off.enabled).toBe(false)

    const res = await closePosition(env, user, opened.position.id)
    expect(res.alreadyClosed).toBe(false)
    expect(res.position.status).toBe("closed")
  })

  it("盈利超过池子余额时按池子上限赔付（capped），且池子不会被抽成负数", async () => {
    await withPool(admin, 100, { game_impact_bps: "500" })
    const user = await makeUser()
    await fund(user.id, 1000)

    // 20 倍多单：成交价含自身冲击（池子只有 100 ⇒ 直接顶到 +3%），
    // 名义 2000 ⇒ 价格每涨 1% 就赚 20，而池子余额只有 100 出头 ⇒ 很容易顶到上限
    const opened = await openPosition(env, user, { side: "long", leverage: 20, margin: 100 })

    // 用「鲸鱼」把价格连续推高 —— 必须**大于**自己那一来一回的滑点（约 6%）
    // 才谈得上盈利，否则只是把滑点交给了池子（那本就是正常代价）。
    const pusher = await makeUser()
    await fund(pusher.id, 60_000)
    for (let i = 0; i < 4; i++) {
      await openPosition(env, pusher, { side: "long", leverage: 1, margin: 10_000 })
    }

    const market = await loadMarket(env)
    const poolBefore = Number(market?.pool_balance ?? 0)
    const markPrice = Number(market?.price ?? 0)
    // 名义盈利远大于池子余额
    const rawProfit = (opened.position.size * (markPrice - opened.position.entry_price)) / opened.position.entry_price
    expect(rawProfit).toBeGreaterThan(poolBefore)

    const res = await closePosition(env, user, opened.position.id)
    expect(res.capped).toBe(true)
    expect(res.pnl).toBe(poolBefore)
    expect(res.position.note).toBeTruthy()
    const poolAfter = Number((await loadMarket(env))?.pool_balance ?? 0)
    expect(poolAfter).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 强平
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 加仓合并（均价）与逐仓 / 全仓
// ---------------------------------------------------------------------------

describe("加仓合并：同方向同模式只留一行，开仓价按规模加权", () => {
  it("两次开多合并成一行：规模/保证金累加，均价按规模加权", async () => {
    await withPool(admin, 100_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    // 第一笔：100 保证金 5x ⇒ 名义 500
    const first = await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })
    // 第二笔：300 保证金 5x ⇒ 名义 1500（更大，应当主导均价）
    const second = await openPosition(env, user, { side: "long", leverage: 5, margin: 300 })

    // 关键：两次开仓拿到的是**同一行**
    expect(second.position.id).toBe(first.position.id)

    const rows = await env.DB.prepare(
      "SELECT * FROM game_positions WHERE user_id = ? AND status = 'open'"
    )
      .bind(user.id)
      .all<{ id: string; size: number; margin: number; entry_price: number; fee_open: number }>()
    expect((rows.results ?? []).length).toBe(1)

    const p = (rows.results ?? [])[0]
    expect(Number(p.size)).toBe(2000)
    expect(Number(p.margin)).toBe(400)
    expect(Number(p.fee_open)).toBe(2) // 每笔最小 1 分

    // 均价 = 加权：(500×成交价1 + 1500×成交价2) / 2000
    const trades = await env.DB.prepare(
      "SELECT price, size FROM game_trades WHERE user_id = ? AND kind = 'open' ORDER BY created_at"
    )
      .bind(user.id)
      .all<{ price: number; size: number }>()
    const legs = trades.results ?? []
    expect(legs.length).toBe(2)
    const weighted =
      (Number(legs[0].size) * Number(legs[0].price) + Number(legs[1].size) * Number(legs[1].price)) /
      2000
    expect(Number(p.entry_price)).toBeCloseTo(weighted, 6)

    // 两笔开仓流水都挂在同一行上 —— 交易记录才能把「多次开仓 + 一次平仓」配成一条
    const linked = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM game_trades WHERE position_id = ? AND kind = 'open'"
    )
      .bind(p.id)
      .first<{ n: number }>()
    expect(Number(linked?.n)).toBe(2)
  })

  it("合并后平仓：按合并后的规模结算，守恒不变", async () => {
    await withPool(admin, 100_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    const first = await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })
    await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })
    const before = await conserved()

    const res = await closePosition(env, user, first.position.id)
    expect(res.alreadyClosed).toBe(false)
    expect(res.position.size).toBe(1000)
    expect(res.position.margin).toBe(200)
    // 到账 = 保证金 + 盈亏 − 手续费
    expect(res.credit).toBe(200 + res.pnl - res.fee)
    expect(await conserved()).toBe(before)
  })

  it("懒迁移 `consolidateUserBuckets`：把存量同桶多行并成一行，并按规模加权算均价", async () => {
    // 这条路径会在站长打开页面时**跑在他的真实持仓上**，所以必须单独验一遍
    // （加仓路径已经验过了，但那条路是「带一笔新成交」的，不完全等价）。
    await withPool(admin, 100_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    // 伪造两行同桶在仓（老版本行为）+ 各自的开仓流水
    const seed = [
      { id: "old-a", size: 500, margin: 100, entry: 100, at: "2020-01-01T00:00:00.000Z" },
      { id: "old-b", size: 1500, margin: 300, entry: 110, at: "2020-01-02T00:00:00.000Z" },
    ]
    for (const s of seed) {
      await env.DB.prepare(
        `INSERT INTO game_positions
           (id, user_id, side, leverage, margin, entry_price, size, liq_price, status,
            opened_at, open_tick, fee_open, order_no, margin_mode, fee_close)
         VALUES (?, ?, 'long', 5, ?, ?, ?, 90, 'open', ?, 0, 1, ?, 'isolated', 0)`
      )
        .bind(s.id, user.id, s.margin, s.entry, s.size, s.at, s.id)
        .run()
      await env.DB.prepare(
        `INSERT INTO game_trades
           (id, user_id, position_id, kind, side, leverage, price, size, margin, fee, pnl,
            balance_after, created_at)
         VALUES (?, ?, ?, 'open', 'long', 5, ?, ?, ?, 1, 0, NULL, ?)`
      )
        .bind(`t-${s.id}`, user.id, s.id, s.entry, s.size, s.margin, s.at)
        .run()
    }

    const merged = await consolidateUserBuckets(env, user.id, 50)
    expect(merged).toBe(1)

    const rows = await env.DB.prepare(
      "SELECT id, size, margin, entry_price, fee_open FROM game_positions WHERE user_id = ? AND status = 'open'"
    )
      .bind(user.id)
      .all<{ id: string; size: number; margin: number; entry_price: number; fee_open: number }>()
    const list = rows.results ?? []
    expect(list.length).toBe(1)
    expect(Number(list[0].size)).toBe(2000)
    expect(Number(list[0].margin)).toBe(400)
    expect(Number(list[0].fee_open)).toBe(2)
    // 加权均价 = (500×100 + 1500×110) / 2000 = 107.5
    expect(Number(list[0].entry_price)).toBeCloseTo(107.5, 6)
    // 保留最早那一行，两笔开仓流水都挂到它上面
    expect(list[0].id).toBe("old-a")
    const linked = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM game_trades WHERE position_id = 'old-a' AND kind = 'open'"
    ).first<{ n: number }>()
    expect(Number(linked?.n)).toBe(2)
    // 幂等：再跑一次没有可合并的了
    expect(await consolidateUserBuckets(env, user.id, 50)).toBe(0)
  })

  it("逐仓与全仓**不合并**：同方向各留一行、各自独立", async () => {
    await withPool(admin, 100_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    const iso = await openPosition(env, user, {
      side: "long",
      leverage: 5,
      margin: 100,
      marginMode: "isolated",
    })
    const cross = await openPosition(env, user, {
      side: "long",
      leverage: 5,
      margin: 100,
      marginMode: "cross",
    })
    expect(cross.position.id).not.toBe(iso.position.id)

    const rows = await env.DB.prepare(
      "SELECT margin_mode FROM game_positions WHERE user_id = ? AND status = 'open' ORDER BY margin_mode"
    )
      .bind(user.id)
      .all<{ margin_mode: string }>()
    const modes = (rows.results ?? []).map((r) => r.margin_mode)
    expect(modes).toEqual(["cross", "isolated"])
  })

  it("存量重复行会在下次加仓时被并掉，流水改挂到保留的那一行", async () => {
    await withPool(admin, 100_000)
    const user = await makeUser()
    await fund(user.id, 10_000)

    // 先正常开一笔
    const first = await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })

    // 手动伪造一行「老版本留下的同桶持仓」+ 它的开仓流水
    await env.DB.prepare(
      `INSERT INTO game_positions
         (id, user_id, side, leverage, margin, entry_price, size, liq_price, status,
          opened_at, open_tick, fee_open, order_no, margin_mode, fee_close)
       VALUES ('legacy-dup', ?, 'long', 5, 100, 99, 500, 90, 'open', ?, 0, 1, 'legacy', 'isolated', 0)`
    )
      .bind(user.id, "2020-01-01T00:00:00.000Z")
      .run()
    await env.DB.prepare(
      `INSERT INTO game_trades
         (id, user_id, position_id, kind, side, leverage, price, size, margin, fee, pnl,
          balance_after, created_at)
       VALUES ('legacy-trade', ?, 'legacy-dup', 'open', 'long', 5, 99, 500, 100, 1, 0, NULL, ?)`
    )
      .bind(user.id, "2020-01-01T00:00:00.000Z")
      .run()

    // 再加一笔 ⇒ 应把重复行并进最早创建的 legacy-dup（opened_at 更早）
    await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })

    const rows = await env.DB.prepare(
      "SELECT id, size, margin FROM game_positions WHERE user_id = ? AND status = 'open'"
    )
      .bind(user.id)
      .all<{ id: string; size: number; margin: number }>()
    const list = rows.results ?? []
    expect(list.length).toBe(1)
    // 500(legacy) + 500(first) + 500(new) = 1500
    expect(Number(list[0].size)).toBe(1500)
    expect(Number(list[0].margin)).toBe(300)
    // 孤儿行的开仓流水必须改挂到保留下来的那一行，否则会永远显示「持仓中」
    const orphan = await env.DB.prepare(
      "SELECT position_id FROM game_trades WHERE id = 'legacy-trade'"
    ).first<{ position_id: string }>()
    expect(orphan?.position_id).toBe(list[0].id)

    // ⚠️ 保留的是**最早那一行**（legacy-dup，它的 id 已经在历史流水里）；
    //    被并掉的是后来那笔正常开的仓 —— 断言别写反（我第一版就写反了）。
    expect(list[0].id).toBe("legacy-dup")
    expect(first.position.id).not.toBe("legacy-dup")
    const removed = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_positions WHERE id = ?")
      .bind(first.position.id)
      .first<{ n: number }>()
    expect(Number(removed?.n)).toBe(0)
  })
})

describe("全仓 / 逐仓两种保证金模式", () => {
  it("逐仓：亏损上限就是这一行的保证金，余额不被追缴", async () => {
    await withPool(admin, 100_000)
    const user = await makeUser()
    await fund(user.id, 5_000)

    const opened = await openPosition(env, user, {
      side: "long",
      leverage: 20,
      margin: 100,
      marginMode: "isolated",
    })
    const balanceAfterOpen = await getPointsBalance(env, user.id)

    // 砸穿爆仓价
    const bear = await makeUser()
    await fund(bear.id, 200_000)
    for (let i = 0; i < 3; i++) {
      await openPosition(env, bear, { side: "short", leverage: 1, margin: 60_000 })
    }
    await advanceAndSweep(env, await loadGameParams(env), Date.now())

    const row = await env.DB.prepare("SELECT status, pnl FROM game_positions WHERE id = ?")
      .bind(opened.position.id)
      .first<{ status: string; pnl: number }>()
    expect(row?.status).toBe("liquidated")
    expect(Number(row?.pnl)).toBe(-100)
    // 逐仓：余额不再被扣（只有那 100 保证金没了）
    expect(await getPointsBalance(env, user.id)).toBe(balanceAfterOpen)
  })

  it("全仓：余额为整仓担保 —— 爆仓更晚，但亏损会从余额追缴", async () => {
    await withPool(admin, 100_000)
    const user = await makeUser()
    // ⚠️ 余额要**远大于维持保证金**，追缴才有可观察的量：
    //    全仓的追缴额 = 余额 − 维持保证金，余额只剩几十的话追缴额几乎为 0，
    //    测试就退化成了「和逐仓差不多」，什么也证明不了（我第一版就是这么写的：
    //    余额 5000 配 2000 名义额 ⇒ 根本不可能爆仓，测试直接红）。
    await fund(user.id, 2_000)

    const opened = await openPosition(env, user, {
      side: "long",
      leverage: 20,
      margin: 900,
      marginMode: "cross",
    })
    const balanceAfterOpen = await getPointsBalance(env, user.id)
    // ⚠️ 守恒基线必须在**所有发分之后**取：发分本身会让 Σ余额增加，
    //    基线取早了就会把「发分」当成不守恒（这个坑我在这个文件里踩过第二次了）。
    const bear = await makeUser()
    await fund(bear.id, 600_000)
    const before = await conserved()

    // 同参数下逐仓的爆仓价约 −9.5%（entry×0.905）；全仓有 1091 余额担保 ⇒ 更远
    // 名义 18000、维持 90：权益要跌破 90 才强平 ⇒ 价格得跌约 10.6%
    const acct = crossAccount(
      [
        {
          side: "long",
          entryPrice: opened.position.entry_price,
          size: opened.position.size,
          margin: opened.position.margin,
        },
      ],
      balanceAfterOpen,
      opened.position.entry_price,
      50
    )
    expect(acct.liquidatable).toBe(false)
    expect(acct.maintenance).toBeCloseTo(90, 6)
    expect(acct.equity).toBeGreaterThan(acct.maintenance)

    // 砸穿全仓的强平线（每笔最多 −3%）
    for (let i = 0; i < 4; i++) {
      await openPosition(env, bear, { side: "short", leverage: 1, margin: 100_000 })
    }
    await advanceAndSweep(env, await loadGameParams(env), Date.now())

    const row = await env.DB.prepare("SELECT status FROM game_positions WHERE id = ?")
      .bind(opened.position.id)
      .first<{ status: string }>()
    expect(row?.status).toBe("liquidated")

    // 全仓的本质：**亏损超过本仓保证金，差额从余额追缴**。
    // 追缴额 = 余额 − 维持保证金 ≈ 1091 − 90 = 1001 ⇒ 余额被扣到只剩维持保证金。
    const after = await getPointsBalance(env, user.id)
    expect(after).toBeLessThan(balanceAfterOpen)
    expect(after).toBeGreaterThanOrEqual(0)
    expect(balanceAfterOpen - after).toBeGreaterThan(500)
    expect(await conserved()).toBe(before)
  })

  it("全仓的爆仓价把可用余额算进去（余额越厚，离爆仓越远）", async () => {
    const params = await setupGame()
    const entry = 100
    const size = 1000
    const margin = 200 // 有效杠杆 5x
    const mm = params.maintenanceBps

    const poor = crossLiqPrice("long", entry, size, margin, 0, mm)
    const rich = crossLiqPrice("long", entry, size, margin, 10_000, mm)
    // 没有余额时：entry × (1 − (200−5)/1000) = 80.5
    expect(poor).toBeCloseTo(80.5, 4)
    // 余额远大于名义规模 ⇒ 理论上跌到 0 也不会爆（被夹到最低价）
    expect(rich).toBeLessThan(poor)
    expect(rich).toBeLessThan(entry)

    // 空单方向相反
    expect(crossLiqPrice("short", entry, size, margin, 0, mm)).toBeGreaterThan(entry)
  })
})

describe("强平", () => {
  it("**盈亏平衡价**：在那个价位平仓，到账恰好回到保证金（前端平衡价公式的依据）", async () => {
    // 前端「盈亏平衡价」用的是 entry × (1 ± (开仓费 + 平仓费) / size)。
    // 这条用例拿**服务端真正的结算函数**去验它 —— 公式一旦和服务端脱节就会红，
    // 比在前端复制一份公式可靠得多（前端那份只是显示，权威永远是服务端）。
    const params = await setupGame()
    const size = 1000
    const margin = 100
    const entry = 100
    const feeOpen = computeFee(size, params.feeOpenBps)

    for (const side of ["long", "short"] as const) {
      const feeClose = computeFee(size, params.feeCloseBps)
      const fees = feeOpen + feeClose
      const breakEven =
        side === "long" ? entry * (1 + fees / size) : entry * (1 - fees / size)

      const settled = settlePosition({
        side,
        entryPrice: entry,
        exitPrice: breakEven,
        size,
        margin,
        feeCloseBps: params.feeCloseBps,
        poolBalance: 1_000_000,
      })
      // 到账 = 保证金 ⇒ 不赚不亏。允许 1 积分的四舍五入误差（computePnl 取整）。
      expect(Math.abs(settled.credit - margin)).toBeLessThanOrEqual(1)

      // 平衡价必须站在「对自己不利」的那一侧：多头高于开仓价、空头低于开仓价
      if (side === "long") expect(breakEven).toBeGreaterThan(entry)
      else expect(breakEven).toBeLessThan(entry)
    }
  })

  it("价格穿过爆仓价后仓位被强平，保证金全额归池", async () => {
    const params = await withPool(admin, 20_000)

    const user = await makeUser()
    await fund(user.id, 1000)
    const opened = await openPosition(env, user, { side: "long", leverage: 20, margin: 100 })
    // 爆仓价按**成交价**（含自身冲击）算：100 × 1.005 × (1 − 1/20 + 0.5%)
    expect(opened.position.liq_price).toBeCloseTo(
      opened.position.entry_price * (1 - 1 / 20 + 50 / 10_000),
      6
    )

    // 反复开空把价格压下去（每笔最多 −3%）
    const bear = await makeUser()
    await fund(bear.id, 100_000)
    for (let i = 0; i < 3; i++) {
      await openPosition(env, bear, { side: "short", leverage: 1, margin: 20_000 })
    }
    const market = await loadMarket(env)
    expect(Number(market?.price)).toBeLessThan(95.5)

    const before = await conserved()
    const poolBefore = Number(market?.pool_balance ?? 0)
    const sweep = await advanceAndSweep(env, params)
    expect(sweep.liquidated).toBeGreaterThanOrEqual(1)

    const positions = await listMyPositions(env, user.id)
    expect(positions.length).toBe(0)
    const row = await env.DB.prepare("SELECT * FROM game_positions WHERE id = ?")
      .bind(opened.position.id)
      .first<{ status: string; pnl: number; fee_close: number }>()
    expect(row?.status).toBe("liquidated")
    expect(Number(row?.pnl)).toBe(-100)
    expect(Number(row?.fee_close)).toBe(0)

    // 保证金进池子；用户拿不到任何返还
    expect(await getPointsBalance(env, user.id)).toBe(899)
    expect(Number((await loadMarket(env))?.pool_balance ?? 0)).toBeGreaterThanOrEqual(poolBefore + 100)
    expect(await conserved()).toBe(before)

    // 成交流水要留一行强平记录
    const trade = await env.DB.prepare(
      "SELECT * FROM game_trades WHERE position_id = ? AND kind = 'liquidate'"
    )
      .bind(opened.position.id)
      .first<{ pnl: number }>()
    expect(Number(trade?.pnl)).toBe(-100)
  })

  it("强平只用一次 CAS 抢占：重复扫描不会二次归池", async () => {
    const params = await withPool(admin, 20_000)
    const user = await makeUser()
    await fund(user.id, 1000)
    const opened = await openPosition(env, user, { side: "long", leverage: 20, margin: 100 })

    const bear = await makeUser()
    await fund(bear.id, 100_000)
    for (let i = 0; i < 3; i++) {
      await openPosition(env, bear, { side: "short", leverage: 1, margin: 20_000 })
    }

    const market = await advanceMarket(env, params)
    const first = await sweepLiquidations(env, params, market)
    expect(first.liquidated.length).toBe(1)

    const market2 = await loadMarket(env)
    const second = await sweepLiquidations(env, params, market2 as NonNullable<typeof market2>)
    expect(second.liquidated.length).toBe(0)

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM game_pool_ledger WHERE ref = ? AND kind = 'intake'"
    )
      .bind(opened.position.id)
      .first<{ c: number }>()
    expect(Number(count?.c)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 重置与统计
// ---------------------------------------------------------------------------

describe("重置行情与统计", () => {
  it("有在仓持仓时拒绝重置（否则等于把所有人瞬间重新定价）", async () => {
    const params = await withPool(admin, 10_000)
    const user = await makeUser()
    await fund(user.id, 1000)
    await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })

    await expect(resetMarket(env, admin, params)).rejects.toMatchObject({ code: "POSITIONS_OPEN" })
  })

  it("没有持仓时可以重置：价格回初始价、K 线清空、换新种子", async () => {
    const params = await setupGame()
    await ensureMarket(env, params)
    const m0 = await ensureMarket(env, params)
    await advanceMarket(env, params, Date.parse(m0.last_tick_at) + 5000 * 120)
    expect(
      Number((await env.DB.prepare("SELECT COUNT(*) AS c FROM game_candles").first<{ c: number }>())?.c)
    ).toBeGreaterThan(0)

    const m1 = await resetMarket(env, admin, params)
    expect(m1.price).toBe(100)
    expect(m1.anchor).toBe(100)
    expect(m1.tick_seq).toBe(0)
    expect(m1.seed).not.toBe(m0.seed)
    expect(
      Number((await env.DB.prepare("SELECT COUNT(*) AS c FROM game_candles").first<{ c: number }>())?.c)
    ).toBe(0)
  })

  it("全服统计给出多空规模与强平数", async () => {
    const params = await withPool(admin, 10_000)
    const user = await makeUser()
    await fund(user.id, 2000)
    await openPosition(env, user, { side: "long", leverage: 2, margin: 100 })
    await openPosition(env, user, { side: "short", leverage: 2, margin: 100 })

    const stats = await gameStats(env)
    expect(stats.openPositions).toBe(2)
    expect(stats.openMargin).toBe(200)
    expect(stats.longSize).toBe(200)
    expect(stats.shortSize).toBe(200)
    expect(stats.totalPositions).toBe(2)
  })

  it("盈亏榜只算已了结的仓位（浮盈不上榜）", async () => {
    const params = await withPool(admin, 10_000)
    const user = await makeUser()
    await fund(user.id, 1000)
    const opened = await openPosition(env, user, { side: "long", leverage: 5, margin: 100 })

    // 还在仓：不该上榜
    const beforeClose = await gameLeaderboard(env, user.id, "all")
    expect(beforeClose.rows.length).toBe(0)
    expect(beforeClose.me).toBeNull()

    await closePosition(env, user, opened.position.id)
    const after = await gameLeaderboard(env, user.id, "all")
    expect(after.rows.length).toBe(1)
    expect(after.me?.trades).toBe(1)
    expect(after.rows[0].username).toBe(user.username)
  })
})

// ---------------------------------------------------------------------------
// 守恒模拟（总验收）
// ---------------------------------------------------------------------------

describe("积分守恒（随机模拟总验收）", () => {
  it("多玩家反复开仓/平仓/强平之后，Σ用户 + 池子 + 在仓保证金 恒定", async () => {
    const params = await withPool(admin, 50_000, {
      // 噪声 120bps/tick + 均值回复 5bps ⇒ 价格的平稳标准差约 12%，
      // 中高杠杆仓位会被随机行情自然打穿（覆盖「噪声触发的强平」这条路径）。
      game_noise_bps: "120",
      game_mean_reversion_bps: "5",
      game_anchor_follow_bps: "1",
      // 单笔冲击硬顶放宽到 15%，收尾阶段的「鲸鱼」才能靠几笔单子把价格推到爆仓线外
      game_max_impact_bps: "1500",
    })

    const players: TestUser[] = []
    for (let i = 0; i < 4; i++) {
      const u = await makeUser()
      await fund(u.id, 20_000)
      players.push(u)
    }
    // 「鲸鱼」：收尾阶段专门用来把价格连续推向同一方向，逼出强平。
    // 单笔冲击有硬顶（sim 里放宽到 1500bps=15%），所以连推几次就能把
    // 中高杠杆的仓位打穿 —— 这比「等随机噪声自己走到爆仓价」可靠得多
    // （后者依赖随机种子，实测会变成随机红的用例）。
    const whale = await makeUser()
    await fund(whale.id, 300_000)

    // 垫本与发分都做完之后再取基线
    const baseline = await conserved()
    expect(baseline).toBeGreaterThan(0)

    // 确定性伪随机，失败可复现
    let x = 987_654_321
    const rnd = () => {
      x = (x * 1103515245 + 12345) % 2147483648
      return x / 2147483648
    }
    const openIds: { user: TestUser; id: string }[] = []

    let opened = 0
    let closed = 0
    let liquidated = 0
    let now = Date.now()

    /** 把已被强平的仓位从待平列表里摘掉（否则后续 close 会拿到 alreadyClosed） */
    async function pruneClosed(): Promise<void> {
      if (openIds.length === 0) return
      const rows = await env.DB.prepare(
        `SELECT id FROM game_positions WHERE id IN (${openIds.map(() => "?").join(",")}) AND status = 'open'`
      )
        .bind(...openIds.map((o) => o.id))
        .all<{ id: string }>()
      const alive = new Set((rows.results ?? []).map((r) => r.id))
      for (let i = openIds.length - 1; i >= 0; i--) {
        if (!alive.has(openIds[i].id)) openIds.splice(i, 1)
      }
    }

    for (let round = 0; round < 60; round++) {
      now += 1000 + Math.floor(rnd() * 30_000)
      const user = players[Math.floor(rnd() * players.length)]
      const roll = rnd()

      if (roll < 0.5 || openIds.length === 0) {
        // 开仓：金额与杠杆都随机，允许因余额不足 / 池子为空而失败（那也是合法路径）
        const margin = 10 + Math.floor(rnd() * 3000)
        const leverage = 1 + Math.floor(rnd() * 20)
        try {
          const res = await openPosition(env, user, {
            side: rnd() < 0.5 ? "long" : "short",
            leverage,
            margin,
            orderNo: `sim-${round}`,
          })
          openIds.push({ user, id: res.position.id })
          opened++
        } catch {
          /* 余额不足 / 池子见底：跳过，不作为失败 */
        }
      } else {
        const pick = openIds.splice(Math.floor(rnd() * openIds.length), 1)[0]
        try {
          const res = await closePosition(env, pick.user, pick.id)
          if (!res.alreadyClosed) closed++
          else liquidated++
        } catch {
          /* 已被强平：跳过 */
        }
      }

      const { liquidated: liq } = await advanceAndSweep(env, params, now)
      liquidated += liq
      if (liq > 0) await pruneClosed()

      // 每一轮都验一次：守恒一旦破坏，立刻能定位到是哪一轮
      expect(await conserved()).toBe(baseline)
    }

    /**
     * 收尾阶段（确定性）：先往上猛推、再往下猛推，直到有仓位被强平。
     *
     * 两个方向都推是必要的 —— 只推一个方向的话，碰上「当时在仓的全是反向单」
     * 就一个都爆不了。上限 14 次 × 15% 足以打穿 3 倍以上的任何仓位
     * （3 倍的爆仓线是 1/3 − 0.5% ≈ 32.8%），而随机杠杆里 1~2 倍只占 10%。
     */
    const whalePushes = async (side: "long" | "short"): Promise<number> => {
      let hits = 0
      for (let i = 0; i < 7; i++) {
        try {
          await openPosition(env, whale, {
            side,
            leverage: 1,
            margin: 50_000,
            orderNo: `whale-${side}-${i}`,
          })
        } catch {
          /* 池子见底 / 余额不足：跳过这一推 */
        }
        now += 30_000
        const r = await advanceAndSweep(env, params, now)
        hits += r.liquidated
        if (r.liquidated > 0) await pruneClosed()
        expect(await conserved()).toBe(baseline)
        if (hits > 0) break
      }
      return hits
    }

    liquidated += await whalePushes("long")
    liquidated += await whalePushes("short")

    // 收尾：把所有还在仓的平掉，守恒依然成立
    for (const item of openIds) {
      try {
        await closePosition(env, item.user, item.id)
      } catch {
        /* 已强平 */
      }
    }
    expect(await conserved()).toBe(baseline)

    // 模拟必须真的发生了（否则这个测试等于什么都没验）
    expect(opened).toBeGreaterThan(20)
    expect(closed).toBeGreaterThan(5)
    expect(liquidated).toBeGreaterThan(0)

    // 池子永不为负是「不凭空增发积分」的另一半保证
    const pool = Number((await loadMarket(env))?.pool_balance ?? 0)
    expect(pool).toBeGreaterThanOrEqual(0)
    // 这个用例要跑几十轮真实 D1 往返（每轮还验一次守恒，便于把问题定位到具体那一轮），
    // 默认 5 秒超时不够 —— 显式放宽，别让它变成一个随机红的用例。
  }, 180_000)
})
