import * as React from "react"
import {
  AlertTriangle,
  ChevronDown,
  Copy,
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
import type { ProxyNode, ProxyOverview, ProxySubscription } from "@/types"

/**
 * 代理节点「使用协议」。版本与后端 PROXY_CONSENT_VERSION 一致。
 * 用户点「启用」前必须勾选同意，服务端才会写入启用状态。
 */
const PROXY_CONSENT_VERSION = 1

const PROXY_AGREEMENT = [
  {
    title: "一、服务性质",
    body: "本模块仅为你提供代理节点订阅链接的浏览与复制服务。节点本身由管理员维护，本站不保证节点随时可用、速度或稳定性。",
  },
  {
    title: "二、流量与到期信息",
    body: "剩余流量、到期日等信息直接取自订阅源返回的内容，解析不到时显示「未知」。",
  },
  {
    title: "三、使用限制",
    body: "订阅链接仅限本人使用，不得转赠、转卖或公开传播。你须对使用节点产生的全部行为负责，遵守所在地法律与平台规则。",
  },
  {
    title: "四、隐私说明",
    body: "启用本功能不会向本站上传你的任何代理流量。访问订阅源时，本站会在服务器端代为抓取并解析，订阅源可能记录访问信息。",
  },
  {
    title: "五、免责声明",
    body: "因使用代理节点产生的任何直接或间接损失，本站不承担责任。管理员有权在任何时候停用个别节点或整个功能。",
  },
]

const NODE_STATUS_BADGE: Record<
  string,
  { label: string; variant: "success" | "secondary" | "destructive" | "outline" }
> = {
  online: { label: "运行中", variant: "success" },
  offline: { label: "不可用", variant: "destructive" },
  maintenance: { label: "维护中", variant: "secondary" },
  unknown: { label: "状态未知", variant: "outline" },
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

function copyText(text: string, label = "已复制") {
  return navigator.clipboard
    .writeText(text)
    .then(() => toast.success(label))
    .catch(() => toast.error("复制失败，请手动选择复制"))
}

/** 订阅源的节点总数（含抓取失败时显示错误） */
function SubStatusBadge({ sub }: { sub: ProxySubscription }) {
  const cfg = NODE_STATUS_BADGE[sub.status] ?? NODE_STATUS_BADGE.unknown
  return (
    <Badge variant={cfg.variant} className="text-xs">
      {cfg.label}
    </Badge>
  )
}

/** 节点配置字段的可读展示 */
function NodeDetails({ node }: { node: ProxyNode }) {
  const fields: [string, string | null][] = [
    ["协议", node.protocol],
    ["服务器", node.server || null],
    ["端口", node.port ? String(node.port) : null],
    ["地区", node.region],
    ["UUID", node.details.uuid || null],
    ["密码", node.details.password || null],
    ["方法", node.details.method || null],
    ["SNI", node.details.sni || null],
    ["流控", node.details.flow || null],
    ["传输", node.details.network || null],
    ["TLS", node.details.tls || node.details.security || null],
    ["OBFS", node.details.obfs || node.details.headerType || null],
  ]
  const present = fields.filter(([, v]) => v !== null && v !== "")
  if (present.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        该节点未能完整解析，可复制原始链接手动导入客户端。
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

export default function ProxyPage() {
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

  // 无权限（403 FEATURE_NOT_PERMITTED）：整页显示提示 + 捐献入口
  const [locked, setLocked] = React.useState(false)

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await proxyApi.overview()
      setData(res)
      // 协议更新过时，要求重新同意
      if (res.activated && res.consentedVersion < res.consentVersion) {
        setConsent(false)
        toast.error("使用协议已更新，请重新阅读并同意")
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
        setLocked(true)
        return
      }
      toast.error(err instanceof HttpError ? err.message : "加载失败")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleEnable = async () => {
    if (!consent) {
      toast.error("请先阅读并勾选同意使用协议")
      return
    }
    setBusy(true)
    try {
      await proxyApi.enable(PROXY_CONSENT_VERSION)
      toast.success("已启用代理节点")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "启用失败")
    } finally {
      setBusy(false)
    }
  }

  const handleDisable = async () => {
    setBusy(true)
    try {
      await proxyApi.disable()
      toast.success("已关闭代理节点")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
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
          ? `${sub.name} 响应 ${res.latencyMs} ms`
          : res.message ?? "订阅地址不可达"
      )
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "检测失败")
    } finally {
      setCheckingId(null)
    }
  }

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="proxy"
        featureLabel="代理节点"
        description="你的账号未被授予「代理节点」权限。站长资源有限，该服务暂未全量开放。"
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="代理节点" description="订阅与节点" />
        <LoadingBlock />
      </div>
    )
  }

  if (!data?.featureEnabled) {
    return (
      <div>
        <PageHeader title="代理节点" description="订阅与节点" />
        <EmptyState
          title="功能已关闭"
          description="管理员暂时关闭了代理节点功能。"
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
        <PageHeader title="代理节点" description="订阅链接与节点浏览" />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-muted-foreground" />
              启用代理节点
            </CardTitle>
            <CardDescription>
              启用后你会看到全部可用的代理订阅与节点。首次启用需阅读并同意使用协议。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {needReconsent && (
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  使用协议已更新到版本 {data.consentVersion}，
                  请重新阅读并勾选同意后继续使用。
                </div>
              </div>
            )}
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>· 查看每个订阅源的协议、地区与当前状态</li>
              <li>· 复制订阅链接，或在页面上直接查看节点配置（地址 / 端口 / UUID / SNI）</li>
              <li>· 订阅源附带流量 / 到期信息时自动展示，否则显示「未知」</li>
            </ul>

            <div className="rounded-md border bg-muted/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">使用协议（版本 {PROXY_CONSENT_VERSION}）</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      启用即表示你已阅读并同意以下条款。
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setAgreementOpen(true)}>
                  查看全文
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
                我已阅读并同意《代理节点使用协议》（版本 {PROXY_CONSENT_VERSION}）
              </span>
            </label>

            <Button onClick={() => void handleEnable()} disabled={busy || !consent}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              同意并启用
            </Button>
          </CardContent>
        </Card>

        <AgreementDialog open={agreementOpen} onOpenChange={setAgreementOpen} />
      </div>
    )
  }

  const subs = data.subscriptions

  return (
    <div>
      <PageHeader
        title="代理节点"
        description="订阅链接与节点配置"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => void load()} aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleDisable()} disabled={busy}>
              关闭功能
            </Button>
          </div>
        }
      />

      {subs.length === 0 ? (
        <EmptyState
          title="暂无可用订阅源"
          description="管理员还没有添加代理订阅源，请稍后再来。"
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
                      </div>
                      <CardDescription className="text-xs">
                        共 {sub.nodes.length} 个节点
                        {sub.lastSyncedAt ? ` · 最近同步 ${fmtTime(sub.lastSyncedAt)}` : ""}
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
                            : result.message ?? "不可达"}
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleCheck(sub)
                        }}
                        disabled={checkingId === sub.id}
                      >
                        {checkingId === sub.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Zap className="h-3.5 w-3.5" />
                        )}
                        测延迟
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          void copyText(sub.url, "订阅链接已复制")
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        复制订阅
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
                        订阅地址抓取失败：{sub.fetchError}。请检查订阅链接是否有效，
                        或稍后点「测延迟」重试。
                      </div>
                    </div>
                  ) : null}

                  {/* 流量 / 到期 */}
                  {(sub.usage.used || sub.usage.total || sub.usage.expire) ? (
                    <div className="flex flex-wrap gap-2">
                      {sub.usage.total && (
                        <Badge variant="secondary" className="text-xs">
                          总流量 {sub.usage.total}
                        </Badge>
                      )}
                      {sub.usage.used && (
                        <Badge variant="secondary" className="text-xs">
                          已用 {sub.usage.used}
                        </Badge>
                      )}
                      {sub.usage.expire && (
                        <Badge variant="secondary" className="text-xs">
                          到期 {sub.usage.expire}
                        </Badge>
                      )}
                    </div>
                  ) : null}

                  {/* 节点列表 */}
                  {sub.nodes.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      该订阅源未解析出节点。
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
                                  {node.name || `节点 ${i + 1}`}
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
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void copyText(node.raw, "节点链接已复制")
                                }}
                              >
                                <Copy className="h-3.5 w-3.5" />
                                复制链接
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
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        节点延迟为对订阅地址的 HTTP 探活结果（近似值），不代表节点实际网络质量。
        剩余流量与到期日以订阅源返回为准。
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>代理节点使用协议（版本 {PROXY_CONSENT_VERSION}）</DialogTitle>
          <DialogDescription>启用本功能即视为同意以下条款。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {PROXY_AGREEMENT.map((s) => (
            <div key={s.title}>
              <p className="text-sm font-medium">{s.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}