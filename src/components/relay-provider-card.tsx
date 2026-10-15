/**
 * 「中转站入驻」卡片（2026-10-12 站长需求）。
 *
 * 放在「邀请与捐献 → 中转站入驻」二级菜单里。朋友把**自己的** NewAPI / Sub2API
 * 登记进来，用户就能在 AI 中转站页顺便看到自己在那边的余额与订阅。
 *
 * 三条口径（与后端配套，改动时两边一起看）：
 *   1. **朋友自己填令牌** —— 这里就是那个入口，站长不用代劳；
 *   2. **额度只读** —— 我们只读余额与订阅，不代发额度、不建 Key、不改余额；
 *   3. 一人可登记多台（上限 5）。
 *
 * ⚠️ 管理员令牌等价于**对方站的管理权**：必须加密存（后端 encryptSecret）、
 *    响应里永不回显、随时能删。界面上也要把这句说清楚，别让人随手贴进去。
 */
import * as React from "react"
import { toast } from "sonner"
import {
  Boxes,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Wallet,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { confirmDialog } from "@/components/confirm-dialog"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { relayApi, errMsg, type RelayProvider, type RelayUserView } from "@/services/api"
import { useT } from "@/i18n"
import { fmtTime } from "@/lib/format"

const KINDS = ["newapi", "sub2api"] as const

export function RelayProviderCard() {
  const { t } = useT()
  const [providers, setProviders] = React.useState<RelayProvider[]>([])
  const [maxPerUser, setMaxPerUser] = React.useState(5)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  // 登记 / 编辑
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<RelayProvider | null>(null)
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<string>("newapi")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [adminToken, setAdminToken] = React.useState("")

  /** 每台站的「我在那边的余额/订阅」预览（点一下才拉，避免进页面打一堆上游） */
  const [views, setViews] = React.useState<Record<string, RelayUserView | "loading">>({})

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await relayApi.list()
      setProviders(res.providers.filter((p) => p.mine))
      setMaxPerUser(res.maxPerUser)
    } catch (err) {
      toast.error(errMsg(err, t("relayp.err.load")))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setName("")
    setKind("newapi")
    setBaseUrl("")
    setAdminToken("")
    setFormOpen(true)
  }

  const openEdit = (p: RelayProvider) => {
    setEditing(p)
    setName(p.name)
    setKind(p.kind)
    setBaseUrl(p.baseUrl ?? "")
    setAdminToken("")
    setFormOpen(true)
  }

  const submit = async () => {
    setBusy(true)
    try {
      let warning: string | undefined
      if (editing) {
        const res = await relayApi.update(editing.id, {
          name,
          kind,
          baseUrl,
          ...(adminToken.trim() ? { adminToken: adminToken.trim() } : {}),
        })
        warning = res.oidcWarning
        toast.success(t("relayp.ok.updated"))
      } else {
        const res = await relayApi.create({ name, kind, baseUrl, adminToken: adminToken.trim() })
        warning = res.oidcWarning
        // 审核制（2026-10-16）：登记**不等于**生效，这句必须说清楚，
        // 否则用户会以为「登记完了怎么在别人那边看不到」是 bug。
        toast.success(t("relayp.ok.created"))
      }
      // 检测不到 OIDC 时放行但要说清楚（对方可能只是开了登录验证码）
      if (warning) toast.warning(`${t("relayp.oidcUnverified")}${warning}`)
      setFormOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("relayp.err.save")))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: RelayProvider) => {
    const ok = await confirmDialog({
      title: t("relayp.delete.title", { name: p.name }),
      desc: t("relayp.delete.desc"),
      okText: t("relayp.delete.confirm"),
      danger: true,
    })
    if (!ok) return
    try {
      await relayApi.remove(p.id)
      toast.success(t("relayp.ok.deleted"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("relayp.err.delete")))
    }
  }

  /** 读「我在那台站」的余额与订阅（只读） */
  const loadView = async (p: RelayProvider, refresh = false) => {
    if (views[p.id] && views[p.id] !== "loading" && !refresh) {
      setViews((v) => {
        const next = { ...v }
        delete next[p.id]
        return next
      })
      return
    }
    setViews((v) => ({ ...v, [p.id]: "loading" }))
    try {
      const res = await relayApi.view(p.id)
      setViews((v) => ({ ...v, [p.id]: res.view }))
    } catch (err) {
      toast.error(errMsg(err, t("relayp.err.view")))
      setViews((v) => {
        const next = { ...v }
        delete next[p.id]
        return next
      })
    }
  }

  const canAdd = providers.length < maxPerUser

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Boxes className="h-4 w-4 text-muted-foreground" />
            {t("relayp.title")}
          </CardTitle>
          <CardDescription>{t("relayp.desc")}</CardDescription>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("relayp.quota", { used: providers.length, max: maxPerUser })}
          </p>
        </div>
        <Button size="sm" onClick={openCreate} disabled={loading || !canAdd}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {t("relayp.register")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : providers.length === 0 ? (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("relayp.empty")}
            </div>
            {/* 入驻前提：对方站必须配好「用 Doulor Cloud 登录」的 OIDC，
                保存时后端会自动检测（读它自己的 OIDC 配置），没配好会直接拒绝 */}
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("relayp.oidcHint")}
            </div>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("relayp.security")}</span>
            </div>
          </div>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <Badge variant="outline">{t(`relayp.kind.${p.kind}`)}</Badge>
                {/*
                  状态徽章（2026-10-16 审核制）—— 三层含义各自一个徽章，别合并：
                    · 待审核   = 等站长看（还没有结论）
                    · 已拒绝   = 有结论，且理由就写在下面（用户知道要改什么）
                    · 已停用   = 审过了，但站长临时关了（审核态仍是 approved）
                  最后一种沿用原来的 destructive 徽章，避免站长停用后用户
                  误以为「又要重新审核」。
                */}
                {p.reviewStatus === "pending" && (
                  <Badge variant="secondary">{t("relayp.review.pending")}</Badge>
                )}
                {p.reviewStatus === "rejected" && (
                  <Badge variant="destructive">{t("relayp.review.rejected")}</Badge>
                )}
                {p.reviewStatus === "approved" && !p.enabled && (
                  <Badge variant="destructive">{t("relayp.disabled")}</Badge>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {t("relayp.createdAt", { time: fmtTime(p.createdAt) })}
                </span>
              </div>
              {p.baseUrl && (
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {p.baseUrl}
                </p>
              )}

              {/* 审核态说明：待审核 / 被拒（带理由）都要有一句话解释「现在能不能用」 */}
              {p.reviewStatus === "pending" && (
                <p className="mt-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {t("relayp.review.pendingHint")}
                </p>
              )}
              {p.reviewStatus === "rejected" && (
                <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {p.reviewNote
                    ? t("relayp.review.rejectedHint", { reason: p.reviewNote })
                    : t("relayp.review.rejectedNoReason")}
                  <br />
                  {t("relayp.review.resubmit")}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  // 不能用时把按钮灰掉（而不是让它点了必 403）：usable 由服务端算，
                  // 包含「已批准」与「未停用」两半，前端不再自己拼这两个条件。
                  disabled={!p.usable}
                  title={p.usable ? undefined : t("relayp.review.notUsable")}
                  onClick={() => void loadView(p, views[p.id] !== undefined)}
                >
                  {views[p.id] === "loading" ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wallet className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("relayp.view")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  {t("common.edit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(p)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("common.delete")}
                </Button>
              </div>

              {/* 只读预览：余额 + 订阅 */}
              {views[p.id] && views[p.id] !== "loading" && (
                <RelayViewBlock view={views[p.id] as RelayUserView} />
              )}
            </div>
          ))
        )}
      </CardContent>

      {/* 登记 / 编辑 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("relayp.edit.title") : t("relayp.create.title")}
            </DialogTitle>
            <DialogDescription>{t("relayp.create.desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="rp-name">{t("relayp.field.name")}</Label>
              <Input
                id="rp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder={t("relayp.field.namePh")}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("relayp.field.kind")}</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`relayp.kind.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rp-url">{t("relayp.field.baseUrl")}</Label>
              <Input
                id="rp-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com"
              />
              <p className="text-xs text-muted-foreground">{t("relayp.field.baseUrlHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rp-token">{t("relayp.field.token")}</Label>
              <Input
                id="rp-token"
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder={editing ? t("relayp.field.tokenKeep") : t("relayp.field.tokenPh")}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {kind === "sub2api" ? t("relayp.tokenHint.sub2api") : t("relayp.tokenHint.newapi")}
              </p>
            </div>
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {/* 保存前先告知「提交 ≠ 生效」：这个预期必须在动手填之前建立 */}
              <span>{t("relayp.review.createHint")}</span>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("relayp.security")}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={busy || !name.trim() || !baseUrl.trim() || (!editing && !adminToken.trim())}
            >
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {editing ? t("common.save") : t("relayp.register")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** 只读预览块：余额 + 订阅列表（AI 中转站页也复用同一份） */
export function RelayViewBlock({
  view,
  onRetry,
  ownerAction,
}: {
  view: RelayUserView
  /** 重试：由外层重新拉数据（不整页刷新，体验好且不会丢别的区块的状态） */
  onRetry?: () => void
  /** 读不到且当前用户是登记人时，给一个「去重新填令牌」的直达入口 */
  ownerAction?: React.ReactNode
}) {
  const { t } = useT()

  if (!view.reachable) {
    return (
      <div className="mt-3 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
        <p>{t("relayp.view.unreachable", { reason: view.error ?? "" })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onRetry?.()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("relayp.view.retry")}
          </Button>
          {ownerAction}
        </div>
      </div>
    )
  }

  if (!view.found) {
    return (
      <div className="mt-3 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
        {t("relayp.view.noAccount")}
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{t("relayp.view.balance")}</span>
        <span className="font-medium tabular-nums">
          {view.currencySymbol}
          {view.balance != null ? view.balance.toFixed(2) : "—"}
        </span>
      </div>
      {view.subscriptions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("relayp.view.noSubs")}</p>
      ) : (
        view.subscriptions.map((s, i) => (
          <div
            key={`${s.title}-${i}`}
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <span className="text-muted-foreground">{s.title}</span>
            <span className="tabular-nums">
              {s.total != null ? (
                <>
                  {view.currencySymbol}
                  {(s.total - (s.used ?? 0)).toFixed(2)} / {view.currencySymbol}
                  {s.total.toFixed(2)}
                </>
              ) : s.used != null ? (
                t("relayp.view.usedOnly", {
                  amount: `${view.currencySymbol}${s.used.toFixed(2)}`,
                })
              ) : (
                "—"
              )}
              {s.expiresAt
                ? ` · ${t("relayp.view.until", { time: fmtTime(new Date(s.expiresAt * 1000).toISOString()) })}`
                : ""}
            </span>
          </div>
        ))
      )}
      <p className="text-[11px] text-muted-foreground">{t("relayp.view.readonly")}</p>
    </div>
  )
}
