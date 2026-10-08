import * as React from "react"
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  Gauge,
  Loader2,
  RefreshCw,
  ScrollText,
  Server,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { FeatureLockedNotice } from "@/components/feature-locked-notice"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { proxyApi, HttpError } from "@/services/api"
import { fmtTime } from "@/lib/format"
import { useT, tStatic } from "@/i18n"
import type {
  ProxyNode,
  ProxyNodeHealth,
  ProxyNodeLatency,
  ProxyOverview,
  ProxySubscription,
} from "@/types"

/**
 * 能被服务端 TCP 握手测速的协议（与后端 proxy-latency.ts 的 TCP_PROTOCOLS 对齐）。
 * hysteria / hysteria2 / tuic 走 QUIC/UDP，Worker 建不了 UDP 连接 —— 必须显示
 * 「不支持测速」而不是「不可用」（没能验证 ≠ 不可用）。
 */
const LATENCY_TESTABLE_PROTOCOLS = new Set([
  "vless",
  "vmess",
  "trojan",
  "ss",
  "ssr",
  "anytls",
])

function canTestLatency(protocol: string): boolean {
  return LATENCY_TESTABLE_PROTOCOLS.has((protocol ?? "").toLowerCase())
}

/** 一批测多少个节点 —— 必须与后端 MAX_LATENCY_BATCH 一致（平台并发连接限制） */
const LATENCY_BATCH = 16

/**
 * 延迟数值的配色分级（参照 Clash 的习惯：绿/黄/橙）。
 * 抽出来是为了让「本次测速」与「历史探活」两条来源的配色完全一致。
 */
function latencyClass(ms: number): string {
  return ms < 150 ? "text-emerald-600" : ms < 400 ? "text-amber-600" : "text-orange-600"
}

/**
 * 节点探活徽标。
 *
 * 两条数据来源，优先级固定为：**本次手动测速的即时结果** > 服务端定期探活沉淀的结论。
 * 前者是用户刚点的、最贴近他此刻的预期；后者是后台轮转探活写进库里的，页面一加载就有。
 *
 * ⚠️ **失败一律不标红**：服务端握不上手可能只是本站出网到该节点不通（Cloudflare
 * 封了部分目标 IP），标红会让人误以为节点坏了。这与后端 proxy-node-health.ts
 * 的「没能验证 ≠ 不可用」是同一条原则 —— 文案统一用中性的「测不到」。
 */
function NodeProbeBadge({
  latency,
  health,
  testable,
}: {
  latency?: ProxyNodeLatency
  health?: ProxyNodeHealth
  testable: boolean
}) {
  const { t } = useT()
  if (!testable) {
    return (
      <span className="text-xs text-muted-foreground" title={t("px.lat.quicHint")}>
        {t("px.lat.unsupported")}
      </span>
    )
  }
  // 1) 本次手动测速的结果优先
  if (latency) {
    if (!latency.ok) {
      return (
        <span className="text-xs text-muted-foreground" title={latency.reason}>
          {t("px.lat.unreachable")}
        </span>
      )
    }
    const ms = latency.latencyMs ?? 0
    return (
      <span className={`font-mono text-xs ${latencyClass(ms)}`} title={t("px.lat.hint")}>
        {ms} ms
      </span>
    )
  }
  // 2) 回落到服务端定期探活沉淀的结论
  if (!health || health.status === "unknown") {
    return (
      <span className="text-xs text-muted-foreground" title={t("px.health.hint")}>
        {t("px.health.unknown")}
      </span>
    )
  }
  if (health.status === "down") {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={health.error ?? t("px.health.hint")}
      >
        {t("px.health.down")}
      </span>
    )
  }
  const ms = health.latencyMs ?? 0
  return (
    <span className={`font-mono text-xs ${latencyClass(ms)}`} title={t("px.health.upHint")}>
      {ms} ms
    </span>
  )
}

/**
 * 代理节点「使用协议」。版本与后端 PROXY_CONSENT_VERSION 一致。
 * 用户点「启用」前必须勾选同意，服务端才会写入启用状态。
 */
const PROXY_CONSENT_VERSION = 1

const PROXY_AGREEMENT = [
  {
    title: "px.ag.1.title",
    body: "px.ag.1.body",
  },
  {
    title: "px.ag.2.title",
    body: "px.ag.2.body",
  },
  {
    title: "px.ag.3.title",
    body: "px.ag.3.body",
  },
  {
    title: "px.ag.4.title",
    body: "px.ag.4.body",
  },
  {
    title: "px.ag.5.title",
    body: "px.ag.5.body",
  },
]

const NODE_STATUS_BADGE: Record<
  string,
  { label: string; variant: "success" | "secondary" | "destructive" | "outline" }
> = {
  online: { label: "frp.ns.online", variant: "success" },
  offline: { label: "frp.ns.offline", variant: "destructive" },
  maintenance: { label: "frp.ns.maintenance", variant: "secondary" },
  unknown: { label: "frp.ns.unknown", variant: "outline" },
}

const PROTOCOL_BADGE_VARIANT: Record<
  string,
  "secondary" | "success" | "outline" | "default"
> = {
  vless: "secondary",
  vmess: "secondary",
  trojan: "secondary",
  ss: "secondary",
  ssr: "secondary",
  anytls: "secondary",
  hysteria: "secondary",
  hysteria2: "secondary",
  tuic: "secondary",
  unknown: "outline",
}

function copyText(text: string, label = tStatic("common.copied")) {
  return navigator.clipboard
    .writeText(text)
    .then(() => toast.success(label))
    .catch(() => toast.error(tStatic("ai.err.copy")))
}

/** 订阅源的节点总数（含抓取失败时显示错误） */
function SubStatusBadge({ sub }: { sub: ProxySubscription }) {
  const { t } = useT()
  const cfg = NODE_STATUS_BADGE[sub.status] ?? NODE_STATUS_BADGE.unknown
  return (
    <Badge variant={cfg.variant} className="text-xs">
      {t(cfg.label)}
    </Badge>
  )
}

/** 节点配置字段的可读展示 */
function NodeDetails({ node }: { node: ProxyNode }) {
  const { t } = useT()
  const fields: [string, string | null][] = [
    [t("px.field.protocol"), node.protocol],
    [t("px.field.server"), node.server || null],
    [t("px.field.port"), node.port ? String(node.port) : null],
    [t("px.field.region"), node.region],
    ["UUID", node.details.uuid || null],
    [t("px.field.password"), node.details.password || null],
    [t("px.field.method"), node.details.method || null],
    ["SNI", node.details.sni || null],
    [t("px.field.flow"), node.details.flow || null],
    [t("px.field.network"), node.details.network || null],
    ["TLS", node.details.tls || node.details.security || null],
    ["OBFS", node.details.obfs || node.details.headerType || null],
  ]
  const present = fields.filter(([, v]) => v !== null && v !== "")
  if (present.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("px.nodePartial")}
      </p>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
      {present.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">{k}</span>
          <span className="truncate font-mono text-xs">{v}</span>
        </div>
      ))}
    </div>
  )
}

/** 订阅列表先显示多少个，其余点「查看更多」再展开（2026-10-03 站长：订阅组太多一次全列太长） */
const PROXY_SUB_BATCH = 10

export default function ProxyPage() {
  const { t } = useT()
  const [data, setData] = React.useState<ProxyOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [consent, setConsent] = React.useState(false)
  const [agreementOpen, setAgreementOpen] = React.useState(false)
  const [checkingId, setCheckingId] = React.useState<string | null>(null)
  /** 探活结果：订阅源 id → { latencyMs, message } */
  const [checkResult, setCheckResult] = React.useState<
    Record<string, { latencyMs: number | null; ok: boolean; message?: string }>
  >({})
  /** 展开的订阅源（默认收起节点列表，点击表头展开） */
  const [expandedSubs, setExpandedSubs] = React.useState<Record<string, boolean>>({})
  /** 展开的节点配置（默认收起，点击节点行展开） */
  const [expandedNodes, setExpandedNodes] = React.useState<Record<string, boolean>>({})
  /** 已加载的订阅列表（懒加载，分批累计） */
  const [subs, setSubs] = React.useState<ProxySubscription[]>([])
  const [hasMore, setHasMore] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  /** 逐节点测速结果：`<订阅id>-<节点下标>` → 结果 */
  const [nodeLatency, setNodeLatency] = React.useState<Record<string, ProxyNodeLatency>>({})
  /** 正在测速的订阅源 id */
  const [latencySubId, setLatencySubId] = React.useState<string | null>(null)
  /** 测速进度文案（如「32/143」） */
  const [latencyProgress, setLatencyProgress] = React.useState("")

  // 无权限（403 FEATURE_NOT_PERMITTED）：整页显示提示 + 捐献入口
  const [locked, setLocked] = React.useState(false)
  /** 正在向服务端索取原始订阅链接的订阅源 id（服务端按天限 3 次） */
  const [revealingId, setRevealingId] = React.useState<string | null>(null)

  /**
   * 索取并复制订阅源**原始链接**。
   *
   * ⚠️ 2026-09-26：列表接口已不再下发 url（它内嵌机场订阅 token），
   * 必须显式调 revealSubscription 按需获取，服务端每天限 3 次。
   */
  const handleCopySubscription = async (id: string) => {
    if (revealingId) return
    setRevealingId(id)
    try {
      const res = await proxyApi.revealSubscription(id)
      await copyText(res.url, t("px.ok.subCopied", { n: res.remaining }))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("px.err.subLink"))
    } finally {
      setRevealingId(null)
    }
  }

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await proxyApi.overview(0, PROXY_SUB_BATCH)
      setData(res)
      setSubs(res.subscriptions)
      setHasMore(res.hasMore)
      // 协议更新过时，要求重新同意
      if (res.activated && res.consentedVersion < res.consentVersion) {
        setConsent(false)
        toast.error(t("px.err.consentUpdated"))
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
        setLocked(true)
        return
      }
      toast.error(err instanceof HttpError ? err.message : t("at.err.load"))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 点「查看更多」：接着拉下一批订阅，追加到列表尾部 */
  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const res = await proxyApi.overview(subs.length, PROXY_SUB_BATCH)
      setSubs((prev) => [...prev, ...res.subscriptions])
      setHasMore(res.hasMore)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("at.err.load"))
    } finally {
      setLoadingMore(false)
    }
  }

  const handleEnable = async () => {
    if (!consent) {
      toast.error(t("st.err.needConsent"))
      return
    }
    setBusy(true)
    try {
      await proxyApi.enable(PROXY_CONSENT_VERSION)
      toast.success(t("px.ok.enabled"))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("frp.err.enable"))
    } finally {
      setBusy(false)
    }
  }

  const handleDisable = async () => {
    setBusy(true)
    try {
      await proxyApi.disable()
      toast.success(t("px.ok.disabled"))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.op"))
    } finally {
      setBusy(false)
    }
  }

  const handleCheck = async (sub: ProxySubscription) => {
    setCheckingId(sub.id)
    try {
      const res = await proxyApi.check(sub.id)
      setCheckResult((prev) => ({ ...prev, [sub.id]: res }))
      toast.success(
        res.ok && res.latencyMs != null
          ? t("px.probe.responded", { name: sub.name, ms: res.latencyMs })
          : (res.message ?? t("px.probe.unreachable"))
      )
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("px.err.probe"))
    } finally {
      setCheckingId(null)
    }
  }

  /**
   * 对订阅里的**逐个节点**测延迟。
   *
   * 服务端一次只测十几条（Cloudflare 每次请求最多 6 个并发连接，
   * 见 proxy-latency.ts 顶部说明），所以这里分批循环、边测边把结果填进列表，
   * 让人能看到进度而不是干等。
   */
  const handleLatencyTest = async (sub: ProxySubscription) => {
    if (latencySubId) return
    setLatencySubId(sub.id)
    setLatencyProgress("")
    try {
      let offset = 0
      let done = 0
      let testable = sub.nodes.length
      let ok = 0
      let fastest: number | null = null
      const seen = new Set<number>()

      for (let guard = 0; guard < 200; guard++) {
        const res = await proxyApi.latency(sub.id, offset, LATENCY_BATCH)
        testable = res.testable
        if (res.results.length === 0) break
        for (const r of res.results) {
          seen.add(r.index)
          if (r.ok) {
            ok += 1
            if (r.latencyMs != null && (fastest === null || r.latencyMs < fastest)) {
              fastest = r.latencyMs
            }
          }
          const key = `${sub.id}-${r.index}`
          setNodeLatency((prev) => ({ ...prev, [key]: r }))
        }
        done = seen.size
        setLatencyProgress(`${done}/${testable}`)
        // offset 是「可测速节点列表」里的位置，不是节点下标 —— 只按已测条数推进
        offset += res.results.length
        if (res.results.length < res.limit || done >= testable) break
      }

      if (testable === 0) {
        toast.message(t("px.speed.noneTestable"))
      } else {
        toast.success(
          t("px.speed.done", { ok, total: testable }) +
          (fastest != null ? t("px.speed.fastest", { ms: fastest }) : "") +
          // 服务端已把本批结论写进代理节点健康表（与定时探活共用判定），
          // 下次刷新页面就会按「可用 → 未探活 → 测不到」重新排列
          t("px.speed.saved")
        )
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("px.err.speed"))
    } finally {
      setLatencySubId(null)
      setLatencyProgress("")
    }
  }

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="proxy"
        featureLabel={t("feat.proxy")}
        description={t("locked.desc", { feature: t("feat.proxy") })}
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={t("px.title")} description={t("px.subtitle")} />
        <LoadingBlock />
      </div>
    )
  }

  if (!data?.featureEnabled) {
    return (
      <div>
        <PageHeader title={t("px.title")} description={t("px.subtitle")} />
        <EmptyState
          title={t("ai.disabled")}
          description={t("px.disabledDesc")}
        />
      </div>
    )
  }

  // 协议版本过期 → 与未启用一样，强制重新阅读并同意
  const needReconsent =
    data.activated && data.consentedVersion < data.consentVersion

  // 未启用 / 协议已更新：先展示协议并确认同意
  if (!data.activated || needReconsent) {
    return (
      <div>
        <PageHeader title={t("px.title")} description={t("px.subtitle2")} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-muted-foreground" />
              {t("px.intro.title")}
            </CardTitle>
            <CardDescription>
              {t("px.intro.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {needReconsent && (
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {t("px.intro.updated", { v: data.consentVersion })}
                </div>
              </div>
            )}
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>{t("px.intro.b1")}</li>
              <li>{t("px.intro.b2")}</li>
              <li>{t("px.intro.b3")}</li>
            </ul>

            <div className="rounded-md border bg-muted/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{t("px.consent.version", { v: PROXY_CONSENT_VERSION })}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("px.consent.desc")}
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setAgreementOpen(true)}>
                  {t("st.consent.viewFull")}
                </Button>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span className="text-sm text-muted-foreground">
                {t("px.consent.check", { v: PROXY_CONSENT_VERSION })}
              </span>
            </label>

            <Button onClick={() => void handleEnable()} disabled={busy || !consent}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("px.consent.agree")}
            </Button>
          </CardContent>
        </Card>

        <AgreementDialog open={agreementOpen} onOpenChange={setAgreementOpen} />
      </div>
    )
  }


  return (
    <div>
      <PageHeader
        title={t("px.title")}
        description={t("px.tagline")}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => void load()} aria-label={t("common.refresh")}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleDisable()} disabled={busy}>
              {t("common.disable")}
            </Button>
          </div>
        }
      />

      {subs.length === 0 ? (
        <EmptyState
          title={t("px.empty")}
          description={t("px.emptyDesc")}
        />
      ) : (
        <div className="space-y-6">
          {subs.map((sub) => {
            const result = checkResult[sub.id]
            const subKey = `sub-${sub.id}`
            const subExpanded = expandedSubs[subKey] ?? false
            return (
              <Card key={sub.id}>
                <CardHeader className="cursor-pointer select-none" onClick={() =>
                  setExpandedSubs((prev) => ({ ...prev, [subKey]: !subExpanded }))
                }>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <ChevronDown
                          className={`h-4 w-4 text-muted-foreground transition-transform ${
                            subExpanded ? "" : "-rotate-90"
                          }`}
                        />
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Server className="h-4 w-4 text-muted-foreground" />
                          {sub.name}
                        </CardTitle>
                        <Badge
                          variant={PROTOCOL_BADGE_VARIANT[sub.protocol] ?? "outline"}
                          className="font-mono text-xs"
                        >
                          {sub.protocol}
                        </Badge>
                        {sub.region && (
                          <span className="text-xs text-muted-foreground">{sub.region}</span>
                        )}
                        <SubStatusBadge sub={sub} />
                        {sub.health && sub.health.total > 0 && (
                          <Badge variant="outline" className="text-xs font-normal" title={t("px.health.hint")}>
                            {t("px.health.summary", {
                              up: sub.health.up,
                              unknown: sub.health.unknown,
                              down: sub.health.down,
                            })}
                          </Badge>
                        )}
                      </div>
                      <CardDescription className="text-xs">
                        {t("px.sub.nodes", { n: sub.nodes.length })}
                        {sub.lastSyncedAt ? t("px.sub.syncedAt", { time: fmtTime(sub.lastSyncedAt) }) : ""}
                        {sub.healthCheckedAt
                          ? t("px.health.checkedAt", { time: fmtTime(sub.healthCheckedAt) })
                          : t("px.health.never")}
                        {sub.statusNote ? ` · ${sub.statusNote}` : ""}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      {result && (
                        <Badge
                          variant={result.ok ? "success" : "destructive"}
                          className="text-xs"
                        >
                          {result.ok && result.latencyMs != null
                            ? `${result.latencyMs} ms`
                            : result.message ?? t("px.probe.shortUnreachable")}
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleLatencyTest(sub)
                        }}
                        disabled={latencySubId === sub.id || sub.nodes.length === 0}
                        title={t("px.speed.hint")}
                      >
                        {latencySubId === sub.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Gauge className="h-3.5 w-3.5" />
                        )}
                        {t("px.speed.btn")}
                        {latencySubId === sub.id && latencyProgress
                          ? ` ${latencyProgress}`
                          : ""}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleCheck(sub)
                        }}
                        disabled={checkingId === sub.id}
                        title={t("px.probe.hint")}
                      >
                        {checkingId === sub.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Zap className="h-3.5 w-3.5" />
                        )}
                        {t("px.probe.btn")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={revealingId === sub.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleCopySubscription(sub.id)
                        }}
                        title={t("px.sub.getHint")}
                      >
                        {revealingId === sub.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {t("px.sub.copy")}
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                {subExpanded && (
                  <CardContent className="space-y-3">
                  {sub.fetchError ? (
                    <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        {t("px.sub.fetchFailed", { err: sub.fetchError })}
                      </div>
                    </div>
                  ) : null}

                  {/* 流量 / 到期 */}
                  {(sub.usage.used || sub.usage.total || sub.usage.expire) ? (
                    <div className="flex flex-wrap gap-2">
                      {sub.usage.total && (
                        <Badge variant="secondary" className="text-xs">
                          {t("px.usage.total", { v: sub.usage.total })}
                        </Badge>
                      )}
                      {sub.usage.used && (
                        <Badge variant="secondary" className="text-xs">
                          {t("px.usage.used", { v: sub.usage.used })}
                        </Badge>
                      )}
                      {sub.usage.expire && (
                        <Badge variant="secondary" className="text-xs">
                          {t("px.usage.expire", { v: sub.usage.expire })}
                        </Badge>
                      )}
                    </div>
                  ) : null}

                  {/* 节点列表 */}
                  {sub.nodes.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      {t("px.sub.noNodes")}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {sub.nodes.map((node, i) => {
                        const nodeKey = `${sub.id}-${i}`
                        const nodeExpanded = expandedNodes[nodeKey] ?? false
                        return (
                          <div key={nodeKey} className="rounded-md border p-3">
                            <div
                              className="flex cursor-pointer select-none flex-wrap items-center justify-between gap-2"
                              onClick={() =>
                                setExpandedNodes((prev) => ({
                                  ...prev,
                                  [nodeKey]: !nodeExpanded,
                                }))
                              }
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <ChevronDown
                                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                                    nodeExpanded ? "" : "-rotate-90"
                                  }`}
                                />
                                <span className="truncate text-sm font-medium">
                                  {node.name || t("px.nodeN", { n: i + 1 })}
                                </span>
                                <Badge
                                  variant={PROTOCOL_BADGE_VARIANT[node.protocol] ?? "outline"}
                                  className="font-mono text-xs"
                                >
                                  {node.protocol}
                                </Badge>
                                {node.region && (
                                  <Badge variant="outline" className="text-xs">
                                    {node.region}
                                  </Badge>
                                )}
                                {node.duplicateOf && (
                                  <Badge variant="secondary" className="text-xs">
                                    {t("px.duplicateOf", { name: node.duplicateOf })}
                                  </Badge>
                                )}
                                <NodeProbeBadge
                                  latency={nodeLatency[nodeKey]}
                                  health={node.health}
                                  testable={canTestLatency(node.protocol)}
                                />
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void copyText(node.raw, t("px.ok.nodeCopied"))
                                }}
                              >
                                <Copy className="h-3.5 w-3.5" />
                                {t("px.nodeCopy")}
                              </Button>
                            </div>
                            {nodeExpanded && (
                              <div className="mt-2 border-t pt-2">
                                <NodeDetails node={node} />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {sub.note && (
                    <p className="text-xs text-muted-foreground">{sub.note}</p>
                  )}
                </CardContent>
                )}
              </Card>
            )
          })}
          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? t("px.loading") : t("px.showMore")}
            </Button>
          )}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        {t("px.note")}
      </p>

      <AgreementDialog open={agreementOpen} onOpenChange={setAgreementOpen} />
    </div>
  )
}

function AgreementDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("px.consent.dialogTitle", { v: PROXY_CONSENT_VERSION })}</DialogTitle>
          <DialogDescription>{t("px.consent.dialogDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {PROXY_AGREEMENT.map((s) => (
            <div key={s.title}>
              <p className="text-sm font-medium">{t(s.title)}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t(s.body)}</p>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("dash.dialog.gotIt")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}