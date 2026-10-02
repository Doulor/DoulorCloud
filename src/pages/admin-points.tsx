import * as React from "react"
import {
  CalendarClock,
  Check,
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
import { fmtDateTime, fmtUid } from "@/lib/format"
import { notifyAttentionChanged } from "@/lib/attention-events"
import { shopIcon } from "@/lib/shop-icons"
import { FEATURE_LABELS } from "@/types"
import { useT } from "@/i18n"
import type {
  AdminPointsOverview,
  AdminPointsUser,
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
  manual: "人工发放",
  quota: "自动充值",
  feature: "授予权限",
  subscription: "开通订阅",
  invite_quota: "邀请码额度",
}

/** 交付方式 → 一句话说明（选中后显示在按钮下方） */
const DELIVERY_HINTS: Record<PointDelivery, string> = {
  manual: "下单后只生成一张「待发放」订单，你在订单列表里点「标记发放」才真正发出去。",
  quota: "下单后自动把金额加到用户的 AI 中转站余额。用户没开通中转站时无法购买。",
  feature: "下单后自动给用户开通选中的模块权限。用户已经有了这个权限时会直接拒绝下单，不会白扣积分。",
  subscription:
    "下单后自动给用户开通 NewAPI 的订阅套餐（按月重置额度那种）。套餐 ID 由你填，在 NewAPI 后台的套餐列表里能看到。",
  invite_quota: "下单后自动增加用户的「邀请码创建额度」，也就是他能建多少个邀请码。",
}

/** 交付方式 → 商品表 / 订单表里的展示文案 */
function deliveryText(delivery: string, quotaYuan?: number | null): string {
  if (delivery === "quota") return `自动充 ¥${fmtMoney(quotaYuan ?? 0)}`
  return DELIVERY_LABELS[delivery as PointDelivery] ?? "人工发放"
}

/** 全部模块（下拉框选项顺序） */
const FEATURE_KEYS: FeatureKey[] = ["ai", "r2", "frp", "proxy"]

/** 流水来源 → 标签 */
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

/** 订单状态 → 标签（用户商品订单的 pending/delivered 含义不同，用 orderStatusText 区分） */
const ORDER_STATUS: Record<string, { label: string; variant: "default" | "outline" | "secondary" | "success" }> = {
  pending: { label: "待发放", variant: "default" },
  delivered: { label: "已发放", variant: "outline" },
  settled: { label: "已结算", variant: "success" },
  cancelled: { label: "已取消", variant: "secondary" },
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
    if (status === "pending") return "待卖家交付"
    if (status === "delivered") return "待买家确认"
  }
  return ORDER_STATUS[status]?.label ?? status
}

/** 用户商品的审核状态 → 标签 */
const REVIEW_STATUS: Record<
  string,
  { label: string; variant: "default" | "outline" | "secondary" | "destructive" | "success" }
> = {
  pending: { label: "待审核", variant: "default" },
  approved: { label: "已通过", variant: "success" },
  rejected: { label: "已拒绝", variant: "destructive" },
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
  return days && days > 0 ? `租用 ${days} 天` : "租用"
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
  if (!o.expiresAt) return `${rentalTerm(o.rentalDays)}（未起算）`
  const time = fmtDateTime(o.expiresAt)
  if (isRentalExpired(o)) {
    return `已到期（${time}）${o.expireHandledAt ? " · 已收回" : " · 待处理"}`
  }
  return `至 ${time}`
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
  const [tab, setTab] = React.useState("shop")

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">积分</h2>
        <p className="text-sm text-muted-foreground">
          积分是站点发放的余额。用户在「积分与商城」页的商城里可以按比例兑换成 AI 中转站余额，
          也可以花积分换你上架的商品。
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="shop" className="gap-1.5">
            <ShoppingBag className="h-3.5 w-3.5" />
            商城
          </TabsTrigger>
          <TabsTrigger value="members" className="gap-1.5">
            <Users className="h-3.5 w-3.5" />
            成员
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
  price: string
  stock: string
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
    price: "",
    stock: "",
    perUserLimit: "",
    delivery: "manual",
    quotaYuan: "",
    feature: "ai",
    planId: "",
    inviteCount: "1",
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
    price: String(p.price),
    stock: p.stock === null ? "" : String(p.stock),
    perUserLimit: p.perUserLimit === null ? "" : String(p.perUserLimit),
    delivery: p.delivery,
    quotaYuan: p.quotaYuan === null ? "" : String(p.quotaYuan),
    feature: (p.deliveryParams?.feature as FeatureKey) ?? "ai",
    planId: p.deliveryParams?.planId === undefined ? "" : String(p.deliveryParams.planId),
    inviteCount:
      p.deliveryParams?.count === undefined ? "1" : String(p.deliveryParams.count),
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
  }

  const isRental = f.billingMode === "rental"
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    imageUrl: f.imageUrl.trim() || null,
    icon: f.icon.trim() || null,
    price: Math.trunc(Number(f.price) || 0),
    stock: f.stock.trim() === "" ? null : Math.trunc(Number(f.stock) || 0),
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
          // `?? []` 是防御性的：老版本后端不下发这个字段，直接 .map 会让整页白屏
          setDonationList(res.donationRewards ?? [])
          setDonationDraft(draftOf(res.donationRewards ?? []))
          setDonationDaily(String(res.donationDailyLimit ?? 0))
          // 老版本后端不下发这个字段 —— 缺了就保留默认值，别让整页白屏
          if (res.inviteConfig) setInviteForm(res.inviteConfig)
        }
      } catch (err) {
        toast.error(errMsg(err, "加载商城数据失败"))
      } finally {
        setLoading(false)
      }
    },
    [orderStatus]
  )

  React.useEffect(() => {
    void load()
  }, [load])

  const saveConfig = async () => {
    const ratio = Number(cfgRatio)
    if (!Number.isFinite(ratio) || ratio <= 0) {
      toast.error("兑换比例必须大于 0（例如 1 表示 1 积分 = 1 元，10 表示 1 积分 = 10 元）")
      return
    }
    const daily = Math.trunc(Number(cfgDaily))
    if (!Number.isFinite(daily) || daily < 0) {
      toast.error("每日上限不能是负数（0 = 不限）")
      return
    }
    setCfgBusy(true)
    try {
      const res = await adminPointsApi.saveConfig({
        enabled: cfgEnabled,
        yuanPerPoint: ratio,
        dailyLimit: daily,
      })
      toast.success(`已保存：1 积分 = ¥${fmtMoney(res.config.yuanPerPoint)}`)
      setRedeemOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, "保存失败"))
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
        toast.error(`「${item.label}」的积分数需在 0 ~ 100000 之间（0 = 该类型不发）`)
        return
      }
      payload[item.key] = n
    }
    if (Object.keys(payload).length === 0) {
      toast.error("没有可保存的档位")
      return
    }
    const daily = Math.trunc(Number(donationDaily))
    if (!Number.isFinite(daily) || daily < 0 || daily > 1000) {
      toast.error("每日发放次数上限需在 0 ~ 1000 之间（0 = 不限）")
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
      toast.success("已保存捐献奖励")
      setDonationOpen(false)
    } catch (err) {
      toast.error(errMsg(err, "保存失败"))
    } finally {
      setDonationBusy(false)
    }
  }

  /** 保存邀请奖励 / 返佣配置 */
  const saveInviteRewards = async () => {
    const perFriend = Math.trunc(Number(inviteForm.perFriend))
    if (!Number.isFinite(perFriend) || perFriend < 0 || perFriend > 100_000) {
      toast.error("每邀请 1 人的积分需在 0 ~ 100000 之间（0 = 不发）")
      return
    }
    const pct = Number(inviteForm.commissionPercent)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error("返佣比例需在 0 ~ 100 之间（0 = 关闭）")
      return
    }
    const daily = Math.trunc(Number(inviteForm.dailyLimit))
    if (!Number.isFinite(daily) || daily < 0 || daily > 1_000_000) {
      toast.error("每日上限需在 0 ~ 1000000 之间（0 = 不限）")
      return
    }
    setInviteBusy(true)
    try {
      const res = await adminPointsApi.saveConfig({
        invitePoints: { ...inviteForm, perFriend, commissionPercent: pct, dailyLimit: daily },
      })
      if (res.inviteConfig) setInviteForm(res.inviteConfig)
      toast.success("已保存邀请奖励配置")
      setInviteOpen(false)
    } catch (err) {
      toast.error(errMsg(err, "保存失败"))
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
      toast.success(cfg.enabled ? "已下架「兑换中转站余额」" : "已上架「兑换中转站余额」")
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, "操作失败"))
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
      toast.error("请填写商品名称")
      return
    }
    if (payload.price < 1) {
      toast.error("售价必须是大于 0 的整数积分")
      return
    }
    if (payload.delivery === "quota" && !(Number(payload.quotaYuan) > 0)) {
      toast.error("自动充值的商品必须填写每件充入金额（元）")
      return
    }
    if (payload.delivery === "subscription" && !(Number(payload.deliveryParams?.planId) > 0)) {
      toast.error("开通订阅的商品必须填写中转站套餐 ID")
      return
    }
    if (payload.delivery === "invite_quota" && !(Number(payload.deliveryParams?.count) > 0)) {
      toast.error("邀请码额度商品必须填写发放数量")
      return
    }
    if (payload.billingMode === "rental") {
      if (!(Number(payload.rentalDays) > 0)) {
        toast.error("租用商品必须填写租期天数（大于 0 的整数）")
        return
      }
      if (!RENTAL_DELIVERIES.includes(payload.delivery)) {
        toast.error("「自动充值」和「邀请码额度」是一次性发放的，不能设为租用")
        return
      }
    }
    setFormBusy(true)
    try {
      if (editingId) {
        await adminPointsApi.updateProduct(editingId, payload)
        toast.success("商品已更新")
      } else {
        await adminPointsApi.createProduct(payload)
        toast.success("商品已创建")
      }
      setDialogOpen(false)
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, "保存商品失败"))
    } finally {
      setFormBusy(false)
    }
  }

  const toggleEnabled = async (p: PointProduct) => {
    try {
      await adminPointsApi.updateProduct(p.id, { ...payloadOf(formOf(p)), enabled: !p.enabled })
      toast.success(p.enabled ? "已下架" : "已上架")
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, "操作失败"))
    }
  }

  const removeProduct = async (p: PointProduct) => {
    if (!confirm(`确定删除商品「${p.name}」？\n\n已产生的订单会保留，不受影响。`)) return
    try {
      await adminPointsApi.deleteProduct(p.id)
      toast.success("已删除")
      await load({ keepConfig: true })
    } catch (err) {
      toast.error(errMsg(err, "删除失败"))
    }
  }

  const submitDeliver = async () => {
    if (!deliverTarget) return
    setDeliverBusy(true)
    try {
      await adminPointsApi.deliverOrder(deliverTarget.id, deliverNote.trim() || undefined)
      toast.success("已标记发放")
      setDeliverTarget(null)
      await load({ keepConfig: true })
      notifyAttentionChanged() // 待处理订单角标当场减一
    } catch (err) {
      toast.error(errMsg(err, "操作失败"))
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
      toast.success(reviewApprove ? "已通过，商品已上架" : "已拒绝")
      setReviewTarget(null)
      await load({ keepConfig: true })
      notifyAttentionChanged() // 待审核商品角标当场减一
    } catch (err) {
      toast.error(errMsg(err, "审核失败"))
    } finally {
      setReviewBusy(false)
    }
  }

  const removeUserProduct = async (p: PointProduct) => {
    if (!confirm(`确定删除用户商品「${p.name}」（${p.ownerName ?? "?"} 上架）？\n\n已产生的订单会保留。`)) return
    try {
      await adminPointsApi.deleteProduct(p.id)
      toast.success("已删除")
      await load({ keepConfig: true })
      notifyAttentionChanged() // 若删的是待审核商品，角标当场减一
    } catch (err) {
      toast.error(errMsg(err, "删除失败"))
    }
  }

  // ---- 用户商品订单：结算 / 退款 ----

  const settleOrder = async (o: PointOrder) => {
    if (!confirm(`把 ${o.price} 积分结算给卖家「${o.sellerName ?? "?"}」？\n\n结算后积分归卖家，撤销要走退款流程。`)) return
    try {
      await adminPointsApi.settleOrder(o.id)
      toast.success("已结算给卖家")
      await load({ keepConfig: true })
      notifyAttentionChanged()
    } catch (err) {
      toast.error(errMsg(err, "结算失败"))
    }
  }

  const cancelOrder = async (o: PointOrder) => {
    const extra =
      o.status === "settled"
        ? `\n\n⚠️ 这单已经结算给卖家了，会先从卖家账上收回 ${o.price} 积分；卖家积分不够会失败。`
        : ""
    const reason = prompt(
      `取消订单「${o.productName}」并把 ${o.price} 积分退回买家 ${o.username}？${extra}\n\n可以填一句原因（会显示在订单备注里）：`,
      ""
    )
    if (reason === null) return
    try {
      await adminPointsApi.cancelOrder(o.id, reason.trim() || undefined)
      toast.success("已取消并退款")
      await load({ keepConfig: true })
      notifyAttentionChanged()
    } catch (err) {
      toast.error(errMsg(err, "取消失败"))
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
            <CardTitle className="text-base">商品（官方）</CardTitle>
            <CardDescription>
              用户花积分购买。「兑换中转站余额」是内置的第一行，兑换比例就在它的「编辑」里改。
              交付方式「自动充值」需要用户已开通中转站；「人工发放」会生成待发放订单。
              商品可以设成租用（付一次用 N 天，到期自动收回权限；续费会顺延剩余天数）。
              用户自己上架的商品在下面单独一块，走审核流程，不能在这里直接编辑。
            </CardDescription>
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
              捐献奖励
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInviteOpen(true)}
              disabled={loading}
            >
              <Users className="mr-1.5 h-3.5 w-3.5" />
              邀请奖励
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load({ keepConfig: true })} disabled={loading}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              新建商品
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <LoadingBlock />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="table-actions-sticky w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">商品</th>
                    <th className="px-3 py-2 text-left font-medium">售价</th>
                    <th className="px-3 py-2 text-left font-medium">库存</th>
                    <th className="px-3 py-2 text-left font-medium">限购</th>
                    <th className="px-3 py-2 text-left font-medium">计费</th>
                    <th className="px-3 py-2 text-left font-medium">交付</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
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
                            兑换中转站余额
                            <Badge variant="outline" className="text-[10px]">
                              内置
                            </Badge>
                          </p>
                          <p className="max-w-xs text-xs text-muted-foreground">
                            用户自己填积分数，按比例换成中转站余额
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <p className="tabular-nums">
                        1 积分 = ¥{fmtMoney(data?.config.yuanPerPoint ?? 1)}
                      </p>
                      <p className="text-xs text-muted-foreground">金额自选</p>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">不限</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {(data?.config.dailyLimit ?? 0) > 0
                        ? `${data?.config.dailyLimit} 次/人/天`
                        : "不限"}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">买断</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">自动充值</td>
                    <td className="px-3 py-2">
                      {data?.config.enabled ? (
                        <Badge variant="success" className="text-[10px]">
                          已上架
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          已下架
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
                          编辑
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void toggleRedeemEnabled()}>
                          {data?.config.enabled ? "下架" : "上架"}
                        </Button>
                      </div>
                    </td>
                  </tr>

                  {products.length === 0 && (
                    <tr className="border-t">
                      <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        还没有上架商品，点右上角「新建商品」加一件吧。
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
                      <td className="px-3 py-2 tabular-nums">{p.price} 积分</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {p.stock === null ? "不限" : p.stock}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {p.perUserLimit === null ? "不限" : `${p.perUserLimit} 件/人`}
                      </td>
                      <td className="px-3 py-2">
                        {p.billingMode === "rental" ? (
                          <Badge variant="secondary" className="text-[10px]">
                            <CalendarClock className="mr-0.5 h-2.5 w-2.5" />
                            {rentalTerm(p.rentalDays)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">买断</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {deliveryText(p.delivery, p.quotaYuan)}
                      </td>
                      <td className="px-3 py-2">
                        {p.enabled ? (
                          <Badge variant="success" className="text-[10px]">
                            已上架
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            已下架
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                            <Pencil className="mr-1 h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void toggleEnabled(p)}>
                            {p.enabled ? "下架" : "上架"}
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
              用户上架的商品
              {pendingReviews > 0 && (
                <Badge variant="default" className="text-[10px]">
                  {pendingReviews} 件待审核
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              用户自己挂的东西，只能人工交付；<span className="text-foreground">审核通过后</span>
              才会出现在用户端的「用户们的商城」里。别人买下的积分先由平台保管，
              卖家发货、买家确认收货后才结算给卖家。
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load({ keepConfig: true })} disabled={loading}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            刷新
          </Button>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <LoadingBlock />
          ) : userProducts.length === 0 ? (
            <EmptyState
              icon={Store}
              title="还没有用户上架商品"
              description="用户在「积分与商城 → 用户们的商城」里点「上传商品」就能提交，之后会出现在这里等你审核。"
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="table-actions-sticky w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">商品</th>
                    <th className="px-3 py-2 text-left font-medium">卖家</th>
                    <th className="px-3 py-2 text-left font-medium">售价</th>
                    <th className="px-3 py-2 text-left font-medium">库存</th>
                    <th className="px-3 py-2 text-left font-medium">审核</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {userProducts.map((p) => {
                    const rv = REVIEW_STATUS[p.reviewStatus] ?? REVIEW_STATUS.pending
                    return (
                      <tr key={p.id} className="border-t">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2.5">
                            <ProductThumb product={p} />
                            <div className="min-w-0">
                              <p className="font-medium">
                                {p.name}
                                {!p.enabled && (
                                  <span className="ml-1.5 text-xs text-muted-foreground">
                                    （已下架）
                                  </span>
                                )}
                              </p>
                              {p.description && (
                                <p className="max-w-xs truncate text-xs text-muted-foreground">
                                  {p.description}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{p.ownerName ?? "—"}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {p.price} 积分
                          {p.billingMode === "rental" && (
                            <Badge variant="secondary" className="ml-1.5 text-[10px]">
                              {rentalTerm(p.rentalDays)}
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {p.stock === null ? "不限" : p.stock}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={rv.variant} className="text-[10px]">
                            {rv.label}
                          </Badge>
                          {p.reviewNote && (
                            <p className="mt-0.5 max-w-[14rem] truncate text-[10px] text-muted-foreground">
                              {p.reviewNote}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1.5">
                            {p.reviewStatus !== "approved" && (
                              <Button size="sm" onClick={() => openReview(p, true)}>
                                <Check className="mr-1 h-3.5 w-3.5" />
                                通过
                              </Button>
                            )}
                            {p.reviewStatus !== "rejected" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openReview(p, false)}
                              >
                                <X className="mr-1 h-3.5 w-3.5" />
                                拒绝
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => void removeUserProduct(p)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
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

      {/* 订单 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">订单</CardTitle>
            <CardDescription>
              积分在下单时已经扣掉。官方商品：「待发放」需要你处理完再点标记；
              用户商品走担保 —— 卖家交付、买家确认后才把积分结算给卖家，你这里可以强制结算或取消退款。
              租用订单会显示租期与到期时间，到期由系统自动收回权益并归还库存。
            </CardDescription>
          </div>
          <Select value={orderStatus} onValueChange={setOrderStatus}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">待处理</SelectItem>
              <SelectItem value="delivered">已交付</SelectItem>
              <SelectItem value="settled">已结算</SelectItem>
              <SelectItem value="cancelled">已取消</SelectItem>
              <SelectItem value="all">全部</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <LoadingBlock />
          ) : orders.length === 0 ? (
            <EmptyState icon={Coins} title="没有订单" description="这个筛选下还没有订单。" />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="table-actions-sticky w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">用户</th>
                    <th className="px-3 py-2 text-left font-medium">商品</th>
                    <th className="px-3 py-2 text-left font-medium">积分</th>
                    <th className="px-3 py-2 text-left font-medium">租期</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                    <th className="px-3 py-2 text-left font-medium">时间</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
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
                              ? `用户商品 · 卖家 ${o.sellerName ?? "?"}`
                              : o.delivery === "quota"
                                ? "自动充值"
                                : (DELIVERY_LABELS[o.delivery as PointDelivery] ?? "人工发放")}
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
                            {orderStatusText(o.status, isUserOrder)}
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
                                    结算给卖家
                                  </Button>
                                )}
                                {!closed && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => void cancelOrder(o)}
                                  >
                                    取消退款
                                  </Button>
                                )}
                                {closed && (
                                  <span className="text-xs text-muted-foreground">
                                    {o.settledAt
                                      ? `结算于 ${fmtDateTime(o.settledAt)}`
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
                                标记已发放
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

      {/* 标记发放 */}
      <Dialog
        open={!!deliverTarget}
        onOpenChange={(o) => {
          if (!o && !deliverBusy) setDeliverTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>标记已发放 · {deliverTarget?.productName}</DialogTitle>
            <DialogDescription>
              {deliverTarget?.username} 用 {deliverTarget?.price} 积分购买。
              积分已经扣过了，这里只是把订单标成已处理。
              {deliverTarget?.billingMode === "rental" && (
                <> 这是租用订单：租期从你点「确认发放」这一刻起算（{deliverTarget.rentalDays ?? "?"} 天）。</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="deliverNote">备注（可选，用户可见）</Label>
            <Input
              id="deliverNote"
              placeholder="如：已发到你的注册邮箱"
              value={deliverNote}
              onChange={(e) => setDeliverNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeliverTarget(null)} disabled={deliverBusy}>
              取消
            </Button>
            <Button onClick={() => void submitDeliver()} disabled={deliverBusy}>
              {deliverBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              确认发放
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
              {reviewApprove ? "通过审核" : "拒绝"} · {reviewTarget?.name}
            </DialogTitle>
            <DialogDescription>
              {reviewTarget?.ownerName ?? "该用户"} 上架，售价 {reviewTarget?.price} 积分
              {reviewTarget?.billingMode === "rental"
                ? `，租期 ${reviewTarget.rentalDays ?? "?"} 天`
                : ""}
              。
              {reviewApprove
                ? "通过后商品会立刻出现在用户端的「用户们的商城」里。"
                : "拒绝后用户能看到你填的理由，可以改完重新提交。"}
              {reviewTarget?.billingMode === "rental" &&
                " 这是租用商品：交付后按上面的天数计租，到期后由买卖双方自行协商归还。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reviewNote">
              {reviewApprove ? "备注（可选，用户可见）" : "拒绝理由（建议填，用户可见）"}
            </Label>
            <Textarea
              id="reviewNote"
              rows={3}
              maxLength={200}
              placeholder={
                reviewApprove ? "如：已核对，可以上架" : "如：商品描述与实际不符 / 属于站内不允许交易的类型"
              }
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewTarget(null)} disabled={reviewBusy}>
              取消
            </Button>
            <Button
              variant={reviewApprove ? "default" : "destructive"}
              onClick={() => void submitReview()}
              disabled={reviewBusy}
            >
              {reviewBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {reviewApprove ? "确认通过" : "确认拒绝"}
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
            <DialogTitle>捐献奖励积分</DialogTitle>
            <DialogDescription>
              捐献审核通过（或反代账号绑定成功）后自动发放给捐献者。填 0 = 该类型不发。
            </DialogDescription>
          </DialogHeader>

          {donationList.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              没有取到档位清单，请刷新后重试。
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
                    <span className="text-xs text-muted-foreground">积分</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {donationList.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor="dp-daily" className="font-normal">
                  每人每日发放上限
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  同一个人一天最多领几次捐献分，填 0 = 不限
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
                <span className="text-xs text-muted-foreground">次/天</span>
              </div>
            </div>
          )}

          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">发放次数：</span>
              每通过一笔新捐献就发一次 —— 这是用户可重复赚积分的通道。
              AI 渠道 / 商汤 Key / 内网穿透 / 代理节点按捐献单据计（同一笔单据被重复审核
              不会重复发，但用户再捐一份新资源会再发一次）；
              反代账号按每次新绑定计，上限由「最多绑定几个账号」天然限制。
            </p>
            <p>
              <span className="font-medium text-foreground">每日上限：</span>
              这是防刷分的硬顶 —— 同一个人一天领满这么多笔后，再捐也不发分
              （捐献照样通过、权限照给，只是不发分，次日恢复）。填 0 就是不限。
            </p>
            <p>
              <span className="font-medium text-foreground">这个值直接影响发放量：</span>
              用户能按兑换比例把积分换成 AI 中转站余额，调高之前先想清楚。
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDonationOpen(false)} disabled={donationBusy}>
              取消
            </Button>
            <Button onClick={() => void saveDonationRewards()} disabled={donationBusy}>
              {donationBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              保存
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
            <DialogTitle>邀请奖励</DialogTitle>
            <DialogDescription>
              发给「邀请人」的两笔积分：好友注册时的固定奖励，以及好友之后赚分时的返佣。
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">开启邀请奖励</p>
              <p className="text-xs text-muted-foreground">
                {inviteForm.enabled
                  ? "已开启：每次有效邀请都会真实增发积分"
                  : "已关闭：邀请不发放任何积分"}
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
                  每邀请 1 个好友
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  每个被邀请人只发一次，填 0 = 不发
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
                <span className="text-xs text-muted-foreground">积分</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor="ip-pct" className="font-normal">
                  好友赚分的返佣比例
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  好友每赚一笔积分（捐献 / 活动），你抽成百分之几，填 0 = 关闭
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
                  每人每日上限
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  一个人一天最多通过邀请拿多少分（奖励 + 返佣合计），填 0 = 不限
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
                <span className="text-xs text-muted-foreground">积分/天</span>
              </div>
            </div>

            <div className="flex items-start justify-between gap-3 border-t pt-3">
              <div className="min-w-0 flex-1">
                <Label className="font-normal">只算「真正消耗了次数」的邀请</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  关掉之后，限时开放注册期间的普通邀请码也会发奖励 —— 那种码可以无限复用，
                  等于随便注册小号白拿钱，强烈建议保持开启。
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
              <span className="font-medium text-foreground">换算成钱：</span>
              当前 1 积分 = ¥{fmtMoney(data?.config.yuanPerPoint ?? 1)}，
              所以每邀请 1 人 = ¥
              {fmtMoney((inviteForm.perFriend || 0) * (data?.config.yuanPerPoint ?? 1))}。
              这笔钱是通过「兑换中转站余额」真实发出去的（AI 上游成本），
              改数字前先算一下预期邀请量。
            </p>
            <p>
              <span className="font-medium text-foreground">返佣只算一级：</span>
              只认直接邀请人，且不返佣「邀请奖励」本身（否则 A→B→C 会层层抽成，
              积分总额指数膨胀）。管理员手动发的分、用户商城的卖家收益也不参与返佣。
            </p>
            <p>
              <span className="font-medium text-foreground">防小号：</span>
              注册只要一个邮箱。不设每日上限 + 关掉上面那道闸，就存在「自己注册小号刷分」的路径。
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={inviteBusy}>
              取消
            </Button>
            <Button onClick={() => void saveInviteRewards()} disabled={inviteBusy}>
              {inviteBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              保存
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
            <DialogTitle>编辑 · 兑换中转站余额</DialogTitle>
            <DialogDescription>
              这是商城里的内置商品：用户自己填积分数，按下面的比例换成 AI 中转站余额。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">上架（开放兑换）</p>
                <p className="text-xs text-muted-foreground">
                  关掉后用户仍能看到余额与明细，但不能兑换 —— 已发放的积分不会消失。
                </p>
              </div>
              <Switch checked={cfgEnabled} onCheckedChange={setCfgEnabled} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pointsYuanPerPoint">兑换比例（每 1 积分 = ? 元）</Label>
              <Input
                id="pointsYuanPerPoint"
                inputMode="decimal"
                value={cfgRatio}
                onChange={(e) => setCfgRatio(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                填 1 就是「1 积分 = 1 元」，填 10 就是「1 积分 = 10 元」，可以填小数（如 0.5）。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pointsDailyLimit">每人每日兑换次数上限</Label>
              <Input
                id="pointsDailyLimit"
                inputMode="numeric"
                value={cfgDaily}
                onChange={(e) => setCfgDaily(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                默认 5，填 0 = 不限。兑换会真实调用中转站加额度，建议保留上限防刷。
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRedeemOpen(false)} disabled={cfgBusy}>
              取消
            </Button>
            <Button onClick={() => void saveConfig()} disabled={cfgBusy}>
              {cfgBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建 / 编辑商品 */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !formBusy && setDialogOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑商品" : "新建商品"}</DialogTitle>
            <DialogDescription>售价按积分填；留空的库存 / 限购表示不限。</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="pdName">名称</Label>
              <Input
                id="pdName"
                maxLength={40}
                placeholder="如：10 元中转站充值"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pdDesc">说明（可选）</Label>
              <Textarea
                id="pdDesc"
                rows={3}
                maxLength={500}
                placeholder="给用户看的补充说明，如发放时间、注意事项"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="pdImage">封面图（可选）</Label>
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

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="pdPrice">售价（积分）</Label>
                <Input
                  id="pdPrice"
                  inputMode="numeric"
                  placeholder="100"
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pdStock">库存（留空 = 不限）</Label>
                <Input
                  id="pdStock"
                  inputMode="numeric"
                  placeholder="不限"
                  value={form.stock}
                  onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pdLimit">每人限购（留空 = 不限）</Label>
                <Input
                  id="pdLimit"
                  inputMode="numeric"
                  placeholder="不限"
                  value={form.perUserLimit}
                  onChange={(e) => setForm((f) => ({ ...f, perUserLimit: e.target.value }))}
                />
              </div>
            </div>

            {/* 计费方式：买断 / 租用。放在交付方式之前，因为租用会限制可选的交付方式 */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">租用模式</p>
                  <p className="text-xs text-muted-foreground">
                    开启后用户付一次积分用一段时间，到期自动失效（续费会顺延剩余天数）；
                    关闭则是买断，永久拥有。
                  </p>
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
                  <Label htmlFor="pdDays">租期（天）</Label>
                  <Input
                    id="pdDays"
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
                  <p className="text-xs text-muted-foreground">
                    租期从「交付生效」那一刻起算（自动交付 = 下单成功；人工发放 = 你点标记发放），
                    不是从下单起算 —— 免得中间等待时间白吃用户的租期。
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>交付方式</Label>
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
                      title={blockedByRental ? "一次性发放，不能设为租用" : undefined}
                      onClick={() => setForm((f) => ({ ...f, delivery: d }))}
                    >
                      {DELIVERY_LABELS[d]}
                    </Button>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">{DELIVERY_HINTS[form.delivery]}</p>
              {form.billingMode === "rental" && (
                <p className="text-xs text-muted-foreground">
                  「自动充值」和「邀请码额度」发出去就收不回来，租用模式下不可选。
                </p>
              )}
            </div>

            {form.delivery === "quota" && (
              <div className="space-y-2">
                <Label htmlFor="pdQuota">每件充入金额（元）</Label>
                <Input
                  id="pdQuota"
                  inputMode="decimal"
                  placeholder="如 10"
                  value={form.quotaYuan}
                  onChange={(e) => setForm((f) => ({ ...f, quotaYuan: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  下单时会自动加到用户的 AI 中转站余额；用户没开通中转站时无法购买。
                </p>
              </div>
            )}

            {form.delivery === "feature" && (
              <div className="space-y-2">
                <Label htmlFor="pdFeature">授予哪个模块</Label>
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
                  下单后自动给用户开通该模块。用户已经有了这个权限时会直接拒绝下单，不会白扣积分。
                </p>
              </div>
            )}

            {form.delivery === "subscription" && (
              <div className="space-y-2">
                <Label htmlFor="pdPlan">中转站套餐 ID</Label>
                <Input
                  id="pdPlan"
                  inputMode="numeric"
                  placeholder="如 2"
                  value={form.planId}
                  onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  填 NewAPI 后台「订阅套餐」列表里的那个数字 ID。这里不写死任何套餐，
                  你建几个就能填几个。
                </p>
              </div>
            )}

            {form.delivery === "invite_quota" && (
              <div className="space-y-2">
                <Label htmlFor="pdInvite">发放额度（个）</Label>
                <Input
                  id="pdInvite"
                  inputMode="numeric"
                  placeholder="如 2"
                  value={form.inviteCount}
                  onChange={(e) => setForm((f) => ({ ...f, inviteCount: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  下单后加到用户的「邀请码创建额度」上，也就是他能建多少个邀请码。
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pdSort">排序（越大越靠前）</Label>
                <Input
                  id="pdSort"
                  inputMode="numeric"
                  value={form.sort}
                  onChange={(e) => setForm((f) => ({ ...f, sort: e.target.value }))}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <p className="text-sm font-medium">上架</p>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={formBusy}>
              取消
            </Button>
            <Button onClick={() => void submitForm()} disabled={formBusy}>
              {formBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------- 成员

function MembersTab() {
  const [data, setData] = React.useState<AdminPointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState("")

  // 发放/扣减弹窗
  const [adjustTarget, setAdjustTarget] = React.useState<AdminPointsUser | null>(null)
  const [delta, setDelta] = React.useState("")
  const [detail, setDetail] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  // 流水弹窗
  const [historyTarget, setHistoryTarget] = React.useState<AdminPointsUser | null>(null)
  const [history, setHistory] = React.useState<PointTransaction[] | null>(null)
  const [historyLoading, setHistoryLoading] = React.useState(false)

  const load = React.useCallback(async (q?: string) => {
    setLoading(true)
    try {
      setData(await adminPointsApi.list(q?.trim() || undefined))
    } catch (err) {
      toast.error(errMsg(err, "加载积分数据失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const openAdjust = (u: AdminPointsUser) => {
    setAdjustTarget(u)
    setDelta("")
    setDetail("")
  }

  const submitAdjust = async () => {
    if (!adjustTarget) return
    const value = Math.trunc(Number(delta))
    if (!Number.isFinite(value) || value === 0) {
      toast.error("请填写非零整数（正数发放、负数扣减）")
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
        `已${value > 0 ? "发放" : "扣减"} ${Math.abs(value)} 积分，${adjustTarget.username} 当前余额 ${res.balance}`
      )
      setAdjustTarget(null)
      await load(query)
    } catch (err) {
      toast.error(errMsg(err, "操作失败"))
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
      toast.error(errMsg(err, "加载流水失败"))
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
          { label: "累计发放", value: data?.stats.issued ?? 0 },
          { label: "累计消耗（兑换 + 商城）", value: data?.stats.redeemed ?? 0 },
          { label: "用户商城成交额", value: data?.stats.traded ?? 0 },
          { label: "用户在手总量", value: data?.stats.holding ?? 0 },
          { label: "持有积分人数", value: data?.stats.holders ?? 0 },
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
            void load(query)
          }}
        >
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索用户名 / 昵称 / 邮箱后回车"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <Button variant="outline" size="sm" onClick={() => void load(query)} disabled={loading}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          刷新
        </Button>
      </div>

      {/* 列表 */}
      {loading && !data ? (
        <LoadingBlock />
      ) : !data || data.users.length === 0 ? (
        <EmptyState
          icon={Coins}
          title="没有匹配的用户"
          description={query ? "换个关键词再试，或清空搜索看全部。" : "还没有用户数据。"}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="table-actions-sticky w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="w-16 px-3 py-2 text-left font-medium">UID</th>
                <th className="px-3 py-2 text-left font-medium">用户</th>
                <th className="px-3 py-2 text-left font-medium">邮箱</th>
                <th className="px-3 py-2 text-left font-medium">注册时间</th>
                <th className="px-3 py-2 text-left font-medium">积分余额</th>
                <th className="px-3 py-2 text-left font-medium">最近变动</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
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
                          已停用
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
                        调整
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openHistory(u)}>
                        流水
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 发放 / 扣减 */}
      <Dialog open={!!adjustTarget} onOpenChange={(o) => !o && setAdjustTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>调整积分 · {adjustTarget?.username}</DialogTitle>
            <DialogDescription>
              当前余额 <span className="font-medium text-foreground">{adjustTarget?.balance ?? 0}</span>{" "}
              积分。正数发放、负数扣减；扣减不能超过余额。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="adjDelta">变动值</Label>
              <Input
                id="adjDelta"
                type="number"
                placeholder="如 100 表示发放 100，-50 表示扣减 50"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adjDetail">备注（可选，用户可见）</Label>
              <Input
                id="adjDetail"
                placeholder="如：活动补发 / 问题补偿"
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
              取消
            </Button>
            <Button onClick={() => void submitAdjust()} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 流水 */}
      <Dialog open={!!historyTarget} onOpenChange={(o) => !o && setHistoryTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>积分流水 · {historyTarget?.username}</DialogTitle>
            <DialogDescription>最近 100 条记录</DialogDescription>
          </DialogHeader>
          {historyLoading ? (
            <LoadingBlock />
          ) : !history || history.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">暂无流水记录。</p>
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {history.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{t.detail || REASON_LABEL[t.reason] || t.reason}</p>
                    <p className="text-xs text-muted-foreground">{fmtDateTime(t.createdAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {t.delta > 0 ? `+${t.delta}` : t.delta}
                    </p>
                    <p className="text-[10px] text-muted-foreground">余额 {t.balance}</p>
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
