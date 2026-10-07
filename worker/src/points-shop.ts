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
 *        · `code`         —— 从商品卡密池取一条**各不相同**的卡密发给买家（一人一条，用完即止）
 *        · `content`      —— 发一段**人人相同**的固定内容（网盘链接 / 说明 / 通用兑换码），
 *                            下单即到账，不消耗库存、不需要卡密池
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
  notWhitelistedGuard,
  type Feature,
} from "./permissions"
import { grantFeatures, loadPermissions } from "./vouchers"
import { audit, getSetting, siteOffsetHours, siteDayString } from "./settings"
import { pushMessage } from "./user-messages"
import { sendSystemDm } from "./handlers/dm"
import type { Env } from "./env"

export type ProductDelivery =
  | "manual"
  | "quota"
  | "feature"
  | "subscription"
  | "invite_quota"
  /**
   * 补签卡：购买后给用户累计「补签卡」数量，可在签到页消耗一张补签一次漏签的签到
   * （2026-10-05 站长要求）。一次性消耗品、可叠加多张，故不允许租用。
   */
  | "checkin_makeup"
  /** 卡密/Key：下单时从商品卡密池原子取出一条交付（2026-10-03） */
  | "code"
  /**
   * 统一内容：发一段**人人相同**的固定内容（网盘链接 / 说明 / 通用兑换码）。
   *
   * 与 `code`（卡密池，一人一条）相对：这里不消耗任何库存，所有买家拿到的是
   * 管理员在商品里填的同一段文字，下单即到账。
   */
  | "content"

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

/**
 * 售后（退款）状态 —— 与 `OrderStatus` **正交**。
 *
 * 订单状态表达「这笔交易走到哪一步」，售后状态表达「退款诉求走到哪一步」。
 * 退款成立时订单变成 `cancelled`（积分原路退回买家，与管理员取消同一语义），
 * 这里同时记 `'refunded'` 用来区分「是退款退掉的」还是「卖家没发货被取消的」。
 *
 * 为什么不做成 `OrderStatus` 的新枚举值（2026-10-02 决策）：
 *   现有所有按 status 过滤的查询（到期收回权益、归还库存、限购计数…）都建立在那 4 个值上，
 *   加值就要逐处复核；而这套售后本来就是「叠加在订单之上的一条支线」，
 *   单独一列既不动老逻辑，又能表达「谁在什么时候申请、卖家怎么说、平台怎么判」。
 *
 * · `requested` —— 买家已申请，等卖家处理（**官方商品订单不会停在这里**，没有卖家）
 * · `rejected`  —— 卖家拒绝，买家可申请平台介入
 * · `platform`  —— 待平台（管理员）判定；官方商品订单一申请就直接到这里
 * · `closed`    —— 平台判定「不予退款」，售后终结（买家可再次申请，见 requestAfterSale）
 * · `refunded`  —— 已退款（订单同时已是 cancelled）
 */
export type AfterSaleStatus =
  | "requested"
  | "rejected"
  | "platform"
  | "closed"
  | "refunded"

/**
 * 确认收货后还能申请售后的天数（买断交易「验收期」的通行做法）。
 *
 * 刻意不导出：期限判定只在 `requestAfterSale` 里做一次，
 * 前端不重复实现（两边各算一遍迟早会算出不同结果）。
 */
const AFTER_SALE_WINDOW_DAYS = 7

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
  /** delivery='invite_quota' / 'checkin_makeup'：数量（邀请码额度 / 补签卡张数） */
  count?: number
  /** delivery='content'：人人相同的固定交付内容（网盘链接 / 说明 / 通用兑换码） */
  content?: string
}

export interface PointProduct {
  id: string
  name: string
  description: string
  imageUrl: string | null
  /** 分类：it / other（见 PRODUCT_CATEGORIES） */
  category: ProductCategory
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
  /** 每日限量（自然日）；null = 不限（用户反馈 6e002b5e：限量商品希望每天补一点） */
  dailyLimit: number | null
  /** 今日已售数；与 buyProduct 的每日计数同日期口径（站点时区日），无每日限时恒 0 */
  dailySold: number
  /** 累计售出（delivered + settled 订单数）——「按热度排序」用 */
  soldCount: number
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
  /**
   * 交付内容快照（仅 `delivery='content'` 的订单非 NULL）。
   *
   * 与 `note` 分开存：note 是列表里一行摘要（多处截断到 300 字），
   * 而这是买家**买到的东西**本身（最长 2000 字、可能多行），要能反复查看。
   * 存订单快照而不是回查商品 —— 商品事后被改/删都不影响历史订单。
   */
  deliveryContent: string | null
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
  /**
   * 本单**实际授予**的模块权限名（仅 delivery='feature' 时非空）。
   * 到期收回时靠它判断「收哪个权限」，不依赖商品行是否还在。
   */
  grantedFeature: string | null
  /** 售后状态；null = 没有进行中的售后（也从不出售后的订单是 null） */
  afterSaleStatus: AfterSaleStatus | null
  /** 买家申请售后时填写的理由 */
  afterSaleReason: string | null
  /** 售后处理意见：卖家拒绝的理由 / 平台判定说明 */
  afterSaleNote: string | null
  /** 买家申请售后（最近一次）的时间 */
  afterSaleRequestedAt: string | null
  /** 售后终结（退款 / 驳回）的时间 */
  afterSaleResolvedAt: string | null
}

/** 新建 / 编辑商品时前端提交的字段（已经过 sanitize） */
export interface ProductInput {
  name: string
  description: string
  imageUrl: string | null
  icon: string | null
  category: ProductCategory
  price: number
  stock: number | null
  /** 每日限量（自然日）；null = 不限 */
  dailyLimit: number | null
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
/** 每日限量上限 */
const MAX_DAILY_LIMIT = 1_000_000
/** 单件自动充值金额上限（元）：防手滑把 100 写成 100000000 */
const MAX_QUOTA_YUAN = 100_000
const MAX_PER_USER_LIMIT = 10_000
/** 中转站套餐 id 上限（纯粹防手滑，真实 id 由 NewAPI 决定） */
const MAX_PLAN_ID = 1_000_000
/** 单件可发放的邀请码创建额度上限 */
const MAX_INVITE_QUOTA = 1_000
/** 补签卡单件最多发多少张（防手滑写个天文数字） */
const MAX_MAKEUP_CARDS = 100
/**
 * 「统一内容」交付的内容长度上限（字符）。
 *
 * 与订单 note 的上限（300）分开取值：note 是给订单列表一行摘要看的，
 * 而这里的内容是**要真的发给用户**的正文（可能是一整段网盘链接与说明），
 * 太短会逼管理员反复裁剪。取 2000 —— 也刚好卡在推送私信的 8 KB 请求体之内
 * （内容会进消息 body，8 KB 足够放下 2000 个中文字符及其它字段）。
 */
const MAX_DELIVERY_CONTENT_LEN = 2_000
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
  "checkin_makeup",
  "code",
  "content",
]

/**
 * 允许搭配「租用」的交付方式。
 *
 * 排除 quota / invite_quota：额度是**一次性消耗品**，发出去就收不回来 ——
 * 到期既没法收回、也没法判断用户用了多少，「租用」只剩个日期好看。
 * （订阅可以：订阅本身就是有期限的；feature 可以：权限能收回；
 *   manual 可以：官方人工商品与用户商品都靠人工履约，平台只记账。）
 *
 * 同样排除 `code` / `content`：卡密和固定内容都是**一次性发出去的文字**，
 * 到期没有任何可收回的东西（用户早就抄走了），列进来只会让人误会「到期会失效」。
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

/** 认不出的售后状态一律当「没有售后」，不做猜测（与 isBillingMode 等同一口径） */
function isAfterSaleStatus(v: unknown): v is AfterSaleStatus {
  return (
    v === "requested" ||
    v === "rejected" ||
    v === "platform" ||
    v === "closed" ||
    v === "refunded"
  )
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
    if (delivery === "checkin_makeup" && Number.isInteger(Number(o.count)) && Number(o.count) > 0) {
      out.count = Number(o.count)
    }
    if (delivery === "content" && typeof o.content === "string" && o.content.trim()) {
      out.content = o.content.slice(0, MAX_DELIVERY_CONTENT_LEN)
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
    // 列有 DEFAULT 'other'，这里再兜一层（老行 / 异常值）
    category: isProductCategory(r.category) ? r.category : "other",
    price: Number(r.price ?? 0),
    stock: r.stock == null ? null : Number(r.stock),
    dailyLimit: r.daily_limit == null ? null : Number(r.daily_limit),
    /** 今日已售数（不限量商品恒 0）—— 与 buyProduct 的每日计数同日期口径 */
    dailySold: Number(r.daily_sold ?? 0),
    /** 累计售出（delivered + settled 的订单数）——「按热度排序」用 */
    soldCount: Number(r.sold_count ?? 0),
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
    deliveryContent: r.delivery_content == null ? null : String(r.delivery_content),
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
    grantedFeature: r.granted_feature == null ? null : String(r.granted_feature),
    afterSaleStatus: isAfterSaleStatus(r.after_sale_status) ? r.after_sale_status : null,
    afterSaleReason: r.after_sale_reason == null ? null : String(r.after_sale_reason),
    afterSaleNote: r.after_sale_note == null ? null : String(r.after_sale_note),
    afterSaleRequestedAt:
      r.after_sale_requested_at == null ? null : String(r.after_sale_requested_at),
    afterSaleResolvedAt:
      r.after_sale_resolved_at == null ? null : String(r.after_sale_resolved_at),
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
 *   · 交付方式只允许 manual / code / content（2026-10-04 放开自动发货：
 *     卡密与固定内容交的是卖家自己的文字，不动平台资源；权限 / 订阅 / 额度
 *     仍是平台能力，不开放给用户）
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
    // 允许两种形式（2026-10-01「本地上传」上线后补的口子，当时漏改这里：
    // 上传接口返回**相对路径**，被这里拒掉，用户保存商品时报「必须是 http(s) 链接」）：
    //   ① http(s) 绝对链接 —— 外链图床，一直以来的用法；
    //   ② /api/shop-img/<userId>/<file> —— 本地上传接口返回的站内路径。
    // 只放行这个前缀而不是任意相对路径：img src 塞站内路径虽多半无害，
    // 但收口到「只可能是我们发的封面地址」最稳，也防误填前端路由。
    if (!/^https?:\/\//i.test(url) && !url.startsWith("/api/shop-img/")) {
      throw new ApiError(400, "封面图地址必须是 http(s) 链接，或使用「本地上传」", "INVALID_INPUT")
    }
    imageUrl = url
  }

  // 分类：白名单收口，非法值回落 other
  const category: ProductCategory = isProductCategory(b.category) ? b.category : "other"

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
  // 每日限量：0 与 null 都当「不限」，统一存 null；用户商品一律不限
  const dailyRaw = asUser ? null : nullableInt(b.dailyLimit, "每日限量", 0, MAX_DAILY_LIMIT)
  const dailyLimit = dailyRaw && dailyRaw > 0 ? dailyRaw : null
  // 限购：0 与 null 都当「不限」，统一存 null；用户商品一律不限
  const limitRaw = asUser ? null : nullableInt(b.perUserLimit, "每人限购", 0, MAX_PER_USER_LIMIT)
  const perUserLimit = limitRaw && limitRaw > 0 ? limitRaw : null

  // 交付方式：
  //   · 官方商品 —— 全部可选（管理员代表平台，能发任何东西）
  //   · 用户商品 —— 只允许 manual / code / content（2026-10-04 站长放开）。
  //     code（卡密池）与 content（固定内容）交的是**卖家自己的一段文字**，
  //     不动用平台资源（权限 / 订阅 / 额度仍不开放），担保交易语义不变。
  //     传其它自动方式直接 400，让前端明确知道不支持，而不是静默降级成 manual。
  const USER_DELIVERIES: readonly ProductDelivery[] = ["manual", "code", "content"]
  const rawDelivery = isDelivery(b.delivery) ? b.delivery : "manual"
  const delivery: ProductDelivery = asUser
    ? USER_DELIVERIES.includes(rawDelivery)
      ? rawDelivery
      : (() => {
          throw new ApiError(
            400,
            "用户商品只支持「人工发放」「卡密/Key」「固定内容」三种交付方式",
            "DELIVERY_NOT_ALLOWED_FOR_USER"
          )
        })()
    : rawDelivery

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
  } else if (delivery === "checkin_makeup") {
    const n = Number(params.count)
    if (!Number.isInteger(n) || n <= 0 || n > MAX_MAKEUP_CARDS) {
      throw new ApiError(
        400,
        `补签卡数量需为 1 ~ ${MAX_MAKEUP_CARDS} 的整数`,
        "INVALID_INPUT"
      )
    }
    deliveryParams = { count: n }
  } else if (delivery === "content") {
    // 统一内容：必须非空（空内容 = 用户花积分买到空气），并限制长度。
    // 换行保留（网盘链接常带说明，可能多行），只做首尾裁剪。
    const text = typeof params.content === "string" ? params.content.trim() : ""
    if (!text) {
      throw new ApiError(400, "请填写要自动发放的内容", "INVALID_INPUT")
    }
    if (text.length > MAX_DELIVERY_CONTENT_LEN) {
      throw new ApiError(
        400,
        `自动发放的内容不能超过 ${MAX_DELIVERY_CONTENT_LEN} 个字符`,
        "INVALID_INPUT"
      )
    }
    deliveryParams = { content: text }
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
    // 一次性发放的交付不能租用：发出去就收不回来（见 RENTAL_DELIVERIES 的说明）
    if (!(RENTAL_DELIVERIES as readonly string[]).includes(delivery)) {
      throw new ApiError(
        400,
        "「自动充余额」「邀请码额度」「卡密」「固定内容」都是一次性发放的，不能设为租用。",
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
    category,
    price,
    stock,
    dailyLimit,
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
  /**
   * 去掉 `deliveryParams.content`（统一内容的**发货正文**）。
   *
   * ⚠️ 必须给「展示给非卖家」的列表用：content 是要卖的东西本身
   * （网盘链接 / 兑换码），出现在公开商品列表里等于**不买也能看**。
   * 只有两种列表可以带原文：商品**卖家自己的**（myProducts，编辑要用）
   * 和**管理端**的。`feature` / `planId` / `count` 不是秘密，保留不动。
   */
  stripContent?: boolean
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
  // 今日已售数：给前端算「今日剩几个」用。日期口径与 buyProduct 的
  // 每日限量计数**完全一致**（站点时区日），否则会出现
  // 「显示剩 1 个、实际已抢完」的错位。
  const day = siteDayString(new Date(), await siteOffsetHours(env))
  const rows = await env.DB.prepare(
    // 排序规则（2026-10-03 站长要求）：**「其他」分类的商品一律排在别的分类下面**，
    // 同组内再按管理员设的 sort 降序、上架时间降序。
    // `(category = 'other')` 在 SQLite 里求值为 0/1，升序即「非 other 在前」。
    `SELECT point_products.*,
            COALESCE((SELECT sold FROM point_product_daily_sales
                       WHERE product_id = point_products.id AND date = ?), 0) AS daily_sold,
            (SELECT COUNT(*) FROM point_orders
              WHERE product_id = point_products.id AND status IN ('delivered', 'settled')) AS sold_count
       FROM point_products ${where}
      ORDER BY (category = 'other') ASC, sort DESC, created_at DESC LIMIT ?`
  )
    .bind(day, ...binds, limit)
    .all<Record<string, unknown>>()
  const items = (rows.results ?? []).map(rowToProduct)
  if (!opts.stripContent) return items
  return items.map((p) =>
    p.deliveryParams?.content
      ? { ...p, deliveryParams: { ...p.deliveryParams, content: undefined } }
      : p
  )
}

/** 读单个商品 */
export async function getProduct(env: Env, id: string): Promise<PointProduct | null> {
  const day = siteDayString(new Date(), await siteOffsetHours(env))
  const row = await env.DB.prepare(
    `SELECT point_products.*,
            COALESCE((SELECT sold FROM point_product_daily_sales
                       WHERE product_id = point_products.id AND date = ?), 0) AS daily_sold,
            (SELECT COUNT(*) FROM point_orders
              WHERE product_id = point_products.id AND status IN ('delivered', 'settled')) AS sold_count
       FROM point_products WHERE id = ?`
  )
    .bind(day, id)
    .first<Record<string, unknown>>()
  return row ? rowToProduct(row) : null
}

/** 商品分类（2026-10-01 站长要求）：先分两类，以后加只改这里 + 前端选项 */
export const PRODUCT_CATEGORIES = ["it", "other"] as const
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]

/** 白名单校验：非白名单值一律回落 other（老前端不带这字段，不能报错） */
export function isProductCategory(v: unknown): v is ProductCategory {
  return typeof v === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(v)
}

const PRODUCT_COLUMNS =
  "(id, name, description, image_url, icon, price, stock, per_user_limit, " +
  " delivery, quota_yuan, delivery_params, billing_mode, rental_days, enabled, sort, " +
  // ⚠️ 新增列一律追加到**末尾**：列顺序一变，INSERT 占位符就要整体重排，
  //    极易漏一处而变成「字段整体错位」的脏数据。这里只改个数。
  " owner_id, owner_name, review_status, review_note, reviewed_at, created_at, updated_at, " +
  "category, daily_limit)"

/** PRODUCT_COLUMNS 的列数 —— INSERT 的占位符个数必须与它一致 */
const PRODUCT_COLUMN_COUNT = 24

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
    input.category,
    input.dailyLimit,
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
  return { id, ...input, reviewNote: null, reviewedAt: now, createdAt: now, updatedAt: now, dailySold: 0, soldCount: 0 }
}

/**
 * 编辑商品（管理员；官方 / 用户两类都能改，整条覆盖，与前端弹窗「保存」语义一致）。
 *
 * 用户商品也放行（2026-10-03 站长：上架后要能改分类/价格等），但：
 *   · 按 `asUser` 口径收口（manual 交付、无 per_user_limit / quota_yuan / sort），
 *     与用户自己编辑保持一致，避免把官方商品字段口径写进用户商品；
 *   · **不动 review_status** —— 管理员只是纠正分类/价格这类小事，
 *     不把已上架的商品打回「待审核」。
 *
 * 用户**自己**编辑仍走 `updateUserProduct()`（改完回待审核，防「先过审再改内容」绕过审核）。
 */
export async function updateProduct(env: Env, id: string, raw: unknown): Promise<PointProduct> {
  const existing = await getProduct(env, id)
  if (!existing) throw new ApiError(404, "商品不存在", "NOT_FOUND")

  const isUserProduct = existing.ownerId != null
  const input = sanitizeProductInput(raw, isUserProduct ? { asUser: true } : undefined)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE point_products SET
       name = ?, description = ?, image_url = ?, icon = ?, price = ?, stock = ?,
       per_user_limit = ?, delivery = ?, quota_yuan = ?, delivery_params = ?,
       billing_mode = ?, rental_days = ?,
       enabled = ?, sort = ?, category = ?, daily_limit = ?, updated_at = ?
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
      input.category,
      input.dailyLimit,
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

// ---------------------------------------------------------------- 卡密池（delivery='code'）

/** 卡密池概览 */
export async function getProductCodes(
  env: Env,
  productId: string
): Promise<{ total: number; used: number; available: number }> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS available
       FROM point_product_codes WHERE product_id = ?`
  )
    .bind(productId)
    .first<{ total: number; available: number }>()
  const total = Number(r?.total ?? 0)
  const available = Number(r?.available ?? 0)
  return { total, used: total - available, available }
}

/** 追加卡密（同一商品下自动去重）。返回新增条数与当前可用数。 */
export async function addProductCodes(
  env: Env,
  productId: string,
  codes: string[]
): Promise<{ added: number; available: number }> {
  const product = await getProduct(env, productId)
  if (!product) throw new ApiError(404, "商品不存在", "NOT_FOUND")

  const clean = [...new Set(codes.map((c) => c.trim()).filter((c) => c.length > 0))]
  if (clean.length > 2000) {
    throw new ApiError(400, "一次最多导入 2000 条卡密", "INVALID_INPUT")
  }
  let inserted = 0
  if (clean.length > 0) {
    const existing = await env.DB.prepare(
      "SELECT code FROM point_product_codes WHERE product_id = ?"
    )
      .bind(productId)
      .all<{ code: string }>()
    const have = new Set((existing.results ?? []).map((r) => r.code))
    const fresh = clean.filter((c) => !have.has(c))
    const now = new Date().toISOString()
    // D1 单次 batch 语句数有限，分批发
    for (let i = 0; i < fresh.length; i += 100) {
      const chunk = fresh.slice(i, i + 100)
      await env.DB.batch(
        chunk.map((c) =>
          env.DB.prepare(
            "INSERT INTO point_product_codes (id, product_id, code, used_by, used_at, created_at) VALUES (?, ?, ?, NULL, NULL, ?)"
          ).bind(uuid(), productId, c, now)
        )
      )
      inserted += chunk.length
    }
  }
  const info = await getProductCodes(env, productId)
  return { added: inserted, available: info.available }
}

/** 清空「未使用」的卡密，返回删除条数 */
export async function clearUnusedProductCodes(env: Env, productId: string): Promise<number> {
  const res = await env.DB.prepare(
    "DELETE FROM point_product_codes WHERE product_id = ? AND used_at IS NULL"
  )
    .bind(productId)
    .run()
  return res.meta?.changes ?? 0
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
  return { id, ...withOwner, reviewNote: null, reviewedAt: null, createdAt: now, updatedAt: now, dailySold: 0, soldCount: 0 }
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
       per_user_limit = NULL, delivery = ?, quota_yuan = NULL,
       delivery_params = ?, billing_mode = ?, rental_days = ?,
       enabled = ?, sort = 0, category = ?,
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
      input.delivery,
      input.deliveryParams ? JSON.stringify(input.deliveryParams) : null,
      input.billingMode,
      input.rentalDays,
      input.enabled ? 1 : 0,
      input.category,
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
/**
 * 自动发货的**完整内容**通过**私聊**发给买家（2026-10-06 站长要求）。
 *
 * 为什么改：此前完整内容只塞在「已发放」的站内通知正文里，而通知在界面上就是
 * 右下角一闪而过的弹窗 —— 买家一眨眼就错过了，只能回头去「我的交易」里翻订单
 * 才能拿到（站长反馈「一瞬间就没了」）。私信会留在会话里，随时能翻、能复制，
 * 也不会被别的弹窗刷掉。
 *
 * 发送方（决定买家看到的是「谁发的」）：
 *   · 用户商品 → **卖家**：货本来就是他发的，且双方有订单关系 ⇒ 免「聊天申请」；
 *   · 官方商品 → **站长**：平台发货。买家若要回复，因收件人是管理团队同样免申请。
 *
 * ⚠️ 失败只记日志：内容同时也存在订单的 `delivery_content` 里（订单页仍可复制），
 *    所以私聊没发出去**绝不能**影响订单本身。
 */
async function sendDeliveryContentDm(
  env: Env,
  opts: {
    buyerId: string
    /** 卖家 id；官方商品为 null */
    sellerId: string | null
    productName: string
    /** 完整交付正文；为空则不发 */
    content?: string
  }
): Promise<void> {
  const text = (opts.content ?? "").trim()
  if (!text) return

  let fromId = opts.sellerId ?? null
  if (!fromId) {
    // 官方商品：由管理团队代发（站长优先，其次超管、管理员）。
    // 兜底到管理员是为了「一定发得出去」—— 万一站点没建站长账号，内容
    // 也不能就这么丢掉（订单里虽有，但买家不会主动去翻）。
    const sender = await env.DB.prepare(
      `SELECT id FROM users
        WHERE role IN ('root', 'superadmin', 'admin') AND status = 'active'
        ORDER BY CASE role WHEN 'root' THEN 0 WHEN 'superadmin' THEN 1 ELSE 2 END,
                 created_at ASC
        LIMIT 1`
    ).first<{ id: string }>()
    fromId = sender?.id ?? null
  }
  if (!fromId) {
    console.error("自动发货内容未能私聊：找不到发送方（卖家与管理团队均缺失）", opts.productName)
    return
  }

  // 私信单条上限 2000，与商品内容上限相同 —— 内容本来就顶到上限时，
  // 宁可不要那句前缀，也不能把内容尾部截掉。
  const prefix = `你买的「${opts.productName}」已自动发货：\n\n`
  const body = prefix.length + text.length > 2000 ? text : prefix + text

  try {
    await sendSystemDm(env, { fromUserId: fromId, toUserId: opts.buyerId, body })
  } catch (err) {
    console.error("自动发货内容私聊失败:", opts.productName, err)
  }
}

/**
 * 订单流转（交付 / 结算 / 取消）后，把消息里挂着的**快捷操作按钮**摘掉。
 *
 * 为什么必须动服务端（2026-10-01 修）：消息的 payload 写进去就不会变，
 * 买家一旦从**积分页**确认收货（而不是从消息里点），消息里的「确认收货」
 * 按钮就永远留着 —— 下次拉列表它还在，点了才报「这单已经结算过了」。
 * 消息页那边的本地摘除（messages.tsx 的 handleOrderActionDone）只管得住
 * 「当场点」这一条路径，管不住刷新和跨页面操作。
 *
 * 实现注意：
 *   - `json_valid` 必须带上 —— payload 列有 NULL 和老数据，`json_*` 遇到
 *     非法 JSON 会直接抛错（D1 方言坑，见 MEMORY）；
 *   - `json_remove` 只删 `$.action` 这一个键，其余字段（orderId 等）原样保留；
 *   - 按 `action IN (...)` 定向摘：交付时只摘「发货」按钮（买家那条新的
 *     「确认收货」消息刚创建，不能误伤），结算 / 取消时全摘。
 */
async function clearOrderActionButtons(
  env: Env,
  orderId: string,
  actions: readonly string[]
): Promise<void> {
  if (actions.length === 0) return
  const placeholders = actions.map(() => "?").join(",")
  try {
    await env.DB.prepare(
      `UPDATE notifications
          SET payload = json_remove(payload, '$.action')
        WHERE json_valid(payload)
          AND json_extract(payload, '$.kind') = 'order'
          AND json_extract(payload, '$.orderId') = ?
          AND json_extract(payload, '$.action') IN (${placeholders})`
    )
      .bind(orderId, ...actions)
      .run()
  } catch (err) {
    // 摘按钮属于「锦上添花」，失败不能让结算 / 交付本身报错
    console.error("清理订单消息按钮失败:", orderId, err)
  }
}

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
    /**
     * 幂等键后缀。
     *
     * 默认键是 `order-<事件>:<订单号>` —— 同一订单的同类事件只会有一条。
     * 但售后的申请 / 拒绝 / 驳回**可能在一单上发生多次**（买家被拒后可重新申请），
     * 那种场景要把时间戳传进来，否则第 2 次开始的通知会被静默去重吃掉。
     */
    dedupSuffix?: string
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
    dedupKey: `order-${opts.event}:${opts.orderId}${opts.dedupSuffix ?? ""}`,
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
 * 自动交付的返回值。
 *
 * `summary` 是一句**短摘要**，进订单备注（`note`，多处截断到 300 字）、审计日志
 * 与「已发放」通知标题；`content` 是**真正发给买家的正文**（目前只有 `content`
 * 交付方式有），会被完整存进 `point_orders.delivery_content` 并作为通知正文下发。
 *
 * 为什么把两者分开而不是只返回一句话：卡密（code）本身就短，塞进 summary 没问题；
 * 但「统一内容」可能是一整段网盘链接 + 使用说明（最长 2000 字），
 * 塞进 300 字的 note 会被截断 —— 用户就拿不到完整内容了。
 */
interface DeliveryResult {
  /** 短摘要（进 note / 审计 / 通知标题） */
  summary: string
  /** 完整交付正文；无独立正文时省略 */
  content?: string
}

/**
 * 自动交付：按商品的 delivery 把东西真的发出去，返回「发了什么」的说明。
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
): Promise<DeliveryResult> {
  switch (product.delivery) {
    case "quota": {
      if (newapiUserId === null) throw new Error("未绑定中转站账号")
      const perUnit = Number(await getSetting(env, "newapi_quota_per_unit")) || 500_000
      const rawQuota = Math.round((product.quotaYuan ?? 0) * perUnit)
      // 展示货币配置失败不能把已经充值成功的权益误判为交付失败；
      // 先取出非副作用信息，再执行不可逆的上游充值。
      const { symbol } = await getCurrencyInfo(env)
      await adminSetQuota(env, newapiUserId, rawQuota, "add")
      return { summary: `已自动充值 ${symbol}${product.quotaYuan}` }
    }

    case "subscription": {
      if (newapiUserId === null) throw new Error("未绑定中转站账号")
      const planId = product.deliveryParams?.planId
      if (!planId) throw new Error("商品未配置套餐 ID")
      // ⚠️ strictLimit：套餐限购（max_purchase_per_user）拒绝必须是**真实失败**——
      //    旧实现把它当成功，用户会遇到「积分扣了、订阅没到」（2026-10-08 成就奖励
      //    事故的同类问题）。抛错会让调用方退积分 / 还原库存，远好过静默吞掉。
      const res = await adminGrantSubscription(env, newapiUserId, planId, { strictLimit: true })
      if (!res.ok) throw new Error(res.message || "中转站拒绝了这次开通")
      return { summary: `已自动开通订阅套餐 #${planId}` }
    }

    case "feature": {
      const f = product.deliveryParams?.feature
      if (!f) throw new Error("商品未配置模块权限")
      // grantFeatures 内部是 `json_set` 单语句原子写，不会覆盖用户其它已开的模块
      await grantFeatures(env, userId, [f])
      return { summary: `已自动授予「${FEATURE_LABELS[f]}」权限` }
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
      return { summary: `已自动增加 ${count} 个邀请码创建额度` }
    }

    case "checkin_makeup": {
      const count = product.deliveryParams?.count
      if (!count) throw new Error("商品未配置补签卡数量")
      await env.DB.prepare(
        `UPDATE users
            SET checkin_makeup_cards = COALESCE(checkin_makeup_cards, 0) + ?,
                updated_at = ?
          WHERE id = ?`
      )
        .bind(count, new Date().toISOString(), userId)
        .run()
      return { summary: `已获得 ${count} 张补签卡` }
    }

    case "code": {
      // 卡密交付（用户反馈 a977d1cf）：原子取出一条未使用的卡密并标记占用。
      // 用 UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING code —— 单语句完成
      // 「选一条 + 标记」，并发下不会两条订单拿到同一个码。
      const now = new Date().toISOString()
      const claimed = await env.DB.prepare(
        `UPDATE point_product_codes
            SET used_by = ?, used_at = ?
          WHERE id = (
            SELECT id FROM point_product_codes
             WHERE product_id = ? AND used_by IS NULL
             ORDER BY created_at ASC LIMIT 1
          )
        RETURNING code`
      )
        .bind(userId, now, product.id)
        .first<{ code: string }>()
      if (!claimed) throw new Error("卡密已售罄，请联系管理员补货")
      // 卡密本身就是用户要的东西：摘要与正文都给它（正文单独存一份，
      // 这样「我的交易」里能原样复制，而不是从「已发货：xxx」里抠）
      return { summary: `已发货：${claimed.code}`, content: claimed.code }
    }

    case "content": {
      // 统一内容：所有人拿到的是管理员在商品里填的同一段文字。
      // 没有上游调用、不消耗任何资源，所以这里不会失败 —— 唯一的失败可能在
      // 下单前的前置校验（内容为空 → PRODUCT_MISCONFIGURED）。
      const text = product.deliveryParams?.content?.trim()
      if (!text) throw new Error("商品未配置自动发放的内容")
      // 摘要只取首行并压到 60 字（进 note / 通知标题，别把多行内容糊进去）
      const firstLine = text.split("\n")[0].trim()
      const summary = `已自动发货：${firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine}`
      return { summary, content: text }
    }

    default:
      throw new Error("未知的交付方式")
  }
}

/**
 * 把商品库存还回去（有限量的商品才需要）。商品已被删时静默跳过。
 *
 * @returns 实际改动的行数（0 = 商品已删 / 不限量，没还成）
 */
async function restoreStock(env: Env, productId: string | null): Promise<number> {
  if (!productId) return 0
  const res = await env.DB.prepare(
    "UPDATE point_products SET stock = stock + 1, updated_at = ? WHERE id = ? AND stock IS NOT NULL"
  )
    .bind(new Date().toISOString(), productId)
    .run()
  return res.meta?.changes ?? 0
}

/** 归还一个「当日名额」（每日限量买的退单/失败补偿用） */
async function releaseDailySlot(env: Env, productId: string | null): Promise<void> {
  if (!productId) return
  const day = siteDayString(new Date(), await siteOffsetHours(env))
  await env.DB.prepare(
    "UPDATE point_product_daily_sales SET sold = MAX(0, sold - 1) WHERE product_id = ? AND date = ?"
  )
    .bind(productId, day)
    .run()
}
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
  if (product.delivery === "checkin_makeup" && !product.deliveryParams?.count) {
    throw new ApiError(500, "该商品配置有误，请联系管理员", "PRODUCT_MISCONFIGURED")
  }
  // 卡密池空了要在扣分**之前**拦住（deliverAuto 也能拦，但那已经扣过分、
  // 要走补偿退款一圈）。官方与用户卡密商品共用这一条。
  if (product.delivery === "code") {
    const pool = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM point_product_codes WHERE product_id = ? AND used_by IS NULL"
    )
      .bind(product.id)
      .first<{ c: number }>()
    if (Number(pool?.c ?? 0) === 0) {
      throw new ApiError(
        400,
        "该商品的卡密已售罄，请联系卖家补货",
        "OUT_OF_STOCK"
      )
    }
  }
  // 统一内容：内容为空就等于「什么都没发」，不能让用户白花积分
  if (product.delivery === "content" && !product.deliveryParams?.content?.trim()) {
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

  let stockReserved = false
  let pointsDeducted = false
  /** 是否已占用一个「当日名额」（用于失败时归还） */
  let dailyReserved = false
  try {
    // 1. 占库存（有限量时才需要；条件 UPDATE 保证并发下不会超卖）
    if (product.stock !== null) {
      const res = await env.DB.prepare(
        "UPDATE point_products SET stock = stock - 1, updated_at = ? " +
          "WHERE id = ? AND enabled = 1 AND stock > 0"
      ).bind(now, product.id).run()
      if ((res.meta?.changes ?? 0) === 0) {
        throw new ApiError(400, "该商品已售罄", "OUT_OF_STOCK")
      }
      stockReserved = true
    }

    // 1b. 每日限量（用户反馈 6e002b5e：「限量商品每天补一点」）：
    //     按自然日累计、隔天自动恢复，靠日期键实现，不需要定时任务。
    if (product.dailyLimit !== null) {
      const day = siteDayString(new Date(), await siteOffsetHours(env))
      const row = await env.DB.prepare(
        `INSERT INTO point_product_daily_sales (product_id, date, sold) VALUES (?, ?, 1)
         ON CONFLICT(product_id, date) DO UPDATE SET sold = sold + 1
         RETURNING sold`
      )
        .bind(product.id, day)
        .first<{ sold: number }>()
      if ((row?.sold ?? 0) > product.dailyLimit) {
        await env.DB.prepare(
          "UPDATE point_product_daily_sales SET sold = MAX(0, sold - 1) WHERE product_id = ? AND date = ?"
        ).bind(product.id, day).run()
        throw new ApiError(400, "该商品今日名额已抢完，明天再来", "OUT_OF_STOCK")
      }
      dailyReserved = true
    }

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
      }
    }
    if (stockReserved) {
      try { await restoreStock(env, product.id) }
      catch (stockErr) { console.error("商城库存补偿失败:", orderId, stockErr) }
    }
    if (dailyReserved) {
      try { await releaseDailySlot(env, product.id) }
      catch (dailyErr) { console.error("商城每日限量补偿失败:", orderId, dailyErr) }
    }
    throw err
  }

  // 4. 交付
  if (product.delivery === "manual") {
    // 人工商品（官方或用户）：都是「先挂 pending，等人工」。用户商品额外要
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
      const { summary, content } = await deliverAuto(env, product, user.id, newapiUserId)
      // deliverAuto 成功后权益已经生效；此后的记账/通知失败不能再退款。
      deliveryApplied = true
      const deliveredAt = new Date().toISOString()
      // note = 一行摘要（多处截断到 300）；delivery_content = 完整交付正文
      // （仅 content / code 这类有独立正文的方式非空，其余为 NULL）。
      await env.DB.prepare(
        "UPDATE point_orders SET status = 'delivered', delivered_at = ?, note = ?, " +
          "delivery_content = ? WHERE id = ?"
      )
        .bind(deliveredAt, summary.slice(0, 300), content ?? null, orderId)
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
          (isUserProduct ? `（用户商品，卖家 ${product.ownerName ?? "?"}，` : "（") +
          `自动交付：${summary}`
      )
      // 有独立正文（统一内容 / 卡密）→ 把**完整内容通过私聊**发给买家。
      // 见 sendDeliveryContentDm 的说明：通知弹窗一闪而过，内容必须落到会话里。
      await sendDeliveryContentDm(env, {
        buyerId: user.id,
        sellerId: product.ownerId,
        productName: product.name,
        content,
      })
      // 通知买家 + （用户商品）通知卖家。
      //
      // ⚠️ 2026-10-06 改：有独立正文时**不再把完整内容塞进通知** —— 通知在界面上
      //    就是右下角一闪而过的弹窗，买家一眨眼就错过（站长反馈）。内容改由
      //    sendDeliveryContentDm 私聊发出（留在会话里可反复查看），这里只留一句
      //    摘要 + 指路。用户商品的通知仍带「确认收货」按钮，那个不能省。
      await notifyOrder(env, user.id, {
        event: "delivered",
        title: `已发放「${product.name}」`,
        body: content
          ? `${summary}\n\n完整内容已通过**私聊**发送给你，在「私信」里随时可看、可复制。`
          : summary || "已自动发放。",
        orderId,
        action: isUserProduct ? "confirm" : undefined,
        peer: isUserProduct ? product.ownerName : undefined,
      })
      if (isUserProduct) {
        await notifyOrder(env, product.ownerId, {
          event: "paid",
          title: `有人买下了你的「${product.name}」`,
          body: `买家 **${user.username}** 花 ${product.price} 积分买下，商品已**自动发货**，无需你操作。买家确认收货后积分即到账。`,
          orderId,
          peer: user.username,
        })
      }
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
        await restoreStock(env, product.id)
        if (dailyReserved) await releaseDailySlot(env, product.id)
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

  // 已交付 → 卖家消息里的「标记已交付」按钮没用了，摘掉
  //（只摘 deliver；马上要发的「确认收货」不受影响）
  await clearOrderActionButtons(env, orderId, ["deliver"])

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

  // 结算完成 → 这个订单**所有**快捷按钮都该消失了：
  // 买家的「确认收货」（不管他是从消息里点的还是从积分页点的），
  // 以及卖家残留的「标记已交付」。不摘的话按钮永远留在消息里，
  // 点了只会得到「这单已经结算过了」（2026-10-01 用户反馈）。
  await clearOrderActionButtons(env, order.id, ["confirm", "deliver"])

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
 * 自动确认收货（2026-10-06 站长要求）。
 *
 * 背景：卖家点「已交付」后，买家可以一直不点「确认收货」—— 积分就永远卡在托管里、
 * 卖家拿不到，订单也一直悬着。这里由定时任务兜底：**交付满 N 天**的订单自动结算给卖家，
 * 与主流电商一致。
 *
 * 天数由设置项 `shop_auto_confirm_days` 控制（<=0 = 关闭自动收货）。
 *
 * 只挑**没有售后在处理**的单子（after_sale_status 为空 / 已被拒 / 已关闭）——
 * 正在争议的订单绝不能被自动结算掉。
 *
 * 用 limit 分批，避免一次扫出太多把定时任务的子请求额度打光；单笔失败只记日志不中断。
 */
export async function autoConfirmDeliveries(env: Env): Promise<number> {
  const days = Number(await getSetting(env, "shop_auto_confirm_days")) || 0
  if (days <= 0) return 0
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT id FROM point_orders
      WHERE status = 'delivered' AND seller_id IS NOT NULL
        AND delivered_at IS NOT NULL AND delivered_at <= ?
        AND (after_sale_status IS NULL OR after_sale_status IN ('rejected', 'closed'))
      ORDER BY delivered_at ASC LIMIT 200`
  )
    .bind(cutoff)
    .all<{ id: string }>()

  let n = 0
  for (const row of rows.results ?? []) {
    const order = await getOrder(env, row.id)
    if (!order) continue
    try {
      await settleEscrow(
        env,
        order,
        order.userId,
        `系统自动确认收货（卖家交付已满 ${days} 天）`
      )
      // settleEscrow 内部只通知卖家，买家这边补一条，免得他一脸懵
      await notifyOrder(env, order.userId, {
        event: "settled",
        title: `已自动确认收货：「${order.productName}」`,
        body: `卖家交付已满 ${days} 天，系统已自动确认收货，${order.price} 积分已结算给卖家。若你实际没有收到货，请尽快联系管理员。`,
        orderId: order.id,
        peer: order.sellerName,
      })
      n++
    } catch (err) {
      console.error("自动确认收货失败:", order.id, err)
    }
  }
  if (n > 0) console.log(`自动确认收货：本批结算 ${n} 笔`)
  return n
}

// ---------------------------------------------------------------- 售后（退款）

/** 售后理由 / 处理意见的长度上限（够说清楚，又不至于把列表撑爆） */
const MAX_AFTER_SALE_REASON = 300
/** 售后理由最短长度：拦掉「1」「退」这种什么都没说的申请 */
const MIN_AFTER_SALE_REASON = 4

/**
 * 执行退款并终结订单 —— **管理员取消**与**售后退款**共用这一段。
 *
 * 步骤与顺序都有理由，别调换：
 *   1. **已结算的**先把积分从卖家手里收回。收不回来就整单失败 ——
 *      绝不把卖家余额扣成负数（与既有口径一致：让管理员先去「成员」里调整，
 *      而不是让平台默默垫一笔、账目变成负的）。
 *   2. 退买家（幂等：`shop-refund:<订单号>`，重复调用不会退两次）。
 *   3. 归还库存 —— 已过期处理过的订单不能再还，否则库存凭空变多。
 *   4. 收回租用权限 —— **必须当场收**：订单变成 cancelled 之后 cron 就再也扫不到它，
 *      不在这里收等于「退了钱还留着权限」。
 *   5. 写订单状态与备注、通知买卖双方、清掉消息里的快捷按钮。
 */
async function refundOrderCore(
  env: Env,
  order: PointOrder,
  opts: {
    actorId: string
    /** 审计动作名：'points.shop.cancel' | 'points.shop.after_sale_refund' */
    auditAction: string
    /** 退款原因，会拼进订单备注 */
    reason?: string
    /** 传 'refunded' 表示这是售后流程收的尾（多写售后字段） */
    afterSaleStatus?: "refunded"
    /** 售后处理说明（卖家同意 / 平台判定） */
    afterSaleNote?: string
    /**
     * 通知事件名，决定买家消息里显示「订单已取消」还是「已退款」。
     *
     * 默认 `'refunded'`（售后场景）；管理员「取消订单」传 `'cancelled'`
     * 以保持这条老路径的文案与 `order_cancelled` 消息类型不变。
     */
    notifyEvent?: "cancelled" | "refunded"
  }
): Promise<PointOrder> {
  if (order.status === "cancelled") {
    throw new ApiError(409, "该订单已取消（积分已退回）", "ORDER_CANCELLED")
  }

  // 1. 已结算的：先把钱从卖家手里收回
  if (order.status === "settled" && order.sellerId) {
    const back = await applyPoints(env, {
      userId: order.sellerId,
      delta: -order.price,
      reason: "admin",
      detail: `订单「${order.productName}」退款，收回卖家收益`,
      dedupKey: `shop-settle-revoke:${order.id}`,
      createdBy: opts.actorId,
    })
    if (!back.applied && back.reason !== "duplicated") {
      throw new ApiError(
        400,
        `卖家 ${order.sellerName ?? "?"} 当前只有 ${back.balance} 积分，不够收回 ${order.price}。` +
          `请先在「成员」里调整卖家积分，再处理这笔退款。`,
        "INSUFFICIENT_POINTS"
      )
    }
  }

  // 2. 退买家
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

  // 3. 库存还回货架（限量的商品才需要；商品已删则静默跳过）
  if (!order.expireHandledAt) {
    await restoreStock(env, order.productId)
  }

  // 4. 写订单：状态、备注，以及（售后流程时）售后收尾字段
  const now = new Date().toISOString()
  // 「取消」与「退款」走同一套动作，但文案要区别开：前者是卖家没交付被平台取消，
  // 后者是买家申请、卖家/平台判定同意 —— 用户看到的词不一样，心里预期也不一样。
  const ev = opts.notifyEvent ?? "refunded"
  const notePrefix = ev === "cancelled" ? "订单已取消" : "订单已退款"
  const note = `${notePrefix}，${order.price} 积分已退回${
    opts.reason ? `：${opts.reason}` : ""
  }`.slice(0, MAX_AFTER_SALE_REASON)
  if (opts.afterSaleStatus === "refunded") {
    await env.DB.prepare(
      "UPDATE point_orders SET status = 'cancelled', note = ?, after_sale_status = 'refunded', " +
        "after_sale_note = ?, after_sale_resolved_at = ? WHERE id = ?"
    )
      .bind(note, opts.afterSaleNote?.slice(0, MAX_AFTER_SALE_REASON) ?? null, now, order.id)
      .run()
  } else {
    await env.DB.prepare("UPDATE point_orders SET status = 'cancelled', note = ? WHERE id = ?")
      .bind(note, order.id)
      .run()
  }

  // 5. 当场收回租用权限（理由见函数头注释）
  if (order.grantedFeature && !order.expireHandledAt) {
    await revokeRentalFeature(env, order, now)
  }

  await audit(
    env,
    opts.actorId,
    opts.auditAction,
    `订单「${order.productName}」退款 ${order.price} 积分（买家 ${order.username}）` +
      `${opts.reason ? ` · ${opts.reason}` : ""}`
  )

  await clearOrderActionButtons(env, order.id, ["confirm", "deliver"])
  await notifyOrder(env, order.userId, {
    event: ev,
    title: `${ev === "cancelled" ? "订单已取消" : "已退款"}：「${order.productName}」`,
    body: `${order.price} 积分已退回你的账户。${opts.reason ? `原因：${opts.reason}` : ""}`,
    orderId: order.id,
    peer: order.sellerName,
  })
  if (order.sellerId) {
    await notifyOrder(env, order.sellerId, {
      event: ev,
      title: `${ev === "cancelled" ? "订单被取消" : "订单已退款"}：「${order.productName}」`,
      body:
        ev === "cancelled"
          ? `买家 ${order.username} 的这单已取消，积分已退回买家。${
              opts.reason ? `原因：${opts.reason}` : ""
            }`
          : `买家 ${order.username} 的这单已退款，${order.price} 积分已从你的收益中收回。${
              opts.reason ? `原因：${opts.reason}` : ""
            }`,
      orderId: order.id,
      peer: order.username,
    })
  }

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/** 售后申请是否「还占着」这单（进行中，不允许重复申请） */
function afterSaleInProgress(s: AfterSaleStatus | null): boolean {
  return s === "requested" || s === "platform" || s === "refunded"
}

/**
 * 买家：申请售后（要退款）。
 *
 * 允许的时机：
 *   · `delivered` —— 卖家说交付了但我没收到，随时可以申请（交易还没完）；
 *   · `settled`   —— 已确认收货，**7 天内**可以申请（见 AFTER_SALE_WINDOW_DAYS）。
 *     主流电商都是「确认收货后 N 天可售后」，超过就走人工。
 *
 * 官方商品订单（没有卖家）直接进 `platform` 由管理员处理 —— 它本来就不存在
 * 「卖家同意/拒绝」这一环，多一步只是让买家白等。
 *
 * 卖家已拒绝（`rejected`）或被平台驳回（`closed`）之后**允许重新申请**：
 * 买家可能补充了新证据，拦着只会把人逼去私聊站长。
 */
export async function requestAfterSale(
  env: Env,
  buyerId: string,
  orderId: string,
  reason: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.userId !== buyerId) {
    throw new ApiError(403, "这不是你的订单", "FORBIDDEN")
  }
  if (order.status === "cancelled") {
    throw new ApiError(409, "该订单已取消，积分已退回，无需申请售后", "ORDER_CANCELLED")
  }
  if (order.status === "pending") {
    throw new ApiError(
      409,
      order.sellerId ? "卖家还没有交付，请先等卖家发货" : "订单尚未发放，请先联系管理员",
      "NOT_DELIVERED"
    )
  }
  if (afterSaleInProgress(order.afterSaleStatus)) {
    throw new ApiError(409, "这笔订单已有售后在处理中", "AFTER_SALE_EXISTS")
  }

  // 已结算的：确认收货后有期限
  if (order.status === "settled" && order.settledAt) {
    const elapsedDays =
      (Date.now() - new Date(order.settledAt).getTime()) / (24 * 60 * 60 * 1000)
    if (elapsedDays > AFTER_SALE_WINDOW_DAYS) {
      throw new ApiError(
        400,
        `已超过确认收货后 ${AFTER_SALE_WINDOW_DAYS} 天的售后申请期限，如有特殊情况请联系管理员`,
        "AFTER_SALE_EXPIRED"
      )
    }
  }

  const text = String(reason ?? "").trim().slice(0, MAX_AFTER_SALE_REASON)
  if (text.length < MIN_AFTER_SALE_REASON) {
    throw new ApiError(400, `请填写退款原因（至少 ${MIN_AFTER_SALE_REASON} 个字）`, "INVALID_INPUT")
  }

  const now = new Date().toISOString()
  // 官方商品订单没有卖家，直接进平台待判
  const next: AfterSaleStatus = order.sellerId ? "requested" : "platform"
  await env.DB.prepare(
    "UPDATE point_orders SET after_sale_status = ?, after_sale_reason = ?, " +
      "after_sale_requested_at = ?, after_sale_note = NULL, after_sale_resolved_at = NULL " +
      "WHERE id = ?"
  )
    .bind(next, text, now, order.id)
    .run()

  await audit(
    env,
    buyerId,
    "points.shop.after_sale.request",
    `${order.username} 对订单「${order.productName}」申请售后（${order.price} 积分）：${text}`
  )

  // 去重后缀用申请时间：同一单可能被反复申请，只用订单号会把后续通知全吃掉
  const dedupSuffix = `:${now}`
  if (order.sellerId) {
    await notifyOrder(env, order.sellerId, {
      event: "after_sale_requested",
      title: `买家申请退款：「${order.productName}」`,
      body: `${order.username} 申请退款，理由：${text}。请到积分页处理（同意退款 / 拒绝）。`,
      orderId: order.id,
      dedupSuffix,
    })
  } else {
    await notifyOrder(env, order.userId, {
      event: "after_sale_requested",
      title: `退款申请已提交：「${order.productName}」`,
      body: `平台会尽快处理你的退款申请（理由：${text}）。`,
      orderId: order.id,
      dedupSuffix,
    })
  }

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/**
 * 买家：拒收（2026-10-06 站长要求）。
 *
 * 场景：卖家点了「已交付」，但买家其实没收到东西 / 货不对板。原先买家只能先
 * 「向卖家申请退款」，等卖家处理 —— 可卖家既然自己声称交付了，让他审自己的退款
 * 没有意义，买家还得多等一轮。所以这里给一条**直达平台介入**的路：
 * 买家填个理由，订单直接进 `after_sale_status = 'platform'`，由管理员判定。
 *
 * 只对**用户商品**订单生效（官方商品本来就走 platform，不需要这步）。
 */
export async function rejectDelivery(
  env: Env,
  buyerId: string,
  orderId: string,
  reason: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.userId !== buyerId) throw new ApiError(403, "这不是你的订单", "FORBIDDEN")
  if (!order.sellerId) {
    throw new ApiError(409, "官方商品订单请用「申请售后」提交", "NOT_USER_ORDER")
  }
  if (order.status !== "delivered") {
    throw new ApiError(
      409,
      "只有「卖家已交付、你还没确认收货」的订单才能拒收",
      "NOT_DELIVERED"
    )
  }
  if (afterSaleInProgress(order.afterSaleStatus)) {
    throw new ApiError(409, "这笔订单已有售后在处理中", "AFTER_SALE_EXISTS")
  }

  const text = String(reason ?? "").trim().slice(0, MAX_AFTER_SALE_REASON)
  if (text.length < MIN_AFTER_SALE_REASON) {
    throw new ApiError(400, `请填写拒收原因（至少 ${MIN_AFTER_SALE_REASON} 个字）`, "INVALID_INPUT")
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE point_orders SET after_sale_status = 'platform', after_sale_reason = ?, " +
      "after_sale_requested_at = ?, after_sale_note = NULL, after_sale_resolved_at = NULL " +
      "WHERE id = ?"
  )
    .bind(text, now, order.id)
    .run()

  await audit(
    env,
    buyerId,
    "points.shop.reject",
    `${order.username} 拒收订单「${order.productName}」（${order.price} 积分）：${text}`
  )

  const dedupSuffix = `:reject:${now}`
  // 通知卖家：买家已拒收、平台将介入
  if (order.sellerId) {
    await notifyOrder(env, order.sellerId, {
      event: "after_sale_requested",
      title: `买家拒收：「${order.productName}」`,
      body: `${order.username} 表示没有收到货 / 货不对板，已提交平台介入（理由：${text}）。请等待管理员判定。`,
      orderId: order.id,
      dedupSuffix,
    })
  }
  await notifyOrder(env, order.userId, {
    event: "after_sale_requested",
    title: `已拒收，平台将介入：「${order.productName}」`,
    body: `管理员会尽快核实并判定（理由：${text}）。`,
    orderId: order.id,
    dedupSuffix,
  })

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/** 买家：撤销售后申请（还没终结时才能撤） */
export async function cancelAfterSale(
  env: Env,
  buyerId: string,
  orderId: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.userId !== buyerId) throw new ApiError(403, "这不是你的订单", "FORBIDDEN")
  if (!order.afterSaleStatus || order.afterSaleStatus === "refunded") {
    throw new ApiError(409, "当前没有可以撤销的售后申请", "NO_AFTER_SALE")
  }
  if (order.afterSaleStatus === "platform") {
    throw new ApiError(
      409,
      "已申请平台介入，不能自己撤销，请等待管理员处理",
      "AFTER_SALE_ESCALATED"
    )
  }

  await env.DB.prepare(
    "UPDATE point_orders SET after_sale_status = NULL, after_sale_resolved_at = ? WHERE id = ?"
  )
    .bind(new Date().toISOString(), order.id)
    .run()

  await audit(
    env,
    buyerId,
    "points.shop.after_sale.cancel",
    `${order.username} 撤销了订单「${order.productName}」的售后申请`
  )

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/** 买家：卖家一直不处理 / 已拒绝 → 申请平台（管理员）介入 */
export async function escalateAfterSale(
  env: Env,
  buyerId: string,
  orderId: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.userId !== buyerId) throw new ApiError(403, "这不是你的订单", "FORBIDDEN")
  if (order.afterSaleStatus !== "requested" && order.afterSaleStatus !== "rejected") {
    throw new ApiError(409, "当前状态不能申请平台介入", "NO_AFTER_SALE")
  }

  await env.DB.prepare("UPDATE point_orders SET after_sale_status = 'platform' WHERE id = ?")
    .bind(order.id)
    .run()

  await audit(
    env,
    buyerId,
    "points.shop.after_sale.escalate",
    `${order.username} 申请平台介入订单「${order.productName}」的退款`
  )

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/**
 * 卖家：处理买家的退款申请。
 *
 * 同意 → 直接走 refundOrderCore 退款（钱从托管退给买家，卖家本来就没拿到）；
 * 拒绝 → 记下理由，买家可以申请平台介入。
 */
export async function sellerResolveAfterSale(
  env: Env,
  sellerId: string,
  orderId: string,
  approve: boolean,
  note?: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  if (order.sellerId !== sellerId) throw new ApiError(403, "这不是你的订单", "FORBIDDEN")
  if (order.afterSaleStatus !== "requested") {
    throw new ApiError(409, "当前没有待你处理的退款申请", "NO_AFTER_SALE")
  }

  const text = String(note ?? "").trim().slice(0, MAX_AFTER_SALE_REASON)

  if (approve) {
    return refundOrderCore(env, order, {
      actorId: sellerId,
      auditAction: "points.shop.after_sale_refund",
      reason: `卖家同意退款（买家理由：${order.afterSaleReason ?? "未填写"}）`,
      afterSaleStatus: "refunded",
      afterSaleNote: text || "卖家同意退款",
    })
  }

  await env.DB.prepare(
    "UPDATE point_orders SET after_sale_status = 'rejected', after_sale_note = ? WHERE id = ?"
  )
    .bind(text || "卖家拒绝退款", order.id)
    .run()

  await audit(
    env,
    sellerId,
    "points.shop.after_sale.reject",
    `卖家 ${order.sellerName ?? ""} 拒绝订单「${order.productName}」的退款：${text || "未说明"}`
  )

  await notifyOrder(env, order.userId, {
    event: "after_sale_rejected",
    title: `退款申请被拒绝：「${order.productName}」`,
    body: `${order.sellerName ?? "卖家"}拒绝了退款${text ? `：${text}` : ""}。如仍有异议，可申请平台介入。`,
    orderId: order.id,
    dedupSuffix: `:${new Date().toISOString()}`,
  })

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/**
 * 管理员（客服）：判定售后。
 *
 * 同意 → 退款（已结算的会先从卖家收益里收回，收不回就报错并提示先调整卖家积分）；
 * 驳回 → `closed`，售后终结（买家仍可再次申请，见 requestAfterSale）。
 *
 * `platform` / `requested` / `rejected` 都允许管理员直接判定 —— 卖家长期不处理时
 * 不必逼买家先点一次「申请介入」。
 */
export async function adminResolveAfterSale(
  env: Env,
  adminId: string,
  orderId: string,
  approve: boolean,
  note?: string
): Promise<PointOrder> {
  const order = await getOrder(env, orderId)
  if (!order) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  const s = order.afterSaleStatus
  if (s !== "platform" && s !== "requested" && s !== "rejected") {
    throw new ApiError(409, "这笔订单当前没有待判定的售后", "NO_AFTER_SALE")
  }

  const text = String(note ?? "").trim().slice(0, MAX_AFTER_SALE_REASON)
  const buyerReason = order.afterSaleReason ?? "未填写"

  if (approve) {
    return refundOrderCore(env, order, {
      actorId: adminId,
      auditAction: "points.shop.after_sale_refund",
      reason: `平台判定退款（买家理由：${buyerReason}）`,
      afterSaleStatus: "refunded",
      afterSaleNote: text || "平台判定同意退款",
    })
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE point_orders SET after_sale_status = 'closed', after_sale_note = ?, " +
      "after_sale_resolved_at = ? WHERE id = ?"
  )
    .bind(text || "平台判定不予退款", now, order.id)
    .run()

  await audit(
    env,
    adminId,
    "points.shop.after_sale.reject",
    `平台驳回订单「${order.productName}」的退款申请（买家 ${order.username}）：${text || "未说明"}`
  )

  await notifyOrder(env, order.userId, {
    event: "after_sale_closed",
    title: `退款申请未通过：「${order.productName}」`,
    body: `平台判定不予退款${text ? `：${text}` : ""}。`,
    orderId: order.id,
    dedupSuffix: `:${now}`,
  })

  const updated = await getOrder(env, order.id)
  if (!updated) throw new ApiError(404, "订单不存在", "NOT_FOUND")
  return updated
}

/**
 * 售后列表（管理端用）。
 *
 * `status` 省略 = 所有有过售后记录的订单（含已终结的），按申请时间倒序。
 * 管理面板的「待处理」用 `status: "platform"`。
 */
export async function listAfterSaleOrders(
  env: Env,
  opts: { status?: AfterSaleStatus; limit?: number } = {}
): Promise<PointOrder[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500)
  const rows = opts.status
    ? await env.DB.prepare(
        "SELECT * FROM point_orders WHERE after_sale_status = ? " +
          "ORDER BY after_sale_requested_at DESC, id DESC LIMIT ?"
      )
        .bind(opts.status, limit)
        .all<Record<string, unknown>>()
    : await env.DB.prepare(
        "SELECT * FROM point_orders WHERE after_sale_status IS NOT NULL " +
          "ORDER BY after_sale_requested_at DESC, id DESC LIMIT ?"
      )
        .bind(limit)
        .all<Record<string, unknown>>()
  return (rows.results ?? []).map(rowToOrder)
}

/**
 * 管理员：取消订单并退款。
 *
 * 三种情况：
 *   · pending / delivered（钱还在托管）—— 直接原路退回买家，卖家没拿到过，无需倒扣
 *   · settled（钱已给卖家）—— 先从卖家账上收回，再退买家；卖家余额不够就报错，
 *     让管理员先去「成员」里调整，而不是把卖家的余额扣成负数
 *   · cancelled —— 已退过，报错
 *
 * ⚠️ 具体步骤全部在 `refundOrderCore` 里 —— 它与**售后退款**共用同一套动作
 *    （收回卖家收益 → 退买家 → 还库存 → 收权限 → 通知）。两处各写一遍必然漏改，
 *    所以这里只保留「谁触发的」和「算取消还是算退款」这两个差异点。
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

  return refundOrderCore(env, order, {
    actorId: adminId,
    auditAction: "points.shop.cancel",
    reason,
    // 保持这条路的老文案与消息类型（order_cancelled）不变
    notifyEvent: "cancelled",
  })
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
  now: string,
  whitelisted: Set<string> = new Set()
): Promise<"revoked" | "kept" | "skipped"> {
  const f = order.grantedFeature
  if (!f || !(FEATURES as readonly string[]).includes(f)) return "skipped"

  // 白名单用户：租用到期也不收回权限（2026-10-03 站长要求）
  if (whitelisted.has(order.username.toLowerCase())) return "kept"

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
  //
  // ⚠️ 带白名单守卫：白名单用户不被收回任何权限（见 permissions.ts::notWhitelistedGuard）。
  //    退款「撤销先前发放的权限」虽然在语义上不算处罚，但它同样是一条**降级写入**，
  //    不带守卫就会被 0114 的触发器 ABORT、把整条退款流程打成 500。
  //    代价是白名单用户退款后会保留该权限 —— 这是刻意的取舍：
  //    白名单是站长手工维护的极短名单，宁可少收一个权限，也不要让流程报错。
  //    真要收回，先把该用户移出白名单再操作。
  await env.DB.prepare(
    `UPDATE users SET permissions = ${featurePermissionSql(f as Feature, false)}, updated_at = ?
      WHERE id = ? AND ${notWhitelistedGuard()}`
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

  // 白名单用户：租用到期也不收回权限（2026-10-03 站长要求）。循环外一次性查成 Set。
  const whitelisted = new Set<string>()
  try {
    const wlRows = await env.DB.prepare("SELECT username FROM moderation_whitelist").all<{
      username: string
    }>()
    for (const r of wlRows.results ?? []) whitelisted.add(r.username.toLowerCase())
  } catch {
    // 表未建好时按「无白名单」处理
  }

  for (const order of orders) {
    try {
      const verdict = await revokeRentalFeature(env, order, now, whitelisted)
      if (verdict === "revoked") res.permissionsRevoked++
      else if (verdict === "kept") res.keptWithOtherSource++

      // 归还库存（不限量 / 商品已删时 restoreStock 返回 0，静默跳过）
      if ((await restoreStock(env, order.productId)) > 0) res.stockReturned++

      await env.DB.prepare("UPDATE point_orders SET expire_handled_at = ? WHERE id = ?")
        .bind(now, order.id)
        .run()
      res.handled++

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
