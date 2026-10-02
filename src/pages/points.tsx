import * as React from "react"
import { Link } from "react-router-dom"
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Coins,
  Handshake,
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
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { ShopIconPicker } from "@/components/shop-icon-picker"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { notifyPointsChanged } from "@/components/points-badge"
import { fmtDateTime } from "@/lib/format"
import { shopIcon } from "@/lib/shop-icons"
import { FEATURE_LABELS } from "@/types"
import type {
  PointBillingMode,
  PointOrder,
  PointProduct,
  PointsOverview,
  UserProductPayload,
} from "@/types"

/** 流水来源 → 展示标签 */
const REASON_LABEL: Record<string, string> = {
  event: "活动奖励",
  admin: "管理员调整",
  redeem: "兑换余额",
  shop: "商城购买",
  shop_sell: "商城售出",
  donation: "捐献奖励",
  invite: "邀请奖励",
  invite_commission: "邀请返佣",
  transfer_out: "转账转出",
  transfer_in: "转账收到",
}

/** 订单状态 → 展示标签（用户商品订单的 pending/delivered 含义不同，用 orderStatusText 区分） */
const ORDER_STATUS: Record<string, { label: string; variant: "default" | "outline" | "secondary" }> = {
  pending: { label: "待发放", variant: "default" },
  delivered: { label: "已发放", variant: "outline" },
  settled: { label: "已结算", variant: "outline" },
  cancelled: { label: "已取消", variant: "secondary" },
}

/**
 * 订单状态的展示文案。
 *
 * 用户商品走**担保**：pending = 等卖家交付（积分在平台手里）、
 * delivered = 卖家已交付、等你确认收货。跟官方商品的「待发放 / 已发放」不是一回事。
 */
function orderStatusText(status: string, isUserOrder: boolean): string {
  if (isUserOrder) {
    if (status === "pending") return "待卖家交付"
    if (status === "delivered") return "待确认收货"
    if (status === "settled") return "已完成"
  }
  return ORDER_STATUS[status]?.label ?? status
}

/** 自己上架商品的审核状态 → 标签 */
const MY_REVIEW: Record<
  string,
  { label: string; variant: "default" | "outline" | "secondary" | "destructive" | "success" }
> = {
  pending: { label: "待审核", variant: "default" },
  approved: { label: "已上架", variant: "success" },
  rejected: { label: "未通过", variant: "destructive" },
}

/**
 * 交付方式 → 商品卡上的一句说明。
 *
 * 用户视角只需要知道「下单后会发生什么、要不要等」，不需要知道内部类型名。
 */
function deliveryLabel(delivery: string): string {
  switch (delivery) {
    case "quota":
      return "自动到账 · 中转站余额"
    case "feature":
      return "自动开通 · 功能权限"
    case "subscription":
      return "自动开通 · 中转站订阅"
    case "invite_quota":
      return "自动到账 · 邀请码额度"
    default:
      return "人工发放"
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
    return "下单后积分先由平台保管，卖家发货、你确认收货后才转给卖家。"
  }
  switch (delivery) {
    case "quota":
      return "下单后会自动充进你的 AI 中转站余额。"
    case "feature":
      return "下单后会自动给你开通对应功能权限，立即生效。"
    case "subscription":
      return "下单后会自动给你的中转站账号开通订阅套餐。"
    case "invite_quota":
      return "下单后会自动增加你的邀请码创建额度。"
    default:
      return "下单后由管理员人工发放，可在「我的订单」里看进度。"
  }
}

/** 租期展示：如「租用 30 天」 */
function rentalTerm(days: number | null | undefined): string {
  return days && days > 0 ? `租用 ${days} 天` : "租用"
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
  if (!o.expiresAt) return `${rentalTerm(o.rentalDays)}（交付后起算）`
  const time = fmtDateTime(o.expiresAt)
  return isRentalExpired(o) ? `已到期（${time}）` : `有效期至 ${time}`
}

/** 购买弹窗里对「租用」的一句解释（官方自动发放 vs 用户商品，收尾方式不同） */
function rentalBuyHint(days: number | null, isUserProduct: boolean): string {
  const term = days && days > 0 ? `${days} 天` : "一个租期"
  if (isUserProduct) {
    return `这是租用商品：交付后 ${term} 内有效，到期请与卖家协商归还；想继续用，再买一次即可（剩余天数会顺延）。`
  }
  return `这是租用商品：交付后 ${term} 内有效，到期后权益会自动收回。想继续用，到期前再买一次即可续期（剩余天数会往后顺延）。`
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

/** 商品卡片（官方 / 用户商品共用；卖家名非空时显示「由 xxx 上架」） */
function ProductCard({
  product,
  balance,
  sellerName,
  onBuy,
}: {
  product: PointProduct
  balance: number
  sellerName?: string | null
  onBuy: (p: PointProduct) => void
}) {
  const soldOut = product.stock !== null && product.stock <= 0
  const tooExpensive = product.price > balance
  const isRental = product.billingMode === "rental"
  return (
    <Card className="flex flex-col">
      <ProductCover imageUrl={product.imageUrl} icon={product.icon} name={product.name} />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardDescription className="min-w-0 truncate">
            {sellerName ? `由 ${sellerName} 上架` : deliveryLabel(product.delivery)}
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
                    ? "已租完"
                    : "已售罄"
                  : isRental
                    ? `剩 ${product.stock} 份`
                    : `剩 ${product.stock} 件`}
              </Badge>
            )}
          </div>
        </div>
        <CardTitle className="text-base">{product.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3">
        {product.description ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {product.description}
          </p>
        ) : (
          <span />
        )}
        <div className="space-y-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums">{product.price}</span>
            <span className="text-xs text-muted-foreground">
              积分
              {isRental ? ` / ${product.rentalDays} 天` : ""}
              {product.delivery === "quota" && product.quotaYuan
                ? ` · 充 ¥${fmtMoney(product.quotaYuan)}`
                : ""}
              {product.perUserLimit ? ` · 每人限 ${product.perUserLimit} 件` : ""}
            </span>
          </div>
          <Button
            className="w-full"
            variant={tooExpensive ? "outline" : "default"}
            disabled={soldOut}
            onClick={() => onBuy(product)}
          >
            {soldOut
              ? isRental
                ? "已租完"
                : "已售罄"
              : tooExpensive
                ? "积分不足"
                : isRental
                  ? "租用"
                  : "购买"}
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
  const [data, setData] = React.useState<PointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  // 兑换弹窗
  const [redeemOpen, setRedeemOpen] = React.useState(false)
  const [amount, setAmount] = React.useState("")
  const [redeemBusy, setRedeemBusy] = React.useState(false)

  // 积分明细弹窗
  const [detailOpen, setDetailOpen] = React.useState(false)

  // 转账弹窗（用户间转账：只需自己确认，凭对方用户名转过去）
  const [transferOpen, setTransferOpen] = React.useState(false)
  const [transferTo, setTransferTo] = React.useState("")
  const [transferAmount, setTransferAmount] = React.useState("")
  const [transferBusy, setTransferBusy] = React.useState(false)

  // 购买弹窗
  const [buyTarget, setBuyTarget] = React.useState<PointProduct | null>(null)
  const [buyBusy, setBuyBusy] = React.useState(false)

  // 我的商品 / 收到的订单
  const [mineOpen, setMineOpen] = React.useState(false)

  // 我的交易弹窗（买的 / 卖的都在里面处理，入口在「我的积分」卡片上）
  const [tradeOpen, setTradeOpen] = React.useState(false)

  // 「用户们的商城」分页：服务端一次给全量（上限 200 个），在本地按 9 个一页切片
  const [shopPage, setShopPage] = React.useState(1)
  const shopTopRef = React.useRef<HTMLDivElement | null>(null)

  // 上架 / 编辑自己的商品
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<UploadForm>(emptyUpload())
  const [formBusy, setFormBusy] = React.useState(false)

  // 封面图直传（2026-10-01）：传完把返回的同源 URL 填进 imageUrl，卖家不用再找图床
  const [coverUploading, setCoverUploading] = React.useState(false)
  const coverInputRef = React.useRef<HTMLInputElement | null>(null)
  const handleCoverPick = async (file: File | undefined) => {
    if (!file) return
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      toast.error("封面只支持 JPG / PNG / WebP / GIF")
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("封面图不能超过 5 MB")
      return
    }
    setCoverUploading(true)
    try {
      const res = await pointsApi.uploadProductImage(file)
      setForm((f) => ({ ...f, imageUrl: res.url }))
      toast.success("封面上传成功")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "封面上传失败")
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
      toast.error(errMsg(err, "加载积分失败"))
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
      toast.error(errMsg(err, "兑换失败"))
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
      toast.success(`已转给 @${res.to} ${transferValue} 积分`)
      setTransferTo("")
      setTransferAmount("")
      setTransferOpen(false)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, "转账失败"))
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
      const term = res.order.billingMode === "rental" ? `（${rentalTerm(res.order.rentalDays)}）` : ""
      toast.success(
        res.order.status === "delivered"
          ? // 自动交付的订单，note 里就是「发了什么」（如「已自动充值 ¥10」）
            `已购买「${res.order.productName}」${term}，${res.order.note ?? "已自动发放"}。`
          : res.order.sellerId
            ? `已买下「${res.order.productName}」${term}，等卖家发货后记得来确认收货。`
            : `已购买「${res.order.productName}」${term}，等待管理员发放。`
      )
      setBuyTarget(null)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, "购买失败"))
    } finally {
      setBuyBusy(false)
    }
  }

  /** 买家确认收货 —— 把托管的积分结算给卖家 */
  const confirmReceipt = async (o: PointOrder) => {
    const rentalNote =
      o.billingMode === "rental"
        ? `\n\n租期从确认收货这一刻起算（${o.rentalDays ?? "?"} 天）。`
        : ""
    if (
      !confirm(
        `确认收到「${o.productName}」了？\n\n确认后 ${o.price} 积分会转给卖家，不能再撤回。${rentalNote}`
      )
    )
      return
    try {
      await pointsApi.confirmReceipt(o.id)
      toast.success("已确认收货，积分已转给卖家")
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, "确认失败"))
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

  const submitUpload = async () => {
    const payload = uploadPayload(form)
    if (!payload.name) {
      toast.error("请填写商品名称")
      return
    }
    if (payload.price < 1) {
      toast.error("售价必须是大于 0 的整数积分")
      return
    }
    if (payload.billingMode === "rental" && (!payload.rentalDays || payload.rentalDays < 1)) {
      toast.error("租用模式请填写租期天数（大于 0 的整数）")
      return
    }
    setFormBusy(true)
    try {
      if (editingId) {
        await pointsApi.updateMyProduct(editingId, payload)
        toast.success("已保存，改动需要管理员重新审核")
      } else {
        await pointsApi.uploadProduct(payload)
        toast.success("已提交，等管理员审核通过后就会出现在「用户们的商城」里")
      }
      setUploadOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, "提交失败"))
    } finally {
      setFormBusy(false)
    }
  }

  const removeMine = async (p: PointProduct) => {
    if (!confirm(`确定删除「${p.name}」？删掉后不能再恢复。`)) return
    try {
      await pointsApi.deleteMyProduct(p.id)
      toast.success("已删除")
      await load()
    } catch (err) {
      toast.error(errMsg(err, "删除失败"))
    }
  }

  const sellerDeliver = async (o: PointOrder) => {
    if (!confirm(`把订单「${o.productName}」标记为已交付？\n\n买家确认收货后积分才会到你的账上。`)) return
    try {
      await pointsApi.sellerDeliver(o.id)
      toast.success("已标记交付，等买家确认收货")
      await load()
    } catch (err) {
      toast.error(errMsg(err, "操作失败"))
    }
  }

  const orders: PointOrder[] = data?.orders ?? []
  const myProducts: PointProduct[] = data?.myProducts ?? []
  const userProducts: PointProduct[] = data?.userProducts ?? []
  const sellerOrders: PointOrder[] = data?.sellerOrders ?? []

  /** 用户商城的页码：商品变少导致页码越界（如删到只剩 1 页）时自动收回到最后一页 */
  const shopPageCount = Math.max(1, Math.ceil(userProducts.length / SHOP_PAGE_SIZE))
  const shopPageSafe = Math.min(shopPage, shopPageCount)
  const pagedUserProducts = userProducts.slice(
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

  return (
    <div>
      <PageHeader
        title="积分与商城"
        description="积分是站点发放的余额，可在下方商城兑换中转站余额或换取商品。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            刷新
          </Button>
        }
      />

      {loading && !data ? (
        <LoadingBlock />
      ) : !data ? (
        <EmptyState
          title="加载失败"
          description="积分数据暂时取不到，请稍后重试。"
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      ) : (
        <div className="space-y-6">
          {/* 余额 —— 「积分明细」收进右侧按钮的弹窗里，不再单独占页面一块 */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="space-y-1">
                <CardDescription>我的积分</CardDescription>
                <CardTitle className="flex items-baseline gap-2 text-4xl">
                  <Coins className="h-7 w-7 text-primary" />
                  {balance}
                  <span className="text-base font-normal text-muted-foreground">
                    ≈ ¥{fmtMoney(balance * yuanPerPoint)}
                  </span>
                </CardTitle>
              </div>
              <div className="flex items-center gap-2">
                {/* 我的交易：买的 / 卖的都在这个弹窗里处理；待处理的笔数直接标在按钮上 */}
                <Button variant="outline" size="sm" onClick={() => setTradeOpen(true)}>
                  <Handshake className="mr-1.5 h-3.5 w-3.5" />
                  我的交易
                  {todoCount > 0 && (
                    <Badge variant="default" className="ml-1.5 text-[10px]">
                      {todoCount}
                    </Badge>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTransferOpen(true)}
                  disabled={balance < 1}
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  转账
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDetailOpen(true)}>
                  <ReceiptText className="mr-1.5 h-3.5 w-3.5" />
                  积分明细
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              当前兑换比例：1 积分 = ¥{fmtMoney(yuanPerPoint)}
              {data.config.dailyLimit > 0 && ` · 兑换每日最多 ${data.config.dailyLimit} 次`}
            </CardContent>
          </Card>

          {/* 官方商城：兑换也是其中一张卡 */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">积分商城</h2>
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
                    <CardDescription>兑换</CardDescription>
                    <Badge variant="outline" className="text-[10px]">
                      按比例
                    </Badge>
                  </div>
                  <CardTitle className="text-base">兑换中转站余额</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    1 积分 = ¥{fmtMoney(yuanPerPoint)}，金额自己填，直接充进 AI 中转站余额。
                  </p>
                  {!data.config.enabled ? (
                    <Button disabled variant="outline" className="w-full">
                      兑换暂未开放
                    </Button>
                  ) : !data.bound ? (
                    <Button variant="outline" className="w-full" asChild>
                      <Link to="/dashboard/ai">先去开通中转站</Link>
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={() => {
                        setAmount("")
                        setRedeemOpen(true)
                      }}
                    >
                      立即兑换
                    </Button>
                  )}
                </CardContent>
              </Card>

              {data.products.map((p) => (
                <ProductCard key={p.id} product={p} balance={balance} onBuy={setBuyTarget} />
              ))}
            </div>
          </div>

          {/* 用户们的商城 */}
          <div>
            <div ref={shopTopRef} className="mb-3 flex flex-wrap items-center gap-2 scroll-mt-20">
              <Store className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">用户们的商城</h2>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setMineOpen(true)}>
                  <Package className="mr-1.5 h-3.5 w-3.5" />
                  我的商品
                  {myProducts.length > 0 && ` (${myProducts.length})`}
                </Button>
                <Button size="sm" onClick={openUpload}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  上传商品
                </Button>
              </div>
            </div>

            <p className="mb-3 text-xs text-muted-foreground">
              这些是其他用户上架的东西。你花积分买下，积分先由平台保管，
              卖家发货、你确认收货后才真正转给卖家 —— 你也可以上传自己的东西卖积分。
            </p>

            {userProducts.length === 0 ? (
              <EmptyState
                icon={Store}
                title="还没有人上架商品"
                description="点右上角「上传商品」把你的东西挂上来，别人用积分兑换，积分就归你。"
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

          {/* 我的交易：买的和卖的都在这里处理，入口是「我的积分」卡片上的「我的交易」按钮。
              站长 2026-09-29 反馈「卖家在哪发货、买家在哪收货找不到」——
              原来「我收到的订单」藏在「我的商品」弹窗最底下，得点开再往下滚才看得到。 */}
          <Dialog open={tradeOpen} onOpenChange={setTradeOpen}>
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  我的交易
                  {todoCount > 0 && (
                    <Badge variant="default" className="text-[10px]">
                      {todoCount} 笔待处理
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription>
                  最近 50 笔。「待发货」= 等卖家交付；「待收货」= 卖家交付了，你点确认后积分才转给卖家。
                  消息中心收到的那条通知里也能直接操作。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-5">
                {/* 待你处理：把要动手的事顶到最上面，进来就能点 */}
                {todoCount > 0 && (
                  <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <p className="text-sm font-medium">待你处理</p>
                    <ul className="space-y-2">
                      {sellerOrders
                        .filter((o) => o.status === "pending")
                        .map((o) => (
                          <li key={o.id} className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm">发货 · {o.productName}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                买家 {o.username} · 到账 +{o.price} 积分
                              </p>
                            </div>
                            <Button
                              size="sm"
                              className="shrink-0"
                              onClick={() => void sellerDeliver(o)}
                            >
                              标记已交付
                            </Button>
                          </li>
                        ))}
                      {orders
                        .filter((o) => o.sellerId !== null && o.status === "delivered")
                        .map((o) => (
                          <li key={o.id} className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm">收货 · {o.productName}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                卖家 {o.sellerName ?? "?"} · 已付 {o.price} 积分
                              </p>
                            </div>
                            <Button
                              size="sm"
                              className="shrink-0"
                              onClick={() => void confirmReceipt(o)}
                            >
                              确认收货
                            </Button>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                <div className="space-y-2">
                  <p className="text-sm font-medium">我买到的（{orders.length}）</p>
                  {orders.length === 0 ? (
                    <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                      还没买过东西。
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
                            {isUserOrder ? ` · 卖家 ${o.sellerName ?? "?"}` : ""}
                            {/* 交易双方能互相联系（2026-10-01）：交付方式、催确认收货都靠它 */}
                            {isUserOrder && o.sellerName && (
                              <>
                                {" · "}
                                <Link
                                  to={`/dashboard/dm/${encodeURIComponent(o.sellerName)}`}
                                  className="underline underline-offset-2 hover:text-foreground"
                                >
                                  发私信
                                </Link>
                              </>
                            )}
                            {o.note ? ` · ${o.note}` : ""}
                          </p>
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
                            <Badge variant={st.variant} className="mt-0.5 text-[10px]">
                              {orderStatusText(o.status, isUserOrder)}
                            </Badge>
                          </div>
                          {isUserOrder && o.status === "delivered" && (
                            <Button size="sm" onClick={() => void confirmReceipt(o)}>
                              <Check className="mr-1 h-3.5 w-3.5" />
                              确认收货
                            </Button>
                          )}
                          {renew && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setBuyTarget(renew)}
                              title={
                                expired
                                  ? "已到期，再买一次重新开始计租"
                                  : "再买一次，租期从当前到期时间往后顺延"
                              }
                            >
                              <RefreshCw className="mr-1 h-3.5 w-3.5" />
                              续费
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                    </ul>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">我卖出的（{sellerOrders.length}）</p>
                  {sellerOrders.length === 0 ? (
                    <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                      还没有人买你的东西。上传商品被别人买下后，订单会出现在这里。
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
                              买家 {o.username} · {fmtDateTime(o.createdAt)}
                              {" · "}
                              <Link
                                to={`/dashboard/dm/${encodeURIComponent(o.username)}`}
                                className="underline underline-offset-2 hover:text-foreground"
                              >
                                发私信
                              </Link>
                              {o.note ? ` · ${o.note}` : ""}
                            </p>
                            {rentalOrderText(o) && (
                              <p className="text-xs text-muted-foreground">{rentalOrderText(o)}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-sm font-medium tabular-nums">+{o.price}</span>
                            {o.status === "pending" ? (
                              <Button size="sm" onClick={() => void sellerDeliver(o)}>
                                标记已交付
                              </Button>
                            ) : (
                              <Badge
                                variant={(ORDER_STATUS[o.status] ?? ORDER_STATUS.pending).variant}
                                className="text-[10px]"
                              >
                                {orderStatusText(o.status, true)}
                              </Badge>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* 积分明细 */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>积分明细</DialogTitle>
            <DialogDescription>最近 50 条记录</DialogDescription>
          </DialogHeader>
          {!data || data.transactions.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="还没有积分记录"
              description="参与站内活动、或由管理员发放后，这里会显示每一笔积分的来去。"
            />
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {data.transactions.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{t.detail || REASON_LABEL[t.reason] || t.reason}</p>
                    <p className="text-xs text-muted-foreground">{fmtDateTime(t.createdAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={
                        t.delta > 0
                          ? "text-sm font-medium text-emerald-600 dark:text-emerald-400"
                          : "text-sm font-medium text-muted-foreground"
                      }
                    >
                      {t.delta > 0 ? `+${t.delta}` : t.delta}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {REASON_LABEL[t.reason] ?? t.reason} · 余额 {t.balance}
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
            <DialogTitle>兑换中转站余额</DialogTitle>
            <DialogDescription>
              1 积分 = ¥{fmtMoney(yuanPerPoint)}，兑换后金额直接充进你的 AI 中转站余额。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="redeem-points">使用积分</Label>
              <Input
                id="redeem-points"
                inputMode="numeric"
                placeholder="请输入积分数"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                {points > 0 ? (
                  <>
                    将兑换 <span className="font-medium text-foreground">¥{fmtMoney(yuan)}</span>
                    {points > balance && (
                      <span className="text-destructive">（超过你的积分余额 {balance}）</span>
                    )}
                  </>
                ) : (
                  `输入积分数后自动计算金额（当前余额 ${balance} 积分）`
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
                全部兑换
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRedeemOpen(false)} disabled={redeemBusy}>
              取消
            </Button>
            <Button onClick={() => void handleRedeem()} disabled={!canRedeem}>
              {redeemBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              确认兑换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 转账弹窗：只需转出方确认，不需要对方同意 */}
      <Dialog open={transferOpen} onOpenChange={(o) => !transferBusy && setTransferOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>转账给别人</DialogTitle>
            <DialogDescription>
              填对方的用户名即可，不需要对方确认，转出后立刻到账。请确认用户名没写错 ——
              转账一经发起无法撤回，只能请对方再转回来。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="transfer-to">收款人用户名</Label>
              <Input
                id="transfer-to"
                placeholder="对方的用户名（不是昵称）"
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transfer-amount">转账积分数</Label>
              <Input
                id="transfer-amount"
                inputMode="numeric"
                placeholder="请输入积分数"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value.replace(/\D/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                {transferValue > 0 ? (
                  <>
                    相当于 <span className="font-medium text-foreground">¥{fmtMoney(transferValue * yuanPerPoint)}</span>
                    {transferValue > balance && (
                      <span className="text-destructive">（超过你的积分余额 {balance}）</span>
                    )}
                  </>
                ) : (
                  `当前余额 ${balance} 积分`
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
                全部转出
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTransferOpen(false)}
              disabled={transferBusy}
            >
              取消
            </Button>
            <Button onClick={() => void handleTransfer()} disabled={!canTransfer}>
              {transferBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              确认转账
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 购买弹窗 */}
      <Dialog open={!!buyTarget} onOpenChange={(o) => !o && !buyBusy && setBuyTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {buyTarget?.billingMode === "rental" ? "租用" : "购买"} · {buyTarget?.name}
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
                <span className="text-muted-foreground">卖家</span>
                <span className="font-medium">{buyTarget?.ownerName ?? "—"}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">售价</span>
              <span className="font-medium tabular-nums">
                {buyTarget?.price ?? 0} 积分
                {buyTarget?.billingMode === "rental" ? ` / ${buyTarget.rentalDays} 天` : ""}
              </span>
            </div>
            {buyTarget?.billingMode === "rental" && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">计费方式</span>
                <span className="font-medium">租用 · 到期自动失效</span>
              </div>
            )}
            {buyTarget?.delivery === "quota" && buyTarget.quotaYuan ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">到账金额</span>
                <span className="font-medium tabular-nums">¥{fmtMoney(buyTarget.quotaYuan)}</span>
              </div>
            ) : null}
            {buyTarget?.delivery === "feature" && buyTarget.deliveryParams?.feature ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">开通功能</span>
                <span className="font-medium">
                  {FEATURE_LABELS[buyTarget.deliveryParams.feature]}
                </span>
              </div>
            ) : null}
            {buyTarget?.delivery === "subscription" && buyTarget.deliveryParams?.planId ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">订阅套餐</span>
                <span className="font-medium tabular-nums">
                  #{buyTarget.deliveryParams.planId}
                </span>
              </div>
            ) : null}
            {buyTarget?.delivery === "invite_quota" && buyTarget.deliveryParams?.count ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">邀请码额度</span>
                <span className="font-medium tabular-nums">
                  +{buyTarget.deliveryParams.count} 个
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">购买后余额</span>
              <span className="font-medium tabular-nums">
                {balance - (buyTarget?.price ?? 0)} 积分
              </span>
            </div>
            {buyTargetNeedsBind && (
              <p className="text-xs text-destructive">
                {buyTarget?.delivery === "subscription"
                  ? "该商品会自动开通中转站订阅，你还没有开通中转站。"
                  : "该商品会自动充进 AI 中转站余额，你还没有开通中转站。"}
                <Link to="/dashboard/ai" className="ml-1 underline-offset-4 hover:underline">
                  去开通
                </Link>
              </p>
            )}
            {!buyTargetAffordable && (
              <p className="text-xs text-destructive">积分不足，无法购买。</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuyTarget(null)} disabled={buyBusy}>
              取消
            </Button>
            <Button onClick={() => void handleBuy()} disabled={!canBuy}>
              {buyBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              确认购买
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 我的商品 + 我收到的订单 */}
      <Dialog open={mineOpen} onOpenChange={setMineOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>我的商品</DialogTitle>
            <DialogDescription>
              审核通过后才会出现在「用户们的商城」里；改动过内容会重新进入待审核。
              别人买下后的订单不在这里，去页面上的「我的交易」处理。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">我上架的（{myProducts.length}）</p>
                <Button
                  size="sm"
                  onClick={() => {
                    setMineOpen(false)
                    openUpload()
                  }}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  上传新商品
                </Button>
              </div>

              {myProducts.length === 0 ? (
                <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                  你还没有上架过商品。
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
                              {p.price} 积分
                              {p.billingMode === "rental" ? ` / ${p.rentalDays} 天` : ""} ·{" "}
                              {p.stock === null ? "不限量" : `剩 ${p.stock} 件`}
                              {!p.enabled ? " · 已下架" : ""}
                            </p>
                            {p.reviewStatus === "rejected" && p.reviewNote && (
                              <p className="mt-0.5 text-xs text-destructive">
                                未通过：{p.reviewNote}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant={rv.variant} className="text-[10px]">
                            {rv.label}
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
            <DialogTitle>{editingId ? "编辑我的商品" : "上传我的商品"}</DialogTitle>
            <DialogDescription>
              提交后要等管理员审核通过才会被别人看到。别人买下后积分先由平台保管，
              你发货、他确认收货后积分才到你的账上。也可以设为租用：买家付一次积分用一段时间，
              到期失效（用户商品的到期归还由你和买家自行协商）。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="upName">名称</Label>
              <Input
                id="upName"
                maxLength={40}
                placeholder="如：英国vps一台"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="upDesc">说明（可选）</Label>
              <Textarea
                id="upDesc"
                rows={3}
                maxLength={500}
                placeholder="写清楚是什么、怎么交付（如「加 QQ 发激活码」「站内私信联系」）"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="upImage">封面图（可选）</Label>
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
                  本地上传
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
                placeholder="https://... 或点「本地上传」"
                value={form.imageUrl}
                onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
              />
              {form.imageUrl.trim() && (
                <p className="text-xs text-muted-foreground">
                  填了封面图就以图片为准，下面的图标不会显示（不用特意清空）。
                  本地上传的图存本站网盘，直接粘外链也可以。
                </p>
              )}
            </div>

            <ShopIconPicker
              value={form.icon}
              disabled={formBusy}
              onChange={(slug) => setForm((f) => ({ ...f, icon: slug }))}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="upPrice">售价（积分）</Label>
                <Input
                  id="upPrice"
                  inputMode="numeric"
                  placeholder="如 200"
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="upStock">
                  库存（留空 = 不限
                  {form.billingMode === "rental"
                    ? "；租用商品指「同时最多能租出几份」，到期归还"
                    : ""}
                  ）
                </Label>
                <Input
                  id="upStock"
                  inputMode="numeric"
                  placeholder="不限"
                  value={form.stock}
                  onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
                />
              </div>
            </div>

            {/* 计费方式：买断 / 租用。租用对用户商品是可用的（交付方式固定人工，属于可收回的一类） */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">租用模式</p>
                  <p className="text-xs text-muted-foreground">
                    开启后买家付一次积分用一段时间，到期失效；关闭则是买断（永久拥有）。
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
                  <Label htmlFor="upDays">租期（天）</Label>
                  <Input
                    id="upDays"
                    inputMode="numeric"
                    placeholder="如 30"
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
                        {d} 天
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">上架</p>
                <p className="text-xs text-muted-foreground">
                  关掉相当于暂时下架，别人看不到，但商品还在。
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={formBusy}>
              取消
            </Button>
            <Button onClick={() => void submitUpload()} disabled={formBusy}>
              {formBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {editingId ? "保存" : "提交审核"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
