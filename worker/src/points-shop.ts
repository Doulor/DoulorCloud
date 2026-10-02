/**
 * 积分商城：商品与订单。
 *
 * 设计要点：
 *   1. 商品分**官方**与**用户**两类，靠 `owner_id` 区分（NULL = 官方）。
 *      官方商品的「交付方式」决定下单之后发生什么：
 *        · `manual`       —— 只生成一张「待发放」订单，由管理员在后台点「标记已发放」
 *        · `quota`        —— 自动充入 AI 中转站余额（元 → 原始额度按 newapi_quota_per_unit 换算）
 *        · `feature`      —— 自动授予一个模块权限（r2 / ai / frp / proxy）
 *        · `subscription` —— 自动开通一个 NewAPI 订阅套餐（planId 由管理员自己填，代码不写死）
 *        · `invite_quota` —— 自动增加「邀请码创建额度」
 *      除 `quota` 用专用列 `quota_yuan` 外，其余类型的参数存在 `delivery_params`（JSON）。
 *   2. **用户商品一律 `manual` 且走担保**（2026-09-28 站长要求「用户也能上传商品卖积分」）：
 *        · 只允许人工交付 —— 自动发权限 / 订阅 / 额度是平台能力，不能由用户创建
 *        · 上架前必须管理员审核（review_status）
 *        · 下单只扣买家积分、**不立刻给卖家**；卖家标记交付、买家确认收货后才结算
 *        · 因此用户商品订单多一个终态 `settled`；中途取消直接原路退买家，
 *          卖家从未拿到过这笔积分，不需要从他账上倒扣
 *   3. 下单顺序：**校验 → 占库存 → 扣积分 → 交付**。所有「用户无法挽回」的检查
 *      （未绑定中转站、已有该权限、超限购、已售罄、买自己的商品）都必须排在扣积分之前 ——
 *      否则会出现「扣了分却拿不到东西」。
 *   4. 自动充值失败时**退回积分 + 还原库存**，订单记为 cancelled。宁可让用户重下
 *      一次，也不能让他丢了积分还没拿到货。
 *   5. 积分变动全部走 points.ts 的 applyPoints()，本文件不直接写 user_points。
 *      结算 / 退款都带 dedup_key（`shop-settle:<订单号>` / `shop-refund:<订单号>`），
 *      并发重复调用不会发两次钱。
 *   6. 订单存的是**下单时的商品名 / 单价 / 卖家名快照**：商品改价或删除都不影响历史订单，
 *      管理员列表也不需要 JOIN products / users。
 *   7. **计费方式**分买断（`one_time`）与租用（`rental`，有效 N 天）：
 *        · 租期在**交付生效**时才写入 `expires_at`（官方自动交付 = 下单成功那一刻；
 *          官方人工交付 = 管理员点发放；用户商品 = 买家确认收货 / 管理员结算），
 *          不是下单时 —— 免得卖家拖延发货白吃买家租期。
 *        · 还在租期内再买同一件 = **续费**，从原到期时间**往后顺延**，不浪费剩余天数。
 *        · 到期由 maintenance 的 `expireRentalOrders` 处理：收回权限（仅 feature 类，
 *          且确认没有别的有效租用在给同一权限）、归还库存、打幂等标记。
 *          **不改订单状态** —— delivered / settled 是历史事实。
 *        · 租用商品的 `stock` 语义是「**同时**最多能租出几份」，到期/取消归还。
 *        · `quota` / `invite_quota` 不允许租用（一次性消耗品，收不回来）。
 *
 * ⚠️ 积分页上那个「兑换中转站余额」**不是**这里的一条商品记录，而是由
 *    points.ts 的 redeemPoints() 处理的、金额可变的商品位（前端画成一张卡片）。
 *    这里只管上架的、单价固定的商品。
 */
import { ApiError } from "./http"
import { uuid } from "./crypto"
import { adminGrantSubscription, adminSetQuota, getCurrencyInfo } from "./newapi-client"
import { applyPoints } from "./points"
import {
  FEATURES,
  FEATURE_LABELS,
  featurePermissionSql,
  hasFeature,
  type Feature,
} from "./permissions"
import { grantFeatures, loadPermissions } from "./vouchers"
import { audit, getSetting } from "./settings"
import { pushMessage } from "./user-messages"
import type { Env } from "./env"

export type ProductDelivery =
  | "manual"
  | "quota"
  | "feature"
  | "subscription"
  | "invite_quota"

/**
 * 计费方式。
 *
 * · `one_time` —— 买断：付一次，永久有效（`expires_at` 恒为 NULL）。
 * · `rental`   —— 租用 / 定期：付一次，有效 `rental_days` 天，到期失效（见 expireRentalOrders）。
 *
 * ⚠️ 租用**不允许**搭配 `quota` / `invite_quota` —— 额度和邀请码额度是
 *    一次性消耗品，发出去就收不回来，「到期收回」无从谈起（见 sanitizeProductInput）。
 */
export type BillingMode = "one_time" | "rental"

/**
 * 订单状态。
 *
 * · `pending`   —— 待发放（官方商品：等管理员）／待卖家交付（用户商品，积分托管中）
 * · `delivered` —— 已发放（官方商品，终态）／卖家已交付、等买家确认（用户商品，仍在托管）
 * · `settled`   —— **仅用户商品**：买家确认收货，积分已结算给卖家（终态）
 * · `cancelled` —— 已取消，积分已退回买家（终态）
 */
export type OrderStatus = "pending" | "delivered" | "settled" | "cancelled"

/** 用户商品的审核状态；官方商品恒为 'approved' */
export type ReviewStatus = "pending" | "approved" | "rejected"

/**
 * 交付参数（`point_products.delivery_params`，JSON）。
 *
 * 每种交付方式只用到其中一个字段，校验见 `sanitizeProductInput`。
 *
 * ⚠️ `quota` **不用这里** —— 它走的是历史专用列 `quota_yuan`（那时还没有本列）。
 *    两者并存，别把 quota_yuan 当成「重复字段」删掉：线上已有商品与历史订单都在读它。
 */
export interface DeliveryParams {
  /** delivery='feature'：要授予的模块 */
  feature?: Feature
  /** delivery='subscription'：NewAPI 套餐 id（管理员自己填，代码里不写死） */
  planId?: number
  /** delivery='invite_quota'：增加的邀请码创建额度 */
  count?: number
}

export interface PointProduct {
  id: string
  name: string
  description: string
  imageUrl: string | null
  /**
   * 内置图标名（lucide slug，如 'gift' / 'credit-card'）；null = 没选。
   *
   * 与 imageUrl 是**互补**关系：imageUrl 优先，没填图片才用图标；
   * 两个都没有时前端回退成默认图标。这里只做格式校验，
   * 具体是不是个存在的图标交给前端映射（未命中会回退，不会崩）。
   */
  icon: string | null
  /** 售价（积分） */
  price: number
  /** 剩余库存；null = 不限量 */
  stock: number | null
  /** 每人限购件数；null = 不限 */
  perUserLimit: number | null
  delivery: ProductDelivery
  /** delivery='quota' 时每件充入多少元 */
  quotaYuan: number | null
  /** 其余自动交付方式各自的参数；quota / manual 时为 null */
  deliveryParams: DeliveryParams | null
  /**
   * 计费方式：买断 / 租用。
   *
   * ⚠️ 租用商品的 `stock` 语义与买断**不同**：买断是「一共能卖几件」，
   *    租用是「**同时**最多能租出几份」（到期/取消会归还，见文件头注释）。
   */
  billingMode: BillingMode
  /** 租期天数；billingMode='one_time' 时为 null */
  rentalDays: number | null
  enabled: boolean
  sort: number
  /** 上架者 id；**null = 官方商品**（站长上架） */
  ownerId: string | null
  /** 上架时的用户名快照（用户商品才有） */
  ownerName: string | null
  /** 审核状态；官方商品恒为 'approved' */
  reviewStatus: ReviewStatus
  /** 审核意见（拒绝时写给用户看） */
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PointOrder {
  id: string
  userId: string
  username: string
  productId: string | null
  productName: string
  price: number
  delivery: string
  quotaYuan: number | null
  status: OrderStatus
  note: string | null
  /** 卖家 id（下单时快照）；**null = 官方商品订单** */
  sellerId: string | null
  sellerName: string | null
  createdAt: string
  deliveredAt: string | null
  /** 积分结算给卖家的时间（仅用户商品订单） */
  settledAt: string | null
  /** 自动充值 / 用户商品订单为 null；人工发放的记录管理员 id */
  deliveredBy: string | null
  /** 下单时的计费方式快照（'one_time' | 'rental'）——订单是快照，商品事后改动不影响它 */
  billingMode: BillingMode
  /** 下单时的租期天数快照；买断订单为 null */
  rentalDays: number | null
  /**
   * 租用订单的到期时间；**买断订单恒为 NULL**。
   *
   * ⚠️ 到期**不会改变 `status`** —— 订单仍然是 delivered / settled（那是「交付/结算」的
   *    历史事实，不该被抹掉）。「是否已到期」由 `expiresAt < now` 派生判断，
   *    前端据此显示「有效期至 X」或「已到期」。收回权益的动作由
   *    `expireRentalOrders` 完成，幂等标记是 `expireHandledAt`。
   */
  expiresAt: string | null
  /** 续费时指向被顺延的原订单 id（追溯用） */
  renewedFrom: string | null
  /** 到期处理（收回权益）的时间；NULL = 还没处理过 */
  expireHandledAt: string | null
  /** 有限库存占用标记；取消或租期到期后由数据库触发器清零 */
  stockReserved: boolean
  /**
   * 本单**实际授予**的模块权限名（仅 delivery='feature' 时非空）。
   * 到期收回时靠它判断「收哪个权限」，不依赖商品行是否还在。
   */
  grantedFeature: string | null
}

/** 新建 / 编辑商品时前端提交的字段（已经过 sanitize） */
export interface ProductInput {
  name: string
  description: string
  imageUrl: string | null
  icon: string | null
  price: number
  stock: number | null
  perUserLimit: number | null
  delivery: ProductDelivery
  quotaYuan: number | null
  deliveryParams: DeliveryParams | null
  billingMode: BillingMode
  rentalDays: number | null
  enabled: boolean
  sort: number
  ownerId: string | null
  ownerName: string | null
  reviewStatus: ReviewStatus
}

const MAX_PRICE = 100_000_000
const MAX_STOCK = 1_000_000
/** 单件自动充值金额上限（元）：防手滑把 100 写成 100000000 */
const MAX_QUOTA_YUAN = 100_000
const MAX_PER_USER_LIMIT = 10_000
/** 中转站套餐 id 上限（纯粹防手滑，真实 id 由 NewAPI 决定） */
const MAX_PLAN_ID = 1_000_000
/** 单件可发放的邀请码创建额度上限 */
const MAX_INVITE_QUOTA = 1_000
/** 图标名格式：lucide 风格的 slug（小写字母 / 数字，单连字符分段） */
const ICON_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_ICON_LEN = 40
/**
 * 单个用户最多能上架多少件商品。
 *
 * 必须有上限：用户商城的列表是所有人共享的，不限制的话一个人挂 500 件
 * 就能把别人的商品全挤到后面去（这是**刷屏**，不是「违规」，所以不靠人工审核兜底）。
 */
const MAX_PRODUCTS_PER_USER = 20

/** 租期上限（天）：3650 天 ≈ 10 年。纯粹防手滑把 30 写成 30000000 */
const MAX_RENTAL_DAYS = 3650

const DELIVERIES: readonly ProductDelivery[] = [
  "manual",
  "quota",
  "feature",
  "subscription",
  "invite_quota",
]

/**
 * 允许搭配「租用」的交付方式。
 *
 * 排除 quota / invite_quota：额度是**一次性消耗品**，发出去就收不回来 ——
 * 到期既没法收回、也没法判断用户用了多少，「租用」只剩个日期好看。
 * （订阅可以：订阅本身就是有期限的；feature 可以：权限能收回；
 *   manual 可以：官方人工商品与用户商品都靠人工履约，平台只记账。）
 */
const RENTAL_DELIVERIES: readonly ProductDelivery[] = [
  "manual",
  "feature",
  "subscription",
]

function isDelivery(v: unknown): v is ProductDelivery {
  return typeof v === "string" && (DELIVERIES as readonly string[]).includes(v)
}

function isBillingMode(v: unknown): v is BillingMode {
  return v === "one_time" || v === "rental"
}

function isReviewStatus(v: unknown): v is ReviewStatus {
  return v === "pending" || v === "approved" || v === "rejected"
}

/**
 * 解析库里存的 delivery_params。
 *
 * 只认「与当前 delivery 匹配」的那个字段 —— 比如 delivery 被从 feature 改成
 * subscription 时，残留的 `{"feature":"ai"}` 不会被读出来，避免出现
 * 「显示是订阅、实际发的是权限」这种自相矛盾的状态。
 * 认不出的值一律当「没配」，交给交付时的兜底报错，而不是静默发个错东西。
 */
function parseDeliveryParams(
  raw: unknown,
  delivery: ProductDelivery
): DeliveryParams | null {
  if (typeof raw !== "string" || !raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o !== "object" || o === null) return null
    const out: DeliveryParams = {}
    if (
      delivery === "feature" &&
      typeof o.feature === "string" &&
      (FEATURES as readonly string[]).includes(o.feature)
    ) {
      out.feature = o.feature as Feature
    }
    if (delivery === "subscription" && Number.isInteger(Number(o.planId)) && Number(o.planId) > 0) {
      out.planId = Number(o.planId)
    }
    if (delivery === "invite_quota" && Number.isInteger(Number(o.count)) && Number(o.count) > 0) {
      out.count = Number(o.count)
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

function rowToProduct(r: Record<string, unknown>): PointProduct {
  const delivery: ProductDelivery = isDelivery(r.delivery) ? r.delivery : "manual"
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    description: String(r.description ?? ""),
    imageUrl: r.image_url == null ? null : String(r.image_url),
    icon: r.icon == null || r.icon === "" ? null : String(r.icon),
    price: Number(r.price ?? 0),
    stock: r.stock == null ? null : Number(r.stock),
    perUserLimit: r.per_user_limit == null ? null : Number(r.per_user_limit),
    delivery,
    quotaYuan: r.quota_yuan == null ? null : Number(r.quota_yuan),
    deliveryParams: parseDeliveryParams(r.delivery_params, delivery),
    // 老行没有这一列时（迁移前）默认按「买断」处理，与历史行为一致
    billingMode: isBillingMode(r.billing_mode) ? r.billing_mode : "one_time",
    rentalDays: r.rental_days == null ? null : Number(r.rental_days),
    enabled: Number(r.enabled ?? 0) === 1,
    sort: Number(r.sort ?? 0),
    ownerId: r.owner_id == null ? null : String(r.owner_id),
    ownerName: r.owner_name == null ? null : String(r.owner_name),
    // 老行没有这一列时（迁移前的官方商品）默认按「已通过」处理，不会被审核流程挡住
    reviewStatus: isReviewStatus(r.review_status) ? r.review_status : "approved",
    reviewNote: r.review_note == null ? null : String(r.review_note),
    reviewedAt: r.reviewed_at == null ? null : String(r.reviewed_at),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  }
}

function rowToOrder(r: Record<string, unknown>): PointOrder {
  const raw = String(r.status ?? "")
  const status: OrderStatus =
    raw === "delivered" || raw === "settled" || raw === "cancelled" ? raw : "pending"
  return {
    id: String(r.id),
    userId: String(r.user_id),
    username: String(r.username ?? ""),
    productId: r.product_id == null ? null : String(r.product_id),
    productName: String(r.product_name ?? ""),
    price: Number(r.price ?? 0),
    delivery: String(r.delivery ?? "manual"),
    quotaYuan: r.quota_yuan == null ? null : Number(r.quota_yuan),
    status,
    note: r.note == null ? null : String(r.note),
    sellerId: r.seller_id == null ? null : String(r.seller_id),
    sellerName: r.seller_name == null ? null : String(r.seller_name),
    createdAt: String(r.created_at ?? ""),
    deliveredAt: r.delivered_at == null ? null : String(r.delivered_at),
    settledAt: r.settled_at == null ? null : String(r.settled_at),
    deliveredBy: r.delivered_by == null ? null : String(r.delivered_by),
    billingMode: isBillingMode(r.billing_mode) ? r.billing_mode : "one_time",
    rentalDays: r.rental_days == null ? null : Number(r.rental_days),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
    renewedFrom: r.renewed_from == null ? null : String(r.renewed_from),
    expireHandledAt: r.expire_handled_at == null ? null : String(r.expire_handled_at),
    stockReserved: Number(r.stock_reserved ?? 0) === 1,
    grantedFeature: r.granted_feature == null ? null : String(r.granted_feature),
  }
}

/** 把整数读成「可空整数」：空串 / null → null；非法值直接报错（不静默兜底） */
function nullableInt(raw: unknown, label: string, min: number, max: number): number | null {
  if (raw === null || raw === undefined || raw === "") return null
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ApiError(400, `${label}必须是整数`, "INVALID_INPUT")
  }
  if (n < min || n > max) {
    throw new ApiError(400, `${label}需在 ${min} ~ ${max} 之间`, "INVALID_INPUT")
  }
  return n
}

/**
 * 校验并归一化商品输入。坏值一律报错，不做「猜用户意图」的兜底。
 *
 * `opts.asUser = true` 时按**用户商品**的规则收紧：
 *   · 交付方式强制 `manual`（自动发权限 / 订阅 / 额度是平台能力，不开放给用户）
 *   · 每人限购强制 null（用户商品不需要这个维度）
 *   · 排序强制 0（用户商品不给自定义排序，免得有人靠 sort 把自己的商品顶到最前）
 *   · 库存仍可自填（用户商品通常是有限件数的二手物，不限量也允许）
 */
function sanitizeProductInput(raw: unknown, opts: { asUser?: boolean } = {}): ProductInput {
  const b = (raw ?? {}) as Record<string, unknown>
  const asUser = opts.asUser === true

  const name = typeof b.name === "string" ? b.name.trim().slice(0, 40) : ""
  if (!name) throw new ApiError(400, "请填写商品名称", "INVALID_INPUT")

  const description = typeof b.description === "string" ? b.description.trim().slice(0, 500) : ""

  let imageUrl: string | null = null
  if (typeof b.imageUrl === "string" && b.imageUrl.trim()) {
    const url = b.imageUrl.trim().slice(0, 500)
    if (!/^https?:\/\//i.test(url)) {
      throw new ApiError(400, "封面图地址必须是 http(s) 链接", "INVALID_INPUT")
    }
    imageUrl = url
  }

  // 图标名只允许 lucide 那种 slug（小写字母 / 数字 / 单连字符分段）。
  // 不做「白名单」是刻意的：前端有回退，加图标时不必两边同时改；
  // 但格式必须卡死，免得把任意字符串塞进库、以后被当成 HTML 或路径用。
  let icon: string | null = null
  if (typeof b.icon === "string" && b.icon.trim()) {
    const slug = b.icon.trim().toLowerCase()
    if (slug.length > MAX_ICON_LEN || !ICON_SLUG_RE.test(slug)) {
      throw new ApiError(400, "图标标识不合法", "INVALID_INPUT")
    }
    icon = slug
  }

  const price = nullableInt(b.price, "售价", 1, MAX_PRICE)
  if (price === null) throw new ApiError(400, "请填写售价（积分）", "INVALID_INPUT")

  const stock = nullableInt(b.stock, "库存", 0, MAX_STOCK)
  // 限购：0 与 null 都当「不限」，统一存 null；用户商品一律不限
  const limitRaw = asUser ? null : nullableInt(b.perUserLimit, "每人限购", 0, MAX_PER_USER_LIMIT)
  const perUserLimit = limitRaw && limitRaw > 0 ? limitRaw : null

  const delivery: ProductDelivery = asUser
    ? "manual"
    : isDelivery(b.delivery)
      ? b.delivery
      : "manual"

  const params = (b.deliveryParams ?? {}) as Record<string, unknown>

  let quotaYuan: number | null = null
  let deliveryParams: DeliveryParams | null = null

  if (delivery === "quota") {
    const n = Number(b.quotaYuan)
    if (!Number.isFinite(n) || n <= 0) {
      throw new ApiError(400, "自动充值的商品必须填写每件充入金额（元）", "INVALID_INPUT")
    }
    if (n > MAX_QUOTA_YUAN) {
      throw new ApiError(400, `单件充值金额不能超过 ${MAX_QUOTA_YUAN} 元`, "INVALID_INPUT")
    }
    // 保留两位小数：避免 0.30000000000000004 这类浮点尾巴进库
    quotaYuan = Math.round(n * 100) / 100
  } else if (delivery === "feature") {
    // 模块名必须是已知的 4 个之一。前端用下拉框给选项，但这里不能信前端 ——
    // 传个 `../../etc` 进来会被原样写进库，以后当成 JSON 键用。
    const f = String(params.feature ?? "")
    if (!(FEATURES as readonly string[]).includes(f)) {
      throw new ApiError(400, "请选择要授予的模块权限", "INVALID_INPUT")
    }
    deliveryParams = { feature: f as Feature }
  } else if (delivery === "subscription") {
    // ⚠️ 套餐 id 由管理员**自己填**，代码里不写死任何一个 —— NewAPI 后台的套餐
    //    是站长自己建的，写死一个 id 等于把商品绑到某个特定部署上。
    const n = Number(params.planId)
    if (!Number.isInteger(n) || n <= 0 || n > MAX_PLAN_ID) {
      throw new ApiError(400, "请填写有效的中转站套餐 ID（正整数）", "INVALID_INPUT")
    }
    deliveryParams = { planId: n }
  } else if (delivery === "invite_quota") {
    const n = Number(params.count)
    if (!Number.isInteger(n) || n <= 0 || n > MAX_INVITE_QUOTA) {
      throw new ApiError(
        400,
        `邀请码额度需为 1 ~ ${MAX_INVITE_QUOTA} 的整数`,
        "INVALID_INPUT"
      )
    }
    deliveryParams = { count: n }
  }

  // 计费方式：买断 / 租用。租期是「天」，只在租用时有值。
  const billingMode: BillingMode = isBillingMode(b.billingMode) ? b.billingMode : "one_time"
  let rentalDays: number | null = null
  if (billingMode === "rental") {
    const n = Number(b.rentalDays)
    if (!Number.isInteger(n) || n <= 0 || n > MAX_RENTAL_DAYS) {
      throw new ApiError(
        400,
        `租期需为 1 ~ ${MAX_RENTAL_DAYS} 的整数（天）`,
        "INVALID_INPUT"
      )
    }
    // 额度类交付不能租用：发出去就收不回来（见 RENTAL_DELIVERIES 的说明）
    if (!(RENTAL_DELIVERIES as readonly string[]).includes(delivery)) {
      throw new ApiError(
        400,
        "「自动充余额」和「邀请码额度」是一次性发放的，不能设为租用。",
        "RENTAL_NOT_SUPPORTED"
      )
    }
    rentalDays = n
  }

  const sort = asUser ? 0 : (nullableInt(b.sort, "排序", -100_000, 100_000) ?? 0)

  return {
    name,
    description,
    imageUrl,
    icon,
    price,
    stock,
    perUserLimit,
    delivery,
    quotaYuan,
    deliveryParams,
    billingMode,
    rentalDays,
    enabled: b.enabled === undefined ? true : Boolean(b.enabled),
    sort,
    // 归属与审核状态由调用方（createProduct / createUserProduct）决定，这里只给中性默认值
    ownerId: null,
    ownerName: null,
    reviewStatus: "approved",
  }
}

export interface ListProductsOptions {
  /** 只返回上架的（用户端展示用） */
  onlyEnabled?: boolean
  /** 只看官方商品（owner_id IS NULL）或只看用户商品；缺省 = 全部 */
  scope?: "official" | "user"
  /** 只看某个用户上架的（含待审核 / 已下架 / 已拒绝） */
  ownerId?: string
  /** 只看某个审核状态 */
  reviewStatus?: ReviewStatus
  limit?: number
}

/** 商品列表 */
export async function listProducts(
  env: Env,
  opts: ListProductsOptions = {}
): Promise<PointProduct[]> {
  const conds: string[] = []
  const binds: unknown[] = []
  if (opts.scope === "official") conds.push("owner_id IS NULL")
  else if (opts.scope === "user") conds.push("owner_id IS NOT NULL")
  if (opts.ownerId) {
    conds.push("owner_id = ?")
    binds.push(opts.ownerId)
  }
  if (opts.reviewStatus) {
    conds.push("review_status = ?")
    binds.push(opts.reviewStatus)
  }
  if (opts.onlyEnabled) conds.push("enabled = 1")

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 500)
  const rows = await env.DB.prepare(
    `SELECT * FROM point_products ${where} ORDER BY sort DESC, created_at DESC LIMIT ?`
  )
    .bind(...binds, limit)
    .all<Record<string, unknown>>()
  return (rows.results ?? []).map(rowToProduct)
}

/** 读单个商品 */
export async function getProduct(env: Env, id: string): Promise<PointProduct | null> {
  const row = await env.DB.prepare("SELECT * FROM point_products WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>()
  return row ? rowToProduct(row) : null
}

const PRODUCT_COLUMNS =
  "(id, name, description, image_url, icon, price, stock, per_user_limit, " +
  " delivery, quota_yuan, delivery_params, billing_mode, rental_days, enabled, sort, " +
  " owner_id, owner_name, review_status, review_note, reviewed_at, created_at, updated_at)"

/** PRODUCT_COLUMNS 的列数 —— INSERT 的占位符个数必须与它一致 */
const PRODUCT_COLUMN_COUNT = 22

function productBindings(id: string, input: ProductInput, now: string): unknown[] {
  return [
    id,
    input.name,
    input.description,
    input.imageUrl,
    input.icon,
    input.price,
    input.stock,
    input.perUserLimit,
    input.delivery,
    input.quotaYuan,
    input.deliveryParams ? JSON.stringify(input.deliveryParams) : null,
    input.billingMode,
    input.rentalDays,
    input.enabled ? 1 : 0,
    input.sort,
    input.ownerId,
    input.ownerName,
    input.reviewStatus,
    null,
    input.reviewStatus === "approved" ? now : null,
    now,
    now,
  ]
}

/** 新建**官方**商品（管理员） */
export async function createProduct(env: Env, raw: unknown): Promise<PointProduct> {
  const input = sanitizeProductInput(raw)
  const now = new Date().toISOString()
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO point_products ${PRODUCT_COLUMNS} VALUES (${new Array(PRODUCT_COLUMN_COUNT).fill("?").join(", ")})`
  )
    .bind(...productBindings(id, input, now))
    .run()
  return { id, ...input, reviewNote: null, reviewedAt: now, createdAt: now, updatedAt: now }
}

/**
 * 编辑**官方**商品（整条覆盖，与前端弹窗「保存」语义一致）。
 *
 * ⚠️ 用户商品不允许走这里 —— 用 updateUserProduct()。否则管理员（或任何
 *    能调到这个接口的路径）会把用户商品整条改掉、还会顺手把审核状态刷成「已通过」。
 */
export async function updateProduct(env: Env, id: string, raw: unknown): Promise<PointProduct> {
  const existing = await getProduct(env, id)
  if (!existing) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  if (existing.ownerId) {
    throw new ApiError(400, "这是用户上架的商品，请用审核操作处理", "NOT_OFFICIAL_PRODUCT")
  }

  const input = sanitizeProductInput(raw)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE point_products SET
       name = ?, description = ?, image_url = ?, icon = ?, price = ?, stock = ?,
       per_user_limit = ?, delivery = ?, quota_yuan = ?, delivery_params = ?,
       billing_mode = ?, rental_days = ?,
       enabled = ?, sort = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      input.name,
      input.description,
      input.imageUrl,
      input.icon,
      input.price,
      input.stock,
      input.perUserLimit,
      input.delivery,
      input.quotaYuan,
      input.deliveryParams ? JSON.stringify(input.deliveryParams) : null,
      input.billingMode,
      input.rentalDays,
      input.enabled ? 1 : 0,
      input.sort,
      now,
      id
    )
    .run()
  const updated = await getProduct(env, id)
  if (!updated) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  return updated
}

/** 删除商品。历史订单保留（存的是快照，不依赖商品行） */
export async function deleteProduct(env: Env, id: string): Promise<void> {
  const res = await env.DB.prepare("DELETE FROM point_products WHERE id = ?").bind(id).run()
  if ((res.meta?.changes ?? 0) === 0) {
    throw new ApiError(404, "商品不存在", "NOT_FOUND")
  }
}

// ---------------------------------------------------------------- 用户商品

/** 用户上架自己的商品（进入待审核，不会立刻出现在用户端） */
export async function createUserProduct(
  env: Env,
  owner: { id: string; username: string },
  raw: unknown
): Promise<PointProduct> {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM point_products WHERE owner_id = ?"
  )
    .bind(owner.id)
    .first<{ c: number }>()
  if (Number(count?.c ?? 0) >= MAX_PRODUCTS_PER_USER) {
    throw new ApiError(
      400,
      `你最多只能上架 ${MAX_PRODUCTS_PER_USER} 件商品，请先删掉一些。`,
      "TOO_MANY_PRODUCTS"
    )
  }

  const input = sanitizeProductInput(raw, { asUser: true })
  const now = new Date().toISOString()
  const id = uuid()
  const withOwner: ProductInput = {
    ...input,
    ownerId: owner.id,
    ownerName: owner.username,
    reviewStatus: "pending",
  }
  await env.DB.prepare(
    `INSERT INTO point_products ${PRODUCT_COLUMNS} VALUES (${new Array(PRODUCT_COLUMN_COUNT).fill("?").join(", ")})`
  )
    .bind(...productBindings(id, withOwner, now))
    .run()
  return { id, ...withOwner, reviewNote: null, reviewedAt: null, createdAt: now, updatedAt: now }
}

/**
 * 用户编辑自己的商品。
 *
 * 改完**重新回到待审核** —— 否则「先挂个正常商品过审，再改成违规内容」
 * 就能绕过审核，那审核等于没有。
 */
export async function updateUserProduct(
  env: Env,
  ownerId: string,
  id: string,
  raw: unknown
): Promise<PointProduct> {
  const existing = await getProduct(env, id)
  if (!existing) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  if (existing.ownerId !== ownerId) {
    throw new ApiError(403, "只能修改自己上架的商品", "FORBIDDEN")
  }

  const input = sanitizeProductInput(raw, { asUser: true })
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE point_products SET
       name = ?, description = ?, image_url = ?, icon = ?, price = ?, stock = ?,
       per_user_limit = NULL, delivery = 'manual', quota_yuan = NULL,
       delivery_params = NULL, billing_mode = ?, rental_days = ?,
       enabled = ?, sort = 0,
       review_status = 'pending', review_note = NULL, reviewed_at = NULL,
       updated_at = ?
     WHERE id = ? AND owner_id = ?`
  )
    .bind(
      input.name,
      input.description,
      input.imageUrl,
      input.icon,
      input.price,
      input.stock,
      input.billingMode,
      input.rentalDays,
      input.enabled ? 1 : 0,
      now,
      id,
      ownerId
    )
    .run()
  const updated = await getProduct(env, id)
  if (!updated) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  return updated
}

/** 用户删除自己的商品。有还没结束的订单时不允许删（免得买家找不到出处） */
export async function deleteUserProduct(
  env: Env,
  ownerId: string,
  id: string
): Promise<void> {
  const existing = await getProduct(env, id)
  if (!existing) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  if (existing.ownerId !== ownerId) {
    throw new ApiError(403, "只能删除自己上架的商品", "FORBIDDEN")
  }
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM point_orders WHERE product_id = ? AND status IN ('pending', 'delivered')"
  )
    .bind(id)
    .first<{ c: number }>()
  if (Number(open?.c ?? 0) > 0) {
    throw new ApiError(
      400,
      "这件商品还有没交付完的订单，处理完再删。",
      "ORDER_IN_PROGRESS"
    )
  }
  await env.DB.prepare("DELETE FROM point_products WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId)
    .run()
}

/** 管理员审核用户商品：通过 / 拒绝 */
export async function reviewProduct(
  env: Env,
  adminId: string,
  id: string,
  approve: boolean,
  note?: string
): Promise<PointProduct> {
  const product = await getProduct(env, id)
  if (!product) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  if (!product.ownerId) {
    throw new ApiError(400, "官方商品不需要审核", "NOT_USER_PRODUCT")
  }

  const now = new Date().toISOString()
  const status: ReviewStatus = approve ? "approved" : "rejected"
  await env.DB.prepare(
    `UPDATE point_products
        SET review_status = ?, review_note = ?, reviewed_at = ?,
            enabled = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(
      status,
      note?.trim().slice(0, 200) || null,
      now,
      approve ? 1 : 0,
      now,
      id
    )
    .run()

  await audit(
    env,
    adminId,
    "points.shop.review",
    `${approve ? "通过" : "拒绝"}用户商品「${product.name}」（${product.ownerName ?? "?"}）` +
      `${note ? ` · ${note}` : ""}`
  )

  // 审核结果通知卖家 —— 之前审核完卖家完全不知情，商品一直「待审核」也没人提醒。
  // 幂等键带上状态：同一商品「先驳回、改完再审通过」应当各留一条。
  await pushMessage(env, product.ownerId, {
    category: "system",
    type: approve ? "product_approved" : "product_rejected",
    title: approve ? `商品已上架：「${product.name}」` : `商品未通过审核：「${product.name}」`,
    body: approve
      ? "已出现在「用户们的商城」里，有人买下时会通知你交付。"
      : `未通过原因：${note?.trim() || "未填写"}。改完重新提交会再次进入审核。`,
    link: "/dashboard/points",
    payload: { kind: "product", productId: product.id },
    dedupKey: `product-review:${product.id}:${status}`,
  })

  const updated = await getProduct(env, id)
  if (!updated) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  return updated
}

// ---------------------------------------------------------------- 订单

/**
 * 订单相关的站内通知（站长 2026-09-29 要求：买卖东西要能在消息中心收到，
 * 并且**直接在消息里执行操作**）。
 *
 * 统一走 `system` 分类（消息中心「系统消息」），并带 payload：
 *   `{ kind: "order", orderId, action: "deliver" | "confirm" | null, peer: string | null }`
 * 前端据此在消息里渲染「发货 / 确认收货」按钮 —— 这是「快捷执行操作」的约定，
 * 改动时两边要一起改（见 `src/pages/messages.tsx` 的 `OrderMessageActions`）。
 *
 * `peer` 是「这笔订单里对方」的用户名快照（给卖家发 → 买家；给买家发 → 卖家）。
 * 前端用它渲染「去私聊」按钮直达 /dashboard/dm/<peer> —— 私信按用户名寻址，
 * 用户名又是下单时的快照字段，不用额外查库；官方商品订单没有对端，为 null。
 *
 * dedupKey = `order-<事件>:<订单号>`：同一个事件重复触发只留一条，
 * 但「下单 / 发货 / 结算」是不同事件，各自留一条，用户能看到完整时间线。
 */
async function notifyOrder(
  env: Env,
  userId: string | null | undefined,
  opts: {
    /** 事件短名，决定 type 与幂等键：paid | placed | delivered | shipped | settled | cancelled */
    event: string
    title: string
    body: string
    orderId: string
    /** 有值时前端会在消息里给一个操作按钮 */
    action?: "deliver" | "confirm"
    /** 订单对端的用户名快照（买家或卖家），前端「去私聊」按钮用 */
    peer?: string | null
  }
): Promise<void> {
  if (!userId) return
  await pushMessage(env, userId, {
    category: "system",
    type: `order_${opts.event}`,
    title: opts.title,
    body: opts.body,
    link: "/dashboard/points",
    payload: {
      kind: "order",
      orderId: opts.orderId,
      action: opts.action ?? null,
      peer: opts.peer ?? null,
    },
    dedupKey: `order-${opts.event}:${opts.orderId}`,
  })
}

/** 订单列表。给 userId 看买家单，给 sellerId 看卖家单；status 可选过滤 */
export async function listOrders(
  env: Env,
  opts: {
    userId?: string
    sellerId?: string
    status?: OrderStatus
    limit?: number
  } = {}
): Promise<PointOrder[]> {
  const conds: string[] = []
  const binds: unknown[] = []
  if (opts.userId) {
    conds.push("user_id = ?")
    binds.push(opts.userId)
  }
  if (opts.sellerId) {
    conds.push("seller_id = ?")
    binds.push(opts.sellerId)
  }
  if (opts.status) {
    conds.push("status = ?")
    binds.push(opts.status)
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500)
  const rows = await env.DB.prepare(
    `SELECT * FROM point_orders ${where} ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(...binds, limit)
    .all<Record<string, unknown>>()
  return (rows.results ?? []).map(rowToOrder)
}

/** 读单个订单 */
async function getOrder(env: Env, id: string): Promise<PointOrder | null> {
  const row = await env.DB.prepare("SELECT * FROM point_orders WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>()
  return row ? rowToOrder(row) : null
}

/** 某用户在某商品上「已买过几件」（已取消的不算） */
async function countUserOrders(env: Env, userId: string, productId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM point_orders WHERE user_id = ? AND product_id = ? AND status != 'cancelled'"
  )
    .bind(userId, productId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

// ---------------------------------------------------------------- 租用

/** ISO 时间 + N 天。非法输入按「现在」起算（不让脏数据把到期时间算成 NaN） */
function addDaysIso(baseIso: string, days: number): string {
  const t = Date.parse(baseIso)
  const start = Number.isFinite(t) ? t : Date.now()
  return new Date(start + days * 86_400_000).toISOString()
}

/**
 * 算租用订单的到期时间。
 *
 * `base` 是「该用户在该商品上已有的、还没到期的租用」的最晚到期时间：
 * 有就**从它往后顺延**（续费不浪费剩余天数），没有就从现在起算。
 *
 * ⚠️ 只在**交付生效**时调用（见 buyProduct / deliverOrder / settleEscrow），
 *    不在下单时调用 —— 否则「卖家拖 5 天才发货」会白吃买家 5 天租期。
 */
function rentalExpiryFrom(base: string | null, days: number, now: string): string {
  const start = base && base > now ? base : now
  return addDaysIso(start, days)
}

/**
 * 找该用户在该商品上**当前仍然有效**的租用订单。
 *
 * 用途有两个：
 *   1. 续费顺延的基数；
 *   2. 判断「用户已有的 feature 权限是不是就来自这个商品的有效租用」——
 *      是的话，买同一件租用商品属于**续费**，不该被 ALREADY_OWNED 拦住。
 *
 * 只认 delivered / settled：还没交付的（pending）不算「有效租用」，
 * 否则「下单后立刻再下一单」就能白拿一段顺延。
 */
async function findActiveRental(
  env: Env,
  userId: string,
  productId: string,
  now: string
): Promise<PointOrder | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM point_orders
      WHERE user_id = ? AND product_id = ?
        AND expires_at IS NOT NULL AND expires_at > ?
        AND expire_handled_at IS NULL
        AND status IN ('delivered', 'settled')
      ORDER BY expires_at DESC
      LIMIT 1`
  )
    .bind(userId, productId, now)
    .first<Record<string, unknown>>()
  return row ? rowToOrder(row) : null
}

/**
 * 交付生效时把租期写进订单。
 *
 * 幂等：只对「还没写过 expires_at」的租用订单生效 —— 重复调用（重试 / 管理员
 * 再点一次）不会把到期时间越推越远。买断订单（rental_days 为空）直接跳过。
 */
async function applyRentalExpiry(
  env: Env,
  order: { id: string; userId: string; productId: string | null; renewedFrom: string | null },
  rentalDays: number | null,
  now: string
): Promise<string | null> {
  if (!rentalDays || rentalDays <= 0) return null

  // 顺延基数：本单自己的 renewedFrom（下单时锁定的那一单）优先，
  // 否则取该用户在该商品上其它仍有效的租用里最晚的到期时间。
  let base: string | null = null
  if (order.renewedFrom) {
    const prev = await env.DB.prepare("SELECT expires_at FROM point_orders WHERE id = ?")
      .bind(order.renewedFrom)
      .first<{ expires_at: string | null }>()
    base = prev?.expires_at ?? null
  }
  if (!base && order.productId) {
    const row = await env.DB.prepare(
      `SELECT MAX(expires_at) AS m FROM point_orders
        WHERE user_id = ? AND product_id = ? AND id != ?
          AND expires_at IS NOT NULL AND expires_at > ?
          AND expire_handled_at IS NULL
          AND status IN ('delivered', 'settled')`
    )
      .bind(order.userId, order.productId, order.id, now)
      .first<{ m: string | null }>()
    base = row?.m ?? null
  }

  const expiresAt = rentalExpiryFrom(base, rentalDays, now)
  await env.DB.prepare(
    "UPDATE point_orders SET expires_at = ? WHERE id = ? AND expires_at IS NULL"
  )
    .bind(expiresAt, order.id)
    .run()
  return expiresAt
}

/**
 * 自动交付：按商品的 delivery 把东西真的发出去，返回一句「发了什么」的说明。
 *
 * 抛错 = 发放失败，调用方负责退积分 / 还原库存 / 把订单置 cancelled。
 * 只处理自动类交付（manual 不走这里；用户商品永远是 manual）。
 *
 * ⚠️ 新增一种自动交付方式时，除 `sanitizeProductInput` 的校验外**必须**在这里加
 *    对应分支 —— 否则 `default` 分支会在下单时抛出「未知的交付方式」。
 */
async function deliverAuto(
  env: Env,
  product: PointProduct,
  userId: string,
  newapiUserId: number | null
): Promise<string> {
  switch (product.delivery) {
    case "quota": {
      if (newapiUserId === null) throw new Error("未绑定中转站账号")
      const perUnit = Number(await getSetting(env, "newapi_quota_per_unit")) || 500_000
      const rawQuota = Math.round((product.quotaYuan ?? 0) * perUnit)
      // 展示货币配置失败不能把已经充值成功的权益误判为交付失败；
      // 先取出非副作用信息，再执行不可逆的上游充值。
      const { symbol } = await getCurrencyInfo(env)
      await adminSetQuota(env, newapiUserId, rawQuota, "add")
      return `已自动充值 ${symbol}${product.quotaYuan}`
    }

    case "subscription": {
      if (newapiUserId === null) throw new Error("未绑定中转站账号")
      const planId = product.deliveryParams?.planId
      if (!planId) throw new Error("商品未配置套餐 ID")
      // ⚠️ adminGrantSubscription 把「已达套餐上限 / 已订阅」也当成 ok，
      //    所以这里不用额外判重 —— 重复买只会白花积分，不会报错到用户脸上。
      const res = await adminGrantSubscription(env, newapiUserId, planId)
      if (!res.ok) throw new Error(res.message || "中转站拒绝了这次开通")
      return `已自动开通订阅套餐 #${planId}`
    }

    case "feature": {
      const f = product.deliveryParams?.feature
      if (!f) throw new Error("商品未配置模块权限")
      // grantFeatures 内部是 `json_set` 单语句原子写，不会覆盖用户其它已开的模块
      await grantFeatures(env, userId, [f])
      return `已自动授予「${FEATURE_LABELS[f]}」权限`
    }

    case "invite_quota": {
      const count = product.deliveryParams?.count
      if (!count) throw new Error("商品未配置邀请码额度")
      await env.DB.prepare(
        `UPDATE users
            SET invite_quota_bonus = COALESCE(invite_quota_bonus, 0) + ?,
                updated_at = ?
          WHERE id = ?`
      )
        .bind(count, new Date().toISOString(), userId)
        .run()
      return `已自动增加 ${count} 个邀请码创建额度`
    }

    default:
      throw new Error("未知的交付方式")
  }
}

/**

/**
 * 下单购买。
 *
 * 顺序见文件头注释。注意**库存是先占后退**：条件 UPDATE 的 `stock > 0` 是并发下
 * 唯一的防超卖手段，所以必须放在最前面，失败路径再补回去。
 *
 * 用户商品走担保：只扣分、不结算给卖家（见文件头注释第 2 条）。
 */
export async function buyProduct(
  env: Env,
  user: { id: string; username: string },
  productId: string
): Promise<PointOrder> {
  const product = await getProduct(env, productId)
  if (!product) throw new ApiError(404, "商品不存在", "NOT_FOUND")
  if (!product.enabled) throw new ApiError(400, "该商品已下架", "PRODUCT_DISABLED")

  const isUserProduct = product.ownerId !== null
  const isRental = product.billingMode === "rental"
  const now = new Date().toISOString()

  // 租用商品的「当前有效租用」—— 必须在扣分之前查，它决定两件事：
  //   1. 是不是**续费**（续费要从原到期时间往后顺延，见 applyRentalExpiry）；
  //   2. feature 类商品「已有该权限」时，是不是**因为本商品的有效租用**才有 ——
  //      是就放行（那是续费），不是就拦下（权限来自别处，再买是白花积分）。
  const activeRental = isRental
    ? await findActiveRental(env, user.id, product.id, now)
    : null

  // 用户商品必须是审核通过的状态。前端只展示已通过的，但接口不能信前端 ——
  // 否则拿一个待审核 / 已拒绝商品的 id 直接 POST 就能买到没审过的东西。
  if (isUserProduct && product.reviewStatus !== "approved") {
    throw new ApiError(400, "该商品还未通过审核", "PRODUCT_DISABLED")
  }
  // 不能买自己上架的东西：否则可以把积分在自己的账号间倒来倒去，
  // 也能用「自己买自己」把库存刷成 0 去挤掉别人。
  if (isUserProduct && product.ownerId === user.id) {
    throw new ApiError(400, "不能购买自己上架的商品", "SELF_PURCHASE")
  }

  // 限购（cancelled 的订单不占额度，失败重下不会被自己卡住）
  //
  // ⚠️ 租用商品**不看**这个：租用天然就是「要么有、要么没有」，
  //    续费会再产生一张订单，用「买过几件」去卡会把正常续费挡在门外。
  if (!isRental && product.perUserLimit && product.perUserLimit > 0) {
    const used = await countUserOrders(env, user.id, product.id)
    if (used >= product.perUserLimit) {
      throw new ApiError(
        400,
        `该商品每人限购 ${product.perUserLimit} 件，你已购买 ${used} 件。`,
        "PURCHASE_LIMIT"
      )
    }
  }

  // ---- 前置检查：全部排在扣积分之前（扣了分却拿不到东西是最糟的体验）----

  // 商品自身配置是否完整。配置坏掉的商品绝不能让用户白花积分。
  if (product.delivery === "feature" && !product.deliveryParams?.feature) {
    throw new ApiError(500, "该商品配置有误，请联系管理员", "PRODUCT_MISCONFIGURED")
  }
  if (product.delivery === "subscription" && !product.deliveryParams?.planId) {
    throw new ApiError(500, "该商品配置有误，请联系管理员", "PRODUCT_MISCONFIGURED")
  }
  if (product.delivery === "invite_quota" && !product.deliveryParams?.count) {
    throw new ApiError(500, "该商品配置有误，请联系管理员", "PRODUCT_MISCONFIGURED")
  }

  // 需要「挂在用户中转站账号上」的交付方式（充余额 / 开订阅）必须先绑定中转站。
  // 与兑换同一理由：没绑就发不出去，必须在扣分之前拦住。
  let newapiUserId: number | null = null
  if (product.delivery === "quota" || product.delivery === "subscription") {
    const account = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ newapi_user_id: number }>()
    if (!account?.newapi_user_id) {
      throw new ApiError(
        400,
        product.delivery === "subscription"
          ? "该商品会自动开通中转站订阅，请先开通中转站账号。"
          : "该商品会自动充入 AI 中转站余额，请先开通中转站账号。",
        "NOT_BOUND"
      )
    }
    newapiUserId = account.newapi_user_id
  }

  // 权限类：已经有了就直接拒单（站长 2026-09-28 定的口径，与「兑换权限券」一致）。
  // 放在扣分之前，用户不会白花积分换一个自己早就有的东西。
  //
  // ⚠️ 例外：**租用商品的续费**。用户手里这个权限就是这件商品的有效租用给的，
  //    此时再买同一件就是续费，不能拦。判据是 activeRental（本商品、未到期）。
  if (product.delivery === "feature") {
    const f = product.deliveryParams?.feature as Feature
    const perms = await loadPermissions(env, user.id)
    if (hasFeature(perms, f) && !activeRental) {
      throw new ApiError(
        400,
        `你已经有「${FEATURE_LABELS[f]}」权限了，无需购买。`,
        "ALREADY_OWNED"
      )
    }
  }

  const orderId = uuid()

  let pointsDeducted = false
  try {
    // 1. 占库存（有限量时才需要；条件 UPDATE 保证并发下不会超卖）

    // 2. 扣积分（dedup_key 用订单号，重放同一请求不会扣两次）
    const deducted = await applyPoints(env, {
      userId: user.id,
      delta: -product.price,
      reason: "shop",
      detail: `购买「${product.name}」`,
      dedupKey: `shop:${orderId}`,
    })
    if (!deducted.applied) {
      throw new ApiError(400, "积分不足，无法购买", "INSUFFICIENT_POINTS")
    }
    pointsDeducted = true

    // 3. 落订单（pending；自动交付成功后再改成 delivered）。
    await env.DB.prepare(
      `INSERT INTO point_orders
         (id, user_id, username, product_id, product_name, price, delivery,
          quota_yuan, status, note, seller_id, seller_name,
          billing_mode, rental_days, renewed_from, granted_feature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, user.username, product.id, product.name, product.price,
      product.delivery, product.quotaYuan, isUserProduct ? "等待卖家交付" : null,
      product.ownerId, product.ownerName, product.billingMode,
      isRental ? product.rentalDays : null, activeRental?.id ?? null,
      product.delivery === "feature" ? (product.deliveryParams?.feature ?? null) : null, now
    ).run()
  } catch (err) {
    // 订单写入失败也必须原路补偿；补偿失败记日志，供管理员对账处理。
    if (pointsDeducted) {
      try {
        await applyPoints(env, {
          userId: user.id,
          delta: product.price,
          reason: "shop",
          detail: `购买「${product.name}」失败退回`,
          dedupKey: `shop-refund:${orderId}`,
        })
      } catch (refundErr) {
        console.error("商城订单补偿退款失败:", orderId, refundErr)
        throw new ApiError(500, "购买失败，补偿正在人工处理", "PURCHASE_COMPENSATION_PENDING")
      }
    }
    throw err
  }

  // 4. 交付
  if (isUserProduct || product.delivery === "manual") {
    // 用户商品 / 官方人工商品：都是「先挂 pending，等人工」。用户商品额外要
    // 等买家确认收货才结算，那一步在 confirmOrder() 里。
    // 租期也等到「人工发放 / 买家确认」时才写（见 deliverOrder / settleEscrow）。
    await audit(
      env,
      user.id,
      "points.shop.buy",
      `${user.username} 用 ${product.price} 积分购买「${product.name}」` +
        (isRental ? `（租用 ${product.rentalDays} 天）` : "") +
        (isUserProduct
          ? `（用户商品，卖家 ${product.ownerName ?? "?"}，待交付）`
          : "（待人工发放）")
    )

    // 通知：用户商品要让**卖家**知道有人下单了（带「发货」快捷按钮），
    // 同时告诉**买家**在等谁 —— 之前这里一条消息都不发，双方都得自己想起来去翻页面。
    if (isUserProduct) {
      await notifyOrder(env, product.ownerId, {
        event: "paid",
        title: `有人买下了你的「${product.name}」`,
        body: `买家 **${user.username}** 花 ${product.price} 积分买下。请尽快交付；买家确认收货后积分才会转到你的账上。`,
        orderId,
        action: "deliver",
        peer: user.username,
      })
      await notifyOrder(env, user.id, {
        event: "placed",
        title: `已买下「${product.name}」`,
        body: `积分已由平台保管，等卖家交付后记得回来确认收货 —— 确认后积分才转给卖家。`,
        orderId,
        peer: product.ownerName,
      })
    } else {
      await notifyOrder(env, user.id, {
        event: "placed",
        title: `已下单「${product.name}」`,
        body: `等待管理员发放，处理进度可在「积分与商城 → 我的交易」查看。`,
        orderId,
      })
    }
  } else {
    let deliveryApplied = false
    try {
      const summary = await deliverAuto(env, product, user.id, newapiUserId)
      // deliverAuto 成功后权益已经生效；此后的记账/通知失败不能再退款。
      deliveryApplied = true
      const deliveredAt = new Date().toISOString()
      await env.DB.prepare(
        "UPDATE point_orders SET status = 'delivered', delivered_at = ?, note = ? WHERE id = ?"
      )
        .bind(deliveredAt, summary.slice(0, 300), orderId)
        .run()
      // 自动交付成功 = 交付生效，这里才写租期（续费会自动顺延）
      await applyRentalExpiry(
        env,
        {
          id: orderId,
          userId: user.id,
          productId: product.id,
          renewedFrom: activeRental?.id ?? null,
        },
        isRental ? product.rentalDays : null,
        deliveredAt
      )
      await audit(
        env,
        user.id,
        "points.shop.buy",
        `${user.username} 用 ${product.price} 积分购买「${product.name}」` +
          (isRental ? `（租用 ${product.rentalDays} 天）` : "") +
          `，${summary}`
      )
      // 自动交付是「下单即到账」，通知只是留个凭证，不需要用户再做什么
      await notifyOrder(env, user.id, {
        event: "delivered",
        title: `已发放「${product.name}」`,
        body: summary || "已自动发放。",
        orderId,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 120) : ""
      if (deliveryApplied) {
        console.error("自动交付成功但订单后处理失败:", orderId, err)
        throw new ApiError(500, "商品已发放，订单记录正在同步，请稍后查看", "DELIVERY_RECORDED_PENDING")
      }
      // deliverAuto 失败且权益尚未生效，才可以退款并还原库存。
      try {
        await applyPoints(env, {
          userId: user.id,
          delta: product.price,
          reason: "shop",
          detail: `购买「${product.name}」失败退回`,
          dedupKey: `shop-refund:${orderId}`,
        })
      } catch (compensationErr) {
        console.error("自动交付失败后的商城补偿失败:", orderId, compensationErr)
        throw new ApiError(500, "购买失败，补偿正在人工处理", "PURCHASE_COMPENSATION_PENDING")
      }
      await env.DB.prepare("UPDATE point_orders SET status = 'cancelled', note = ? WHERE id = ?")
        .bind(`自动发放失败，积分已退回${msg ? `：${msg}` : ""}`.slice(0, 300), orderId)
        .run()
      throw new ApiError(502, `购买失败，积分已退回：${msg || "上游暂时不可用，请稍后重试"}`, "PURCHASE_FAILED")
    }
  }

  const created = await getOrder(env, orderId)
  if (!created) throw new ApiError(500, "订单创建失败", "INTERNAL")
  return created
}

/** 管理端：把一张待发放的订单标记为已发放（只针对官方商品） */
export async function deliverOrder(
  env: Env,
  adminId: string,
  orderId: string,
  note?: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.sellerId) {
    throw new ApiError(
      400,
      "这是用户商品订单，请用「结算」或「取消退款」处理。",
      "NOT_OFFICIAL_ORDER"
    )
  }
  if (order.status === "delivered") throw new ApiError(409, "该订单已发放", "ALREADY_DELIVERED")
  if (order.status === "cancelled") {
    throw new ApiError(409, "该订单已取消（积分已退回），无需发放", "ORDER_CANCELLED")
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE point_orders SET status = 'delivered', delivered_at = ?, delivered_by = ?, note = ? WHERE id = ?"
  )
    .bind(now, adminId, note ? note.trim().slice(0, 300) : order.note, orderId)
    .run()

  // 人工发放 = 交付生效，租期从这里起算（买断商品 rentalDays 为空，自动跳过）
  if (order.productId) {
    const product = await getProduct(env, order.productId)
    await applyRentalExpiry(
      env,
      {
        id: order.id,
        userId: order.userId,
        productId: order.productId,
        renewedFrom: order.renewedFrom,
      },
      product?.billingMode === "rental" ? product.rentalDays : null,
      now
    )
  }

  await audit(
    env,
    adminId,
    "points.shop.deliver",
    `发放订单「${order.productName}」（${order.username}，${order.price} 积分）`
  )

  // 官方人工商品发放完成 → 告诉买家（他之前收到的是「等待管理员发放」那条）
  await notifyOrder(env, order.userId, {
    event: "delivered",
    title: `已发放「${order.productName}」`,
    body: note?.trim() || "管理员已完成发放。",
    orderId,
  })

  const updated = await getOrder(env, orderId)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/** 卖家：把自己那单标记为「已交付」（积分仍在托管，等买家确认） */
export async function sellerDeliverOrder(
  env: Env,
  sellerId: string,
  orderId: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.sellerId !== sellerId) {
    throw new ApiError(403, "这不是你的订单", "FORBIDDEN")
  }
  if (order.status === "delivered") throw new ApiError(409, "这单已经标记过交付了", "ALREADY_DELIVERED")
  if (order.status === "settled") throw new ApiError(409, "这单已经结算完成", "ALREADY_SETTLED")
  if (order.status === "cancelled") {
    throw new ApiError(409, "这单已取消（积分已退回买家）", "ORDER_CANCELLED")
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE point_orders SET status = 'delivered', delivered_at = ? WHERE id = ?"
  )
    .bind(now, orderId)
    .run()

  await audit(
    env,
    sellerId,
    "points.shop.seller_deliver",
    `${order.sellerName ?? "卖家"} 标记订单「${order.productName}」已交付（买家 ${order.username}）`
  )

  // 通知买家来确认收货（带快捷按钮）—— 不确认积分就一直挂在托管里，
  // 卖家拿不到钱，所以这一步的提醒对双方都重要。
  await notifyOrder(env, order.userId, {
    event: "shipped",
    title: `卖家已交付「${order.productName}」`,
    body: `请查收后点「确认收货」；确认后积分才会转给卖家 ${order.sellerName ?? ""}。`,
    orderId,
    action: "confirm",
    peer: order.sellerName,
  })

  const updated = await getOrder(env, orderId)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/**
 * 结算：把托管的积分给卖家。买家确认收货 / 管理员强制结算都走这里。
 *
 * 幂等靠 `shop-settle:<订单号>` 这个 dedup_key：重复调用不会给两次钱。
 */
async function settleEscrow(
  env: Env,
  order: PointOrder,
  actorId: string,
  actorLabel: string
): Promise<PointOrder> {
  if (!order.sellerId) {
    throw new ApiError(400, "这不是用户商品订单，无需结算", "NOT_USER_ORDER")
  }
  if (order.status === "settled") throw new ApiError(409, "这单已经结算过了", "ALREADY_SETTLED")
  if (order.status === "cancelled") {
    throw new ApiError(409, "这单已取消（积分已退回买家）", "ORDER_CANCELLED")
  }
  if (order.status === "pending") {
    throw new ApiError(409, "卖家还没有标记交付，不能结算", "NOT_DELIVERED")
  }

  const res = await applyPoints(env, {
    userId: order.sellerId,
    delta: order.price,
    reason: "shop_sell",
    detail: `卖出「${order.productName}」（买家 ${order.username}）`,
    dedupKey: `shop-settle:${order.id}`,
  })
  // applied=false 且原因不是「重复」时，说明钱没进卖家账，不能把订单标成已结算
  if (!res.applied && res.reason !== "duplicated") {
    throw new ApiError(500, "结算失败，请稍后重试", "SETTLE_FAILED")
  }

  const now = new Date().toISOString()
  await env.DB.prepare("UPDATE point_orders SET status = 'settled', settled_at = ? WHERE id = ?")
    .bind(now, order.id)
    .run()

  // 用户商品的租期从**结算**（买家确认收货 / 管理员结算）起算 —— 这时才算真正交付完成。
  // 卖家的「标记已交付」只是中间态，买家可能还要验货。
  if (order.productId) {
    const product = await getProduct(env, order.productId)
    await applyRentalExpiry(
      env,
      {
        id: order.id,
        userId: order.userId,
        productId: order.productId,
        renewedFrom: order.renewedFrom,
      },
      product?.billingMode === "rental" ? product.rentalDays : null,
      now
    )
  }

  await audit(
    env,
    actorId,
    "points.shop.settle",
    `${actorLabel}：订单「${order.productName}」结算 ${order.price} 积分给卖家 ${order.sellerName ?? "?"}`
  )

  // 通知卖家：钱到账了。`actorLabel` 区分是买家确认的还是管理员强制结算的，
  // 免得卖家以为「买家一直没确认，钱怎么自己来了」。
  await notifyOrder(env, order.sellerId, {
    event: "settled",
    title: `积分到账：卖出「${order.productName}」`,
    body: `${order.price} 积分已入账（${actorLabel}，买家 ${order.username}）。`,
    orderId: order.id,
    peer: order.username,
  })

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/** 买家：确认收货（把托管的积分结算给卖家） */
export async function confirmOrder(
  env: Env,
  buyerId: string,
  orderId: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.userId !== buyerId) {
    throw new ApiError(403, "这不是你的订单", "FORBIDDEN")
  }
  return settleEscrow(env, order, buyerId, "买家确认收货")
}

/** 管理员：强制结算（卖家交付了但买家一直不确认时用） */
export async function adminSettleOrder(
  env: Env,
  adminId: string,
  orderId: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return settleEscrow(env, order, adminId, "管理员结算")
}

/**
 * 管理员：取消订单并退款。
 *
 * 三种情况：
 *   · pending / delivered（钱还在托管）—— 直接原路退回买家，卖家没拿到过，无需倒扣
 *   · settled（钱已给卖家）—— 先从卖家账上收回，再退买家；卖家余额不够就报错，
 *     让管理员先去「成员」里调整，而不是把卖家的余额扣成负数
 *   · cancelled —— 已退过，报错
 */
export async function adminCancelOrder(
  env: Env,
  adminId: string,
  orderId: string,
  reason?: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.status === "cancelled") throw new ApiError(409, "该订单已取消", "ORDER_CANCELLED")

  // 已结算的：先把钱从卖家手里收回，收不回来就别往下走
  if (order.status === "settled" && order.sellerId) {
    const back = await applyPoints(env, {
      userId: order.sellerId,
      delta: -order.price,
      reason: "admin",
      detail: `订单「${order.productName}」被撤销，收回卖家收益`,
      dedupKey: `shop-settle-revoke:${order.id}`,
      createdBy: adminId,
    })
    if (!back.applied && back.reason !== "duplicated") {
      throw new ApiError(
        400,
        `卖家 ${order.sellerName ?? "?"} 当前只有 ${back.balance} 积分，不够收回 ${order.price}。` +
          `请先在「成员」里调整卖家积分，再取消这单。`,
        "INSUFFICIENT_POINTS"
      )
    }
  }

  // 退买家（幂等：dedup_key 保证重复取消不会退两次）
  const refunded = await applyPoints(env, {
    userId: order.userId,
    delta: order.price,
    reason: "shop",
    detail: `「${order.productName}」退款`,
    dedupKey: `shop-refund:${order.id}`,
  })
  if (!refunded.applied && refunded.reason !== "duplicated") {
    throw new ApiError(500, "退款失败，请稍后重试", "REFUND_FAILED")
  }

  // 库存还回货架（有限量的商品才需要；商品已删则静默跳过）
  //
  // ⚠️ 租用商品**到期时已经归还过一次**（见 expireRentalOrders）。
  //    若这单已经过到期处理（expire_handled_at 非空），这里就不能再还一次 ——
  //    否则库存会凭空变多（租出去 1 份、收回来 2 份）。
  if (!order.expireHandledAt) {
  }

  const note = `订单已取消，${order.price} 积分已退回${reason ? `：${reason}` : ""}`.slice(0, 300)
  await env.DB.prepare("UPDATE point_orders SET status = 'cancelled', note = ? WHERE id = ?")
    .bind(note, orderId)
    .run()

  await audit(
    env,
    adminId,
    "points.shop.cancel",
    `取消订单「${order.productName}」（买家 ${order.username}，${order.price} 积分已退回）` +
      `${reason ? ` · ${reason}` : ""}`
  )

  // ⚠️ 租用 + feature 类订单被取消时，必须**当场收回权限**：
  //    退款已经退了，若只等 cron 处理，这单 status 变成 cancelled 后就再也不会被扫到
  //    （cron 只扫 delivered / settled），用户等于白拿权限还拿回积分。
  if (order.grantedFeature && !order.expireHandledAt) {
    await revokeRentalFeature(env, order, new Date().toISOString())
  }

  // 通知买卖双方 —— 这是「钱动了」的事件，双方都该知道（尤其卖家：
  // 他可能已经发货，突然被取消会一头雾水）。
  const cancelReason = reason ? `原因：${reason}` : ""
  await notifyOrder(env, order.userId, {
    event: "cancelled",
    title: `订单已取消：「${order.productName}」`,
    body: `${order.price} 积分已退回你的账户。${cancelReason}`,
    orderId,
    peer: order.sellerName,
  })
  await notifyOrder(env, order.sellerId, {
    event: "cancelled",
    title: `订单被取消：「${order.productName}」`,
    body: `买家 ${order.username} 的这单已取消，积分已退回买家。${cancelReason}`,
    orderId,
    peer: order.username,
  })

  const updated = await getOrder(env, orderId)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

// ---------------------------------------------------------------- 到期处理

/**
 * 收回某张订单带来的模块权限。
 *
 * **只在「用户没有别的未到期租用也在给同一个权限」时才真的收回** ——
 * 否则「续费单还在、旧单先到期」就会把权限收掉，等于白续。
 * （与商汤 Key 巡检的口径一致：仅当没有别的来源时才收回。）
 *
 * ⚠️ 这里只看「本商城的其它有效租用」，不查管理员直接授予 / 捐献 / 邀请码来的权限。
 *    理论上可能出现「管理员后来也给了同一权限，租用到期时被一并收掉」——
 *    要完全避免需要在授予时记录来源，代价大而收益小（与 donations 的
 *    granted_feature 口径一致，沿用同一取舍）。
 *
 * @returns "revoked" 已收回 / "kept" 有别的有效租用，保留 / "skipped" 本单没给权限
 */
async function revokeRentalFeature(
  env: Env,
  order: PointOrder,
  now: string
): Promise<"revoked" | "kept" | "skipped"> {
  const f = order.grantedFeature
  if (!f || !(FEATURES as readonly string[]).includes(f)) return "skipped"

  const other = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM point_orders
      WHERE user_id = ? AND id != ? AND granted_feature = ?
        AND expires_at IS NOT NULL AND expires_at > ?
        AND expire_handled_at IS NULL
        AND status IN ('delivered', 'settled')`
  )
    .bind(order.userId, order.id, f, now)
    .first<{ c: number }>()
  if (Number(other?.c ?? 0) > 0) return "kept"

  // 原子写：只把该模块置 false，不整列覆盖（见 permissions.ts 的说明）
  await env.DB.prepare(
    `UPDATE users SET permissions = ${featurePermissionSql(f as Feature, false)}, updated_at = ?
      WHERE id = ?`
  )
    .bind(now, order.userId)
    .run()
  return "revoked"
}

export interface RentalExpiryResult {
  /** 本次扫到多少个「已到期但还没处理过」的租用订单 */
  checked: number
  /** 实际处理完的订单数 */
  handled: number
  /** 收回的模块权限数 */
  permissionsRevoked: number
  /** 因「用户还有别的未到期租用也在给同一权限」而**保留**权限的数量 */
  keptWithOtherSource: number
  /** 归还的库存份数 */
  stockReturned: number
  /** 需要人工跟进的事项（用户商品的到期等） */
  notes: string[]
  errors: string[]
}

/**
 * 处理到期的租用订单。由 maintenance（每小时那条 cron）调用。
 *
 * 做三件事：
 *   1. 收回模块权限（delivery='feature'）—— 见 revokeRentalFeature 的「别的来源」判断；
 *   2. 归还库存 —— 租用商品的 stock 是「**同时**最多能租出几份」，到期要还回去，
 *      否则租出去几次就永久少几份；
 *   3. 打上 `expire_handled_at` —— **幂等标记**，重复跑不会重复收回 / 重复还库存。
 *
 * 不做的事（都是刻意的）：
 *   · 不改 `status` —— delivered / settled 是「交付 / 结算」的历史事实，不该被抹掉。
 *     「是否已到期」由 `expiresAt < now` 在前端派生判断。
 *   · `delivery='subscription'` 不动上游 —— 订阅本身的有效期由 NewAPI 套餐决定。
 *   · `delivery='manual'`（含**所有用户商品**）不强制回收 —— 平台管不了实物 / 服务，
 *     只记一笔 note 让管理员知道，由买卖双方自行处理。
 */
export async function expireRentalOrders(
  env: Env,
  opts: { dryRun?: boolean; limit?: number } = {}
): Promise<RentalExpiryResult> {
  const dryRun = opts.dryRun === true
  const now = new Date().toISOString()
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 500)

  const res: RentalExpiryResult = {
    checked: 0,
    handled: 0,
    permissionsRevoked: 0,
    keptWithOtherSource: 0,
    stockReturned: 0,
    notes: [],
    errors: [],
  }

  const rows = await env.DB.prepare(
    `SELECT * FROM point_orders
      WHERE expires_at IS NOT NULL AND expires_at <= ?
        AND expire_handled_at IS NULL
        AND status IN ('delivered', 'settled')
      ORDER BY expires_at ASC
      LIMIT ?`
  )
    .bind(now, limit)
    .all<Record<string, unknown>>()

  const orders = (rows.results ?? []).map(rowToOrder)
  res.checked = orders.length
  // dryRun 只观察不写库（与 maintenance 的其它项一致）
  if (dryRun) return res

  for (const order of orders) {
    try {
      const verdict = await revokeRentalFeature(env, order, now)
      if (verdict === "revoked") res.permissionsRevoked++
      else if (verdict === "kept") res.keptWithOtherSource++

      // 归还库存（不限量 / 商品已删时 restoreStock 返回 0，静默跳过）

      await env.DB.prepare("UPDATE point_orders SET expire_handled_at = ? WHERE id = ?")
        .bind(now, order.id)
        .run()
      res.handled++
      if (reservedBeforeExpiry) res.stockReturned++

      // 用户商品（manual 交付）平台无法强制回收，留给管理员跟进
      if (order.sellerId) {
        res.notes.push(
          `租用到期：用户商品「${order.productName}」（买家 ${order.username}，卖家 ${order.sellerName ?? "?"}）` +
            `已到期，平台不会强制回收，需要时请人工联系双方。`
        )
      }

      await audit(
        env,
        order.userId,
        "points.shop.expire",
        `租用到期：「${order.productName}」（${order.username}，${order.price} 积分）` +
          (verdict === "revoked"
            ? `，已收回「${FEATURE_LABELS[order.grantedFeature as Feature] ?? order.grantedFeature}」权限`
            : verdict === "kept"
              ? "，用户还有别的未到期租用，权限保留"
              : "")
      )
    } catch (err) {
      res.errors.push(
        `订单 ${order.id} 到期处理失败: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return res
}
