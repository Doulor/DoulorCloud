/**
 * 造物典藏 —— **典藏设置**（管理端）。
 *
 * 路由（路径相对 `/api`，都在 `index.ts` 登记）：
 *   GET  /admin/collection/invest          参数 + 池子 + 全服统计
 *   PUT  /admin/collection/invest          改玩法参数 / 上下架 / 卡片外观
 *   POST /admin/collection/invest/pool     划拨垫本 / 抽回资金
 *   GET  /admin/collection/invest/ledger   池子审计流水
 *   POST /admin/collection/invest/reset    重置行情（危险）
 *
 * 权限：`requireAdminScope(env, request, "collection")`（权限树里登记在
 * 「内容与运营」组下的「造物典藏」）。站长与超管不受白名单限制。
 *
 * ⚠️ 参数写入**必须先过 `sanitizeGameParams`** 再落库：设置项在库里是字符串，
 *    一个手滑多打两个 0（maxLeverage=100000）会直接进引擎。写入侧用引擎自己的
 *    清洗函数，读出来就一定是合法值 —— 读写同一套规则，不会漂移。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { audit, getSettings, updateSettings } from "../settings"
import { getPointsBalance } from "../points"
import {
  depositToPool,
  ensureMarket,
  gameStats,
  loadGameParams,
  poolLedger,
  resetMarket,
  withdrawFromPool,
} from "../game-market"
import { sanitizeGameParams } from "../game-engine"
import { getPlugin, toPublicPlugin, updatePluginRow } from "../collection-plugins"
import type { Env } from "../env"

/** 「在线投资」在清单里的 slug。将来别的内置游戏各有一份同构的设置接口 */
const INVEST_SLUG = "invest"

/** 前端表单能改的 14 个玩法参数（对应 settings.ts 里的 game_* 键） */
const PARAM_KEYS = [
  "game_enabled",
  "game_tick_seconds",
  "game_candle_seconds",
  "game_max_leverage",
  "game_min_margin",
  "game_fee_open_bps",
  "game_fee_close_bps",
  "game_maintenance_bps",
  "game_noise_bps",
  "game_impact_bps",
  "game_mean_reversion_bps",
  "game_reversion_deadband_bps",
  "game_currency",
  "game_test_grant",
  "game_anchor_follow_bps",
  "game_max_impact_bps",
  "game_base_price",
] as const

type ParamKey = (typeof PARAM_KEYS)[number]

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad")
    return body as Record<string, unknown>
  } catch {
    throw new ApiError(400, "请求体格式错误", "INVALID_INPUT")
  }
}

/** 只接受已知键；其余一律忽略（不报错 —— 前端版本可能比后端新，宽容一点） */
function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * GET /api/admin/collection/invest
 *
 * 一次返回设置页要的全部东西：参数原始值（表单回显用字符串，避免「存 5、
 * 显示 5.0」这类噪声）、清洗后的生效值、池子、全服统计、行情快照。
 */
export async function getGameAdmin(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")

  const params = await loadGameParams(env)
  const [settings, market, stats, plugin, myBalance] = await Promise.all([
    getSettings(env),
    ensureMarket(env, params),
    gameStats(env),
    getPlugin(env, INVEST_SLUG),
    getPointsBalance(env, admin.id),
  ])

  const raw: Record<string, string> = {}
  for (const key of PARAM_KEYS) raw[key] = settings[key]

  return json({
    plugin: plugin ? toPublicPlugin(plugin, true) : null,
    /** 表单回显用（库里存的原始字符串） */
    raw,
    /** 实际生效的参数（已被 sanitize，可能与 raw 不同 —— 那说明库里的值被收口了） */
    effective: {
      enabled: params.enabled,
      tickSeconds: params.tickMs / 1000,
      candleSeconds: params.candleMs / 1000,
      maxLeverage: params.maxLeverage,
      minMargin: params.minMargin,
      feeOpenBps: params.feeOpenBps,
      feeCloseBps: params.feeCloseBps,
      maintenanceBps: params.maintenanceBps,
      noiseBps: params.noiseBps,
      impactBps: params.impactBps,
      meanReversionBps: params.meanReversionBps,
    reversionDeadbandBps: params.reversionDeadbandBps,
      anchorFollowBps: params.anchorFollowBps,
      maxImpactBps: params.maxImpactBps,
      basePrice: params.basePrice,
      /** 当前货币模式与测试币额度（管理面板的切换器回显用） */
      currency: params.currency,
      testGrant: params.testGrant,
    },
    market: {
      price: market.price,
      anchor: market.anchor,
      tickSeq: market.tick_seq,
      lastTickAt: market.last_tick_at,
      candleOpenAt: market.candle_open_at,
    },
    pool: {
      balance: market.pool_balance,
      /** 测试币池子（与真积分池互不影响） */
      testBalance: Number(market.pool_test_balance ?? 0),
      /** 站长自己的余额 —— 划拨垫本是从他账户扣，页面直接告诉他有多少可划 */
      myBalance,
    },
    stats,
  })
}

/**
 * PUT /api/admin/collection/invest
 *
 * body: { params?: { game_xxx: number|string }, plugin?: { status?, accent?, name?, tagline?, description? } }
 *
 * 参数先合到「当前值」上再整体清洗 —— **部分更新**是必须支持的：
 * 前端只提交被改动的那几个输入框，如果直接对缺省值取默认，
 * 会把没动过的参数悄悄重置回默认（站长改个手续费把杠杆上限改回 20，很难发现）。
 */
export async function updateGameAdmin(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")
  const body = await readJson(request)

  const patch: Partial<Record<ParamKey, string>> = {}
  const rawParams = (body.params ?? {}) as Record<string, unknown>
  for (const key of PARAM_KEYS) {
    if (!(key in rawParams)) continue
    const v = rawParams[key]
    if (key === "game_enabled") {
      patch[key] = v === true || v === "1" || v === 1 || v === "true" ? "1" : "0"
      continue
    }
    // 字符串型参数：只认这两个取值，其余一律回落 points（安全方向：真积分）
    if (key === "game_currency") {
      patch[key] = v === "test" ? "test" : "points"
      continue
    }
    const n = numOrUndefined(v)
    if (n !== undefined) patch[key] = String(n)
  }

  if (Object.keys(patch).length > 0) {
    // 先合并到当前值，再整体清洗，最后把**清洗后的值**写回库
    const current = await loadGameParams(env)
    const merged = sanitizeGameParams({
      enabled: patch.game_enabled !== undefined ? patch.game_enabled : current.enabled,
      tickSeconds: patch.game_tick_seconds ?? current.tickMs / 1000,
      candleSeconds: patch.game_candle_seconds ?? current.candleMs / 1000,
      maxLeverage: patch.game_max_leverage ?? current.maxLeverage,
      minMargin: patch.game_min_margin ?? current.minMargin,
      feeOpenBps: patch.game_fee_open_bps ?? current.feeOpenBps,
      feeCloseBps: patch.game_fee_close_bps ?? current.feeCloseBps,
      maintenanceBps: patch.game_maintenance_bps ?? current.maintenanceBps,
      noiseBps: patch.game_noise_bps ?? current.noiseBps,
      impactBps: patch.game_impact_bps ?? current.impactBps,
      meanReversionBps: patch.game_mean_reversion_bps ?? current.meanReversionBps,
    reversionDeadbandBps:
      patch.game_reversion_deadband_bps ?? current.reversionDeadbandBps,
      anchorFollowBps: patch.game_anchor_follow_bps ?? current.anchorFollowBps,
      maxImpactBps: patch.game_max_impact_bps ?? current.maxImpactBps,
      basePrice: patch.game_base_price ?? current.basePrice,
      currency: patch.game_currency ?? current.currency,
      testGrant: patch.game_test_grant ?? current.testGrant,
    })

    await updateSettings(env, {
      game_enabled: merged.enabled ? "1" : "0",
      game_tick_seconds: String(merged.tickMs / 1000),
      game_candle_seconds: String(merged.candleMs / 1000),
      game_max_leverage: String(merged.maxLeverage),
      game_min_margin: String(merged.minMargin),
      game_fee_open_bps: String(merged.feeOpenBps),
      game_fee_close_bps: String(merged.feeCloseBps),
      game_maintenance_bps: String(merged.maintenanceBps),
      game_noise_bps: String(merged.noiseBps),
      game_impact_bps: String(merged.impactBps),
      game_mean_reversion_bps: String(merged.meanReversionBps),
          game_reversion_deadband_bps: String(merged.reversionDeadbandBps),
      game_anchor_follow_bps: String(merged.anchorFollowBps),
      game_max_impact_bps: String(merged.maxImpactBps),
      game_base_price: String(merged.basePrice),
      game_currency: merged.currency,
      game_test_grant: String(merged.testGrant),
    })

    /**
     * ⚠️ 切换货币时**必须记下时间点**（`currency_since`）。
     *
     * 排行榜是拿 game_trades 的盈亏汇总的，而两段时期的 1 分完全不是一回事
     * （一段是真积分、一段是测试币）。记下切换时刻后，排行榜只统计切换之后的成交，
     * 否则榜上会出现「真积分时代赚的 3000」压着「测试币时代亏的 20」这种荒谬对比。
     */
    if (current.currency !== merged.currency) {
      await env.DB.prepare(
        "UPDATE game_market SET currency_since = ?, updated_at = ? WHERE id = 1"
      )
        .bind(new Date().toISOString(), new Date().toISOString())
        .run()
    }
  }

  // 插件自身的行（上下架 / 卡片外观）。刻意与玩法参数分开：一个是运营状态，一个是玩法
  const pluginPatch = (body.plugin ?? {}) as Record<string, unknown>
  const row: {
    status?: string
    accent?: string
    name?: string
    tagline?: string
    description?: string
  } = {}
  if (typeof pluginPatch.status === "string") {
    const allowed = ["draft", "review", "published", "disabled"]
    if (!allowed.includes(pluginPatch.status)) {
      throw new ApiError(400, "未知的上架状态", "INVALID_INPUT")
    }
    row.status = pluginPatch.status
  }
  if (typeof pluginPatch.accent === "string") {
    // 只允许 hex 色值或空（空 = 用站点默认色）。别让这里变成注入 CSS 的口子
    const accent = pluginPatch.accent.trim()
    if (accent && !/^#[0-9a-fA-F]{3,8}$/.test(accent)) {
      throw new ApiError(400, "强调色要填 #RRGGBB 形式", "INVALID_INPUT")
    }
    row.accent = accent
  }
  if (typeof pluginPatch.name === "string") row.name = pluginPatch.name.trim().slice(0, 40)
  if (typeof pluginPatch.tagline === "string") row.tagline = pluginPatch.tagline.trim().slice(0, 80)
  if (typeof pluginPatch.description === "string") {
    row.description = pluginPatch.description.trim().slice(0, 1000)
  }
  if (Object.keys(row).length > 0) {
    await updatePluginRow(env, INVEST_SLUG, row)
  }

  await audit(
    env,
    admin.id,
    "collection.game.config",
    `${admin.username} 更新了「在线投资」的典藏设置` +
      (Object.keys(patch).length > 0 ? `（${Object.keys(patch).join(", ")}）` : "")
  )

  return await getGameAdmin(env, request)
}

/**
 * POST /api/admin/collection/invest/pool  { action: "deposit" | "withdraw", amount }
 *
 * 垫本划拨：从站长账户扣、池子加（总量不变）。这是全游戏唯一的资金注入入口，
 * 也是「站内积分守恒」在管理员侧的那一半。
 */
export async function setGamePool(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")
  const body = await readJson(request)
  const action = body.action === "withdraw" ? "withdraw" : "deposit"
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount < 1) {
    throw new ApiError(400, "数量必须是不小于 1 的整数", "INVALID_INPUT")
  }

  const params = await loadGameParams(env)
  // 池子行必须存在（首次划拨时它还没被创建）
  await ensureMarket(env, params)

  const res =
    action === "deposit"
      ? await depositToPool(env, admin, amount)
      : await withdrawFromPool(env, admin, amount)

  return json({
    ok: true,
    action,
    pool: res.pool,
    /** 操作后站长自己的余额 */
    balance: res.balance,
  })
}

/** GET /api/admin/collection/invest/ledger?limit=50 */
export async function getGameLedger(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "collection")
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const rows = await poolLedger(env, Number.isFinite(limit) ? limit : 50)
  return json({
    entries: rows.map((r) => ({
      id: String(r.id),
      delta: Number(r.delta ?? 0),
      balanceAfter: Number(r.balance_after ?? 0),
      kind: String(r.kind),
      username: r.username === null || r.username === undefined ? null : String(r.username),
      ref: r.ref === null || r.ref === undefined ? null : String(r.ref),
      note: r.note === null || r.note === undefined ? null : String(r.note),
      createdAt: String(r.created_at),
    })),
  })
}

/**
 * POST /api/admin/collection/invest/reset  { confirm: "RESET" }
 *
 * 重置行情：价格回到初始价、K 线清空、换新种子。**有在仓持仓时直接拒绝**
 * （理由见 game-market.ts 的 resetMarket）。
 */
export async function resetGame(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "collection")
  const body = await readJson(request)
  if (body.confirm !== "RESET") {
    throw new ApiError(400, "危险操作需要二次确认（confirm 传 \"RESET\"）", "CONFIRM_REQUIRED")
  }
  const params = await loadGameParams(env)
  const market = await resetMarket(env, admin, params)
  return json({ ok: true, price: market.price, tickSeq: market.tick_seq })
}
