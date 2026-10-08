import * as React from "react"
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Coins,
  Gift,
  Loader2,
  Upload,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Store,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ShopIconPicker } from "@/components/shop-icon-picker"
import { adminPointsApi, errMsg, pointsApi, HttpError } from "@/services/api"
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from "@/types"
import { fmtDateTime, fmtUid } from "@/lib/format"
import { notifyAttentionChanged } from "@/lib/attention-events"
import { shopIcon } from "@/lib/shop-icons"
import { FEATURE_LABELS } from "@/types"
import { useT, tStatic } from "@/i18n"
import type {
  AdminPointsOverview,
  AdminPointsUser,
  AfterSaleStatus,
  AdminShopData,
  DonationRewardItem,
  FeatureKey,
  InvitePointsConfig,
  PointBillingMode,
  PointDelivery,
  PointDeliveryParams,
  PointOrder,
  PointProduct,
  PointProductPayload,
  PointTransaction,
} from "@/types"

/** 交付方式 → 短标签（按钮上显示） */
const DELIVERY_LABELS: Record<PointDelivery, string> = {
  manual: "pt.delivery.manual",
  quota: "ap.dlv.quota",
  feature: "ap.dlv.feature",
  subscription: "ap.dlv.subscription",
  invite_quota: "ap.dlv.inviteQuota",
  checkin_makeup: "ap.dlv.checkinMakeup",
  code: "ap.dlv.code",
  content: "ap.dlv.content",
}

/** 交付方式 → 一句话说明（选中后显示在按钮下方） */
const DELIVERY_HINTS: Record<PointDelivery, string> = {
  manual: "ap.hint.manual",
  quota: "ap.hint.quota",
  feature: "ap.hint.feature",
  subscription: "ap.hint.subscription",
  invite_quota: "ap.hint.inviteQuota",
  checkin_makeup: "ap.hint.checkinMakeup",
  code: "ap.hint.code",
  content: "ap.hint.content",
}

/** 交付方式 → 商品表 / 订单表里的展示文案 */
function deliveryText(delivery: string, quotaYuan?: number | null): string {
  if (delivery === "quota") return tStatic("ap.dlv.quotaShort", { v: fmtMoney(quotaYuan ?? 0) })
  return tStatic(DELIVERY_LABELS[delivery as PointDelivery] ?? "pt.delivery.manual")
}

/** 全部模块（下拉框选项顺序） */
const FEATURE_KEYS: FeatureKey[] = ["ai", "r2", "frp", "proxy"]

/** 流水来源 → 标签 */
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

/** 订单状态 → 标签（用户商品订单的 pending/delivered 含义不同，用 orderStatusText 区分） */
const ORDER_STATUS: Record<string, { label: string; variant: "default" | "outline" | "secondary" | "success" }> = {
  pending: { label: "pt.status.pending", variant: "default" },
  delivered: { label: "pt.status.delivered", variant: "outline" },
  settled: { label: "pt.status.settled", variant: "success" },
  cancelled: { label: "pt.status.cancelled", variant: "secondary" },
}

/**
 * 订单状态的展示文案。
 *
 * 用户商品订单走**担保**：pending = 等卖家交付（积分托管中）、
 * delivered = 卖家已交付、等买家确认。和官方商品的「待发放 / 已发放」不是一回事，
 * 混着显示会让管理员以为要自己去点「发放」。
 */
function orderStatusText(status: string, isUserOrder: boolean): string {
  if (isUserOrder) {
    if (status === "pending") return "pt.status.awaitSeller"
    if (status === "delivered") return "ap.status.awaitBuyer"
  }
  return ORDER_STATUS[status]?.label ?? status
}

/** 售后状态 → 展示标签（与用户端 points.tsx 的定义保持一致） */
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

/** 用户商品的审核状态 → 标签 */
const REVIEW_STATUS: Record<
  string,
  { label: string; variant: "default" | "outline" | "secondary" | "destructive" | "success" }
> = {
  pending: { label: "pt.review.pending", variant: "default" },
  approved: { label: "ap.review.approved", variant: "success" },
  rejected: { label: "ap.review.rejected", variant: "destructive" },
}

/** 金额展示：整数不带小数，非整数保留两位 */
function fmtMoney(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** 捐献奖励清单 → 输入框草稿（key → 字符串；输入框里必须是字符串） */
function draftOf(items: DonationRewardItem[]): Record<string, string> {
  return Object.fromEntries(items.map((d) => [d.key, String(d.points)]))
}

/**
 * 允许「租用」的交付方式。
 *
 * `quota`（自动充余额）与 `invite_quota`（邀请码额度）是**一次性消耗品**，
 * 发出去就收不回来，租用没有意义 —— 后端会直接拒绝（错误码 RENTAL_NOT_SUPPORTED），
 * 这里同步把它们置灰，免得管理员填完才被打回。
 */
const RENTAL_DELIVERIES: readonly PointDelivery[] = ["manual", "feature", "subscription"]

/** 租期展示：如「租用 30 天」 */
function rentalTerm(days: number | null | undefined): string {
  return days && days > 0 ? tStatic("pt.rental.term", { n: days }) : tStatic("pt.rental.rental")
}

/** 租用订单是否已到期 */
function isRentalExpired(o: PointOrder): boolean {
  if (!o.expiresAt) return false
  const t = new Date(o.expiresAt).getTime()
  return !Number.isNaN(t) && t <= Date.now()
}

/**
 * 订单的租期说明（管理端展示）：
 *   未交付 → 「租用 N 天（未起算）」；已交付 → 「至 X」；已到期 → 「已到期（X）」；
 *   到期但已收回 → 追加「已收回」。
 */
function rentalOrderText(o: PointOrder): string | null {
  if (o.billingMode !== "rental") return null
  if (!o.expiresAt) return tStatic("ap.rental.notStarted", { term: rentalTerm(o.rentalDays) })
  const time = fmtDateTime(o.expiresAt)
  if (isRentalExpired(o)) {
    return tStatic("ap.rental.expired", {
      time,
      note: o.expireHandledAt ? tStatic("ap.rental.reclaimed") : tStatic("ap.rental.pendingHandle"),
    })
  }
  return tStatic("ap.rental.until", { time })
}

/** 租期快捷值（天） */
const RENTAL_DAY_PRESETS = [7, 30, 90, 365] as const

/**
 * 管理面板「积分」标签。
 *
 * 单独放一个文件而不是塞进 admin.tsx：那个文件已 8000+ 行，且常有别的改动
 * 同时动它（同 admin-feedback.tsx / admin-audit.tsx 的处理）。
 *
 * 两个分类（2026-09-28 站长要求，参照「邀请码」页的已使用/未使用分页）：
 *   · 商城 —— 兑换配置 + 商品管理 + 订单发放
 *   · 成员 —— 用户积分总览、手动发放/扣减、查流水
 *
 * 「活动发积分」在「活动」标签里配，不在这里 —— 两处都能发会让权限与审计变乱。
 */
export function PointsAdminPanel() {
  const { t } = useT()
  const [tab, setTab] = React.useState("shop")

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("ap.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("ap.desc")}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        {/* h-auto + flex-wrap：移动端窄屏放不下时换行，而不是横向溢出屏幕外 */}
        <TabsList className="h-auto max-w-full flex-wrap">
          <TabsTrigger value="shop" className="gap-1.5">
            <ShoppingBag className="h-3.5 w-3.5" />
            {t("ap.tab.shop")}
          </TabsTrigger>
          <TabsTrigger value="members" className="gap-1.5">
            <Users className="h-3.5 w-3.5" />
            {t("ap.tab.members")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="shop">
          <ShopTab />
        </TabsContent>
        <TabsContent value="members">
          <MembersTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------- 商城

interface FormState {
  name: string
  description: string
  imageUrl: string
  /** 内置图标 slug；空串 = 没选 */
  icon: string
  /** 分类：it / other（2026-10-01 加） */
  category: ProductCategory
  price: string
  stock: string
  /** 每日限量（自然日）；空 = 不限 */
  dailyLimit: string
  /** 是否公示这件商品的购买记录（买家用户名 + 下单时间，最近 10 条） */
  showPurchases: boolean
  perUserLimit: string
  delivery: PointDelivery
  /** delivery='quota' 时每件充入多少元 */
  quotaYuan: string
  /** delivery='feature' 时授予哪个模块 */
  feature: FeatureKey
  /** delivery='subscription' 时的套餐 ID（管理员自己填） */
  planId: string
  /** delivery='invite_quota' 时增加的额度 */
  inviteCount: string
  /** delivery='content' 时人人相同的固定发放内容（网盘链接 / 说明 / 通用兑换码） */
  content: string
  /** 计费方式：买断 / 租用 */
  billingMode: PointBillingMode
  /** 租期天数（字符串，空 = 未填）；买断时忽略 */
  rentalDays: string
  enabled: boolean
  sort: string
}

function emptyForm(): FormState {
  return {
    name: "",
    description: "",
    imageUrl: "",
    icon: "",
    category: "other",
    price: "",
    stock: "",
    dailyLimit: "",
    showPurchases: false,
    perUserLimit: "",
    delivery: "manual",
    quotaYuan: "",
    feature: "ai",
    planId: "",
    inviteCount: "1",
    content: "",
    billingMode: "one_time",
    rentalDays: "",
    enabled: true,
    sort: "0",
  }
}

function formOf(p: PointProduct): FormState {
  return {
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl ?? "",
    icon: p.icon ?? "",
    category: p.category ?? "other",
    price: String(p.price),
    stock: p.stock === null ? "" : String(p.stock),
    dailyLimit: p.dailyLimit === null || p.dailyLimit === undefined ? "" : String(p.dailyLimit),
    showPurchases: p.showPurchases === true,
    perUserLimit: p.perUserLimit === null ? "" : String(p.perUserLimit),
    delivery: p.delivery,
    quotaYuan: p.quotaYuan === null ? "" : String(p.quotaYuan),
    feature: (p.deliveryParams?.feature as FeatureKey) ?? "ai",
    planId: p.deliveryParams?.planId === undefined ? "" : String(p.deliveryParams.planId),
    inviteCount:
      p.deliveryParams?.count === undefined ? "1" : String(p.deliveryParams.count),
    content: p.deliveryParams?.content ?? "",
    billingMode: p.billingMode,
    rentalDays: p.rentalDays === null ? "" : String(p.rentalDays),
    enabled: p.enabled,
    sort: String(p.sort),
  }
}

/** 表单 → 提交体。留空的数值字段一律传 null（后端语义：不限） */
function payloadOf(f: FormState): PointProductPayload {
  // 只带当前交付方式用得上的那个参数 —— 免得切来切去时把上一种方式的
  // 残留值一起提交上去（后端也会按 delivery 忽略不匹配的字段，两边都干净）
  let deliveryParams: PointDeliveryParams | null = null
  if (f.delivery === "feature") deliveryParams = { feature: f.feature }
  else if (f.delivery === "subscription") {
    deliveryParams = { planId: Math.trunc(Number(f.planId) || 0) }
  } else if (f.delivery === "invite_quota") {
    deliveryParams = { count: Math.trunc(Number(f.inviteCount) || 0) }
  } else if (f.delivery === "checkin_makeup") {
    deliveryParams = { count: Math.trunc(Number(f.inviteCount) || 0) }
  } else if (f.delivery === "content") {
    deliveryParams = { content: f.content }
  }

  const isRental = f.billingMode === "rental"
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    imageUrl: f.imageUrl.trim() || null,
    category: f.category,
    icon: f.icon.trim() || null,
    price: Math.trunc(Number(f.price) || 0),
    stock: f.stock.trim() === "" ? null : Math.trunc(Number(f.stock) || 0),
    dailyLimit: f.dailyLimit.trim() === "" ? null : Math.trunc(Number(f.dailyLimit) || 0),
    showPurchases: f.showPurchases,
    perUserLimit: f.perUserLimit.trim() === "" ? null : Math.trunc(Number(f.perUserLimit) || 0),
    delivery: f.delivery,
    quotaYuan: f.delivery === "quota" ? Number(f.quotaYuan) || 0 : null,
    deliveryParams,
    billingMode: f.billingMode,
    rentalDays: isRental ? Math.trunc(Number(f.rentalDays) || 0) : null,
    enabled: f.enabled,
    sort: Math.trunc(Number(f.sort) || 0),
  }
}

/** 卡密池管理（delivery='code'，用户反馈 a977d1cf）：只在编辑已存在的商品时出现 */
function CodeManager({ productId }: { productId: string }) {
  const { t } = useT()
  const [info, setInfo] = React.useState<{
    total: number
    used: number
    available: number
  } | null>(null)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setInfo(await adminPointsApi.getProductCodes(productId))
    } catch (err) {
      toast.error(errMsg(err, t("ap.codes.loadFailed")))
    }
  }, [productId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    const codes = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (codes.length === 0) return
    setBusy(true)
    try {
      const r = await adminPointsApi.addProductCodes(productId, codes)
      toast.success(t("ap.codes.added", { n: r.added, avail: r.available }))
      setText("")
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("ap.codes.addFailed")))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!confirm(t("ap.codes.confirmClear"))) return
    setBusy(true)
    try {
      const r = await adminPointsApi.clearProductCodes(productId)
      toast.success(t("ap.codes.cleared", { n: r.removed }))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("ap.codes.clearFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <Label>{t("ap.codes.title")}</Label>
        {info && (
          <span className="text-xs text-muted-foreground">
            {t("ap.codes.stats", { avail: info.available, used: info.used, total: info.total })}
          </span>
        )}
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={t("ap.codes.placeholder")}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void add()} disabled={busy || !text.trim()}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t("ap.codes.add")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void clear()} disabled={busy}>
          {t("ap.codes.clear")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("ap.codes.hint")}</p>
    </div>
  )
}

/** 商品列表里的小缩略图：有封面图用图，否则用图标（和用户端卡片的优先级一致） */
function ProductThumb({ product }: { product: PointProduct }) {
  if (product.imageUrl) {
    return (
      <img
        src={product.imageUrl}
        alt=""
        loading="lazy"
        className="h-9 w-9 shrink-0 rounded-md border object-cover"
      />
    )
  }
  const Icon = shopIcon(product.icon)
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
      <Icon className="h-4 w-4 text-primary" />
    </span>
  )
}

function ShopTab() {
  const { t } = useT()
  const [data, setData] = React.useState<AdminShopData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [orderStatus, setOrderStatus] = React.useState("pending")

  // 发放弹窗
  const [deliverTarget, setDeliverTarget] = React.useState<PointOrder | null>(null)
  const [deliverNote, setDeliverNote] = React.useState("")
  const [deliverBusy, setDeliverBusy] = React.useState(false)

  // 用户商品审核弹窗
  const [reviewTarget, setReviewTarget] = React.useState<PointProduct | null>(null)
  const [reviewApprove, setReviewApprove] = React.useState(true)
  const [reviewNote, setReviewNote] = React.useState("")
  const [reviewBusy, setReviewBusy] = React.useState(false)

  // 兑换配置（比例语义：每 1 积分 = ? 元）
  const [cfgEnabled, setCfgEnabled] = React.useState(true)
  const [cfgRatio, setCfgRatio] = React.useState("1")
  const [cfgDaily, setCfgDaily] = React.useState("5")
  /** 用户商城：卖家交付后多少天自动确认收货（0 = 关闭） */
  const [cfgAutoConfirm, setCfgAutoConfirm] = React.useState("7")
  const [cfgBusy, setCfgBusy] = React.useState(false)
  /** 「兑换中转站余额」这一行的编辑弹窗 */
  const [redeemOpen, setRedeemOpen] = React.useState(false)

  // 捐献奖励：档位清单（服务端下发，带中文名与固定顺序）+ 输入框草稿（key → 字符串）
  const [donationList, setDonationList] = React.useState<DonationRewardItem[]>([])
  const [donationDraft, setDonationDraft] = React.useState<Record<string, string>>({})
  /** 每人每日发放次数上限草稿（0 = 不限） */
  const [donationDaily, setDonationDaily] = React.useState("10")
  const [donationOpen, setDonationOpen] = React.useState(false)
  const [donationBusy, setDonationBusy] = React.useState(false)

  // 邀请奖励 / 返佣（编辑入口：商城 → 「邀请奖励」）
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteBusy, setInviteBusy] = React.useState(false)
  const [inviteForm, setInviteForm] = React.useState<InvitePointsConfig>({
    enabled: false,
    perFriend: 20,
    commissionPercent: 10,
    dailyLimit: 0,
    requireConsumed: true,
  })

  // 商品弹窗
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<FormState>(emptyForm())
  const [formBusy, setFormBusy] = React.useState(false)

  // 封面图直传（2026-10-01）：与用户端共用同一个接口，传完把 URL 填进 imageUrl
  const [coverUploading, setCoverUploading] = React.useState(false)
  const coverInputRef = React.useRef<HTMLInputElement | null>(null)

  // ---- 售后（客服介入）----
  // 买家申请退款后：有卖家的先在卖家那一步（requested），卖家拒绝或被申请介入后到这里。
  // 官方商品订单没有卖家，一申请就直接进 platform。
  const [afterSales, setAfterSales] = React.useState<PointOrder[]>([])
  const [afterSaleLoading, setAfterSaleLoading] = React.useState(true)
  /** "platform"（待处理，默认）| "all"（全部有售后记录的）| 具体状态值 */
  const [afterSaleFilter, setAfterSaleFilter] = React.useState("platform")
  const [resolveTarget, setResolveTarget] = React.useState<{
    order: PointOrder
    approve: boolean
  } | null>(null)
  const [resolveNote, setResolveNote] = React.useState("")
  const [resolveBusy, setResolveBusy] = React.useState(false)

  const loadAfterSales = React.useCallback(async (status: string) => {
    setAfterSaleLoading(true)
    try {
      const res = await adminPointsApi.afterSales(status)
      setAfterSales(res.orders)
    } catch (err) {
      // 售后列表拉不到不该让整页白屏：报一条 toast、按空处理
      toast.error(errMsg(err, t("ap.err.loadAfterSales")))
      setAfterSales([])
    } finally {
      setAfterSaleLoading(false)
    }
  }, [])
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

  const load = React.useCallback(
    async (opts?: { keepConfig?: boolean }) => {
      setLoading(true)
      try {
        const res = await adminPointsApi.shop(orderStatus === "all" ? undefined : orderStatus)
        setData(res)
        // 只有首次加载才把配置灌进输入框，免得用户正在改比例时被后台刷新覆盖
        if (!opts?.keepConfig) {
          setCfgEnabled(res.config.enabled)
          setCfgRatio(String(res.config.yuanPerPoint))
          setCfgDaily(String(res.config.dailyLimit))
          setCfgAutoConfirm(String(res.config.autoConfirmDays ?? 7))
          // `?? []` 是防御性的：老版本后端不下发这个字段，直接 .map 会让整页白屏
          setDonationList(res.donationRewards ?? [])
          setDonationDraft(draftOf(res.donationRewards ?? []))
          setDonationDaily(String(res.donationDailyLimit ?? 0))
          // 老版本后端不下发这个字段 —— 缺了就保留默认值，别让整页白屏
          if (res.inviteConfig) setInviteForm(res.inviteConfig)
        }
      } catch (err) {
        toast.error(errMsg(err, t("ap.err.loadShop")))
      } finally {
        setLoading(false)
      }
    },
    [orderStatus]
  )

  React.useEffect(() => {
    void load()
  }, [load])

  // 售后列表单独加载：它有自己的筛选，不该被订单筛选带着一起重查
  React.useEffect(() => {
    void loadAfterSales(afterSaleFilter)
  }, [afterSaleFilter, loadAfterSales])

  /**
   * 提交客服判定。
   * 同意退款时后端会：已结算的先从卖家收益里扣回 → 退买家 → 还库存 → 收权限。
   * 卖家积分不够会报错并提示先在「成员」里调整 —— 这里照原样把报错给管理员看。
   */
  const submitResolve = async () => {
    const tgt = resolveTarget
    if (!tgt) return
    setResolveBusy(true)
    try {
      await adminPointsApi.resolveAfterSale(
        tgt.order.id,
        tgt.approve,
        resolveNote.trim() || undefined
      )
      toast.success(t(tgt.approve ? "ap.toast.afterSaleApproved" : "ap.toast.afterSaleRejected"))
      setResolveTarget(null)
      setResolveNote("")
      await Promise.all([loadAfterSales(afterSaleFilter), load({ keepConfig: true })])
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.afterSale")))
    } finally {
      setResolveBusy(false)
    }
  }

  const saveConfig = async () => {
    const ratio = Number(cfgRatio)
    if (!Number.isFinite(ratio) || ratio <= 0) {
      toast.error(t("ap.err.ratePositive"))
      return
    }
    const daily = Math.trunc(Number(cfgDaily))
    if (!Number.isFinite(daily) || daily < 0) {
      toast.error(t("ap.err.dailyLimitNegative"))
      return
    }
    const autoConfirm = Math.trunc(Number(cfgAutoConfirm))
    if (!Number.isFinite(autoConfirm) || autoConfirm < 0 || autoConfirm > 90) {
      toast.error(t("ap.err.autoConfirmRange"))
      return
    }
    setCfgBusy(true)
    try {
      const res = await adminPointsApi.saveConfig({
        enabled: cfgEnabled,
        yuanPerPoint: ratio,
        dailyLimit: daily,
        autoConfirmDays: autoConfirm,
      })
      toast.success(t("ap.toast.rateSaved", { v: fmtMoney(res.config.yuanPerPoint) }))
      setRedeemOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.save")))
    } finally {
      setCfgBusy(false)
    }
  }

  /**
   * 保存捐献奖励积分。
   *
   * 一次提交**全部档位**（而不是只提交改过的）：档位只有 7 个，整体提交语义最清楚，
   * 也避免「管理员改了 A 档、B 档的输入框里是脏值却没提交」这种半保存状态。
   */
  const saveDonationRewards = async () => {
    const payload: Record<string, number> = {}
    for (const item of donationList) {
      const n = Math.trunc(Number(donationDraft[item.key]))
      if (!Number.isFinite(n) || n < 0 || n > 100_000) {
        toast.error(t("ap.err.donationPointsRange", { label: item.label }))
        return
      }
      payload[item.key] = n
    }
    if (Object.keys(payload).length === 0) {
      toast.error(t("ap.err.noTiers"))
      return
    }
    const daily = Math.trunc(Number(donationDaily))
    if (!Number.isFinite(daily) || daily < 0 || daily > 1000) {
      toast.error(t("ap.err.dailyTimesRange"))
      return
    }
    setDonationBusy(true)
    try {
      const res = await adminPointsApi.saveConfig({
        donationRewards: payload,
        donationDailyLimit: daily,
      })
      setDonationList(res.donationRewards ?? [])
      setDonationDraft(draftOf(res.donationRewards ?? []))
      setDonationDaily(String(res.donationDailyLimit ?? daily))
      toast.success(t("ap.toast.donationSaved"))
      setDonationOpen(false)
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.save")))
    } finally {
      setDonationBusy(false)
    }
  }

  /** 保存邀请奖励 / 返佣配置 */
  const saveInviteRewards = async () => {
    const perFriend = Math.trunc(Number(inviteForm.perFriend))
    if (!Number.isFinite(perFriend) || perFriend < 0 || perFriend > 100_000) {
      toast.error(t("ap.err.invitePointsRange"))
      return
    }
    const pct = Number(inviteForm.commissionPercent)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error(t("ap.err.commissionRange"))
      return
    }
    const daily = Math.trunc(Number(inviteForm.dailyLimit))
    if (!Number.isFinite(daily) || daily < 0 || daily > 1_000_000) {
      toast.error(t("ap.err.inviteDailyRange"))
      return
    }
    setInviteBusy(true)
    try {
      const res = await adminPointsApi.saveConfig({
        invitePoints: { ...inviteForm, perFriend, commissionPercent: pct, dailyLimit: daily },
      })
      if (res.inviteConfig) setInviteForm(res.inviteConfig)
      toast.success(t("ap.toast.inviteSaved"))
      setInviteOpen(false)
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.save")))
    } finally {
      setInviteBusy(false)
    }
  }

  /**
   * 内置行「兑换中转站余额」的上架 / 下架。
   *
   * 直接用服务端当前值提交，而不是读表单 state —— 否则用户改了比例没保存，
   * 点一下「下架」会连比例一起写进去，属于静默改数据。
   */
  const toggleRedeemEnabled = async () => {
    const cfg = data?.config
    if (!cfg) return
    try {
      await adminPointsApi.saveConfig({
        enabled: !cfg.enabled,
        yuanPerPoint: cfg.yuanPerPoint,
        dailyLimit: cfg.dailyLimit,
      })
      toast.success(cfg.enabled ? t("ap.toast.redeemUnlisted") : t("ap.toast.redeemListed"))
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.op")))
    }
  }

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm())
    setDialogOpen(true)
  }

  const openEdit = (p: PointProduct) => {
    setEditingId(p.id)
    setForm(formOf(p))
    setDialogOpen(true)
  }

  const submitForm = async () => {
    const payload = payloadOf(form)
    if (!payload.name) {
      toast.error(t("pt.err.nameRequired"))
      return
    }
    if (payload.price < 1) {
      toast.error(t("pt.err.priceInvalid"))
      return
    }
    if (payload.delivery === "quota" && !(Number(payload.quotaYuan) > 0)) {
      toast.error(t("ap.err.quotaYuanRequired"))
      return
    }
    if (payload.delivery === "subscription" && !(Number(payload.deliveryParams?.planId) > 0)) {
      toast.error(t("ap.err.planIdRequired"))
      return
    }
    if (payload.delivery === "invite_quota" && !(Number(payload.deliveryParams?.count) > 0)) {
      toast.error(t("ap.err.inviteCountRequired"))
      return
    }
    if (payload.delivery === "checkin_makeup" && !(Number(payload.deliveryParams?.count) > 0)) {
      toast.error(t("ap.err.makeupCountRequired"))
      return
    }
    if (payload.delivery === "content" && !payload.deliveryParams?.content?.trim()) {
      toast.error(t("ap.err.contentRequired"))
      return
    }
    if (payload.billingMode === "rental") {
      if (!(Number(payload.rentalDays) > 0)) {
        toast.error(t("ap.err.rentalDaysRequired"))
        return
      }
      if (!RENTAL_DELIVERIES.includes(payload.delivery)) {
        toast.error(t("ap.err.rentalNotSupported"))
        return
      }
    }
    setFormBusy(true)
    try {
      if (editingId) {
        await adminPointsApi.updateProduct(editingId, payload)
        toast.success(t("ap.toast.productUpdated"))
      } else {
        await adminPointsApi.createProduct(payload)
        toast.success(t("ap.toast.productCreated"))
      }
      setDialogOpen(false)
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.saveProduct")))
    } finally {
      setFormBusy(false)
    }
  }

  const toggleEnabled = async (p: PointProduct) => {
    try {
      await adminPointsApi.updateProduct(p.id, { ...payloadOf(formOf(p)), enabled: !p.enabled })
      toast.success(p.enabled ? t("ap.delisted") : t("ap.listed"))
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.op")))
    }
  }

  const removeProduct = async (p: PointProduct) => {
    if (!confirm(t("ap.confirm.deleteProduct", { name: p.name }))) return
    try {
      await adminPointsApi.deleteProduct(p.id)
      toast.success(t("pt.toast.deleted"))
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.delete")))
    }
  }

  const submitDeliver = async () => {
    if (!deliverTarget) return
    setDeliverBusy(true)
    try {
      await adminPointsApi.deliverOrder(deliverTarget.id, deliverNote.trim() || undefined)
      toast.success(t("ap.toast.markedDelivered"))
      setDeliverTarget(null)
      await load({ keepConfig: true })
      notifyAttentionChanged() // 订单已不参与角标（2026-10-03），保留调用以备恢复
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.op")))
    } finally {
      setDeliverBusy(false)
    }
  }

  // ---- 用户商品审核 ----

  const openReview = (p: PointProduct, approve: boolean) => {
    setReviewTarget(p)
    setReviewApprove(approve)
    setReviewNote("")
  }

  const submitReview = async () => {
    if (!reviewTarget) return
    setReviewBusy(true)
    try {
      await adminPointsApi.reviewProduct(
        reviewTarget.id,
        reviewApprove,
        reviewNote.trim() || undefined
      )
      toast.success(reviewApprove ? t("ap.toast.reviewApproved") : t("ap.review.rejected"))
      setReviewTarget(null)
      await load({ keepConfig: true })
      notifyAttentionChanged() // 待审核商品角标当场减一
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.review")))
    } finally {
      setReviewBusy(false)
    }
  }

  const removeUserProduct = async (p: PointProduct) => {
    if (
      !confirm(
        t("ap.confirm.deleteUserProduct", { name: p.name, seller: p.ownerName ?? "?" })
      )
    )
      return
    try {
      await adminPointsApi.deleteProduct(p.id)
      toast.success(t("pt.toast.deleted"))
      await load({ keepConfig: true })
      notifyAttentionChanged() // 若删的是待审核商品，角标当场减一
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.delete")))
    }
  }

  // ---- 用户商品订单：结算 / 退款 ----

  const settleOrder = async (o: PointOrder) => {
    if (
      !confirm(
        t("ap.confirm.settle", { price: o.price, seller: o.sellerName ?? "?" })
      )
    )
      return
    try {
      await adminPointsApi.settleOrder(o.id)
      toast.success(t("ap.toast.settled"))
      await load({ keepConfig: true })
      notifyAttentionChanged()
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.settle")))
    }
  }

  const cancelOrder = async (o: PointOrder) => {
    const extra =
      o.status === "settled" ? t("ap.cancelExtraSettled", { n: o.price }) : ""
    const reason = prompt(
      t("ap.cancelOrderMessage", {
        name: o.productName,
        price: o.price,
        user: o.username,
        extra,
      }),
      ""
    )
    if (reason === null) return
    try {
      await adminPointsApi.cancelOrder(o.id, reason.trim() || undefined)
      toast.success(t("ap.toast.cancelled"))
      await load({ keepConfig: true })
      notifyAttentionChanged()
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.cancel")))
    }
  }

  const products = data?.products ?? []
  const userProducts = data?.userProducts ?? []
  const orders = data?.orders ?? []
  const pendingReviews = userProducts.filter((p) => p.reviewStatus === "pending").length

  return (
    <div className="space-y-4">
      {/* 商品 —— 「兑换中转站余额」不再单独占一块卡片，它就是下面表里的第一行内置商品 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("ap.officialProducts")}</CardTitle>
            <CardDescription>{t("ap.officialProductsDesc")}</CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDonationDraft(draftOf(donationList))
                setDonationDaily(String(data?.donationDailyLimit ?? 0))
                setDonationOpen(true)
              }}
              disabled={loading}
            >
              <Gift className="mr-1.5 h-3.5 w-3.5" />
              {t("ap.donationRewards")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInviteOpen(true)}
              disabled={loading}
            >
              <Users className="mr-1.5 h-3.5 w-3.5" />
              {t("ap.inviteRewards")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load({ keepConfig: true })} disabled={loading}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("ap.newProduct")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <LoadingBlock variant="list" />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="table-actions-sticky w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.product")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("pt.priceLabel")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.stock")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.limit")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.billing")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.delivery")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.status")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("ap.th.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {/*
                    内置商品行：兑换中转站余额。
                    它**不是** point_products 里的一条记录（金额由用户自选，走 redeemPoints()），
                    所以没有删除按钮、也不会售罄；「下架」就是关掉 points_enabled。
                  */}
                  <tr className="border-t bg-primary/5">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
                          <Wallet className="h-4 w-4 text-primary" />
                        </span>
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 font-medium">
                            {t("pt.redeemBalance")}
                            <Badge variant="outline" className="text-[10px]">
                              {t("ap.builtin")}
                            </Badge>
                          </p>
                          <p className="max-w-xs text-xs text-muted-foreground">
                            {t("ap.redeemRowDesc")}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <p className="tabular-nums">
                        {t("ap.rateLine", { v: fmtMoney(data?.config.yuanPerPoint ?? 1) })}
                      </p>
                      <p className="text-xs text-muted-foreground">{t("ap.amountFree")}</p>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{t("pt.form.unlimited")}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {(data?.config.dailyLimit ?? 0) > 0
                        ? t("ap.timesPerDay", { n: data?.config.dailyLimit ?? 0 })
                        : t("pt.form.unlimited")}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{t("ap.oneTime")}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{t("ap.dlv.quota")}</td>
                    <td className="px-3 py-2">
                      {data?.config.enabled ? (
                        <Badge variant="success" className="text-[10px]">
                          {t("ap.listed")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          {t("ap.delisted")}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setCfgEnabled(data?.config.enabled ?? true)
                            setCfgRatio(String(data?.config.yuanPerPoint ?? 1))
                            setCfgDaily(String(data?.config.dailyLimit ?? 0))
                            setRedeemOpen(true)
                          }}
                        >
                          <Pencil className="mr-1 h-3.5 w-3.5" />
                          {t("common.edit")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void toggleRedeemEnabled()}>
                          {data?.config.enabled ? t("ap.unlist") : t("ap.list")}
                        </Button>
                      </div>
                    </td>
                  </tr>

                  {products.length === 0 && (
                    <tr className="border-t">
                      <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        {t("ap.noOfficialProducts")}
                      </td>
                    </tr>
                  )}

                  {products.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2.5">
                          <ProductThumb product={p} />
                          <div className="min-w-0">
                            <p className="font-medium">{p.name}</p>
                            {p.description && (
                              <p className="max-w-xs truncate text-xs text-muted-foreground">
                                {p.description}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{t("pt.pointsUnit", { n: p.price })}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {p.stock === null ? t("pt.form.unlimited") : p.stock}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {p.perUserLimit === null
                          ? t("pt.form.unlimited")
                          : t("ap.perUserUnit", { n: p.perUserLimit })}
                      </td>
                      <td className="px-3 py-2">
                        {p.billingMode === "rental" ? (
                          <Badge variant="secondary" className="text-[10px]">
                            <CalendarClock className="mr-0.5 h-2.5 w-2.5" />
                            {rentalTerm(p.rentalDays)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("ap.oneTime")}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {deliveryText(p.delivery, p.quotaYuan)}
                      </td>
                      <td className="px-3 py-2">
                        {p.enabled ? (
                          <Badge variant="success" className="text-[10px]">
                            {t("ap.listed")}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            {t("ap.delisted")}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                            <Pencil className="mr-1 h-3.5 w-3.5" />
                            {t("common.edit")}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void toggleEnabled(p)}>
                            {p.enabled ? t("ap.unlist") : t("ap.list")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void removeProduct(p)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 用户上架的商品 —— 审核通过后才会出现在用户端的「用户们的商城」里 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Store className="h-4 w-4" />
              {t("ap.userProducts")}
              {pendingReviews > 0 && (
                <Badge variant="default" className="text-[10px]">
                  {t("ap.pendingReviewBadge", { n: pendingReviews })}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>{t("ap.userProductsDesc")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load({ keepConfig: true })} disabled={loading}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("common.refresh")}
          </Button>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <LoadingBlock variant="list" />
          ) : userProducts.length === 0 ? (
            <EmptyState
              icon={Store}
              title={t("ap.userProductsEmpty")}
              description={t("ap.userProductsEmptyDesc")}
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {/* 卡片而不是表格（2026-10-01 站长反馈：表格列多，横向滚动后
                  商品信息和「通过 / 拒绝」没法同时看到，信息也展示不全）。
                  两列自适应、窄屏单列，永不横向滚动。 */}
              {userProducts.map((p) => {
                const rv = REVIEW_STATUS[p.reviewStatus] ?? REVIEW_STATUS.pending
                return (
                  <div key={p.id} className="flex flex-col gap-3 rounded-lg border p-3">
                    <div className="flex items-start gap-3">
                      <ProductThumb product={p} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-medium">{p.name}</span>
                          <Badge variant={rv.variant} className="text-[10px]">
                            {t(rv.label)}
                          </Badge>
                          {!p.enabled && (
                            <Badge variant="outline" className="text-[10px]">
                              {t("ap.delisted")}
                            </Badge>
                          )}
                        </div>
                        {p.description && (
                          <p className="mt-1 line-clamp-2 break-all text-xs text-muted-foreground">
                            {p.description}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {t("pt.sellerLabel")}{" "}
                        <span className="text-foreground">{p.ownerName ?? "—"}</span>
                      </span>
                      <span>
                        {t(PRODUCT_CATEGORY_LABELS[p.category] ?? PRODUCT_CATEGORY_LABELS.other)}
                      </span>
                      <span className="tabular-nums">{t("pt.pointsUnit", { n: p.price })}</span>
                      <span className="tabular-nums">
                        {t("ap.th.stock")} {p.stock === null ? t("pt.form.unlimited") : p.stock}
                      </span>
                      {p.billingMode === "rental" && <span>{rentalTerm(p.rentalDays)}</span>}
                    </div>

                    {p.reviewNote && (
                      <p className="line-clamp-2 break-all rounded-md bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground">
                        {p.reviewNote}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      {/* 编辑：上架后也要能改分类/价格等（2026-10-03 站长反馈
                          「不能对已上架的商品进行分类」—— 原来这里只有通过/拒绝/删除） */}
                      <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        {t("common.edit")}
                      </Button>
                      {p.reviewStatus !== "approved" && (
                        <Button size="sm" onClick={() => openReview(p, true)}>
                          <Check className="mr-1 h-3.5 w-3.5" />
                          {t("ap.approve")}
                        </Button>
                      )}
                      {p.reviewStatus !== "rejected" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openReview(p, false)}
                        >
                          <X className="mr-1 h-3.5 w-3.5" />
                          {t("ap.reject")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-destructive hover:text-destructive"
                        onClick={() => void removeUserProduct(p)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("common.delete")}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 订单 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("ap.orders")}</CardTitle>
            <CardDescription>{t("ap.ordersDesc")}</CardDescription>
          </div>
          <Select value={orderStatus} onValueChange={setOrderStatus}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">{t("ap.filter.pending")}</SelectItem>
              <SelectItem value="delivered">{t("ap.filter.delivered")}</SelectItem>
              <SelectItem value="settled">{t("pt.status.settled")}</SelectItem>
              <SelectItem value="cancelled">{t("pt.status.cancelled")}</SelectItem>
              <SelectItem value="all">{t("common.all")}</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <LoadingBlock variant="list" />
          ) : orders.length === 0 ? (
            <EmptyState icon={Coins} title={t("ap.ordersEmpty")} description={t("ap.ordersEmptyDesc")} />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="table-actions-sticky w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.user")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.product")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.title")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.rentalTerm")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.status")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.time")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("ap.th.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const isUserOrder = o.sellerId !== null
                    const st = ORDER_STATUS[o.status] ?? ORDER_STATUS.pending
                    const closed = o.status === "settled" || o.status === "cancelled"
                    return (
                      <tr key={o.id} className="border-t">
                        <td className="px-3 py-2 font-medium">{o.username}</td>
                        <td className="px-3 py-2">
                          <p>{o.productName}</p>
                          <p className="text-xs text-muted-foreground">
                            {isUserOrder
                              ? t("ap.userOrderSeller", { seller: o.sellerName ?? "?" })
                              : t(
                                  DELIVERY_LABELS[o.delivery as PointDelivery] ??
                                    "pt.delivery.manual"
                                )}
                          </p>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{o.price}</td>
                        <td className="px-3 py-2 text-xs">
                          {o.billingMode === "rental" ? (
                            <span
                              className={
                                isRentalExpired(o) ? "text-destructive" : "text-muted-foreground"
                              }
                            >
                              {rentalOrderText(o)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={st.variant} className="text-[10px]">
                            {t(orderStatusText(o.status, isUserOrder))}
                          </Badge>
                          {o.note && (
                            <p className="mt-0.5 max-w-[16rem] truncate text-[10px] text-muted-foreground">
                              {o.note}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {fmtDateTime(o.createdAt)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1.5">
                            {isUserOrder ? (
                              <>
                                {o.status === "delivered" && (
                                  <Button size="sm" onClick={() => void settleOrder(o)}>
                                    {t("ap.settle")}
                                  </Button>
                                )}
                                {!closed && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => void cancelOrder(o)}
                                  >
                                    {t("ap.cancelRefund")}
                                  </Button>
                                )}
                                {closed && (
                                  <span className="text-xs text-muted-foreground">
                                    {o.settledAt
                                      ? t("ap.settledAt", { time: fmtDateTime(o.settledAt) })
                                      : "—"}
                                  </span>
                                )}
                              </>
                            ) : o.status === "pending" ? (
                              <Button
                                size="sm"
                                onClick={() => {
                                  setDeliverNote("")
                                  setDeliverTarget(o)
                                }}
                              >
                                {t("ap.markDelivered")}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {o.deliveredAt ? fmtDateTime(o.deliveredAt) : "—"}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 售后处理（客服介入） */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("ap.afterSales")}</CardTitle>
            <CardDescription>{t("ap.afterSalesDesc")}</CardDescription>
          </div>
          <Select value={afterSaleFilter} onValueChange={setAfterSaleFilter}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="platform">{t("ap.afterSaleFilter.pending")}</SelectItem>
              <SelectItem value="all">{t("common.all")}</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {afterSaleLoading ? (
            <LoadingBlock variant="list" />
          ) : afterSales.length === 0 ? (
            <EmptyState
              icon={Coins}
              title={t("ap.afterSalesEmpty")}
              description={t("ap.afterSalesEmptyDesc")}
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="table-actions-sticky w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.user")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.product")}</th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("ap.th.afterSaleReason")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.status")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("ap.th.time")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("ap.th.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {afterSales.map((o) => {
                    const s = o.afterSaleStatus
                    const st = s ? AFTER_SALE_STATUS[s] : null
                    // 卖家还没处理的也允许客服直接判（卖家长期不理时不必逼买家先点一次「申请介入」）
                    const actionable = s === "platform" || s === "requested" || s === "rejected"
                    return (
                      <tr key={o.id} className="border-t">
                        <td className="px-3 py-2">
                          <p className="font-medium">{o.username}</p>
                          <p className="text-xs text-muted-foreground">
                            {o.sellerId
                              ? t("ap.userOrderSeller", { seller: o.sellerName ?? "?" })
                              : t(
                                  DELIVERY_LABELS[o.delivery as PointDelivery] ??
                                    "pt.delivery.manual"
                                )}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <p>{o.productName}</p>
                          <p className="text-xs tabular-nums text-muted-foreground">
                            {t("pt.pointsUnit", { n: o.price })}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <p className="max-w-[18rem] text-xs">{o.afterSaleReason ?? "—"}</p>
                          {o.afterSaleNote && (
                            <p className="mt-0.5 max-w-[18rem] text-[10px] text-muted-foreground">
                              {o.afterSaleNote}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={st?.variant ?? "outline"} className="text-[10px]">
                            {st ? t(st.label) : "—"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {o.afterSaleRequestedAt ? fmtDateTime(o.afterSaleRequestedAt) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1.5">
                            {actionable ? (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => setResolveTarget({ order: o, approve: true })}
                                >
                                  {t("ap.afterSale.approve")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-destructive hover:text-destructive"
                                  onClick={() => setResolveTarget({ order: o, approve: false })}
                                >
                                  {t("ap.afterSale.reject")}
                                </Button>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {o.afterSaleResolvedAt ? fmtDateTime(o.afterSaleResolvedAt) : "—"}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 售后判定弹窗 */}
      <Dialog
        open={!!resolveTarget}
        onOpenChange={(o) => {
          if (!o && !resolveBusy) setResolveTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(resolveTarget?.approve ? "ap.afterSale.approveTitle" : "ap.afterSale.rejectTitle")}
            </DialogTitle>
            <DialogDescription>
              {resolveTarget?.approve
                ? t("ap.afterSale.approveDesc", {
                    price: resolveTarget.order.price,
                    buyer: resolveTarget.order.username,
                  })
                : t("ap.afterSale.rejectDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="resolveNote">{t("ap.afterSale.noteLabel")}</Label>
            <Textarea
              id="resolveNote"
              rows={3}
              maxLength={300}
              placeholder={t(
                resolveTarget?.approve
                  ? "ap.afterSale.approveNotePlaceholder"
                  : "ap.afterSale.rejectNotePlaceholder"
              )}
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResolveTarget(null)}
              disabled={resolveBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitResolve()} disabled={resolveBusy}>
              {resolveBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 标记发放 */}
      <Dialog
        open={!!deliverTarget}
        onOpenChange={(o) => {
          if (!o && !deliverBusy) setDeliverTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("ap.markDeliveredTitle", { name: deliverTarget?.productName ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {t("ap.deliverDesc1", {
                user: deliverTarget?.username ?? "",
                price: deliverTarget?.price ?? 0,
              })}
              {t("ap.deliverDesc2")}
              {deliverTarget?.billingMode === "rental" && (
                <>
                  {" "}
                  {t("ap.deliverRentalNote", { n: deliverTarget.rentalDays ?? "?" })}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="deliverNote">{t("ap.noteOptionalUserVisible")}</Label>
            <Input
              id="deliverNote"
              placeholder={t("ap.deliverNotePlaceholder")}
              value={deliverNote}
              onChange={(e) => setDeliverNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeliverTarget(null)} disabled={deliverBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitDeliver()} disabled={deliverBusy}>
              {deliverBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("ap.confirmDeliver")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 审核用户商品 */}
      <Dialog
        open={!!reviewTarget}
        onOpenChange={(o) => {
          if (!o && !reviewBusy) setReviewTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewApprove ? t("ap.reviewApproveTitle") : t("ap.reject")} · {reviewTarget?.name}
            </DialogTitle>
            <DialogDescription>
              {t("ap.reviewMeta", {
                seller: reviewTarget?.ownerName ?? t("ap.reviewThisUser"),
                price: reviewTarget?.price ?? 0,
              })}
              {reviewTarget?.billingMode === "rental"
                ? t("ap.reviewRentalAppend", { n: reviewTarget.rentalDays ?? "?" })
                : ""}
              {t("ap.period")}
              {reviewApprove ? t("ap.reviewApproveHint") : t("ap.reviewRejectHint")}
              {reviewTarget?.billingMode === "rental" && t("ap.reviewRentalHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reviewNote">
              {reviewApprove ? t("ap.noteOptionalUserVisible") : t("ap.rejectReasonLabel")}
            </Label>
            <Textarea
              id="reviewNote"
              rows={3}
              maxLength={200}
              placeholder={
                reviewApprove ? t("ap.notePlaceholder") : t("ap.rejectReasonPlaceholder")
              }
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewTarget(null)} disabled={reviewBusy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={reviewApprove ? "default" : "destructive"}
              onClick={() => void submitReview()}
              disabled={reviewBusy}
            >
              {reviewBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {reviewApprove ? t("ap.confirmReviewApprove") : t("ap.confirmReviewReject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        捐献奖励设置。
        与兑换比例同属「积分经济旋钮」，但**单独一个弹窗**：7 个档位塞进兑换弹窗太挤，
        而且两者改的时机不同（比例是调价、奖励是调活动力度）。
      */}
      <Dialog open={donationOpen} onOpenChange={(o) => !donationBusy && setDonationOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("ap.donationTitle")}</DialogTitle>
            <DialogDescription>
              {t("ap.donationDesc")}
            </DialogDescription>
          </DialogHeader>

          {donationList.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("ap.donationNoTiers")}
            </p>
          ) : (
            <div className="space-y-3">
              {donationList.map((item) => (
                <div key={item.key} className="flex items-center justify-between gap-3">
                  <Label htmlFor={`dp-${item.key}`} className="min-w-0 flex-1 truncate font-normal">
                    {item.label}
                  </Label>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Input
                      id={`dp-${item.key}`}
                      inputMode="numeric"
                      className="w-24 text-right tabular-nums"
                      value={donationDraft[item.key] ?? ""}
                      onChange={(e) =>
                        setDonationDraft((d) => ({ ...d, [item.key]: e.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">{t("ap.title")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {donationList.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor="dp-daily" className="font-normal">
                  {t("ap.donationDailyLabel")}
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("ap.donationDailyHint")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Input
                  id="dp-daily"
                  inputMode="numeric"
                  className="w-24 text-right tabular-nums"
                  value={donationDaily}
                  onChange={(e) => setDonationDaily(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">{t("ap.timesPerDayUnit")}</span>
              </div>
            </div>
          )}

          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{t("ap.issueTimesLabel")}</span>
              {t("ap.donationIssueNote")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("ap.dailyCapLabel")}</span>
              {t("ap.donationDailyCapNote")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("ap.valueImpactLabel")}</span>
              {t("ap.valueImpactNote")}
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDonationOpen(false)} disabled={donationBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void saveDonationRewards()} disabled={donationBusy}>
              {donationBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        邀请奖励 / 返佣设置。
        与捐献奖励一样属于「积分经济旋钮」，单独一个弹窗 —— 它改的是**拉新成本**，
        和「兑换比例（调价）」「捐献奖励（调活动力度）」三者的调整时机都不同。
      */}
      <Dialog open={inviteOpen} onOpenChange={(o) => !inviteBusy && setInviteOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("ap.inviteRewards")}</DialogTitle>
            <DialogDescription>
              {t("ap.inviteDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">{t("ap.inviteEnable")}</p>
              <p className="text-xs text-muted-foreground">
                {inviteForm.enabled
                  ? t("ap.inviteOn")
                  : t("ap.inviteOff")}
              </p>
            </div>
            <Switch
              checked={inviteForm.enabled}
              onCheckedChange={(v) => setInviteForm((f) => ({ ...f, enabled: v }))}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor="ip-per" className="font-normal">
                  {t("ap.perInvite")}
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("ap.perInviteHint")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Input
                  id="ip-per"
                  inputMode="numeric"
                  className="w-24 text-right tabular-nums"
                  value={String(inviteForm.perFriend)}
                  onChange={(e) =>
                    setInviteForm((f) => ({ ...f, perFriend: Number(e.target.value) || 0 }))
                  }
                />
                <span className="text-xs text-muted-foreground">{t("ap.title")}</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor="ip-pct" className="font-normal">
                  {t("ap.commissionLabel")}
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("ap.commissionHint")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Input
                  id="ip-pct"
                  inputMode="decimal"
                  className="w-24 text-right tabular-nums"
                  value={String(inviteForm.commissionPercent)}
                  onChange={(e) =>
                    setInviteForm((f) => ({
                      ...f,
                      commissionPercent: Number(e.target.value) || 0,
                    }))
                  }
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor="ip-daily" className="font-normal">
                  {t("ap.inviteDailyLabel")}
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("ap.inviteDailyHint")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Input
                  id="ip-daily"
                  inputMode="numeric"
                  className="w-24 text-right tabular-nums"
                  value={String(inviteForm.dailyLimit)}
                  onChange={(e) =>
                    setInviteForm((f) => ({ ...f, dailyLimit: Number(e.target.value) || 0 }))
                  }
                />
                <span className="text-xs text-muted-foreground">{t("ap.pointsPerDay")}</span>
              </div>
            </div>

            <div className="flex items-start justify-between gap-3 border-t pt-3">
              <div className="min-w-0 flex-1">
                <Label className="font-normal">{t("ap.consumedOnlyLabel")}</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("ap.consumedOnlyNote")}
                </p>
              </div>
              <Switch
                className="mt-0.5 shrink-0"
                checked={inviteForm.requireConsumed}
                onCheckedChange={(v) => setInviteForm((f) => ({ ...f, requireConsumed: v }))}
              />
            </div>
          </div>

          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{t("ap.toMoneyLabel")}</span>
              {t("ap.toMoneyCurrent", { v: fmtMoney(data?.config.yuanPerPoint ?? 1) })}
              {t("ap.toMoneyPerInvite")}
              {fmtMoney((inviteForm.perFriend || 0) * (data?.config.yuanPerPoint ?? 1))}
              {t("ap.period")}
              {t("ap.toMoneyNote")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("ap.oneLevelLabel")}</span>
              {t("ap.oneLevelNote")}
            </p>
            <p>
              <span className="font-medium text-foreground">{t("ap.antiAltLabel")}</span>
              {t("ap.antiAltNote")}
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={inviteBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void saveInviteRewards()} disabled={inviteBusy}>
              {inviteBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        内置商品「兑换中转站余额」的编辑弹窗。
        原先这块内容是单独一张卡片摆在商品表上面 —— 站长要求「兑换也当商品」，
        所以改成从商品表第一行的「编辑」进来。
      */}
      <Dialog open={redeemOpen} onOpenChange={(o) => !cfgBusy && setRedeemOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ap.editRedeemTitle")}</DialogTitle>
            <DialogDescription>
              {t("ap.editRedeemDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("ap.redeemEnabledLabel")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("ap.redeemEnabledHint")}
                </p>
              </div>
              <Switch checked={cfgEnabled} onCheckedChange={setCfgEnabled} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pointsYuanPerPoint">{t("ap.rateLabel")}</Label>
              <Input
                id="pointsYuanPerPoint"
                inputMode="decimal"
                value={cfgRatio}
                onChange={(e) => setCfgRatio(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("ap.rateHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pointsDailyLimit">{t("ap.redeemDailyLabel")}</Label>
              <Input
                id="pointsDailyLimit"
                inputMode="numeric"
                value={cfgDaily}
                onChange={(e) => setCfgDaily(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("ap.redeemDailyHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pointsAutoConfirm">{t("ap.autoConfirmLabel")}</Label>
              <Input
                id="pointsAutoConfirm"
                inputMode="numeric"
                value={cfgAutoConfirm}
                onChange={(e) => setCfgAutoConfirm(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("ap.autoConfirmHint")}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRedeemOpen(false)} disabled={cfgBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void saveConfig()} disabled={cfgBusy}>
              {cfgBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建 / 编辑商品 */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !formBusy && setDialogOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? t("ap.editProduct") : t("ap.newProduct")}</DialogTitle>
            <DialogDescription>{t("ap.formDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="pdName">{t("pt.form.name")}</Label>
              <Input
                id="pdName"
                maxLength={40}
                placeholder={t("ap.namePlaceholder")}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pdDesc">{t("pt.form.desc")}</Label>
              <Textarea
                id="pdDesc"
                rows={3}
                maxLength={500}
                placeholder={t("ap.descPlaceholder")}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="pdImage">{t("pt.form.cover")}</Label>
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
                {/* 与用户端同一个上传接口；传完把返回的同源 URL 填进输入框 */}
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => void handleCoverPick(e.target.files?.[0])}
                />
              </div>
              <Input
                id="pdImage"
                placeholder={t("pt.form.coverPlaceholder")}
                value={form.imageUrl}
                onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
              />
              {form.imageUrl.trim() && (
                <p className="text-xs text-muted-foreground">{t("pt.form.coverHint")}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="pdCategory">{t("pt.form.category")}</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v as ProductCategory }))}
              >
                <SelectTrigger id="pdCategory" className="w-40">
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
            </div>

            <ShopIconPicker
              value={form.icon}
              disabled={formBusy}
              onChange={(slug) => setForm((f) => ({ ...f, icon: slug }))}
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="pdPrice">{t("pt.form.price")}</Label>
                <Input
                  id="pdPrice"
                  inputMode="numeric"
                  placeholder="100"
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pdStock">{t("pt.form.stock")}</Label>
                <Input
                  id="pdStock"
                  inputMode="numeric"
                  placeholder={t("pt.form.unlimited")}
                  value={form.stock}
                  onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pdLimit">{t("ap.perUserLimitLabel")}</Label>
                <Input
                  id="pdLimit"
                  inputMode="numeric"
                  placeholder={t("pt.form.unlimited")}
                  value={form.perUserLimit}
                  onChange={(e) => setForm((f) => ({ ...f, perUserLimit: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pdDaily">{t("ap.dailyLimitLabel")}</Label>
                <Input
                  id="pdDaily"
                  inputMode="numeric"
                  placeholder={t("pt.form.unlimited")}
                  value={form.dailyLimit}
                  onChange={(e) => setForm((f) => ({ ...f, dailyLimit: e.target.value }))}
                />
                <p className="text-[11px] text-muted-foreground">{t("ap.dailyLimitHint")}</p>
              </div>
            </div>

            {/* 计费方式：买断 / 租用。放在交付方式之前，因为租用会限制可选的交付方式 */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t("pt.form.rentalMode")}</p>
                  <p className="text-xs text-muted-foreground">{t("ap.rentalModeHint")}</p>
                </div>
                <Switch
                  checked={form.billingMode === "rental"}
                  onCheckedChange={(v) =>
                    setForm((f) => {
                      const billingMode: PointBillingMode = v ? "rental" : "one_time"
                      // 打开租用时，如果当前交付方式不允许租用，自动切到「人工发放」，
                      // 否则用户会带着一个不可用的组合去提交
                      const delivery =
                        v && !RENTAL_DELIVERIES.includes(f.delivery) ? "manual" : f.delivery
                      return {
                        ...f,
                        billingMode,
                        delivery,
                        rentalDays: v && !f.rentalDays ? "30" : f.rentalDays,
                      }
                    })
                  }
                />
              </div>

              {form.billingMode === "rental" && (
                <div className="space-y-2">
                  <Label htmlFor="pdDays">{t("pt.form.rentalDays")}</Label>
                  <Input
                    id="pdDays"
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
                  <p className="text-xs text-muted-foreground">{t("ap.rentalDaysHint")}</p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t("ap.deliveryLabel")}</Label>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(DELIVERY_LABELS) as PointDelivery[]).map((d) => {
                  const blockedByRental =
                    form.billingMode === "rental" && !RENTAL_DELIVERIES.includes(d)
                  return (
                    <Button
                      key={d}
                      type="button"
                      variant={form.delivery === d ? "default" : "outline"}
                      size="sm"
                      disabled={blockedByRental}
                      title={blockedByRental ? t("ap.rentalBlockedTip") : undefined}
                      onClick={() => setForm((f) => ({ ...f, delivery: d }))}
                    >
                      {t(DELIVERY_LABELS[d])}
                    </Button>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">{t(DELIVERY_HINTS[form.delivery])}</p>
              {form.billingMode === "rental" && (
                <p className="text-xs text-muted-foreground">
                  {t("ap.rentalBlockedNote")}
                </p>
              )}
            </div>

            {form.delivery === "quota" && (
              <div className="space-y-2">
                <Label htmlFor="pdQuota">{t("ap.quotaYuanLabel")}</Label>
                <Input
                  id="pdQuota"
                  inputMode="decimal"
                  placeholder={t("ap.quotaYuanPlaceholder")}
                  value={form.quotaYuan}
                  onChange={(e) => setForm((f) => ({ ...f, quotaYuan: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  {t("ap.quotaHint")}
                </p>
              </div>
            )}

            {form.delivery === "code" && (
              <div className="space-y-2">
                {editingId ? (
                  <CodeManager productId={editingId} />
                ) : (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    {t("ap.codes.saveFirst")}
                  </p>
                )}
              </div>
            )}

            {form.delivery === "feature" && (
              <div className="space-y-2">
                <Label htmlFor="pdFeature">{t("ap.featureLabel")}</Label>
                <Select
                  value={form.feature}
                  onValueChange={(v) => setForm((f) => ({ ...f, feature: v as FeatureKey }))}
                >
                  <SelectTrigger id="pdFeature">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FEATURE_KEYS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(FEATURE_LABELS[k])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("ap.featureHint")}
                </p>
              </div>
            )}

            {form.delivery === "subscription" && (
              <div className="space-y-2">
                <Label htmlFor="pdPlan">{t("ap.planIdLabel")}</Label>
                <Input
                  id="pdPlan"
                  inputMode="numeric"
                  placeholder={t("ap.numPlaceholder")}
                  value={form.planId}
                  onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">{t("ap.planIdHint")}</p>
              </div>
            )}

            {(form.delivery === "invite_quota" || form.delivery === "checkin_makeup") && (
              <div className="space-y-2">
                <Label htmlFor="pdInvite">
                  {form.delivery === "checkin_makeup"
                    ? t("ap.makeupCountLabel")
                    : t("ap.inviteCountLabel")}
                </Label>
                <Input
                  id="pdInvite"
                  inputMode="numeric"
                  placeholder={t("ap.numPlaceholder")}
                  value={form.inviteCount}
                  onChange={(e) => setForm((f) => ({ ...f, inviteCount: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  {form.delivery === "checkin_makeup"
                    ? t("ap.makeupCountHint")
                    : t("ap.inviteCountHint")}
                </p>
              </div>
            )}

            {form.delivery === "content" && (
              <div className="space-y-2">
                <Label htmlFor="pdContent">{t("ap.contentLabel")}</Label>
                <Textarea
                  id="pdContent"
                  rows={6}
                  placeholder={t("ap.contentPlaceholder")}
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  {t("ap.contentHint", { n: form.content.length })}
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pdSort">{t("ap.sortLabel")}</Label>
                <Input
                  id="pdSort"
                  inputMode="numeric"
                  value={form.sort}
                  onChange={(e) => setForm((f) => ({ ...f, sort: e.target.value }))}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <p className="text-sm font-medium">{t("ap.list")}</p>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                />
              </div>
            </div>

            {/* 公示购买记录（2026-10-08 站长要求）：开启后用户点开商品详情就能看到
                这件商品最近 10 条购买记录（买家用户名 + 下单时间）。
                买家用户名属于个人信息，所以默认关闭，由管理员逐件决定。 */}
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5 pr-3">
                <p className="text-sm font-medium">{t("ap.showPurchasesLabel")}</p>
                <p className="text-xs text-muted-foreground">{t("ap.showPurchasesHint")}</p>
              </div>
              <Switch
                checked={form.showPurchases}
                onCheckedChange={(v) => setForm((f) => ({ ...f, showPurchases: v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={formBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitForm()} disabled={formBusy}>
              {formBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------- 成员

function MembersTab() {
  const { t } = useT()
  const [data, setData] = React.useState<AdminPointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState("")
  /**
   * 用户列表服务端分页（2026-10-08）。
   * 站长反馈「只能看见最后两百个用户、没有分页」——原接口写死 LIMIT 200，且
   * 「持有积分人数 / 在手总量」是从这 200 人里数出来的（全站 683 人 / 118273 分，
   * 页面却显示 100 / 14795）。现在列表分页、统计聚合全表，两者彻底解耦。
   */
  const [page, setPage] = React.useState(0)
  const POINTS_PAGE_SIZE = 50

  // 发放/扣减弹窗
  const [adjustTarget, setAdjustTarget] = React.useState<AdminPointsUser | null>(null)
  const [delta, setDelta] = React.useState("")
  const [detail, setDetail] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  // 流水弹窗
  const [historyTarget, setHistoryTarget] = React.useState<AdminPointsUser | null>(null)
  const [history, setHistory] = React.useState<PointTransaction[] | null>(null)
  const [historyLoading, setHistoryLoading] = React.useState(false)

  /**
   * 拉积分总览。`q`/`p` 显式传入（不读 state），因为搜索与翻页都要能指定目标页：
   * 搜索词变化时回第一页，翻页时保留当前搜索词。
   */
  const loadPage = React.useCallback(
    async (q: string, p: number) => {
      setLoading(true)
      try {
        setData(
          await adminPointsApi.list({
            query: q.trim() || undefined,
            limit: POINTS_PAGE_SIZE,
            offset: p * POINTS_PAGE_SIZE,
          })
        )
      } catch (err) {
        toast.error(errMsg(err, t("ap.err.loadMembers")))
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  /** 刷新当前页（保留搜索词与页码） */
  const load = React.useCallback(
    async (q?: string) => {
      await loadPage(q ?? query, page)
    },
    [loadPage, query, page]
  )

  React.useEffect(() => {
    void loadPage("", 0)
    // 只在挂载时跑一次（后续由搜索/翻页显式触发）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPage])

  const openAdjust = (u: AdminPointsUser) => {
    setAdjustTarget(u)
    setDelta("")
    setDetail("")
  }

  const submitAdjust = async () => {
    if (!adjustTarget) return
    const value = Math.trunc(Number(delta))
    if (!Number.isFinite(value) || value === 0) {
      toast.error(t("ap.err.nonZeroInt"))
      return
    }
    setBusy(true)
    try {
      const res = await adminPointsApi.adjust({
        username: adjustTarget.username,
        delta: value,
        detail: detail.trim() || undefined,
      })
      toast.success(
        t("ap.toast.adjusted", {
          verb: value > 0 ? t("ap.verb.issue") : t("ap.verb.deduct"),
          n: Math.abs(value),
          user: adjustTarget.username,
          balance: res.balance,
        })
      )
      setAdjustTarget(null)
      await load(query)
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.op")))
    } finally {
      setBusy(false)
    }
  }

  const openHistory = async (u: AdminPointsUser) => {
    setHistoryTarget(u)
    setHistory(null)
    setHistoryLoading(true)
    try {
      const res = await adminPointsApi.history(u.username)
      setHistory(res.transactions)
    } catch (err) {
      toast.error(errMsg(err, t("ap.err.loadTx")))
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 汇总 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: t("ap.stat.issued"), value: data?.stats.issued ?? 0 },
          { label: t("ap.stat.redeemed"), value: data?.stats.redeemed ?? 0 },
          { label: t("ap.stat.traded"), value: data?.stats.traded ?? 0 },
          { label: t("ap.stat.holding"), value: data?.stats.holding ?? 0 },
          { label: t("ap.stat.holders"), value: data?.stats.holders ?? 0 },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="mt-1 flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
                <Coins className="h-4 w-4 text-amber-500" />
                {s.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 搜索 */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative max-w-sm flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            // 搜索词变了要回第一页，否则会停在「上一条搜索结果的第 N 页」上，
            // 命中数不够时直接显示空白。
            setPage(0)
            void loadPage(query, 0)
          }}
        >
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("ap.searchPlaceholder")}
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <Button variant="outline" size="sm" onClick={() => void load(query)} disabled={loading}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t("common.refresh")}
        </Button>
      </div>

      {/* 列表 */}
      {loading && !data ? (
        <LoadingBlock variant="list" />
      ) : !data || data.users.length === 0 ? (
        <EmptyState
          icon={Coins}
          title={t("ap.noUserMatch")}
          description={query ? t("ap.noUserMatchDesc") : t("ap.noUserData")}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="table-actions-sticky w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="w-16 px-3 py-2 text-left font-medium">UID</th>
                <th className="px-3 py-2 text-left font-medium">{t("ap.th.user")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("ap.th.email")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("ap.th.joinedAt")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("ap.th.balance")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("ap.th.lastChange")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("ap.th.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">
                    {u.uid != null ? fmtUid(u.uid) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{u.username}</span>
                      {u.nickname && <span className="text-muted-foreground">{u.nickname}</span>}
                      {u.status !== "active" && (
                        <Badge variant="outline" className="text-[10px]">
                          {t("common.disabled")}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{u.email || "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {u.createdAt ? fmtDateTime(u.createdAt) : "—"}
                  </td>
                  <td className="px-3 py-2 font-medium tabular-nums">{u.balance}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {u.updatedAt ? fmtDateTime(u.updatedAt) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => openAdjust(u)}>
                        <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
                        {t("ap.adjust")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openHistory(u)}>
                        {t("ap.tx")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 服务端分页控件（2026-10-08）：total 来自接口，翻页即拉对应页 */}
      {!loading && data?.total != null && data.total > POINTS_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t("adm.userPageInfo", {
              from: page * POINTS_PAGE_SIZE + 1,
              to: Math.min((page + 1) * POINTS_PAGE_SIZE, data.total),
              total: data.total,
            })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => {
                const next = Math.max(0, p - 1)
                void loadPage(query, next)
                return next
              })}
            >
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              {t("adm.userPagePrev")}
            </Button>
            <span className="tabular-nums">
              {page + 1} / {Math.ceil(data.total / POINTS_PAGE_SIZE)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * POINTS_PAGE_SIZE >= data.total}
              onClick={() => setPage((p) => {
                const next = p + 1
                void loadPage(query, next)
                return next
              })}
            >
              {t("adm.userPageNext")}
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* 发放 / 扣减 */}
      <Dialog open={!!adjustTarget} onOpenChange={(o) => !o && setAdjustTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("ap.adjustTitle", { user: adjustTarget?.username ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {t("ap.adjustBalancePrefix")} <span className="font-medium text-foreground">{adjustTarget?.balance ?? 0}</span>{" "}
              {t("ap.adjustDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="adjDelta">{t("ap.deltaLabel")}</Label>
              <Input
                id="adjDelta"
                type="number"
                placeholder={t("ap.deltaPlaceholder")}
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adjDetail">{t("ap.noteOptionalUserVisible")}</Label>
              <Input
                id="adjDetail"
                placeholder={t("ap.adjustNotePlaceholder")}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {[10, 50, 100, 500].map((n) => (
                <Button key={n} variant="outline" size="sm" onClick={() => setDelta(String(n))}>
                  +{n}
                </Button>
              ))}
              <Button variant="outline" size="sm" onClick={() => setDelta("-10")}>
                -10
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustTarget(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitAdjust()} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 流水 */}
      <Dialog open={!!historyTarget} onOpenChange={(o) => !o && setHistoryTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("ap.txTitle", { user: historyTarget?.username ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("ap.txDesc")}</DialogDescription>
          </DialogHeader>
          {historyLoading ? (
            <LoadingBlock variant="list" />
          ) : !history || history.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("ap.txEmpty")}</p>
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {history.map((tx) => (
                <li key={tx.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {tx.detail || t(REASON_LABEL[tx.reason] ?? tx.reason)}
                    </p>
                    <p className="text-xs text-muted-foreground">{fmtDateTime(tx.createdAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {tx.delta > 0 ? `+${tx.delta}` : tx.delta}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {t("pt.balanceSuffix", { n: tx.balance })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
