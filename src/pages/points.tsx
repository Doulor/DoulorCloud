import * as React from "react"
import { Link } from "react-router-dom"
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Eye,
  Loader2,
  Package,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCw,
  Send,
  ShoppingBag,
  Sparkles,
  Store,
  Trash2,
  Upload,
  Wallet,
  CalendarCheck,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { AnchoredPanel } from "@/components/anchored-panel"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { ShopIconPicker } from "@/components/shop-icon-picker"
import { CheckinDialog } from "@/components/checkin-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { pointsApi, errMsg, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from "@/types"
import { notifyPointsChanged } from "@/components/points-badge"
import { fmtDateTime } from "@/lib/format"
import { shopIcon } from "@/lib/shop-icons"
import { FEATURE_LABELS } from "@/types"
import { useT, tStatic } from "@/i18n"
import type {
  AfterSaleStatus,
  PointBillingMode,
  PointOrder,
  PointProduct,
  PointsOverview,
  UserProductPayload,
} from "@/types"

/** 流水来源 → 展示标签 */
const REASON_LABEL: Record<string, string> = {
  event: "pt.reason.event",
  admin: "pt.reason.admin",
  redeem: "pt.reason.redeem",
  shop: "pt.reason.shop",
  shop_sell: "pt.reason.shopSell",
  donation: "pt.reason.donation",
  invite: "pt.reason.invite",
  invite_commission: "pt.reason.inviteCommission",
  transfer_out: "pt.reason.transferOut",
  transfer_in: "pt.reason.transferIn",
}

/** 订单状态 → 展示标签（用户商品订单的 pending/delivered 含义不同，用 orderStatusText 区分） */
const ORDER_STATUS: Record<string, { label: string; variant: "default" | "outline" | "secondary" }> = {
  pending: { label: "pt.status.pending", variant: "default" },
  delivered: { label: "pt.status.delivered", variant: "outline" },
  settled: { label: "pt.status.settled", variant: "outline" },
  cancelled: { label: "pt.status.cancelled", variant: "secondary" },
}

/**
 * 订单状态的展示文案。
 *
 * 用户商品走**担保**：pending = 等卖家交付（积分在平台手里）、
 * delivered = 卖家已交付、等你确认收货。跟官方商品的「待发放 / 已发放」不是一回事。
 *
 * ⚠️ 返回的是 **i18n key**，调用方要再套一层 t()（这样语言切换能立刻生效）。
 */
function orderStatusText(status: string, isUserOrder: boolean): string {
  if (isUserOrder) {
    if (status === "pending") return "pt.status.awaitSeller"
    if (status === "delivered") return "pt.status.awaitReceipt"
    if (status === "settled") return "pt.status.done"
  }
  return ORDER_STATUS[status]?.label ?? status
}

/** 售后状态 → 展示标签（只在订单确实走过售后时才显示） */
const AFTER_SALE_STATUS: Record<
  AfterSaleStatus,
  { label: string; variant: "default" | "outline" | "secondary" | "destructive" | "success" }
> = {
  requested: { label: "pt.afterSale.st.requested", variant: "default" },
  rejected: { label: "pt.afterSale.st.rejected", variant: "destructive" },
  platform: { label: "pt.afterSale.st.platform", variant: "default" },
  closed: { label: "pt.afterSale.st.closed", variant: "secondary" },
  refunded: { label: "pt.afterSale.st.refunded", variant: "success" },
}

/**
 * 买家能不能对这笔订单申请退款。
 *
 * 与后端 `requestAfterSale` 的口径保持一致：
 *   · 订单必须是 delivered（卖家已交付、我还没确认）或 settled（已确认收货）；
 *   · 没有进行中的售后（requested / platform）—— 已退款更不行；
 *   · 卖家拒绝 / 平台驳回之后允许重新申请。
 * 「确认收货后 7 天」的期限由后端判定（前端不重复实现，避免两边算出不同结果）。
 */
function canRequestAfterSale(o: PointOrder): boolean {
  if (o.status !== "delivered" && o.status !== "settled") return false
  const s = o.afterSaleStatus
  return s === null || s === "rejected" || s === "closed"
}

/** 买家能不能申请平台介入（卖家一直不处理 / 已拒绝） */
function canEscalateAfterSale(o: PointOrder): boolean {
  return o.afterSaleStatus === "requested" || o.afterSaleStatus === "rejected"
}

/** 买家能不能自己撤销（已经申请平台介入后要等客服判定，不能自撤） */
function canWithdrawAfterSale(o: PointOrder): boolean {
  return o.afterSaleStatus === "requested"
}

/** 自己上架商品的审核状态 → 标签 */
const MY_REVIEW: Record<
  string,
  { label: string; variant: "default" | "outline" | "secondary" | "destructive" | "success" }
> = {
  pending: { label: "pt.review.pending", variant: "default" },
  approved: { label: "pt.review.approved", variant: "success" },
  rejected: { label: "pt.review.rejected", variant: "destructive" },
}

/**
 * 交付方式 → 商品卡上的一句说明。
 *
 * 用户视角只需要知道「下单后会发生什么、要不要等」，不需要知道内部类型名。
 */
function deliveryLabel(delivery: string): string {
  switch (delivery) {
    case "quota":
      return tStatic("pt.delivery.quota")
    case "feature":
      return tStatic("pt.delivery.feature")
    case "subscription":
      return tStatic("pt.delivery.subscription")
    case "invite_quota":
      return tStatic("pt.delivery.inviteQuota")
    default:
      return tStatic("pt.delivery.manual")
  }
}

/** 需要先绑定中转站账号才能自动发放的方式（余额 / 订阅都挂在 NewAPI 用户上） */
function needsNewapiBinding(delivery: string): boolean {
  return delivery === "quota" || delivery === "subscription"
}

/** 购买弹窗顶部的一句说明：下单后到底会发生什么 */
function buyHint(delivery: string, isUserProduct: boolean): string {
  if (isUserProduct) {
    // 用户商品是担保交易：钱先放平台，卖家交付 + 买家确认后才转给卖家
    return tStatic("pt.buyHint.userProduct")
  }
  switch (delivery) {
    case "quota":
      return tStatic("pt.buyHint.quota")
    case "feature":
      return tStatic("pt.buyHint.feature")
    case "subscription":
      return tStatic("pt.buyHint.subscription")
    case "invite_quota":
      return tStatic("pt.buyHint.inviteQuota")
    default:
      return tStatic("pt.buyHint.manual")
  }
}

/** 租期展示：如「租用 30 天」 */
function rentalTerm(days: number | null | undefined): string {
  return days && days > 0 ? tStatic("pt.rental.term", { n: days }) : tStatic("pt.rental.rental")
}

/** 租用订单是否已到期（只有租用订单才有 expiresAt） */
function isRentalExpired(o: PointOrder): boolean {
  if (!o.expiresAt) return false
  const t = new Date(o.expiresAt).getTime()
  return !Number.isNaN(t) && t <= Date.now()
}

/**
 * 订单上的租期说明。
 *
 * · 还没交付 → 只说明租期，提示「交付后起算」（租期不是从下单起算的）
 * · 已交付未到期 → 有效期至 X
 * · 已到期 → 已到期（X）
 * · 已取消 / 买断单 → 没有租期可讲，返回 null
 */
function rentalOrderText(o: PointOrder): string | null {
  if (o.billingMode !== "rental") return null
  if (o.status === "cancelled") return null
  if (!o.expiresAt) return tStatic("pt.rental.afterDelivery", { term: rentalTerm(o.rentalDays) })
  const time = fmtDateTime(o.expiresAt)
  return isRentalExpired(o)
    ? tStatic("pt.rental.expired", { time })
    : tStatic("pt.rental.validUntil", { time })
}

/** 购买弹窗里对「租用」的一句解释（官方自动发放 vs 用户商品，收尾方式不同） */
function rentalBuyHint(days: number | null, isUserProduct: boolean): string {
  const term = days && days > 0 ? tStatic("pt.days", { n: days }) : tStatic("pt.rental.oneTerm")
  if (isUserProduct) {
    return tStatic("pt.rental.buyHintUser", { term })
  }
  return tStatic("pt.rental.buyHintOfficial", { term })
}

/** 金额展示：整数不带小数，非整数保留两位 */
function fmtMoney(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * 商品卡片顶部的封面区（固定 144px 高，保证同一行卡片对齐）。
 *
 * 三种来源，优先级：**真实图片 > 用户/站长选的图标 > 默认图标**。
 * 图标单独占满整个封面区（80px 见方），是卡片上最显眼的一块。
 */
function ProductCover({
  imageUrl,
  icon,
  name,
}: {
  imageUrl?: string | null
  icon?: string | null
  name: string
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        loading="lazy"
        className="h-36 w-full shrink-0 rounded-t-xl object-cover"
      />
    )
  }
  const Icon = shopIcon(icon)
  return (
    <div className="flex h-36 w-full shrink-0 items-center justify-center overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-primary/15 via-primary/5 to-transparent">
      <Icon className="h-20 w-20 text-primary" strokeWidth={1.25} aria-hidden />
    </div>
  )
}

/** 商城分类筛选项（「全部」+ 各分类） */
const SHOP_CAT_FILTERS: { key: ProductCategory | "all"; label: string }[] = [
  { key: "all", label: "pt.cat.all" },
  { key: "it", label: PRODUCT_CATEGORY_LABELS.it },
  { key: "other", label: PRODUCT_CATEGORY_LABELS.other },
]

/** 商品卡片（官方 / 用户商品共用；卖家名非空时显示「由 xxx 上架」） */
function ProductCard({
  product,
  balance,
  sellerName,
  onBuy,
  onDetail,
}: {
  product: PointProduct
  balance: number
  sellerName?: string | null
  onBuy: (p: PointProduct) => void
  /** 点击查看完整商品详情（用户反馈 4b720eeb：标题/描述过长看不全） */
  onDetail?: (p: PointProduct) => void
}) {
  const { t } = useT()
  const soldOut = product.stock !== null && product.stock <= 0
  const tooExpensive = product.price > balance
  const isRental = product.billingMode === "rental"
  return (
    <Card
      className="flex min-w-0 cursor-pointer flex-col"
      onClick={() => onDetail?.(product)}
    >
      <ProductCover imageUrl={product.imageUrl} icon={product.icon} name={product.name} />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardDescription className="min-w-0 truncate">
            {sellerName ? (
              <>
                {t("pt.bySeller", { name: sellerName })}
                {/* 快速联系卖家（2026-10-01）：问细节、催发货都从这进，
                    跟订单记录里的「发私信」是同一个会话 */}
                <Link
                  to={`/dashboard/dm/${encodeURIComponent(sellerName)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="ml-1 whitespace-nowrap text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  {t("pt.dm")}
                </Link>
              </>
            ) : (
              deliveryLabel(product.delivery)
            )}
          </CardDescription>
          <div className="flex shrink-0 items-center gap-1">
            {isRental && (
              <Badge variant="secondary" className="text-[10px]">
                <CalendarClock className="mr-0.5 h-2.5 w-2.5" />
                {rentalTerm(product.rentalDays)}
              </Badge>
            )}
            {product.stock !== null && (
              <Badge variant="outline" className="text-[10px]">
                {soldOut
                  ? isRental
                    ? t("pt.rentedOut")
                    : t("pt.soldOut")
                  : isRental
                    ? t("pt.leftCopies", { n: product.stock })
                    : t("pt.leftPieces", { n: product.stock })}
              </Badge>
            )}
          </div>
        </div>
        <CardTitle className="flex items-center gap-1.5 text-base">
          <span className="min-w-0 truncate">{product.name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            {t(PRODUCT_CATEGORY_LABELS[product.category] ?? PRODUCT_CATEGORY_LABELS.other)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3">
        {product.description ? (
          // ⚠️ 必须 line-clamp + break-all：商品描述里常有一整段不带空格的链接，
          // 没有断行机会会一路把卡片撑爆（2026-10-01 用户反馈「描述过长超出卡片」）。
          // 点卡片任意位置（含图标/封面）都会打开完整详情弹窗，这里无需单独按钮。
          <p className="line-clamp-3 break-all whitespace-pre-wrap text-sm text-muted-foreground">
            {product.description}
          </p>
        ) : (
          <span />
        )}
        <div className="space-y-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums">{product.price}</span>
            <span className="text-xs text-muted-foreground">
              {t("pt.unit")}
              {isRental ? ` / ${t("pt.days", { n: product.rentalDays ?? 0 })}` : ""}
              {product.delivery === "quota" && product.quotaYuan
                ? ` · ${t("pt.quotaFill", { v: fmtMoney(product.quotaYuan) })}`
                : ""}
              {product.perUserLimit ? ` · ${t("pt.perUserLimit", { n: product.perUserLimit })}` : ""}
            </span>
          </div>
          <Button
            className="w-full"
            variant={tooExpensive ? "outline" : "default"}
            disabled={soldOut}
            onClick={(e) => {
              e.stopPropagation()
              onBuy(product)
            }}
          >
            {soldOut
              ? isRental
                ? t("pt.rentedOut")
                : t("pt.soldOut")
              : tooExpensive
                ? t("pt.insufficientShort")
                : isRental
                  ? t("pt.rental.rental")
                  : t("pt.buy")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** 上架 / 编辑自己商品时的表单 */
interface UploadForm {
  name: string
  description: string
  imageUrl: string
  icon: string
  category: ProductCategory
  price: string
  stock: string
  /** 计费方式：买断 / 租用 */
  billingMode: PointBillingMode
  /** 租期天数（字符串，空 = 未填）；买断时忽略 */
  rentalDays: string
  enabled: boolean
}

function emptyUpload(): UploadForm {
  return {
    name: "",
    description: "",
    imageUrl: "",
    icon: "",
    category: "other",
    price: "",
    stock: "",
    billingMode: "one_time",
    rentalDays: "",
    enabled: true,
  }
}

function uploadOf(p: PointProduct): UploadForm {
  return {
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl ?? "",
    icon: p.icon ?? "",
    category: p.category ?? "other",
    price: String(p.price),
    stock: p.stock === null ? "" : String(p.stock),
    billingMode: p.billingMode,
    rentalDays: p.rentalDays === null ? "" : String(p.rentalDays),
    enabled: p.enabled,
  }
}

function uploadPayload(f: UploadForm): UserProductPayload {
  const isRental = f.billingMode === "rental"
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    imageUrl: f.imageUrl.trim() || null,
    category: f.category,
    icon: f.icon.trim() || null,
    price: Math.trunc(Number(f.price) || 0),
    stock: f.stock.trim() === "" ? null : Math.trunc(Number(f.stock) || 0),
    billingMode: f.billingMode,
    rentalDays: isRental ? Math.trunc(Number(f.rentalDays) || 0) : null,
    enabled: f.enabled,
  }
}

/** 租期快捷值（天）—— 覆盖「周 / 月 / 季 / 年」四个常见档位 */
const RENTAL_DAY_PRESETS = [7, 30, 90, 365] as const

/** 「用户们的商城」每页商品数（3 列 × 3 行） */
const SHOP_PAGE_SIZE = 9

export default function PointsPage() {
  const { t } = useT()
  const { user } = useAuth()
  const [data, setData] = React.useState<PointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  // 兑换弹窗
  const [redeemOpen, setRedeemOpen] = React.useState(false)
  const [amount, setAmount] = React.useState("")
  const [redeemBusy, setRedeemBusy] = React.useState(false)

  // 积分明细弹窗
  const [detailOpen, setDetailOpen] = React.useState(false)

  // 转账弹窗（用户间转账：只需自己确认，凭对方用户名转过去）
  const [checkinOpen, setCheckinOpen] = React.useState(false)
  const [transferOpen, setTransferOpen] = React.useState(false)
  const [transferTo, setTransferTo] = React.useState("")
  const [transferAmount, setTransferAmount] = React.useState("")
  const [transferBusy, setTransferBusy] = React.useState(false)

  // 购买弹窗
  const [buyTarget, setBuyTarget] = React.useState<PointProduct | null>(null)
  /** 商品详情弹窗（用户反馈 4b720eeb：标题/描述过长在卡片里看不全） */
  const [detailTarget, setDetailTarget] = React.useState<PointProduct | null>(null)
  const [buyBusy, setBuyBusy] = React.useState(false)

  // 我的商品 / 收到的订单
  const [mineOpen, setMineOpen] = React.useState(false)

  // 「用户们的商城」分页：服务端一次给全量（上限 200 个），在本地按 9 个一页切片
  const [shopPage, setShopPage] = React.useState(1)
  const shopTopRef = React.useRef<HTMLDivElement | null>(null)

  // 上架 / 编辑自己的商品
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<UploadForm>(emptyUpload())
  const [formBusy, setFormBusy] = React.useState(false)
  /** 发布效果预览弹窗 */
  const [previewOpen, setPreviewOpen] = React.useState(false)

  // 封面图直传（2026-10-01）：传完把返回的同源 URL 填进 imageUrl，卖家不用再找图床
  const [coverUploading, setCoverUploading] = React.useState(false)
  const coverInputRef = React.useRef<HTMLInputElement | null>(null)

  // 售后（退款）：买家「申请退款」与卖家「拒绝并说明理由」共用一个对话框，用 mode 区分
  const [afterSaleTarget, setAfterSaleTarget] = React.useState<PointOrder | null>(null)
  const [afterSaleMode, setAfterSaleMode] = React.useState<"request" | "reject">("request")
  const [afterSaleText, setAfterSaleText] = React.useState("")
  const [afterSaleBusy, setAfterSaleBusy] = React.useState(false)
  const handleCoverPick = async (file: File | undefined) => {
    if (!file) return
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      toast.error(t("pt.err.coverFormat"))
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t("pt.err.coverSize"))
      return
    }
    setCoverUploading(true)
    try {
      const res = await pointsApi.uploadProductImage(file)
      setForm((f) => ({ ...f, imageUrl: res.url }))
      toast.success(t("pt.toast.coverUploaded"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pt.err.coverUpload"))
    } finally {
      setCoverUploading(false)
      if (coverInputRef.current) coverInputRef.current.value = ""
    }
  }

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await pointsApi.overview())
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.load")))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const yuanPerPoint = data?.config.yuanPerPoint ?? 1
  const balance = data?.balance ?? 0
  const points = Math.floor(Number(amount) || 0)
  const yuan = Math.round(points * yuanPerPoint * 100) / 100

  const canRedeem =
    !!data?.config.enabled && !!data?.bound && points >= 1 && points <= balance && !redeemBusy

  const handleRedeem = async () => {
    if (!canRedeem) return
    setRedeemBusy(true)
    try {
      const res = await pointsApi.redeem(points)
      toast.success(res.detail)
      setAmount("")
      setRedeemOpen(false)
      // 让顶栏积分徽章立刻跟着变，不用等切标签页
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.redeem")))
    } finally {
      setRedeemBusy(false)
    }
  }

  /** 转账：金额不能超过自己的余额（服务端也会再挡一次） */
  const transferValue = Math.floor(Number(transferAmount) || 0)
  const canTransfer =
    transferTo.trim().length > 0 &&
    transferValue >= 1 &&
    transferValue <= balance &&
    !transferBusy

  const handleTransfer = async () => {
    if (!canTransfer) return
    setTransferBusy(true)
    try {
      const res = await pointsApi.transfer(transferTo.trim(), transferValue)
      toast.success(t("pt.toast.transferred", { to: res.to, n: transferValue }))
      setTransferTo("")
      setTransferAmount("")
      setTransferOpen(false)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.transfer")))
    } finally {
      setTransferBusy(false)
    }
  }

  const buyIsUserProduct = !!buyTarget?.ownerId
  const buyTargetAffordable = !!buyTarget && buyTarget.price <= balance
  const buyTargetNeedsBind = !!buyTarget && needsNewapiBinding(buyTarget.delivery) && !data?.bound
  const canBuy = buyTargetAffordable && !buyTargetNeedsBind && !buyBusy

  const handleBuy = async () => {
    if (!buyTarget || !canBuy) return
    setBuyBusy(true)
    try {
      const res = await pointsApi.buy(buyTarget.id)
      const term =
        res.order.billingMode === "rental"
          ? t("pt.rental.termParen", { term: rentalTerm(res.order.rentalDays) })
          : ""
      toast.success(
        res.order.status === "delivered"
          ? // 自动交付的订单，note 里就是「发了什么」（如「已自动充值 ¥10」）
            t("pt.toast.boughtAuto", {
              name: res.order.productName,
              term,
              note: res.order.note ?? t("pt.autoDelivered"),
            })
          : res.order.sellerId
            ? t("pt.toast.boughtUser", { name: res.order.productName, term })
            : t("pt.toast.boughtManual", { name: res.order.productName, term })
      )
      setBuyTarget(null)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.buy")))
    } finally {
      setBuyBusy(false)
    }
  }

  /** 买家确认收货 —— 把托管的积分结算给卖家 */
  const confirmReceipt = async (o: PointOrder) => {
    const rentalNote =
      o.billingMode === "rental"
        ? "\n\n" + t("pt.rental.noteFromReceipt", { n: o.rentalDays ?? "?" })
        : ""
    if (
      !confirm(
        t("pt.confirm.receipt", { name: o.productName, price: o.price, note: rentalNote })
      )
    )
      return
    try {
      await pointsApi.confirmReceipt(o.id)
      toast.success(t("pt.toast.receiptConfirmed"))
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.confirmReceipt")))
    }
  }

  // ---- 售后（退款）----

  /** 买家：打开「申请退款」对话框 */
  const openAfterSale = (o: PointOrder) => {
    setAfterSaleMode("request")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }

  /** 卖家：打开「拒绝退款」对话框（要写明理由，买家才服气） */
  const openAfterSaleReject = (o: PointOrder) => {
    setAfterSaleMode("reject")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }

  /** 提交对话框 —— 买家申请 / 卖家拒绝共用 */
  const submitAfterSale = async () => {
    const o = afterSaleTarget
    if (!o) return
    const text = afterSaleText.trim()
    if (afterSaleMode === "request" && text.length < 4) {
      toast.error(t("pt.afterSale.reasonTooShort"))
      return
    }
    if (afterSaleMode === "reject" && !text) {
      toast.error(t("pt.afterSale.rejectNeedReason"))
      return
    }
    setAfterSaleBusy(true)
    try {
      if (afterSaleMode === "request") {
        await pointsApi.requestAfterSale(o.id, text)
        toast.success(t("pt.toast.afterSaleRequested"))
      } else {
        await pointsApi.sellerResolveAfterSale(o.id, false, text)
        toast.success(t("pt.toast.afterSaleRejected"))
      }
      setAfterSaleTarget(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    } finally {
      setAfterSaleBusy(false)
    }
  }

  /** 卖家：同意退款（积分原路退回买家；卖家本就没拿到过这笔托管积分） */
  const approveAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmApprove", { name: o.productName, price: o.price }))) return
    try {
      await pointsApi.sellerResolveAfterSale(o.id, true)
      toast.success(t("pt.toast.afterSaleApproved"))
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  /** 买家：撤销自己的退款申请 */
  const withdrawAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmWithdraw"))) return
    try {
      await pointsApi.cancelAfterSale(o.id)
      toast.success(t("pt.toast.afterSaleWithdrawn"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  /** 买家：卖家不处理或已拒绝 → 申请平台（管理员）介入 */
  const escalateAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmEscalate"))) return
    try {
      await pointsApi.escalateAfterSale(o.id)
      toast.success(t("pt.toast.afterSaleEscalated"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  // ---- 我的商品 ----

  const openUpload = () => {
    setEditingId(null)
    setForm(emptyUpload())
    setUploadOpen(true)
  }

  const openEditMine = (p: PointProduct) => {
    setEditingId(p.id)
    setForm(uploadOf(p))
    setUploadOpen(true)
  }

  /** 发布效果预览：用当前表单值拼一个 PointProduct，直接复用商品卡片渲染 */
  const previewProduct: PointProduct | null = React.useMemo(() => {
    if (!previewOpen) return null
    const p = uploadPayload(form)
    const now = new Date().toISOString()
    return {
      id: "__preview__",
      name: p.name,
      description: p.description,
      imageUrl: p.imageUrl,
      category: p.category,
      icon: p.icon,
      price: p.price,
      stock: p.stock,
      dailyLimit: null,
      perUserLimit: null,
      // 用户商品交付方式固定为人工
      delivery: "manual",
      quotaYuan: null,
      deliveryParams: null,
      enabled: p.enabled,
      sort: 0,
      ownerId: "__preview__",
      ownerName: user?.username ?? null,
      reviewStatus: "pending",
      reviewNote: null,
      reviewedAt: null,
      billingMode: p.billingMode,
      rentalDays: p.rentalDays,
      createdAt: now,
      updatedAt: now,
    }
  }, [previewOpen, form, user])

  const submitUpload = async () => {
    const payload = uploadPayload(form)
    if (!payload.name) {
      toast.error(t("pt.err.nameRequired"))
      return
    }
    if (payload.price < 1) {
      toast.error(t("pt.err.priceInvalid"))
      return
    }
    if (payload.billingMode === "rental" && (!payload.rentalDays || payload.rentalDays < 1)) {
      toast.error(t("pt.err.rentalDaysRequired"))
      return
    }
    setFormBusy(true)
    try {
      if (editingId) {
        await pointsApi.updateMyProduct(editingId, payload)
        toast.success(t("pt.toast.savedReview"))
      } else {
        await pointsApi.uploadProduct(payload)
        toast.success(t("pt.toast.submitted"))
      }
      setUploadOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.submit")))
    } finally {
      setFormBusy(false)
    }
  }

  const removeMine = async (p: PointProduct) => {
    if (!confirm(t("pt.confirm.deleteMine", { name: p.name }))) return
    try {
      await pointsApi.deleteMyProduct(p.id)
      toast.success(t("pt.toast.deleted"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.delete")))
    }
  }

  const sellerDeliver = async (o: PointOrder) => {
    if (!confirm(t("pt.confirm.deliver", { name: o.productName }))) return
    try {
      await pointsApi.sellerDeliver(o.id)
      toast.success(t("pt.toast.delivered"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.op")))
    }
  }

  const orders: PointOrder[] = data?.orders ?? []
  const myProducts: PointProduct[] = data?.myProducts ?? []
  const userProducts: PointProduct[] = data?.userProducts ?? []
  /** 用户商城的分类筛选：all / it / other */
  const [shopCat, setShopCat] = React.useState<ProductCategory | "all">("all")
  const shownUserProducts =
    shopCat === "all" ? userProducts : userProducts.filter((p) => p.category === shopCat)
  const sellerOrders: PointOrder[] = data?.sellerOrders ?? []

  /** 用户商城的页码：商品变少导致页码越界（如删到只剩 1 页）时自动收回到最后一页 */
  const shopPageCount = Math.max(1, Math.ceil(shownUserProducts.length / SHOP_PAGE_SIZE))
  const shopPageSafe = Math.min(shopPage, shopPageCount)
  const pagedUserProducts = shownUserProducts.slice(
    (shopPageSafe - 1) * SHOP_PAGE_SIZE,
    shopPageSafe * SHOP_PAGE_SIZE
  )

  /** 翻页后把商城标题滚回视野 —— 否则新一页全在视口上方，看着像没反应 */
  const gotoShopPage = (p: number) => {
    setShopPage(p)
    shopTopRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
  }
  /** 需要我处理的：别人买了我的东西但还没交付 */
  const todoSellerOrders = sellerOrders.filter((o) => o.status === "pending").length
  /** 需要我确认收货的 */
  const todoConfirm = orders.filter((o) => o.sellerId !== null && o.status === "delivered").length
  /** 一共几件事等着我动手（发货 + 收货），用于卡片角标 */
  const todoCount = todoSellerOrders + todoConfirm

  /** 「我的交易」二级菜单：顶部按钮 → 下拉分类 → 点分类弹窗看明细（2026-10-03 站长要求） */
  const [tradesMenuOpen, setTradesMenuOpen] = React.useState(false)
  const tradesBtnRef = React.useRef<HTMLDivElement | null>(null)
  const [tradesView, setTradesView] = React.useState<null | "todo" | "bought" | "sold">(null)
  const openTradesView = (v: "todo" | "bought" | "sold") => {
    setTradesMenuOpen(false)
    setTradesView(v)
  }

  /**
   * 续费：找到订单对应的商品，重新走一遍购买流程。
   *
   * 只从「正在卖的商品」里找（官方上架 + 用户已通过审核）—— 商品下架或删除后就续不了，
   * 这时按钮不显示。续费本身由服务端处理成「从原到期时间往后顺延」。
   */
  const renewTarget = (o: PointOrder): PointProduct | null => {
    if (!o.productId || o.billingMode !== "rental" || o.status === "cancelled") return null
    return (
      data?.products.find((p) => p.id === o.productId) ??
      data?.userProducts.find((p) => p.id === o.productId) ??
      null
    )
  }

  /**
   * 「我的交易」三个分区的渲染。原先这三块是页面底部一张大卡片，
   * 2026-10-03 站长要求收进顶部「我的交易」按钮的二级菜单里（点分类再弹窗看）。
   * 抽成渲染函数是为了弹窗里复用同一套 UI（含卖家发货 / 买家收货 / 售后等操作）。
   */
  const renderTodoList = () => (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <ul className="space-y-2">
        {sellerOrders
          .filter((o) => o.status === "pending")
          .map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {t("pt.todo.ship", { name: o.productName })}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.todo.shipMeta", { user: o.username, n: o.price })}
                </p>
              </div>
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => void sellerDeliver(o)}
              >
                {t("pt.markDelivered")}
              </Button>
            </li>
          ))}
        {orders
          .filter((o) => o.sellerId !== null && o.status === "delivered")
          .map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {t("pt.todo.receive", { name: o.productName })}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.todo.receiveMeta", {
                    seller: o.sellerName ?? "?",
                    price: o.price,
                  })}
                </p>
              </div>
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => void confirmReceipt(o)}
              >
                {t("pt.confirmReceipt")}
              </Button>
            </li>
          ))}
      </ul>
    </div>
  )

  const renderBoughtList = () =>
    orders.length === 0 ? (
      <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
        {t("pt.boughtEmpty")}
      </p>
    ) : (
      <ul className="divide-y">
        {orders.map((o) => {
          const isUserOrder = o.sellerId !== null
          const st = ORDER_STATUS[o.status] ?? ORDER_STATUS.pending
          const rental = rentalOrderText(o)
          const expired = isRentalExpired(o)
          const renew = renewTarget(o)
          return (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {o.productName}
                  {o.billingMode === "rental" && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      {rentalTerm(o.rentalDays)}
                    </Badge>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {fmtDateTime(o.createdAt)}
                  {isUserOrder ? ` · ${t("pt.sellerLabel")} ${o.sellerName ?? "?"}` : ""}
                  {/* 交易双方能互相联系（2026-10-01）：交付方式、催确认收货都靠它 */}
                  {isUserOrder && o.sellerName && (
                    <>
                      {" · "}
                      <Link
                        to={`/dashboard/dm/${encodeURIComponent(o.sellerName)}`}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        {t("pt.sendDm")}
                      </Link>
                    </>
                  )}
                  {o.note ? ` · ${o.note}` : ""}
                </p>
                {(o.afterSaleReason || o.afterSaleNote) && (
                  <p className="truncate text-xs text-muted-foreground">
                    {o.afterSaleReason
                      ? `${t("pt.afterSale.reasonLabel")}${o.afterSaleReason}`
                      : ""}
                    {o.afterSaleReason && o.afterSaleNote ? " · " : ""}
                    {o.afterSaleNote
                      ? `${t("pt.afterSale.noteLabel")}${o.afterSaleNote}`
                      : ""}
                  </p>
                )}
                {rental && (
                  <p
                    className={
                      expired
                        ? "text-xs font-medium text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {rental}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <div>
                  <p className="text-sm font-medium tabular-nums text-muted-foreground">
                    -{o.price}
                  </p>
                  <div className="mt-0.5 flex flex-col items-end gap-1">
                    <Badge variant={st.variant} className="text-[10px]">
                      {t(orderStatusText(o.status, isUserOrder))}
                    </Badge>
                    {o.afterSaleStatus && (
                      <Badge
                        variant={AFTER_SALE_STATUS[o.afterSaleStatus].variant}
                        className="text-[10px]"
                      >
                        {t(AFTER_SALE_STATUS[o.afterSaleStatus].label)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {isUserOrder && o.status === "delivered" && (
                    <Button size="sm" onClick={() => void confirmReceipt(o)}>
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t("pt.confirmReceipt")}
                    </Button>
                  )}
                  {canRequestAfterSale(o) && (
                    <Button size="sm" variant="outline" onClick={() => openAfterSale(o)}>
                      {t("pt.afterSale.request")}
                    </Button>
                  )}
                  {canEscalateAfterSale(o) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void escalateAfterSale(o)}
                    >
                      {t("pt.afterSale.escalate")}
                    </Button>
                  )}
                  {canWithdrawAfterSale(o) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void withdrawAfterSale(o)}
                    >
                      {t("pt.afterSale.withdraw")}
                    </Button>
                  )}
                </div>
                {renew && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBuyTarget(renew)}
                    title={expired ? t("pt.renewExpiredTip") : t("pt.renewTip")}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    {t("pt.renew")}
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    )

  const renderSoldList = () =>
    sellerOrders.length === 0 ? (
      <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
        {t("pt.soldEmpty")}
      </p>
    ) : (
      <ul className="divide-y rounded-md border">
        {sellerOrders.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {o.productName}
                {o.billingMode === "rental" && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px]">
                    {rentalTerm(o.rentalDays)}
                  </Badge>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t("pt.soldMeta", { user: o.username, time: fmtDateTime(o.createdAt) })}
                {" · "}
                <Link
                  to={`/dashboard/dm/${encodeURIComponent(o.username)}`}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {t("pt.sendDm")}
                </Link>
                {o.note ? ` · ${o.note}` : ""}
              </p>
              {o.afterSaleReason && (
                <p className="truncate text-xs text-amber-600 dark:text-amber-400">
                  {t("pt.afterSale.buyerReason")}
                  {o.afterSaleReason}
                </p>
              )}
              {o.afterSaleNote && o.afterSaleStatus !== "requested" && (
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.afterSale.noteLabel")}
                  {o.afterSaleNote}
                </p>
              )}
              {rentalOrderText(o) && (
                <p className="text-xs text-muted-foreground">{rentalOrderText(o)}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium tabular-nums">+{o.price}</span>
              <div className="flex flex-col items-end gap-1">
                {o.status === "pending" ? (
                  <Button size="sm" onClick={() => void sellerDeliver(o)}>
                    {t("pt.markDelivered")}
                  </Button>
                ) : (
                  <Badge
                    variant={(ORDER_STATUS[o.status] ?? ORDER_STATUS.pending).variant}
                    className="text-[10px]"
                  >
                    {t(orderStatusText(o.status, true))}
                  </Badge>
                )}
                {o.afterSaleStatus && (
                  <Badge
                    variant={AFTER_SALE_STATUS[o.afterSaleStatus].variant}
                    className="text-[10px]"
                  >
                    {t(AFTER_SALE_STATUS[o.afterSaleStatus].label)}
                  </Badge>
                )}
                {o.afterSaleStatus === "requested" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void approveAfterSale(o)}
                    >
                      {t("pt.afterSale.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openAfterSaleReject(o)}
                    >
                      {t("pt.afterSale.reject")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    )

  return (
    <div>
      <PageHeader
        title={t("pt.title")}
        description={t("pt.desc")}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            {t("common.refresh")}
          </Button>
        }
      />

      {loading && !data ? (
        <LoadingBlock />
      ) : !data ? (
        <EmptyState
          title={t("pt.loadFailed")}
          description={t("pt.loadFailedDesc")}
          action={<Button onClick={() => void load()}>{t("common.retry")}</Button>}
        />
      ) : (
        <div className="space-y-6">
          {/* 余额 —— 「积分明细」收进右侧按钮的弹窗里，不再单独占页面一块 */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="space-y-1">
                <CardDescription>{t("pt.myPoints")}</CardDescription>
                <CardTitle className="flex items-baseline gap-2 text-4xl">
                  <Coins className="h-7 w-7 text-primary" />
                  {balance}
                  <span className="text-base font-normal text-muted-foreground">
                    ≈ ¥{fmtMoney(balance * yuanPerPoint)}
                  </span>
                </CardTitle>
              </div>
              {/**
               * 按钮区父容器：flex-wrap 让按钮在窄屏自动换行（全局规则，见 MEMORY.md）。
               * 每个按钮都是 whitespace-nowrap 的 flex 项，按钮再多也不撑破卡片 ——
               * 最多换行，不会把最后一个按钮顶出屏幕外（390px 手机 / WebToApp WebView 实测）。
               */}
              <div className="flex flex-wrap items-center gap-2">
                {/* 每日签到：放在转账左边，作为积分获取的常驻入口 */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCheckinOpen(true)}
                >
                  <CalendarCheck className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.checkin")}
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTransferOpen(true)}
                  disabled={balance < 1}
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.transfer")}
                </Button>

                {/* 我的交易：二级菜单。按钮本身带「待处理」角标，点开选分类再看明细
                    （2026-10-03 站长要求：原来它是页面底部一整张卡片，太靠下） */}
                <div ref={tradesBtnRef} className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTradesMenuOpen((v) => !v)}
                  >
                    <Package className="mr-1.5 h-3.5 w-3.5" />
                    {t("pt.myTrades")}
                    {todoCount > 0 && (
                      <Badge
                        variant="default"
                        className="ml-1.5 h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
                      >
                        {todoCount}
                      </Badge>
                    )}
                    <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
                  </Button>
                  <AnchoredPanel
                    anchorRef={tradesBtnRef}
                    open={tradesMenuOpen}
                    onClose={() => setTradesMenuOpen(false)}
                    width={208}
                    height={172}
                  >
                    <div className="space-y-0.5 p-1">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                        onClick={() => openTradesView("todo")}
                      >
                        <span>{t("pt.todoTitle")}</span>
                        {todoCount > 0 && (
                          <Badge variant="default" className="text-[10px]">
                            {todoCount}
                          </Badge>
                        )}
                      </button>
                      <button
                        type="button"
                        className="block w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                        onClick={() => openTradesView("bought")}
                      >
                        {t("pt.boughtTitle", { n: orders.length })}
                      </button>
                      <button
                        type="button"
                        className="block w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                        onClick={() => openTradesView("sold")}
                      >
                        {t("pt.soldTitle", { n: sellerOrders.length })}
                      </button>
                    </div>
                  </AnchoredPanel>
                </div>

                <Button variant="outline" size="sm" onClick={() => setDetailOpen(true)}>
                  <ReceiptText className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.detail")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {t("pt.rate", { v: fmtMoney(yuanPerPoint) })}
              {data.config.dailyLimit > 0 &&
                ` · ${t("pt.rateDailyLimit", { n: data.config.dailyLimit })}`}
            </CardContent>
          </Card>

          {/* 官方商城：兑换也是其中一张卡 */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">{t("pt.officialShop")}</h2>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* 兑换中转站余额 —— 金额自选，所以单独走兑换弹窗 */}
              <Card className="flex flex-col border-primary/40">
                {/* 兑换卡也走同一个封面样式，否则它和右边的商品卡高度不齐 */}
                <div className="flex h-36 w-full shrink-0 items-center justify-center overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-primary/20 via-primary/5 to-transparent">
                  <Wallet className="h-20 w-20 text-primary" strokeWidth={1.25} aria-hidden />
                </div>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardDescription>{t("pt.redeem")}</CardDescription>
                    <Badge variant="outline" className="text-[10px]">
                      {t("pt.byRate")}
                    </Badge>
                  </div>
                  <CardTitle className="text-base">{t("pt.redeemBalance")}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    {t("pt.redeemCardDesc", { v: fmtMoney(yuanPerPoint) })}
                  </p>
                  {!data.config.enabled ? (
                    <Button disabled variant="outline" className="w-full">
                      {t("pt.redeemClosed")}
                    </Button>
                  ) : !data.bound ? (
                    <Button variant="outline" className="w-full" asChild>
                      <Link to="/dashboard/ai">{t("pt.goBindGateway")}</Link>
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={() => {
                        setAmount("")
                        setRedeemOpen(true)
                      }}
                    >
                      {t("pt.redeemNow")}
                    </Button>
                  )}
                </CardContent>
              </Card>

              {data.products.map((p) => (
                <ProductCard key={p.id} product={p} balance={balance} onBuy={setBuyTarget} onDetail={setDetailTarget} />
              ))}
            </div>
          </div>

          {/* 用户们的商城 */}
          <div>
            <div ref={shopTopRef} className="mb-3 flex flex-wrap items-center gap-2 scroll-mt-20">
              <Store className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">{t("pt.userShop")}</h2>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setMineOpen(true)}>
                  <Package className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.myProducts")}
                  {myProducts.length > 0 && ` (${myProducts.length})`}
                </Button>
                <Button size="sm" onClick={openUpload}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("pt.uploadProduct")}
                </Button>
              </div>
            </div>

            <p className="mb-3 text-xs text-muted-foreground">
              {t("pt.userShopDesc")}
            </p>

            {/* 分类筛选（2026-10-03 站长要求：「其他」的商品默认排在后面） */}
            <div className="mb-3 flex flex-wrap gap-2">
              {SHOP_CAT_FILTERS.map((f) => (
                <Button
                  key={f.key}
                  size="sm"
                  variant={shopCat === f.key ? "default" : "outline"}
                  onClick={() => setShopCat(f.key)}
                >
                  {t(f.label)}
                </Button>
              ))}
            </div>

            {userProducts.length === 0 ? (
              <EmptyState
                icon={Store}
                title={t("pt.userShopEmpty")}
                description={t("pt.userShopEmptyDesc")}
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {pagedUserProducts.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    balance={balance}
                    sellerName={p.ownerName}
                    onBuy={setBuyTarget}
                    onDetail={setDetailTarget}
                  />
                ))}
              </div>
            )}

            {/* 分页：每页 9 个（3 列 × 3 行），只有一页时不显示 */}
            {shopPageCount > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={shopPageSafe <= 1}
                  onClick={() => gotoShopPage(shopPageSafe - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  上一页
                </Button>
                <span className="tabular-nums">
                  第 {shopPageSafe} / {shopPageCount} 页 · 共 {userProducts.length} 个商品
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={shopPageSafe >= shopPageCount}
                  onClick={() => gotoShopPage(shopPageSafe + 1)}
                >
                  下一页
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>

          {/* 我的交易：二级菜单点开后的弹窗。
              原先这里是页面底部一整张卡片（待处理 + 我买到的 + 我卖出的），
              2026-10-03 站长要求收进顶部「我的交易」按钮的二级菜单里。 */}
          <Dialog
            open={tradesView !== null}
            onOpenChange={(o) => {
              if (!o) setTradesView(null)
            }}
          >
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {tradesView === "todo"
                    ? t("pt.todoTitle")
                    : tradesView === "bought"
                      ? t("pt.boughtTitle", { n: orders.length })
                      : t("pt.soldTitle", { n: sellerOrders.length })}
                </DialogTitle>
                <DialogDescription>{t("pt.tradesDesc")}</DialogDescription>
              </DialogHeader>
              {tradesView === "todo" ? (
                todoCount > 0 ? (
                  renderTodoList()
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {t("pt.todoNone")}
                  </p>
                )
              ) : tradesView === "bought" ? (
                renderBoughtList()
              ) : (
                renderSoldList()
              )}
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* 售后（退款）：买家「申请退款」与卖家「拒绝并说明理由」共用一个对话框 */}
      <Dialog
        open={afterSaleTarget !== null}
        onOpenChange={(v) => {
          if (!v) setAfterSaleTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(afterSaleMode === "request" ? "pt.afterSale.request" : "pt.afterSale.reject")}
            </DialogTitle>
            <DialogDescription>
              {t(
                afterSaleMode === "request"
                  ? "pt.afterSale.requestDesc"
                  : "pt.afterSale.rejectDesc"
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="afterSaleText">
              {t(
                afterSaleMode === "request"
                  ? "pt.afterSale.reasonLabel"
                  : "pt.afterSale.rejectNote"
              )}
            </Label>
            <Textarea
              id="afterSaleText"
              value={afterSaleText}
              onChange={(e) => setAfterSaleText(e.target.value)}
              maxLength={300}
              rows={3}
              placeholder={t(
                afterSaleMode === "request"
                  ? "pt.afterSale.reasonPlaceholder"
                  : "pt.afterSale.rejectPlaceholder"
              )}
            />
            {afterSaleTarget && (
              <p className="text-xs text-muted-foreground">
                {afterSaleTarget.productName} ·{" "}
                {t("pt.pointsUnit", { n: afterSaleTarget.price })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAfterSaleTarget(null)}
              disabled={afterSaleBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitAfterSale()} disabled={afterSaleBusy}>
              {afterSaleBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t("pt.afterSale.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 积分明细 */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("pt.detail")}</DialogTitle>
            <DialogDescription>{t("pt.detailDesc")}</DialogDescription>
          </DialogHeader>
          {!data || data.transactions.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={t("pt.detailEmpty")}
              description={t("pt.detailEmptyDesc")}
            />
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {data.transactions.map((tx) => (
                <li key={tx.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {tx.detail || t(REASON_LABEL[tx.reason] ?? tx.reason)}
                    </p>
                    <p className="text-xs text-muted-foreground">{fmtDateTime(tx.createdAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={
                        tx.delta > 0
                          ? "text-sm font-medium text-emerald-600 dark:text-emerald-400"
                          : "text-sm font-medium text-muted-foreground"
                      }
                    >
                      {tx.delta > 0 ? `+${tx.delta}` : tx.delta}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {t(REASON_LABEL[tx.reason] ?? tx.reason)} ·{" "}
                      {t("pt.balanceSuffix", { n: tx.balance })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {/* 兑换弹窗 */}
      <Dialog open={redeemOpen} onOpenChange={(o) => !redeemBusy && setRedeemOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("pt.redeemBalance")}</DialogTitle>
            <DialogDescription>{t("pt.redeemDialogDesc", { v: fmtMoney(yuanPerPoint) })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="redeem-points">{t("pt.usePoints")}</Label>
              <Input
                id="redeem-points"
                inputMode="numeric"
                placeholder={t("pt.pointsPlaceholder")}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                {points > 0 ? (
                  <>
                    {t("pt.willRedeem")}{" "}
                    <span className="font-medium text-foreground">¥{fmtMoney(yuan)}</span>
                    {points > balance && (
                      <span className="text-destructive">
                        {t("pt.overBalance", { n: balance })}
                      </span>
                    )}
                  </>
                ) : (
                  t("pt.amountHint", { n: balance })
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAmount(String(balance))}
                disabled={balance < 1}
              >
                {t("pt.redeemAll")}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRedeemOpen(false)} disabled={redeemBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleRedeem()} disabled={!canRedeem}>
              {redeemBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("pt.confirmRedeem")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 转账弹窗：只需转出方确认，不需要对方同意 */}
      {/* 每日签到 */}
      <CheckinDialog open={checkinOpen} onOpenChange={setCheckinOpen} onDone={() => void load()} />

      <Dialog open={transferOpen} onOpenChange={(o) => !transferBusy && setTransferOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("pt.transferTitle")}</DialogTitle>
            <DialogDescription>{t("pt.transferDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="transfer-to">{t("pt.transferTo")}</Label>
              <Input
                id="transfer-to"
                placeholder={t("pt.transferToPlaceholder")}
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transfer-amount">{t("pt.transferAmount")}</Label>
              <Input
                id="transfer-amount"
                inputMode="numeric"
                placeholder={t("pt.pointsPlaceholder")}
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value.replace(/\D/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                {transferValue > 0 ? (
                  <>
                    {t("pt.equals")}{" "}
                    <span className="font-medium text-foreground">
                      ¥{fmtMoney(transferValue * yuanPerPoint)}
                    </span>
                    {transferValue > balance && (
                      <span className="text-destructive">
                        {t("pt.overBalance", { n: balance })}
                      </span>
                    )}
                  </>
                ) : (
                  t("pt.balanceSuffix", { n: balance })
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTransferAmount(String(balance))}
                disabled={balance < 1}
              >
                {t("pt.transferAll")}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTransferOpen(false)}
              disabled={transferBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleTransfer()} disabled={!canTransfer}>
              {transferBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("pt.confirmTransfer")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 购买弹窗 */}
      <Dialog open={!!buyTarget} onOpenChange={(o) => !o && !buyBusy && setBuyTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {buyTarget?.billingMode === "rental" ? tStatic("pt.rental.rental") : t("pt.buy")} · {buyTarget?.name}
            </DialogTitle>
            <DialogDescription>
              {buyHint(buyTarget?.delivery ?? "manual", buyIsUserProduct)}
              {buyTarget?.billingMode === "rental" && (
                <> {rentalBuyHint(buyTarget.rentalDays, buyIsUserProduct)}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {buyIsUserProduct && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.sellerLabel")}</span>
                <span className="font-medium">{buyTarget?.ownerName ?? "—"}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("pt.priceLabel")}</span>
              <span className="font-medium tabular-nums">
                {t("pt.pointsUnit", { n: buyTarget?.price ?? 0 })}
                {buyTarget?.billingMode === "rental"
                  ? ` / ${t("pt.days", { n: buyTarget.rentalDays ?? 0 })}`
                  : ""}
              </span>
            </div>
            {buyTarget?.billingMode === "rental" && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.billingLabel")}</span>
                <span className="font-medium">{t("pt.billingRental")}</span>
              </div>
            )}
            {buyTarget?.delivery === "quota" && buyTarget.quotaYuan ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.quotaAmount")}</span>
                <span className="font-medium tabular-nums">¥{fmtMoney(buyTarget.quotaYuan)}</span>
              </div>
            ) : null}
            {buyTarget?.delivery === "feature" && buyTarget.deliveryParams?.feature ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.featureLabel")}</span>
                <span className="font-medium">
                  {t(FEATURE_LABELS[buyTarget.deliveryParams.feature])}
                </span>
              </div>
            ) : null}
            {buyTarget?.delivery === "subscription" && buyTarget.deliveryParams?.planId ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.planLabel")}</span>
                <span className="font-medium tabular-nums">
                  #{buyTarget.deliveryParams.planId}
                </span>
              </div>
            ) : null}
            {buyTarget?.delivery === "invite_quota" && buyTarget.deliveryParams?.count ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.inviteQuotaLabel")}</span>
                <span className="font-medium tabular-nums">
                  {t("pt.countUnit", { n: buyTarget.deliveryParams.count })}
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("pt.balanceAfter")}</span>
              <span className="font-medium tabular-nums">
                {t("pt.pointsUnit", { n: balance - (buyTarget?.price ?? 0) })}
              </span>
            </div>
            {buyTargetNeedsBind && (
              <p className="text-xs text-destructive">
                {buyTarget?.delivery === "subscription"
                  ? t("pt.needBind.subscription")
                  : t("pt.needBind.quota")}
                <Link to="/dashboard/ai" className="ml-1 underline-offset-4 hover:underline">
                  {t("pt.goOpen")}
                </Link>
              </p>
            )}
            {!buyTargetAffordable && (
              <p className="text-xs text-destructive">{t("pt.insufficient")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuyTarget(null)} disabled={buyBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleBuy()} disabled={!canBuy}>
              {buyBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("pt.confirmBuy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 商品详情：完整标题 + 描述（卡片里被截断，这里看全文） */}
      <Dialog open={!!detailTarget} onOpenChange={(o) => !o && setDetailTarget(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-all">{detailTarget?.name}</DialogTitle>
            <DialogDescription>{t("pt.detailTitle")}</DialogDescription>
          </DialogHeader>
          {detailTarget && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="text-lg font-semibold tabular-nums">{detailTarget.price}</span>
                <span className="text-xs text-muted-foreground">
                  {t("pt.unit")}
                  {detailTarget.billingMode === "rental"
                    ? ` / ${t("pt.days", { n: detailTarget.rentalDays ?? 0 })}`
                    : ""}
                  {detailTarget.perUserLimit
                    ? ` · ${t("pt.perUserLimit", { n: detailTarget.perUserLimit })}`
                    : ""}
                </span>
              </div>
              {detailTarget.description ? (
                <p className="whitespace-pre-wrap break-all text-sm text-muted-foreground">
                  {detailTarget.description}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("pt.detailNoDesc")}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailTarget(null)}>
              {t("common.close")}
            </Button>
            <Button
              onClick={() => {
                if (detailTarget) {
                  setBuyTarget(detailTarget)
                  setDetailTarget(null)
                }
              }}
            >
              {t("pt.buy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 我的商品 + 我收到的订单 */}
      <Dialog open={mineOpen} onOpenChange={setMineOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("pt.myProducts")}</DialogTitle>
            <DialogDescription>{t("pt.myProductsDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{t("pt.listedTitle", { n: myProducts.length })}</p>
                <Button
                  size="sm"
                  onClick={() => {
                    setMineOpen(false)
                    openUpload()
                  }}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("pt.uploadNew")}
                </Button>
              </div>

              {myProducts.length === 0 ? (
                <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                  {t("pt.listedEmpty")}
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {myProducts.map((p) => {
                    const rv = MY_REVIEW[p.reviewStatus] ?? MY_REVIEW.pending
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-3 p-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
                            {p.imageUrl ? (
                              <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              (() => {
                                const I = shopIcon(p.icon)
                                return <I className="h-4 w-4 text-primary" />
                              })()
                            )}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {t("pt.pointsUnit", { n: p.price })}
                              {p.billingMode === "rental"
                                ? ` / ${t("pt.days", { n: p.rentalDays ?? 0 })}`
                                : ""}{" "}
                              ·{" "}
                              {p.stock === null
                                ? t("pt.unlimited")
                                : t("pt.leftPieces", { n: p.stock })}
                              {!p.enabled ? t("pt.delisted") : ""}
                            </p>
                            {p.reviewStatus === "rejected" && p.reviewNote && (
                              <p className="mt-0.5 text-xs text-destructive">
                                {t("pt.rejectedNote", { note: p.reviewNote })}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant={rv.variant} className="text-[10px]">
                            {t(rv.label)}
                          </Badge>
                          <Button variant="outline" size="sm" onClick={() => openEditMine(p)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void removeMine(p)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 上架 / 编辑自己的商品 */}
      <Dialog open={uploadOpen} onOpenChange={(o) => !formBusy && setUploadOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? t("pt.editMine") : t("pt.uploadMine")}</DialogTitle>
            <DialogDescription>{t("pt.uploadDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="upName">{t("pt.form.name")}</Label>
              <Input
                id="upName"
                maxLength={40}
                placeholder={t("pt.form.namePlaceholder")}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="upDesc">{t("pt.form.desc")}</Label>
              <Textarea
                id="upDesc"
                rows={3}
                maxLength={500}
                placeholder={t("pt.form.descPlaceholder")}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="upImage">{t("pt.form.cover")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={coverUploading}
                  onClick={() => coverInputRef.current?.click()}
                >
                  {coverUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  {t("pt.form.localUpload")}
                </Button>
                {/* 隐藏的文件选择：传完立即把返回的 URL 填进下面的输入框 */}
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => void handleCoverPick(e.target.files?.[0])}
                />
              </div>
              <Input
                id="upImage"
                placeholder={t("pt.form.coverPlaceholder")}
                value={form.imageUrl}
                onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
              />
              {form.imageUrl.trim() && (
                <p className="text-xs text-muted-foreground">
                  {t("pt.form.coverHint")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="upCategory">{t("pt.form.category")}</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v as ProductCategory }))}
              >
                <SelectTrigger id="upCategory" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRODUCT_CATEGORY_LABELS) as ProductCategory[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(PRODUCT_CATEGORY_LABELS[c])}
                      </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("pt.form.categoryHint")}
              </p>
            </div>

            <ShopIconPicker
              value={form.icon}
              disabled={formBusy}
              onChange={(slug) => setForm((f) => ({ ...f, icon: slug }))}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="upPrice">{t("pt.form.price")}</Label>
                <Input
                  id="upPrice"
                  inputMode="numeric"
                  placeholder={t("pt.form.pricePlaceholder")}
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="upStock">
                  {form.billingMode === "rental" ? t("pt.form.stockRental") : t("pt.form.stock")}
                </Label>
                <Input
                  id="upStock"
                  inputMode="numeric"
                  placeholder={t("pt.form.unlimited")}
                  value={form.stock}
                  onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
                />
              </div>
            </div>

            {/* 计费方式：买断 / 租用。租用对用户商品是可用的（交付方式固定人工，属于可收回的一类） */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t("pt.form.rentalMode")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("pt.form.rentalModeHint")}
                  </p>
                </div>
                <Switch
                  checked={form.billingMode === "rental"}
                  onCheckedChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      billingMode: v ? "rental" : "one_time",
                      // 打开时给个默认租期，省得忘了填被服务端打回
                      rentalDays: v && !f.rentalDays ? "30" : f.rentalDays,
                    }))
                  }
                />
              </div>

              {form.billingMode === "rental" && (
                <div className="space-y-2">
                  <Label htmlFor="upDays">{t("pt.form.rentalDays")}</Label>
                  <Input
                    id="upDays"
                    inputMode="numeric"
                    placeholder={t("pt.form.rentalDaysPlaceholder")}
                    value={form.rentalDays}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, rentalDays: e.target.value.replace(/\D/g, "") }))
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    {RENTAL_DAY_PRESETS.map((d) => (
                      <Button
                        key={d}
                        type="button"
                        size="sm"
                        variant={form.rentalDays === String(d) ? "default" : "outline"}
                        onClick={() => setForm((f) => ({ ...f, rentalDays: String(d) }))}
                      >
                        {t("pt.days", { n: d })}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("pt.form.enabled")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("pt.form.enabledHint")}
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreviewOpen(true)}
              disabled={formBusy}
            >
              <Eye className="mr-1.5 h-4 w-4" />
              {t("pt.preview.open")}
            </Button>
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={formBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitUpload()} disabled={formBusy}>
              {formBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {editingId ? t("common.save") : t("pt.submitReview")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 发布效果预览：复用商品卡片，按当前表单值实时渲染 */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("pt.preview.title")}</DialogTitle>
            <DialogDescription>{t("pt.preview.hint")}</DialogDescription>
          </DialogHeader>
          {previewProduct && (
            // 预览不产生交互：私信链接禁用，购买按钮为空操作
            <div className="[&_a]:pointer-events-none">
              <ProductCard
                product={previewProduct}
                balance={Number.MAX_SAFE_INTEGER}
                sellerName={previewProduct.ownerName}
                onBuy={() => {}}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
