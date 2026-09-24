import * as React from "react"
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Heart,
  Loader2,
  Plus,
  Send,
  Ticket,
  Trash2,
  Unplug,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { donationApi, myInviteApi, voucherApi, wb2apiApi, HttpError } from "@/services/api"
import { fmtTime } from "@/lib/format"
import type {
  AiProbeResult,
  DonationOverview,
  MyInvite,
  MyInvitesOverview,
  Permissions,
  VoucherOverview,
  Wb2ApiDonationBlock,
} from "@/types"

const TYPE_META: Record<string, { label: string; desc: string }> = {
  // 卡片标题用「AI 模型」而不是「AI 中转站」：这里捐的是模型（渠道是载体），
  // 叫「中转站」会把「站点」和「模型资源」混起来，用户容易不知道该填什么。
  ai: { label: "AI 模型", desc: "贡献一个模型渠道，让其他用户也能用" },
  frp: { label: "内网穿透", desc: "提供完整可用的 config.yml" },
  proxy: { label: "代理节点", desc: "贡献你的代理订阅链接" },
}

/**
 * AI 上游的接口格式选项。
 *
 * 上游可能只实现了其中一种 —— 用错格式会直接被拒（典型报错是 401 / 404），
 * 而报错内容通常看不出是「格式不对」。所以让用户能自己切换着试。
 * `value` 是探测时用的格式名，`channelType` 是建渠道时给 NewAPI 的类型。
 */
const AI_FORMATS: { value: string; label: string; channelType: number }[] = [
  { value: "auto", label: "自动识别（推荐）", channelType: 1 },
  { value: "openai", label: "OpenAI 兼容（/v1/chat/completions）", channelType: 1 },
  { value: "anthropic", label: "Anthropic 原生（/v1/messages）", channelType: 14 },
]

export default function DonationPage() {
  const [data, setData] = React.useState<DonationOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [dialogType, setDialogType] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await donationApi.list()
      setData(res)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // 我的邀请码（额度 + 列表）
  const [invites, setInvites] = React.useState<MyInvitesOverview | null>(null)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteCode, setInviteCode] = React.useState("")
  const [inviteFeatures, setInviteFeatures] = React.useState<string[]>([])
  const [inviteBusy, setInviteBusy] = React.useState(false)
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null)

  const loadInvites = React.useCallback(async () => {
    try {
      setInvites(await myInviteApi.list())
    } catch {
      // 静默：额度区加载失败不影响捐献主流程
    }
  }, [])

  React.useEffect(() => {
    void loadInvites()
  }, [loadInvites])

  const handleCreateInvite = async () => {
    setInviteBusy(true)
    try {
      await myInviteApi.create({
        code: inviteCode.trim() || undefined,
        features: inviteFeatures,
      })
      toast.success("邀请码已创建")
      setInviteOpen(false)
      setInviteCode("")
      setInviteFeatures([])
      await loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setInviteBusy(false)
    }
  }

  const handleDeleteInvite = async (inv: MyInvite) => {
    try {
      const res = await myInviteApi.remove(inv.id)
      toast.success(res.refunded ? "已删除，额度已退还" : "已删除（该码已被使用，额度不退还）")
      await loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode(null), 1500)
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }

  const perms = data?.permissions
  // 全部三种资源都可捐献（已解锁的用户也能主动贡献），
  // 只是未解锁的会标注出来，方便知道贡献哪个能解锁什么。
  const allTypes = data ? Object.entries(data.typeLabels) : []

  return (
    <div>
      <PageHeader title="捐献" description="贡献资源，解锁功能权限" />

      <Wb2ApiDonationCard
        block={data?.wb2api}
        aiUnlocked={perms?.ai ?? false}
        onDone={() => void load()}
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Heart className="h-4 w-4 text-muted-foreground" />
            资源有限，按需开放
          </CardTitle>
          <CardDescription>
            站长资源有限，部分功能不会全量开放。如果你愿意贡献以下资源，
            管理员审核通过后将为你解锁对应功能权限。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            你的
            <span className="text-foreground">首次捐献成功</span>
            会额外赠送一张「自选权限」兑换码 —— 可以自己拿来开通任意一个还没开的模块，
            也可以送给别人。
          </div>
          {allTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            allTypes.map(([type, label]) => {
              const unlocked = perms?.[type as keyof Permissions] ?? false
              return (
              <div
                key={type}
                className="flex items-center justify-between rounded-md border px-4 py-3"
              >
                <div className="space-y-0.5">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {label}
                    {unlocked ? (
                      <Badge variant="success">已解锁</Badge>
                    ) : (
                      <Badge variant="secondary">未解锁</Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {TYPE_META[type]?.desc}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setDialogType(type)}>
                  <Plus className="h-4 w-4" />
                  贡献
                </Button>
              </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* 兑换码：放在最前面 —— 拿到码的人一进页面就要能用，
          之前排在「我的邀请码」下面（那列表很长）导致根本看不到 */}
      <RedeemCard onChanged={() => void load()} />

      {/* 我的邀请码：额度 + 创建 + 列表 */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Ticket className="h-4 w-4 text-muted-foreground" />
                我的邀请码
              </CardTitle>
              <CardDescription>
                每人默认 {invites?.quota.inviteBase ?? 3} 个额度；
                每笔捐献获批再 +2 个额度，并获得 1 个对应模块的权限额度。
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => setInviteOpen(true)}
              disabled={(invites?.quota.inviteRemaining ?? 0) < 1}
            >
              <Plus className="h-4 w-4" />
              创建
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {invites && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground">邀请码额度</p>
                  <p className="mt-1 text-lg font-semibold">
                    {invites.quota.inviteRemaining}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      / {invites.quota.inviteTotal}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    基础 {invites.quota.inviteBase} + 捐献 {invites.quota.inviteBonus}
                  </p>
                </div>
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground">模块权限额度（可转授）</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {invites.quotaFeatures.map((f) => {
                      const isBasic = invites.basicFeatures?.includes(f) ?? false
                      const remain =
                        invites.quota.featureRemaining[
                          f as keyof typeof invites.quota.featureRemaining
                        ]
                      return (
                        <span key={f} className="text-sm">
                          {invites.featureLabels[f]}
                          {isBasic ? (
                            <Badge variant="outline" className="ml-1.5 align-middle">
                              基础
                            </Badge>
                          ) : (
                            <span
                              className={
                                'ml-1 font-semibold ' +
                                (remain > 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-muted-foreground')
                              }
                            >
                              {remain}
                            </span>
                          )}
                        </span>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    基础权限模块人人可授，不消耗额度；受限模块勾选时会消耗对应额度
                  </p>
                </div>
              </div>

              {invites.invites.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  还没有创建过邀请码。
                </p>
              ) : (
                <div className="divide-y rounded-md border">
                  {invites.invites.map((inv) => {
                    const extra = invites.quotaFeatures.filter(
                      (f) => inv.permissions[f as keyof Permissions]
                    )
                    const used = inv.usedCount >= inv.maxUses
                    return (
                      <div
                        key={inv.id}
                        className="flex flex-wrap items-center gap-2 px-4 py-2.5"
                      >
                        <span className="font-mono text-sm">{inv.code}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => void copyCode(inv.code)}
                          title="复制"
                        >
                          {copiedCode === inv.code ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Badge variant="outline">域名 · 邮箱 · 名片</Badge>
                        {extra.map((f) => (
                          <Badge
                            key={f}
                            variant={
                              invites.basicFeatures?.includes(f)
                                ? "outline"
                                : "secondary"
                            }
                          >
                            {invites.featureLabels[f]}
                          </Badge>
                        ))}
                        <Badge variant={used ? 'destructive' : 'success'}>
                          {used ? '已使用' : '未使用'}
                        </Badge>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {fmtTime(inv.createdAt)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteInvite(inv)}
                          title={used ? '删除（额度不退还）' : '删除并退还额度'}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <LoadingBlock />
      ) : (data?.donations.length ?? 0) === 0 ? (
        <EmptyState icon={Heart} title="还没有捐献记录" description="贡献资源后，记录会显示在这里。" />
      ) : (
        <div className="space-y-3">
          {data!.donations.map((d) => (
            <Card key={d.id}>
              <CardHeader className="flex flex-row items-start justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-base">
                    {TYPE_META[d.type]?.label ?? d.type}
                  </CardTitle>
                  <CardDescription>{fmtTime(d.createdAt)}</CardDescription>
                </div>
                <Badge
                  variant={
                    d.status === "approved" ? "success" : d.status === "rejected" ? "destructive" : "secondary"
                  }
                >
                  {d.status === "approved" ? "已通过" : d.status === "rejected" ? "未通过" : "待审核"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.autoReviewed && (
                  <Badge variant="outline">
                    {d.status === "approved" ? "系统自动校验通过" : "系统自动校验未通过"}
                  </Badge>
                )}
                {d.channelId !== null && d.channelId !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    已接入中转站渠道 #{d.channelId}
                  </p>
                )}
                {d.remark && <p className="text-sm text-muted-foreground">备注：{d.remark}</p>}
                {d.reviewNote && (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    审核回复：{d.reviewNote}
                  </p>
                )}
                {d.status === "pending" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await donationApi.cancel(d.id)
                        toast.success("已撤销")
                        void load()
                      } catch (err) {
                        toast.error(err instanceof HttpError ? err.message : "撤销失败")
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    撤销申请
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialogType && (
        <DonationForm
          type={dialogType}
          maxModels={data?.maxAiModels ?? 30}
          maxSubUrls={data?.maxSubUrls ?? 8}
          onClose={() => setDialogType(null)}
          onSubmitted={() => {
            setDialogType(null)
            void load()
          }}
        />
      )}

      {/* 创建邀请码 */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建邀请码</DialogTitle>
            <DialogDescription>
              基础权限含域名、邮箱、个人名片，以及标记为「基础」的模块（不消耗额度）。
              勾选受限模块会消耗对应额度。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invCode">邀请码（留空自动生成）</Label>
              <Input
                id="invCode"
                placeholder="DC-XXXX-XXXX"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>附加模块权限</Label>
              {invites?.quotaFeatures.map((f) => {
                const isBasic = invites.basicFeatures?.includes(f) ?? false
                const remain =
                  invites.quota.featureRemaining[
                    f as keyof typeof invites.quota.featureRemaining
                  ]
                const checked = inviteFeatures.includes(f)
                // 基础权限模块无需额度，始终可勾选
                const disabled = !checked && !isBasic && remain < 1
                return (
                  <label
                    key={f}
                    className={
                      'flex items-center gap-3 rounded-md border px-4 py-2.5 ' +
                      (disabled ? 'opacity-50' : 'cursor-pointer')
                    }
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) =>
                        setInviteFeatures((prev) =>
                          e.target.checked
                            ? [...prev, f]
                            : prev.filter((x) => x !== f)
                        )
                      }
                    />
                    <span className="flex-1 text-sm">
                      {invites.featureLabels[f]}
                    </span>
                    {isBasic ? (
                      <Badge variant="outline">基础权限</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        剩余 {remain}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              本次将消耗 1 个邀请码额度
              {inviteFeatures.length > 0 &&
                `，以及 ${
                  inviteFeatures.filter(
                    (f) => !(invites?.basicFeatures?.includes(f) ?? false)
                  ).length
                } 个受限模块额度`}
              。当前剩余 {invites?.quota.inviteRemaining ?? 0} 个邀请码额度。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateInvite()} disabled={inviteBusy}>
              {inviteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DonationForm({
  type,
  maxModels,
  maxSubUrls,
  onClose,
  onSubmitted,
}: {
  type: string
  /** AI 类型一次最多能选多少个模型（每个都要真调一次验证可用性） */
  maxModels: number
  /** 代理类型一次最多能提交多少个订阅链接（每个都要真拉一次） */
  maxSubUrls: number
  onClose: () => void
  onSubmitted: () => void
}) {
  const meta = TYPE_META[type]
  const [busy, setBusy] = React.useState(false)
  const [remark, setRemark] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [configYml, setConfigYml] = React.useState("")
  const [subUrls, setSubUrls] = React.useState("")

  // ---- AI 捐献：探测上游 → 勾选模型 ----
  const [probing, setProbing] = React.useState(false)
  const [probe, setProbe] = React.useState<AiProbeResult | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [filter, setFilter] = React.useState("")
  /**
   * 接口格式。
   *   auto      = 两种都试（先 OpenAI 再 Anthropic），用能读到模型列表的那个
   *   openai    = 只按 OpenAI 兼容试
   *   anthropic = 只按 Anthropic 原生试
   *
   * 之所以让用户能手动指定：有的上游**只实现了 Anthropic 原生接口**，
   * 用 OpenAI 格式去调一定失败，但自动识别时也只会在最后一个候选里报错，
   * 用户需要能自己试出来是哪种。
   */
  const [format, setFormat] = React.useState<"auto" | "openai" | "anthropic">("auto")
  /** 提交时带上的渠道类型；缺省 OpenAI 兼容 */
  const [channelType, setChannelType] = React.useState(1)
  /** 探测失败时的兜底：手填模型名，进管理员的「人工复核」队列 */
  const [manual, setManual] = React.useState(false)
  const [manualModels, setManualModels] = React.useState("")

  const handleProbe = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      toast.error("请先填写 Base URL 和 API Key")
      return
    }
    setProbing(true)
    try {
      const res = await donationApi.probeAi({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        format,
      })
      setProbe(res)
      if (res.ok) {
        // 服务端会给归一化后的地址（去掉尾部 /v1），回填让用户看到真正会用的那个
        setBaseUrl(res.baseUrl)
        if (res.channelType !== null) setChannelType(res.channelType)
        setSelected([])
        setManual(false)
        toast.success(
          `识别为「${res.channelTypeName}」，共 ${res.models.length} 个模型`
        )
      } else {
        setManual(true)
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "探测失败")
    } finally {
      setProbing(false)
    }
  }

  const toggleModel = (m: string) => {
    setSelected((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m)
      if (prev.length >= maxModels) {
        toast.info(`一次最多选 ${maxModels} 个模型（每个都要真实调用一次验证可用性）`)
        return prev
      }
      return [...prev, m]
    })
  }

  /** 全选：超过上限时只取前 N 个并说明原因，不静默截断 */
  const selectAll = () => {
    const all = probe?.models ?? []
    if (all.length > maxModels) {
      setSelected(all.slice(0, maxModels))
      toast.info(`共 ${all.length} 个模型，一次最多捐 ${maxModels} 个，已为你选上前 ${maxModels} 个`)
    } else {
      setSelected(all)
    }
  }

  const handleSubmit = async () => {
    setBusy(true)
    try {
      let payload: unknown
      if (type === "ai") {
        if (!baseUrl.trim() || !apiKey.trim()) {
          toast.error("请填写 Base URL 和 API Key")
          setBusy(false)
          return
        }
        const models = manual
          ? manualModels
              .split(/[\n,]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : selected
        if (models.length === 0) {
          toast.error(manual ? "请填写至少一个模型名" : "请至少选择一个要捐献的模型")
          setBusy(false)
          return
        }
        if (models.length > maxModels) {
          toast.error(`一次最多捐献 ${maxModels} 个模型（当前 ${models.length} 个）`)
          setBusy(false)
          return
        }
        payload = {
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          models,
          channelType,
          ...(manual ? { manualModels: true } : {}),
        }
      } else if (type === "frp") {
        if (!configYml.trim()) {
          toast.error("请粘贴 config.yml")
          setBusy(false)
          return
        }
        payload = { configYml: configYml.trim() }
      } else {
        const urls = subUrls.split("\n").map((s) => s.trim()).filter(Boolean)
        if (urls.length === 0) {
          toast.error("请填写至少一个订阅链接")
          setBusy(false)
          return
        }
        if (urls.length > maxSubUrls) {
          toast.error(`一次最多提交 ${maxSubUrls} 个订阅链接（当前 ${urls.length} 个）`)
          setBusy(false)
          return
        }
        payload = { subUrls: urls }
      }

      const res = await donationApi.create({
        type: type as "ai" | "frp" | "proxy",
        payload,
        remark,
      })

      // AI 与代理都是自动化流程，提交后当场就有结论
      if (res.status === "approved") {
        const okMsg =
          type === "ai"
            ? "校验通过，渠道已接入中转站，AI 权限已解锁"
            : type === "proxy"
              ? "校验通过，订阅已接入节点池，代理节点权限已解锁"
              : "已自动通过审核，对应功能权限已解锁"
        toast.success(okMsg, {
          description:
            [
              res.reviewNote,
              res.voucherCode
                ? `首次捐献奖励：自选权限兑换码 ${res.voucherCode}，可在下方「兑换码」里使用。`
                : "",
            ]
              .filter(Boolean)
              .join("\n") || undefined,
          duration: 12000,
        })
      } else if (res.status === "rejected") {
        toast.error("未通过自动校验", {
          // 后端会把「哪个模型为什么没通过」写在这里，原样给用户看
          description: res.reviewNote ?? "已转人工复核，管理员会跟进",
          duration: 10000,
        })
      } else {
        toast.success("捐献申请已提交，请等待管理员审核", {
          description: res.reviewNote ?? undefined,
        })
      }
      onSubmitted()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "提交失败")
    } finally {
      setBusy(false)
    }
  }

  const visibleModels = probe?.ok
    ? probe.models.filter((m) =>
        filter.trim() ? m.toLowerCase().includes(filter.trim().toLowerCase()) : true
      )
    : []

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>捐献 · {meta?.label}</DialogTitle>
          <DialogDescription>{meta?.desc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {type === "ai" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                提交后系统会把渠道接入中转站，并
                <span className="text-foreground">逐个模型真实调用一次</span>
                验证可用性：只保留可用的（最多 {maxModels} 个），
                <span className="text-foreground">通过即当场解锁 AI 权限</span>
                ；全部不可用则拒绝并写明原因。逐个测试需要几秒到几十秒，请耐心等待。
              </div>
              <div className="space-y-2">
                <Label>Base URL</Label>
                <Input
                  placeholder="https://api.example.com"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value)
                    setProbe(null)
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  填到域名即可，末尾的 <code>/v1</code> 会自动去掉。
                </p>
              </div>
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
                    setProbe(null)
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label>接口格式</Label>
                <Select
                  value={format}
                  onValueChange={(v) => {
                    setFormat(v as typeof format)
                    const picked = AI_FORMATS.find((f) => f.value === v)
                    // 手选格式时立刻定下渠道类型；auto 则等探测结果来决定
                    if (picked && v !== "auto") setChannelType(picked.channelType)
                    // 换了格式，之前的探测结果与勾选都作废
                    setProbe(null)
                    setSelected([])
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_FORMATS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  读不到模型列表时先换一种格式再检测 —— 有的上游只实现了 Anthropic 原生接口，
                  用 OpenAI 格式去调必然失败。
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleProbe()}
                  disabled={probing || busy}
                >
                  {probing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  自动检测并获取模型
                </Button>
                {probe?.ok && (
                  <Badge variant="secondary">
                    {probe.channelTypeName} · {probe.models.length} 个模型
                  </Badge>
                )}
              </div>

              {probe?.ok && !manual && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>
                      选择要捐献的模型
                      <span className="ml-1 font-normal text-muted-foreground">
                        （已选 {selected.length} / {maxModels}）
                      </span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={selectAll}
                      >
                        全选
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected([])}
                      >
                        清空
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setManual(true)}
                      >
                        手动填写
                      </Button>
                    </div>
                  </div>
                  <Input
                    placeholder="筛选模型名…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                    {visibleModels.length === 0 ? (
                      <p className="py-3 text-center text-xs text-muted-foreground">
                        没有匹配的模型
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {visibleModels.map((m) => {
                          const on = selected.includes(m)
                          return (
                            <button
                              key={m}
                              type="button"
                              onClick={() => toggleModel(m)}
                              className={
                                "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                                (on
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border hover:bg-muted")
                              }
                            >
                              {m}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    捐献的模型在中转站里会显示为{" "}
                    <code>donation-模型名</code>，方便与其他来源区分。
                    提交时会逐个真实调用一次，<span className="text-foreground">测试不通过的模型不会被上传</span>。
                  </p>
                </div>
              )}

              {manual && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>模型名（每行一个，或逗号分隔）</Label>
                    {probe?.ok && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setManual(false)}
                      >
                        回到列表选择
                      </Button>
                    )}
                  </div>
                  <Textarea
                    rows={4}
                    className="font-mono text-xs"
                    placeholder={"gpt-4o\ndeepseek-chat"}
                    value={manualModels}
                    onChange={(e) => setManualModels(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    无法自动读取上游模型列表时才需要手填。提交后仍会尝试接入并做真实测试，
                    测试通过就自动解锁；失败则转给管理员人工复核。
                  </p>
                </div>
              )}
            </>
          )}
          {type === "frp" && (
            <div className="space-y-2">
              <Label>完整 config.yml</Label>
              <Textarea rows={10} placeholder="serverAddr: ..." value={configYml} onChange={(e) => setConfigYml(e.target.value)} className="font-mono text-xs" />
            </div>
          )}
          {type === "proxy" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                提交后系统会
                <span className="text-foreground">逐个真实拉取订阅链接</span>
                ，能解析出节点的才算有效：
                <span className="text-foreground">有可用的就自动通过并接入节点池</span>
                ，全部无效则拒绝并写明原因。一次最多 {maxSubUrls} 个链接。
              </div>
              <div className="space-y-2">
                <Label>订阅链接（每行一个）</Label>
                <Textarea
                  rows={5}
                  placeholder="https://example.com/sub/abc"
                  value={subUrls}
                  onChange={(e) => setSubUrls(e.target.value)}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  只支持 http/https 的订阅地址（不是单个节点链接）；
                  识别的协议有 vless / vmess / trojan / ss / ssr / anytls / hysteria2 / tuic。
                  节点能不能连上我们测不了（Cloudflare 出网无法对节点端口探测），
                  但「链接是否有效、拿到的是不是节点列表」会自动校验。
                </p>
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label>备注（可选）</Label>
            <Input placeholder="渠道来源、稳定性说明等" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {busy
              ? type === "ai"
                ? "正在逐个测试模型…"
                : type === "proxy"
                  ? "正在逐个校验订阅…"
                  : "提交中…"
              : type === "ai"
                ? "提交并接入中转站"
                : type === "proxy"
                  ? "提交并校验订阅"
                  : "提交申请"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 兑换码卡片。
 *
 * ⚠️ 这里把**邀请码**和**兑换券**当成同一种东西展示（后端 `GET /api/vouchers`
 * 就把两者合成一个 `codes` 列表返回）：
 *   - 发给别人：新用户拿去注册，已在站的用户拿它补权限
 *   - 给自己用：同一个按钮，补上自己还没有的模块
 * 所以卡片里不再区分「邀请码」「兑换券」，统一叫「码」。
 */
function RedeemCard({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = React.useState<VoucherOverview | null>(null)
  const [code, setCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState<string | null>(null)
  /** 每张自选码各自选了哪个模块 */
  const [choice, setChoice] = React.useState<Record<string, string>>({})

  const load = React.useCallback(async () => {
    try {
      setData(await voucherApi.list())
    } catch {
      // 静默：码区加载失败不影响捐献主流程
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const labelOf = (key: string) =>
    data?.features.find((f) => f.key === key)?.label ?? key

  const doRedeem = async (raw: string, feature?: string) => {
    const c = raw.trim()
    if (!c) {
      toast.error("请填写兑换码")
      return
    }
    setBusy(true)
    try {
      const res = await voucherApi.redeem({ code: c, feature })
      toast.success(`已开通：${res.granted.map(labelOf).join("、")}`)
      setCode("")
      await load()
      // 权限变了，让外层的捐献页重新拉一次（解锁状态会同步刷新）
      onChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "兑换失败")
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }

  const codes = data?.codes ?? []
  const available = (data?.features ?? []).filter((f) => !f.owned)

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">兑换码</CardTitle>
        <CardDescription>
          邀请码和兑换码是同一个东西：<span className="text-foreground">可以发给别人</span>
          （新用户注册，或让对方补权限），
          <span className="text-foreground">也可以给自己用</span>
          —— 把自己没有的模块开通。首次捐献成功会赠送一张「自选权限」的码。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {codes.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">我持有的码</p>
            {codes.map((c) => {
              // 自选码只有在「还有没开的模块」时才能自用；否则它是给别人准备的
              const selfSelectable = c.selfSelect && available.length > 0
              const hasFeatures = c.features.length > 0
              const canSelfUse = c.selfSelect ? selfSelectable : hasFeatures
              return (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                >
                  <span className="font-mono text-sm">{c.code}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => void copy(c.code)}
                    title="复制这个码"
                  >
                    {copied === c.code ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {c.selfSelect ? (
                    selfSelectable ? (
                      <>
                        <Badge variant="secondary">自选权限</Badge>
                        <Select
                          value={choice[c.id] ?? ""}
                          onValueChange={(val) =>
                            setChoice((prev) => ({ ...prev, [c.id]: val }))
                          }
                        >
                          <SelectTrigger className="h-8 w-44">
                            <SelectValue placeholder="选择要开通的模块" />
                          </SelectTrigger>
                          <SelectContent>
                            {available.map((f) => (
                              <SelectItem key={f.key} value={f.key}>
                                {f.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </>
                    ) : (
                      <>
                        <Badge variant="secondary">自选权限</Badge>
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          你已开通全部模块，这张码自己用不上，可以转送给别人
                        </span>
                      </>
                    )
                  ) : hasFeatures ? (
                    c.features.map((f) => (
                      <Badge key={f} variant="outline">
                        {labelOf(f)}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">仅用于注册</Badge>
                  )}
                  {c.transferable && (
                    <span className="text-xs text-muted-foreground">可发给别人</span>
                  )}
                  {canSelfUse && (
                    <Button
                      size="sm"
                      className="ml-auto"
                      disabled={busy || (c.selfSelect && !choice[c.id])}
                      onClick={() =>
                        void doRedeem(c.code, c.selfSelect ? choice[c.id] : undefined)
                      }
                    >
                      给自己开通
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="space-y-2">
          <Label>用别人的码</Label>
          <div className="flex gap-2">
            <Input
              className="font-mono"
              placeholder="VX-XXXX-XXXX，或别人给你的邀请码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button onClick={() => void doRedeem(code)} disabled={busy || !code.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              兑换
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            只会补上你还没有的权限，已有的会跳过并提示。
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * WorkBuddy 反代账号捐献卡（免审核通道）。
 *
 * 与上面三张「提交 → 管理员审核」的卡不同：这里登录成功即自动解锁 ai 权限，
 * 不需要人工审核。因此**必须让用户清楚自己在捐什么** —— 账号会进共享池被
 * 其他用户使用、会被自动化任务使用，且有封号风险，故做成强制勾选。
 */
function Wb2ApiDonationCard({
  block,
  aiUnlocked,
  onDone,
}: {
  block: Wb2ApiDonationBlock | undefined
  aiUnlocked: boolean
  onDone: () => void
}) {
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  // 通道未开启或未配置 → 整卡隐藏（避免用户点进去才发现不可用）
  if (!block || !block.enabled || !block.configured) return null

  const full = block.remaining < 1

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Unplug className="h-4 w-4 text-muted-foreground" />
          反代账号
          {aiUnlocked ? (
            <Badge variant="success">已解锁 AI 中转站</Badge>
          ) : (
            <Badge variant="secondary">未解锁</Badge>
          )}
        </CardTitle>
        <CardDescription>
          登录你自己的 WorkBuddy {block.realm === "global" ? "国际版" : "国内版"}账号，把账号贡献到共享池，
          即可解锁「AI 中转站」权限 —— 无需等待管理员审核，登录成功立即生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>
              <span className="font-medium">请务必知悉：</span>
              你的账号将<span className="font-medium">加入共享账号池，被本站其他用户使用</span>，
              并且会被站点的<span className="font-medium">自动化任务</span>
              （签到、活跃上报、旅行、奖励任务等）操作。
              这可能<span className="font-medium">违反 WorkBuddy 服务条款，并导致你的账号被封禁</span>。
              请仅在你自愿接受该后果时继续。
            </span>
          </p>
        </div>

        {block.bindings.length > 0 && (
          <div className="divide-y rounded-md border">
            {block.bindings.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-sm font-medium">
                  {b.nickname || b.uid}
                </span>
                <Badge variant={b.status === "active" ? "success" : "secondary"}>
                  {b.status === "active" ? "使用中" : "已移除"}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {fmtTime(b.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            已绑定 {block.used} / {block.limit} 个账号
            {full && "（已达上限，可联系管理员移除后重试）"}
          </p>
          <Button
            size="sm"
            disabled={full || !acknowledged}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            登录并捐献
          </Button>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            我已阅读并同意上述说明，理解账号会进入共享池供他人使用、
            会被自动化任务操作，并自行承担可能的封号风险。
          </span>
        </label>
      </CardContent>

      {dialogOpen && (
        <Wb2ApiLoginDialog
          realm={block.realm}
          onClose={() => setDialogOpen(false)}
          onDone={() => {
            setDialogOpen(false)
            setAcknowledged(false)
            onDone()
          }}
        />
      )}
    </Card>
  )
}

/** 登录弹窗：展示授权链接 + 轮询状态 */
function Wb2ApiLoginDialog({
  onClose,
  onDone,
  realm,
}: {
  onClose: () => void
  onDone: () => void
  realm: string
}) {
  const [url, setUrl] = React.useState<string | null>(null)
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const [phase, setPhase] = React.useState<"starting" | "waiting" | "done" | "failed">(
    "starting"
  )
  const [message, setMessage] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<number | null>(null)

  // 发起登录（挂载即调一次）
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await wb2apiApi.loginStart()
        if (cancelled) return
        setUrl(res.url)
        setSessionId(res.sessionId)
        setPhase("waiting")
      } catch (err) {
        if (cancelled) return
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : "发起登录失败")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 轮询（3 秒一次，与网关面板同节奏）
  React.useEffect(() => {
    if (phase !== "waiting" || !sessionId) return
    let stopped = false

    const tick = async () => {
      try {
        const res = await wb2apiApi.loginPoll(sessionId)
        if (stopped) return
        if (res.status === "done") {
          stopped = true
          setPhase("done")
          const r = res.result
          setMessage(
            `已绑定 ${r?.nickname || r?.uid || ""}` +
              (r?.alreadyBound
                ? "（该账号此前已绑定过）"
                : r?.aiGranted
                  ? "，已为你解锁 AI 中转站权限"
                  : "，你的 AI 中转站权限此前已解锁")
          )
          return
        }
        if (res.status === "failed") {
          stopped = true
          setPhase("failed")
          setMessage(res.message || "登录失败")
          return
        }
      } catch (err) {
        if (stopped) return
        stopped = true
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : "轮询失败")
      }
    }

    timerRef.current = window.setInterval(() => void tick(), 3000)
    void tick()
    return () => {
      stopped = true
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [phase, sessionId])

  const copyUrl = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>登录 WorkBuddy {realm === "global" ? "国际版" : "国内版"}账号</DialogTitle>
          <DialogDescription>
            在打开的页面登录你的账号，本站会自动检测登录结果并完成绑定。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {phase === "starting" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在生成授权链接…
            </p>
          )}

          {url && (
            <>
              <div className="space-y-2">
                <Label>授权链接</Label>
                <div className="flex gap-2">
                  <Input readOnly value={url} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => void copyUrl()}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => window.open(url, "_blank", "noopener")}
                    aria-label="打开链接"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {phase === "waiting" && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  等待你在浏览器中完成登录…（链接 15 分钟内有效）
                </p>
              )}
            </>
          )}

          {phase === "done" && (
            <p className="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}

          {phase === "failed" && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}
        </div>

        <DialogFooter>
          {phase === "done" ? (
            <Button onClick={onDone}>完成</Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {phase === "failed" ? "关闭" : "取消"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}