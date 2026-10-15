/**
 * 「其它中转站」的入口与站内界面（2026-10-12 站长要求）。
 *
 * 交互（站长定的）：
 *   · AI 中转站页标题旁一个按钮「去看看其他中转站」→ 弹出列表 → 点进去
 *   · 进去后是**一整台中转站的界面**（`/dashboard/ai?relay=<id>`），
 *     区块与本站那套一致：接入信息 / 余额与订阅 / 我的 Key / 可用模型 / 前往本站
 *   · 不再用「卡片式只读展示」（那版被否掉了）
 *
 * ⚠️ 能力边界（老实标注，不假装）：
 *   我们手上只有**登记人的管理员令牌**，所以只能做管理员能做的事：
 *     ✓ 余额、订阅、可用模型、站点地址
 *     ✓ Sub2API 还能列 Key（它管理员接口能读用户 Key）
 *     ✗ NewAPI 的 Key 列表（Key 是用户维度的，管理员令牌读不到）
 *     ✗ 新建 Key / 改密码 / 同步（要**用户本人**在那台站的凭据 ——
 *       这正是下一步要做的事：让用户用 Doulor Cloud 在那台站登录一次，把凭据绑过来）
 *   做不到的按钮不摆出来骗人，直接给「前往对方站」的入口并写明原因。
 */
import * as React from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import {
  ArrowLeft,
  Boxes,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldAlert,
  Sparkles,
  Wallet,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { PageHeader } from "@/components/page-header"
import { LoadingBlock } from "@/components/loading-block"
import { RelayViewBlock } from "@/components/relay-provider-card"
import {
  relayApi,
  errMsg,
  type RelayKeyRow,
  type RelayProvider,
  type RelayUserView,
} from "@/services/api"
import { useT } from "@/i18n"
import { fmtTime } from "@/lib/format"

/* ------------------------------------------------------------------ 入口按钮 */

/** 标题旁的「去看看其他中转站」：点开是列表，选一台就进入它的界面 */
export function RelaySwitcher({ currentId }: { currentId?: string }) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [providers, setProviders] = React.useState<RelayProvider[] | null>(null)

  const load = async () => {
    setOpen(true)
    if (providers) return
    try {
      const res = await relayApi.list()
      setProviders(res.providers)
    } catch (err) {
      toast.error(errMsg(err, t("relayp.err.load")))
      setProviders([])
    }
  }

  const list = (providers ?? []).filter((p) => p.id !== currentId)

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => void load()}>
        <Boxes className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {t("relayp.switch")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("relayp.switch.title")}</DialogTitle>
            <DialogDescription>{t("relayp.switch.desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Link
              to="/dashboard/ai"
              onClick={() => setOpen(false)}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3 transition-colors hover:bg-accent/40"
            >
              <span className="font-medium">{t("relayp.switch.official")}</span>
              <Badge variant="outline">{t("relayp.kind.newapi")}</Badge>
              <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            </Link>
            {providers === null ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : list.length === 0 ? (
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                {t("relayp.switch.empty")}
              </p>
            ) : (
              list.map((p) => (
                <Link
                  key={p.id}
                  to={`/dashboard/ai?relay=${encodeURIComponent(p.id)}`}
                  onClick={() => setOpen(false)}
                  className="flex flex-wrap items-center gap-2 rounded-lg border p-3 transition-colors hover:bg-accent/40"
                >
                  <span className="font-medium">{p.name}</span>
                  <Badge variant="outline">{t(`relayp.kind.${p.kind}`)}</Badge>
                  {/* 审核制（2026-10-16）：这里可能出现**我自己**待审/被拒的站，
                      状态照实标出来，免得点进去才发现用不了 */}
                  {p.reviewStatus === "pending" && (
                    <Badge variant="secondary">{t("relayp.review.pending")}</Badge>
                  )}
                  {p.reviewStatus === "rejected" && (
                    <Badge variant="destructive">{t("relayp.review.rejected")}</Badge>
                  )}
                  {p.reviewStatus === "approved" && !p.enabled && (
                    <Badge variant="destructive">{t("relayp.disabled")}</Badge>
                  )}
                  <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                </Link>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/* ------------------------------------------------------------------ 站内界面 */

/** 某台中转站的完整界面（区块与本站一致，数据来自那台站） */
export function RelayStationView({ id }: { id: string }) {
  const { t } = useT()
  const [provider, setProvider] = React.useState<RelayProvider | null>(null)
  const [notFound, setNotFound] = React.useState(false)
  const [view, setView] = React.useState<RelayUserView | null>(null)
  const [keys, setKeys] = React.useState<{ supported: boolean; keys: RelayKeyRow[]; detail?: string } | null>(null)
  const [models, setModels] = React.useState<{ models: string[]; detail?: string } | null>(null)

  /** 单独重拉「余额与订阅」（令牌刚更新完时最需要它） */
  const reloadView = React.useCallback(async () => {
    setView(null)
    try {
      const r = await relayApi.view(id)
      setView(r.view)
    } catch {
      /* 失败保持原状，界面会显示「读不到」 */
    }
  }, [id])

  React.useEffect(() => {
    let stopped = false
    void (async () => {
      try {
        const res = await relayApi.list()
        const found = res.providers.find((p) => p.id === id) ?? null
        if (stopped) return
        if (!found) {
          setNotFound(true)
          return
        }
        setProvider(found)
        /**
         * 🔴 审核制（2026-10-16）：**先确认这台站可用，再去读它的三块数据**。
         *
         * 原先是四路并发一起发，未通过审核时后端一律 403，而这里的 catch 是
         * 「忽略错误」（上游是别人家的站，读不到不该拖垮页面）——结果三块都会
         * 永远停在「加载中」，看起来像页面卡死。现在改成：不可用就根本不发请求，
         * 直接渲染状态卡片（待审核 / 已拒绝+理由 / 已停用）。
         *
         * 代价是多一次串行等待（先拿列表再取数据，约一个 RTT）：
         * 这条路径只在「点进某台中转站」时走，且 `usable` 只有列表接口知道
         * （它由服务端算，前端不自己拼），值得。
         */
        if (!found.usable) return
        // 三块数据各自拉：任一慢/失败都不该拖住整页（对方站是别人家的，可能很慢）
        void relayApi
          .view(id)
          .then((r) => !stopped && setView(r.view))
          .catch(() => undefined)
        void relayApi
          .keys(id)
          .then((r) => !stopped && setKeys(r))
          .catch(() => undefined)
        void relayApi
          .models(id)
          .then((r) => !stopped && setModels(r))
          .catch(() => undefined)
      } catch {
        if (!stopped) setNotFound(true)
      }
    })()
    return () => {
      stopped = true
    }
  }, [id])

  if (notFound) {
    return (
      <div>
        <PageHeader title={t("relayp.station.missing")} />
        <Button asChild variant="outline">
          <Link to="/dashboard/ai">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {t("relayp.station.back")}
          </Link>
        </Button>
      </div>
    )
  }

  const baseUrl = provider?.baseUrl ?? ""
  const keyCount = keys?.keys.length ?? 0
  const usable = provider?.usable ?? false

  return (
    <div>
      <PageHeader
        title={provider ? provider.name : t("common.loading")}
        description={provider ? t(`relayp.kind.${provider.kind}`) : ""}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {baseUrl && (
              <Button size="sm" variant="outline" asChild>
                <a href={baseUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  {t("relayp.station.visit")}
                </a>
              </Button>
            )}
            <RelaySwitcher currentId={id} />
          </div>
        }
      />

      <div className="space-y-6">
        {/* 列表还没回来：先给骨架，免得整页空白（可用性判断依赖列表接口的 usable） */}
        {!provider && <LoadingBlock variant="cards" />}

        {/* 未通过审核：把状态说清楚，并把三块上游数据整段换成一句解释 */}
        {provider && !usable && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                {t("relayp.review.title")}
              </CardTitle>
              <CardDescription>{t("relayp.review.notUsable")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {provider.reviewStatus === "pending" ? (
                <Badge variant="secondary">{t("relayp.review.pending")}</Badge>
              ) : provider.reviewStatus === "rejected" ? (
                <Badge variant="destructive">{t("relayp.review.rejected")}</Badge>
              ) : (
                <Badge variant="destructive">{t("relayp.disabled")}</Badge>
              )}
              <p className="text-sm text-muted-foreground">
                {provider.reviewStatus === "pending"
                  ? t("relayp.review.pendingHint")
                  : provider.reviewStatus === "rejected"
                    ? provider.reviewNote
                      ? t("relayp.review.rejectedHint", { reason: provider.reviewNote })
                      : t("relayp.review.rejectedNoReason")
                    : t("relayp.review.disabledHint")}
              </p>
              {provider.mine && provider.reviewStatus !== "approved" && (
                <Button size="sm" variant="outline" asChild>
                  <Link to="/dashboard/donations?tab=relay">
                    <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                    {t("relayp.review.manage")}
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {provider && usable && (
          <>
        {/* 接入信息：与本站那套同款写法（Base URL + 说明） */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("ai.access.title")}
            </CardTitle>
            <CardDescription>{t("ai.access.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("relayp.station.baseUrl")}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                  {baseUrl ? `${baseUrl}/v1` : "—"}
                </code>
              </div>
              <p className="text-xs text-muted-foreground">{t("relayp.station.keyNote")}</p>
            </div>
          </CardContent>
        </Card>

        {/* 余额与订阅（只读） */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              {t("relayp.view")}
            </CardTitle>
            <CardDescription>{t("relayp.station.quotaDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {view === null ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              <RelayViewBlock
                view={view}
                onRetry={() => void reloadView()}
                ownerAction={
                  provider?.mine ? (
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        to="/dashboard/donations?tab=relay"
                        title={t("relayp.station.fixTokenHint")}
                      >
                        <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                        {t("relayp.station.fixToken")}
                      </Link>
                    </Button>
                  ) : null
                }
              />
            )}
          </CardContent>
        </Card>

        {/* 我的 Key（Sub2API 能读；NewAPI 读不到 ⇒ 如实说明） */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("relayp.station.keysTitle")}
            </CardTitle>
            <CardDescription>{t("relayp.station.keysDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {keys === null ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : !keys.supported ? (
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                {keys.detail ?? t("relayp.station.keysUnsupported")}
              </div>
            ) : keyCount === 0 ? (
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                {t("relayp.station.keysEmpty")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("relayp.station.colName")}</TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead>{t("relayp.station.colGroup")}</TableHead>
                      <TableHead>{t("relayp.station.colCreated")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keys.keys.map((k, i) => (
                      <TableRow key={`${k.name}-${i}`}>
                        <TableCell className="text-sm">{k.name}</TableCell>
                        <TableCell className="font-mono text-xs">{k.keyMasked}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {k.group ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {k.createdAt ? fmtTime(k.createdAt) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* 新建 Key / 改密码：需要用户本人在这台站的凭据 —— 说清原因 + 给直达入口 */}
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("relayp.station.writeNote")}
            </div>
          </CardContent>
        </Card>

        {/* 可用模型 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              {t("relayp.station.modelsTitle")}
            </CardTitle>
            <CardDescription>
              {models
                ? models.detail ?? t("relayp.station.modelsCount", { n: String(models.models.length) })
                : t("common.loading")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {models === null ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : models.models.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {models.detail ?? t("relayp.station.modelsEmpty")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {models.models.map((m) => (
                  <span
                    key={m}
                    className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
                  >
                    {m}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
          </>
        )}

        {/* 底部直达入口：无论审核态都给「回到本站中转站」与「前往对方站」 */}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard/ai">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              {t("relayp.station.back")}
            </Link>
          </Button>
          {baseUrl && (
            <Button asChild size="sm">
              <a href={baseUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="mr-1.5 h-4 w-4" />
                {t("relayp.station.visit")}
              </a>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
