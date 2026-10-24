import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { confirmDialog } from "@/components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState } from "@/components/empty-state"
import { useT } from "@/i18n"
import { adminApi } from "@/services/api"
import type { AdminFrpAgent, AdminFrpNode, AdminFrpPlan, AdminFrpSubscription } from "@/types"

/**
 * 内网穿透「租用化」管理台（2026-10-13）。
 *
 * 这个组件的存在意义：**让管理员再也不需要打开 frps-panel 的网页**。
 * 那个网页现在其实是坏的（HTML/i18n 链路 panic），而且手工建号 + 手写到期日本来就
 * 不可能规模化 —— 存量 46 个账号的 comment 里全是人写的「Gatsby-2027-10.12」。
 *
 * 数据流（务必理解，否则会误判「为什么改了没立刻生效」）：
 *   管理端 → D1（唯一真值） → 服务器上的 frp-agent 每 20 秒拉一次 → frps-panel → frps
 * 所以本页所有操作**最多 20 秒后**才在面板上落地。表格里的「同步状态」就是这条链路的
 * 观测点：`synced` 表示 agent 已确认落地，`error` 会把原因直接显示出来。
 *
 * 因此本组件**从不直接调用面板**，管理员的操作也不会因为那台服务器抖动而失败。
 */

interface PlanFormState {
  id: string
  nodeId: string
  name: string
  days: string
  pricePoints: string
  maxPorts: string
  sortOrder: string
  enabled: boolean
  note: string
}

interface SubFormState {
  username: string
  nodeId: string
  planId: string
  days: string
  portCount: string
  ports: string
}

const EMPTY_PLAN: PlanFormState = {
  id: "",
  nodeId: "",
  name: "",
  days: "30",
  pricePoints: "100",
  maxPorts: "1",
  sortOrder: "0",
  enabled: true,
  note: "",
}

const EMPTY_SUB: SubFormState = {
  username: "",
  nodeId: "",
  planId: "",
  days: "30",
  portCount: "1",
  ports: "",
}

/** 把 "31000-31999, 32100" 解析成 [[31000,31999],[32100,32100]] */
function parseRangeText(text: string): [number, number][] {
  const out: [number, number][] = []
  for (const chunk of text.split(/[,，\s]+/)) {
    const t = chunk.trim()
    if (!t) continue
    const m = /^(\d+)\s*[-~]\s*(\d+)$/.exec(t)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      out.push([Math.min(a, b), Math.max(a, b)])
      continue
    }
    if (/^\d+$/.test(t)) {
      const n = Number(t)
      out.push([n, n])
    }
  }
  return out
}

function formatRanges(ranges: [number, number][]): string {
  return ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(", ")
}

export function AdminFrpRental() {
  const { t } = useT()

  const [plans, setPlans] = React.useState<AdminFrpPlan[]>([])
  const [subs, setSubs] = React.useState<AdminFrpSubscription[]>([])
  const [agents, setAgents] = React.useState<AdminFrpAgent[]>([])
  const [nodes, setNodes] = React.useState<AdminFrpNode[]>([])
  const [userPrefix, setUserPrefix] = React.useState("dcfrp_")
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")

  const [planOpen, setPlanOpen] = React.useState(false)
  const [planForm, setPlanForm] = React.useState<PlanFormState>(EMPTY_PLAN)
  const [rangeText, setRangeText] = React.useState("")

  const [subOpen, setSubOpen] = React.useState(false)
  const [subForm, setSubForm] = React.useState<SubFormState>(EMPTY_SUB)
  const [created, setCreated] = React.useState<{ user: string; token: string; ports: number[] } | null>(null)

  const [extendTarget, setExtendTarget] = React.useState<AdminFrpSubscription | null>(null)
  const [extendDays, setExtendDays] = React.useState("30")
  const [portsTarget, setPortsTarget] = React.useState<AdminFrpSubscription | null>(null)
  const [portsText, setPortsText] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [planRes, subRes, nodeRes] = await Promise.all([
        adminApi.listFrpRentalPlans(),
        adminApi.listFrpRentals(),
        adminApi.listFrpNodes(),
      ])
      setPlans(planRes.plans)
      setSubs(subRes.subscriptions)
      setAgents(subRes.agents)
      setUserPrefix(subRes.userPrefix)
      setNodes(nodeRes.nodes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError("")
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const statusBadge = (status: string) => {
    if (status === "active") return <Badge>{t("frpr.status.active")}</Badge>
    if (status === "expired") return <Badge variant="secondary">{t("frpr.status.expired")}</Badge>
    if (status === "cancelled") return <Badge variant="secondary">{t("frpr.status.cancelled")}</Badge>
    return <Badge variant="outline">{t("frpr.status.pending")}</Badge>
  }

  const syncBadge = (s: AdminFrpSubscription) => {
    if (s.syncState === "synced") {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t("frpr.sync.synced")}
        </span>
      )
    }
    if (s.syncState === "error") {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive" title={s.lastError ?? ""}>
          <XCircle className="h-3.5 w-3.5" />
          {t("frpr.sync.error")}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("frpr.sync.pending")}
      </span>
    )
  }

  const daysLeftText = (n: number) =>
    n >= 0 ? t("frpr.daysLeft", { v0: n }) : t("frpr.expiredAgo", { v0: Math.abs(n) })

  const openNewPlan = () => {
    setPlanForm({ ...EMPTY_PLAN, nodeId: nodes[0]?.id ?? "" })
    setRangeText("")
    setPlanOpen(true)
  }

  const openEditPlan = (p: AdminFrpPlan) => {
    setPlanForm({
      id: p.id,
      nodeId: p.nodeId,
      name: p.name,
      days: String(p.days),
      pricePoints: String(p.pricePoints),
      maxPorts: String(p.maxPorts),
      sortOrder: String(p.sortOrder),
      enabled: p.enabled,
      note: p.note ?? "",
    })
    setRangeText(formatRanges(p.allowRanges))
    setPlanOpen(true)
  }

  const submitPlan = async () => {
    const ranges = parseRangeText(rangeText)
    await run(async () => {
      await adminApi.upsertFrpRentalPlan({
        id: planForm.id || undefined,
        nodeId: planForm.nodeId,
        name: planForm.name,
        days: Number(planForm.days),
        pricePoints: Number(planForm.pricePoints),
        maxPorts: Number(planForm.maxPorts),
        sortOrder: Number(planForm.sortOrder),
        enabled: planForm.enabled,
        note: planForm.note,
        allowRanges: ranges.length > 0 ? ranges : undefined,
      })
      setPlanOpen(false)
    })
  }

  const submitSub = async () => {
    const explicitPorts = parseRangeText(subForm.ports)
      .map(([a]) => a)
      .filter((n) => n > 0)
    await run(async () => {
      const res = await adminApi.createFrpRental({
        username: subForm.username.trim(),
        nodeId: subForm.nodeId || undefined,
        planId: subForm.planId || undefined,
        days: Number(subForm.days),
        portCount: Number(subForm.portCount),
        ports: explicitPorts.length > 0 ? explicitPorts : undefined,
      })
      setSubOpen(false)
      setCreated({ user: res.frpUser, token: res.frpToken, ports: res.ports })
    })
  }

  if (loading && plans.length === 0 && subs.length === 0) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("frpr.loading")}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* ---- agent 心跳：这一条直接决定「管理端说的话算不算数」 ---- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" />
            {t("frpr.agent.title")}
          </CardTitle>
          <CardDescription>{t("frpr.agent.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("frpr.agent.never")}</p>
          ) : (
            agents.map((a) => (
              <div key={a.nodeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {a.online ? (
                  <span className="inline-flex items-center gap-1 font-medium">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    {t("frpr.agent.online")}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-destructive">
                    <XCircle className="h-4 w-4" />
                    {t("frpr.agent.offline")}
                  </span>
                )}
                <span className="text-muted-foreground">{a.nodeId}</span>
                <span className="text-muted-foreground">
                  {t("frpr.agent.lastSeen", { v0: new Date(a.lastSeenAt).toLocaleString() })}
                </span>
                <span className="text-muted-foreground">{t("frpr.agent.reports", { v0: a.reportCount })}</span>
                {a.lastError ? <span className="text-destructive">{a.lastError}</span> : null}
              </div>
            ))
          )}
              {/* ---- 节点健康（2026-10-24 起自动探测：控制端口 + agent 心跳） ---- */}
              {nodes.length > 0 ? (
                <div className="mt-3 space-y-2 border-t pt-3">
                  {nodes.map((n) => (
                    <div key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      {n.status === "online" ? (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                          <CheckCircle2 className="h-4 w-4" />
                          {t("frpr.node.online")}
                        </span>
                      ) : n.status === "degraded" ? (
                        <span className="inline-flex items-center gap-1 font-medium text-amber-600">
                          <AlertTriangle className="h-4 w-4" />
                          {t("frpr.node.degraded")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-medium text-destructive">
                          <XCircle className="h-4 w-4" />
                          {t("frpr.node.offline")}
                        </span>
                      )}
                      <span className="font-medium">{n.name}</span>
                      <span className="text-muted-foreground">{n.serverAddr}:{n.serverPort}</span>
                      {n.statusUpdatedAt ? (
                        <span className="text-muted-foreground">
                          {t("frpr.node.checkedAt", { v0: new Date(n.statusUpdatedAt).toLocaleString() })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("frpr.node.neverChecked")}</span>
                      )}
                      {n.statusNote ? <span className="text-destructive">{n.statusNote}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
        </CardContent>
      </Card>

      {/* ---- 套餐 ---- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 pb-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("frpr.plans.title")}</CardTitle>
            <CardDescription>{t("frpr.plans.desc")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" onClick={openNewPlan}>
              <Plus className="h-4 w-4" />
              {t("frpr.plans.add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {plans.length === 0 ? (
            <EmptyState title={t("frpr.plans.empty")} description={t("frpr.plans.emptyHint")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("frpr.plans.name")}</TableHead>
                  <TableHead>{t("frpr.plans.days")}</TableHead>
                  <TableHead>{t("frpr.plans.price")}</TableHead>
                  <TableHead>{t("frpr.plans.ports")}</TableHead>
                  <TableHead>{t("frpr.plans.ranges")}</TableHead>
                  <TableHead>{t("frpr.plans.state")}</TableHead>
                  <TableHead className="text-right">{t("frpr.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{t("frpr.unitDays", { v0: p.days })}</TableCell>
                    <TableCell>{t("frpr.unitPoints", { v0: p.pricePoints })}</TableCell>
                    <TableCell>{p.maxPorts}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRanges(p.allowRanges)}
                    </TableCell>
                    <TableCell>
                      {p.enabled ? (
                        <Badge>{t("frpr.plans.enabled")}</Badge>
                      ) : (
                        <Badge variant="secondary">{t("frpr.plans.disabled")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEditPlan(p)}>
                          {t("frpr.edit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await adminApi.deleteFrpRentalPlan(p.id)
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ---- 订阅 ---- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 pb-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("frpr.subs.title")}</CardTitle>
            <CardDescription>{t("frpr.subs.desc", { v0: userPrefix })}</CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setSubForm({ ...EMPTY_SUB, nodeId: nodes[0]?.id ?? "" })
              setCreated(null)
              setSubOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            {t("frpr.subs.create")}
          </Button>
        </CardHeader>
        <CardContent>
          {subs.length === 0 ? (
            <EmptyState title={t("frpr.subs.empty")} description={t("frpr.subs.emptyHint")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("frpr.subs.user")}</TableHead>
                  <TableHead>{t("frpr.subs.account")}</TableHead>
                  <TableHead>{t("frpr.subs.ports")}</TableHead>
                  <TableHead>{t("frpr.subs.expires")}</TableHead>
                  <TableHead>{t("frpr.subs.left")}</TableHead>
                  <TableHead>{t("frpr.subs.state")}</TableHead>
                  <TableHead>{t("frpr.subs.sync")}</TableHead>
                  <TableHead className="text-right">{t("frpr.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subs.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.username ?? s.userId.slice(0, 8)}</TableCell>
                    <TableCell className="font-mono text-xs">{s.frpUser}</TableCell>
                    <TableCell className="font-mono text-xs">{s.ports.join(", ")}</TableCell>
                    <TableCell className="text-xs">
                      {new Date(s.expiresAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        {daysLeftText(s.daysLeft)}
                      </span>
                    </TableCell>
                    <TableCell>{statusBadge(s.status)}</TableCell>
                    <TableCell>{syncBadge(s)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setExtendTarget(s)
                            setExtendDays("30")
                          }}
                        >
                          {t("frpr.act.extend")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await adminApi.updateFrpRental(s.id, {
                                action: s.status === "cancelled" ? "resume" : "suspend",
                              })
                            })
                          }
                        >
                          {s.status === "cancelled" ? t("frpr.act.resume") : t("frpr.act.suspend")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setPortsTarget(s)
                            setPortsText(s.ports.join(", "))
                          }}
                        >
                          {t("frpr.act.setPorts")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            const ok = await confirmDialog({
                              title: t("frpr.act.revoke"),
                              desc: t("frpr.act.revokeConfirm", { v0: s.frpUser }),
                              okText: t("frpr.act.revoke"),
                              danger: true,
                            })
                            if (!ok) return
                            await run(async () => {
                              await adminApi.updateFrpRental(s.id, { action: "revoke" })
                            })
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ---- 套餐编辑 ---- */}
      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{planForm.id ? t("frpr.plans.editTitle") : t("frpr.plans.addTitle")}</DialogTitle>
            <DialogDescription>{t("frpr.plans.formDesc")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>{t("frpr.form.node")}</Label>
              <Select
                value={planForm.nodeId}
                onValueChange={(v) => setPlanForm({ ...planForm, nodeId: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("frpr.form.nodeHint")}</p>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("frpr.form.name")}</Label>
              <Input
                value={planForm.name}
                onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })}
                placeholder={t("frpr.form.namePlaceholder")}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>{t("frpr.form.days")}</Label>
                <Input
                  type="number"
                  value={planForm.days}
                  onChange={(e) => setPlanForm({ ...planForm, days: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("frpr.form.price")}</Label>
                <Input
                  type="number"
                  value={planForm.pricePoints}
                  onChange={(e) => setPlanForm({ ...planForm, pricePoints: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("frpr.form.ports")}</Label>
                <Input
                  type="number"
                  value={planForm.maxPorts}
                  onChange={(e) => setPlanForm({ ...planForm, maxPorts: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("frpr.form.ranges")}</Label>
              <Input
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                placeholder="31000-31999"
              />
              <p className="text-xs text-muted-foreground">{t("frpr.form.rangesHint")}</p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t("frpr.form.enabled")}</Label>
                <p className="text-xs text-muted-foreground">{t("frpr.form.enabledHint")}</p>
              </div>
              <Switch
                checked={planForm.enabled}
                onCheckedChange={(v) => setPlanForm({ ...planForm, enabled: v })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanOpen(false)}>
              {t("frpr.cancel")}
            </Button>
            <Button onClick={() => void submitPlan()} disabled={busy || !planForm.name || !planForm.nodeId}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("frpr.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 手工开订阅 ---- */}
      <Dialog open={subOpen} onOpenChange={setSubOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("frpr.subs.createTitle")}</DialogTitle>
            <DialogDescription>{t("frpr.subs.createDesc")}</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">{t("frpr.created")}</p>
              <p className="font-mono text-xs">
                {t("frpr.form.username")}: {created.user}
              </p>
              <p className="font-mono text-xs break-all">
                {t("frpr.createdToken")}: {created.token}
              </p>
              <p className="font-mono text-xs">
                {t("frpr.subs.ports")}: {created.ports.join(", ")}
              </p>
              <p className="text-xs text-muted-foreground">{t("frpr.createdHint")}</p>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>{t("frpr.form.username")}</Label>
                <Input
                  value={subForm.username}
                  onChange={(e) => setSubForm({ ...subForm, username: e.target.value })}
                  placeholder={t("frpr.form.usernamePlaceholder")}
                />
                <p className="text-xs text-muted-foreground">{t("frpr.form.usernameHint")}</p>
              </div>
              <div className="grid gap-1.5">
                <Label>{t("frpr.form.plan")}</Label>
                <Select
                  value={subForm.planId}
                  onValueChange={(v) => setSubForm({ ...subForm, planId: v === "__none__" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("frpr.form.planNone")}</SelectItem>
                    {plans
                      .filter((p) => p.enabled)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} · {t("frpr.unitDays", { v0: p.days })} ·{" "}
                          {t("frpr.unitPoints", { v0: p.pricePoints })}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("frpr.form.planHint")}</p>
              </div>
              {!subForm.planId ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label>{t("frpr.form.days")}</Label>
                    <Input
                      type="number"
                      value={subForm.days}
                      onChange={(e) => setSubForm({ ...subForm, days: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>{t("frpr.form.portCount")}</Label>
                    <Input
                      type="number"
                      value={subForm.portCount}
                      onChange={(e) => setSubForm({ ...subForm, portCount: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label>{t("frpr.form.portsOptional")}</Label>
                <Input
                  value={subForm.ports}
                  onChange={(e) => setSubForm({ ...subForm, ports: e.target.value })}
                  placeholder="31100, 31101"
                />
                <p className="text-xs text-muted-foreground">{t("frpr.form.portsOptionalHint")}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubOpen(false)}>
              {created ? t("frpr.close") : t("frpr.cancel")}
            </Button>
            {created ? null : (
              <Button onClick={() => void submitSub()} disabled={busy || !subForm.username.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("frpr.subs.submit")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 续期 ---- */}
      <Dialog open={extendTarget !== null} onOpenChange={(v) => !v && setExtendTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("frpr.act.extendTitle")}</DialogTitle>
            <DialogDescription>
              {t("frpr.act.extendDesc", { v0: extendTarget?.frpUser ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>{t("frpr.act.extendDays")}</Label>
            <Input
              type="number"
              value={extendDays}
              onChange={(e) => setExtendDays(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("frpr.act.extendHint")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendTarget(null)}>
              {t("frpr.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const target = extendTarget
                setExtendTarget(null)
                void run(async () => {
                  await adminApi.updateFrpRental(target!.id, {
                    action: "extend",
                    days: Number(extendDays),
                  })
                })
              }}
            >
              {t("frpr.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 改端口 ---- */}
      <Dialog open={portsTarget !== null} onOpenChange={(v) => !v && setPortsTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("frpr.act.portsTitle")}</DialogTitle>
            <DialogDescription>
              {t("frpr.act.portsDesc", { v0: portsTarget?.frpUser ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>{t("frpr.subs.ports")}</Label>
            <Input value={portsText} onChange={(e) => setPortsText(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("frpr.act.portsHint")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPortsTarget(null)}>
              {t("frpr.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const target = portsTarget
                const ports = portsText
                  .split(/[,，\s]+/)
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isInteger(n) && n > 0)
                setPortsTarget(null)
                void run(async () => {
                  await adminApi.updateFrpRental(target!.id, { action: "setPorts", ports })
                })
              }}
            >
              {t("frpr.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
