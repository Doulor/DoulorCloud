import * as React from "react"
import {
  AlertTriangle,
  Copy,
  Download,
  FileCode2,
  Loader2,
  Network,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { FeatureLockedNotice } from "@/components/feature-locked-notice"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { frpApi, HttpError } from "@/services/api"
import { fmtTime } from "@/lib/format"
import type { FrpApplication, FrpNode, FrpOverview, FrpTunnel } from "@/types"
import { useT, tStatic } from "@/i18n"

const STATUS_BADGE: Record<
  FrpApplication["status"],
  { label: string; variant: "success" | "secondary" | "destructive" }
> = {
  pending: { label: "frp.st.pending", variant: "secondary" },
  approved: { label: "frp.st.approved", variant: "success" },
  rejected: { label: "frp.st.rejected", variant: "destructive" },
}

const NODE_STATUS: Record<
  FrpNode["status"],
  { label: string; variant: "success" | "secondary" | "destructive" | "outline" }
> = {
  online: { label: "frp.ns.online", variant: "success" },
  offline: { label: "frp.ns.offline", variant: "destructive" },
  maintenance: { label: "frp.ns.maintenance", variant: "secondary" },
  unknown: { label: "frp.ns.unknown", variant: "outline" },
}

function NodeStatusBadge({ node }: { node: FrpNode }) {
  const { t } = useT()
  const cfg = NODE_STATUS[node.status] ?? NODE_STATUS.unknown
  return (
    <Badge variant={cfg.variant} className="text-xs">
      {node.status === "online" && (
        <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {t(cfg.label)}
    </Badge>
  )
}

/**
 * 生成 frpc 的 config.toml。
 *
 * 优先用服务端下发的**参数化模板**（捐献者提供的 frpc.toml 样例剥掉个人凭据后得到），
 * 这样带鉴权插件 / 自定义字段的服务器也能生成正确配置；模板为空时回落到内置生成器。
 * 占位符：{serverAddr} {serverPort} {authToken} {user} {password} {proxies}。
 */
function buildConfig(
  node: FrpNode,
  app: FrpApplication,
  metadatasToken: string,
  authToken: string,
  template: string | null
): string {
  const proxiesBlock =
    app.tunnels.length === 0
      ? tStatic("frp.cfg.noTunnels")
      : app.tunnels
          .map((tn) =>
            [
              "[[proxies]]",
              `name = "${tn.name}"`,
              `type = "${tn.type}"`,
              `localIP = "${tn.localIP}"`,
              `localPort = ${tn.localPort}`,
              `remotePort = ${tn.remotePort}`,
              "",
            ].join("\n")
          )
          .join("")

  const values: Record<string, string> = {
    "{serverAddr}": node.serverAddr,
    "{serverPort}": String(node.serverPort),
    "{authToken}": authToken.trim(),
    "{user}": app.frpUser,
    "{password}": metadatasToken,
  }

  // 没有模板 → 用内置生成器（与后端 frp-config.ts 的 DEFAULT_FRP_TEMPLATE 一致）
  const tpl =
    (template ?? "").trim() ||
    [
      'serverAddr = "{serverAddr}"',
      "serverPort = {serverPort}",
      "",
      'auth.token = "{authToken}"',
      "",
      'user = "{user}"',
      'metadatas.token = "{password}"',
    ].join("\n")

  // 值为空的占位符 → 删掉整行（`auth.token = ""` 会让 frpc 直接连不上）
  const emptyKeys = ["{serverAddr}", "{serverPort}", "{authToken}", "{user}", "{password}"]
    .filter((ph) => !values[ph])
  let body = tpl
    .split("\n")
    .filter((line) => !emptyKeys.some((ph) => line.includes(ph)))
    .join("\n")

  for (const [ph, v] of Object.entries(values)) {
    body = body.split(ph).join(v)
  }

  body = body.includes("{proxies}")
    ? body.split("{proxies}").join(proxiesBlock)
    : `${body}\n\n${proxiesBlock}`

  return `${body.replace(/\n{3,}/g, "\\n\\n").trimEnd()}\n\n${tStatic("frp.cfg.generatedBy", { at: new Date().toLocaleString(tStatic("frp.cfg.locale")) })}`
}

export default function FrpPage() {
  const { t } = useT()
  const [data, setData] = React.useState<FrpOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  // 申请表单
  const [applyOpen, setApplyOpen] = React.useState(false)
  const [form, setForm] = React.useState({
    nodeId: "",
    frpUser: "",
    frpPassword: "",
    notifyEmail: "",
    remark: "",
  })
  const [selectedPorts, setSelectedPorts] = React.useState<number[]>([])
  const [portInput, setPortInput] = React.useState("")
  const [tunnels, setTunnels] = React.useState<FrpTunnel[]>([])

  // 配置生成
  const [configApp, setConfigApp] = React.useState<FrpApplication | null>(null)
  const [configText, setConfigText] = React.useState("")

  // 无权限（403 FEATURE_NOT_PERMITTED）：整页显示提示 + 捐献入口
  const [locked, setLocked] = React.useState(false)

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await frpApi.overview()
      setData(res)
      if (res.notifyOptions.length > 0) {
        setForm((f) => ({
          ...f,
          notifyEmail: f.notifyEmail || res.notifyOptions[0].email,
        }))
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

  const nodeById = (id: string) => data?.nodes.find((n) => n.id === id) ?? null

  const takenSet = React.useMemo(() => {
    const s = new Set<number>()
    for (const p of data?.takenPorts[form.nodeId] ?? []) s.add(p)
    return s
  }, [data, form.nodeId])

  const addPort = () => {
    const node = nodeById(form.nodeId)
    if (!node) {
      toast.error(t("frp.err.pickNode"))
      return
    }
    const p = Math.trunc(Number(portInput))
    if (!Number.isFinite(p)) {
      toast.error(t("frp.err.enterPort"))
      return
    }
    if (p < node.portMin || p > node.portMax) {
      toast.error(t("frp.err.portRange", { min: node.portMin, max: node.portMax }))
      return
    }
    if (takenSet.has(p)) {
      toast.error(t("frp.err.portTaken", { port: p }))
      return
    }
    if (selectedPorts.includes(p)) {
      toast.error(t("frp.err.portAdded"))
      return
    }
    if (selectedPorts.length >= node.maxPorts) {
      toast.error(t("frp.err.portLimit", { n: node.maxPorts }))
      return
    }
    setSelectedPorts((prev) => [...prev, p].sort((a, b) => a - b))
    setPortInput("")
  }

  const addTunnel = () => {
    setTunnels((prev) => [
      ...prev,
      {
        name: `tunnel-${prev.length + 1}`,
        type: "tcp",
        localIP: "127.0.0.1",
        localPort: 8080,
        remotePort: selectedPorts[prev.length] ?? nodeById(form.nodeId)?.portMin ?? 20000,
      },
    ])
  }

  const patchTunnel = (i: number, patch: Partial<FrpTunnel>) =>
    setTunnels((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))

  const handleEnable = async () => {
    setBusy(true)
    try {
      await frpApi.enable()
      toast.success(t("frp.ok.enabled"))
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
      await frpApi.disable()
      toast.success(t("frp.ok.disabled"))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.op"))
    } finally {
      setBusy(false)
    }
  }

  const handleApply = async () => {
    setBusy(true)
    try {
      await frpApi.apply({
        nodeId: form.nodeId,
        frpUser: form.frpUser,
        frpPassword: form.frpPassword,
        ports: selectedPorts,
        tunnels,
        notifyEmail: form.notifyEmail,
        remark: form.remark,
      })
      toast.success(t("frp.ok.submitted"))
      setApplyOpen(false)
      setSelectedPorts([])
      setTunnels([])
      setForm((f) => ({ ...f, frpPassword: "", remark: "" }))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("frp.err.submit"))
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async (app: FrpApplication) => {
    try {
      await frpApi.cancel(app.id)
      toast.success(t("frp.ok.withdrawn"))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("frp.err.withdraw"))
    }
  }

  /** 打开配置生成：只对已通过的申请可用（后端已批准并分配端口） */
  const openConfig = (app: FrpApplication) => {
    const node = nodeById(app.nodeId)
    if (!node) {
      toast.error(t("frp.err.nodeMissing"))
      return
    }
    setConfigApp(app)
    if (!app.configAuthToken) {
      toast.error(t("frp.err.noToken"))
      return
    }
    // metadatas.token 就是申请时填写的密码
    setConfigText(
      buildConfig(node, app, app.frpPassword, app.configAuthToken, app.configTemplate)
    )
  }

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(configText)
      toast.success(t("frp.ok.copied"))
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  const downloadConfig = () => {
    const blob = new Blob([configText], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "config.toml"
    a.click()
    URL.revokeObjectURL(url)
    toast.success(t("frp.ok.downloaded"))
  }

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="frp"
        featureLabel={t("feat.frp")}
        description={t("locked.desc", { feature: t("feat.frp") })}
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={t("frp.title")} description={t("frp.subtitle")} />
        <LoadingBlock />
      </div>
    )
  }

  if (!data?.featureEnabled) {
    return (
      <div>
        <PageHeader title={t("frp.title")} description={t("frp.subtitle")} />
        <EmptyState
          title={t("ai.disabled")}
          description={t("frp.disabledDesc")}
        />
      </div>
    )
  }

  // 未启用：与网盘/中转站一致，先让用户手动启用
  if (!data.activated) {
    return (
      <div>
        <PageHeader title={t("frp.title")} description={t("frp.subtitle")} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Network className="h-4 w-4 text-muted-foreground" />
              {t("frp.intro.title")}
            </CardTitle>
            <CardDescription>
              {t("frp.intro.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>{t("frp.intro.s1")}</li>
              <li>{t("frp.intro.s2")}</li>
              <li>{t("frp.intro.s3")}</li>
            </ul>
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("frp.intro.note")}
            </div>
            <Button onClick={() => void handleEnable()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("frp.intro.cta")}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const approved = data.applications.filter((a) => a.status === "approved")

  return (
    <div>
      <PageHeader
        title={t("frp.title")}
        description={t("frp.tagline")}
        actions={
          <Button variant="outline" size="sm" onClick={() => void handleDisable()} disabled={busy}>
            {t("common.disable")}
          </Button>
        }
      />

      <div className="space-y-6">
        {/* 下载核心 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-muted-foreground" />
              {t("frp.step1.title")}
            </CardTitle>
            <CardDescription>
              {t("frp.step1.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href={data.coreUrl} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" />
                {t("frp.step1.download")}
              </a>
            </Button>
          </CardContent>
        </Card>

        {/* 节点 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4 text-muted-foreground" />
              {t("frp.nodes.title")}
            </CardTitle>
            <CardDescription>
              {t("frp.nodes.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.nodes.length === 0 ? (
              <EmptyState title={t("frp.nodes.empty")} description={t("frp.nodes.emptyDesc")} />
            ) : (
              <div className="space-y-3">
                {data.nodes.map((n) => {
                  const used = data.myPorts[n.id]?.length ?? 0
                  return (
                    <div
                      key={n.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="space-y-0.5">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          {n.name}
                          {n.region && (
                            <span className="text-xs text-muted-foreground">
                              {n.region}
                            </span>
                          )}
                          <NodeStatusBadge node={n} />
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {t("frp.nodes.line", {
                            addr: n.serverAddr,
                            port: n.serverPort,
                            min: n.portMin,
                            max: n.portMax,
                            n: n.maxPorts,
                          })}
                        </p>
                        {n.note && (
                          <p className="text-xs text-muted-foreground">{n.note}</p>
                        )}
                        {n.status === "offline" && (
                          <p className="text-xs text-destructive">
                            {t("frp.nodes.unavailable")}
                          </p>
                        )}
                        {n.statusNote && (
                          <p className="text-xs text-muted-foreground">
                            {n.statusNote}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {used > 0 && (
                          <Badge variant="secondary" className="text-xs">
                            {t("frp.nodes.used", { n: used })}
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          disabled={n.status === "offline" || n.status === "maintenance"}
                          onClick={() => {
                            setForm((f) => ({ ...f, nodeId: n.id }))
                            setSelectedPorts([])
                            setTunnels([])
                            setApplyOpen(true)
                          }}
                        >
                          {n.status === "maintenance" ? t("frp.ns.maintenance") : t("frp.nodes.apply")}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 我的申请 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("frp.apps.title", { n: data.applications.length })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.applications.length === 0 ? (
              <EmptyState
                title={t("frp.apps.empty")}
                description={t("frp.apps.emptyDesc")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("frp.apps.col.node")}</TableHead>
                    <TableHead>{t("frp.apps.col.account")}</TableHead>
                    <TableHead>{t("frp.apps.col.ports")}</TableHead>
                    <TableHead>{t("frp.apps.col.status")}</TableHead>
                    <TableHead>{t("frp.apps.col.submitted")}</TableHead>
                    <TableHead className="w-40" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.applications.map((a) => {
                    const badge = STATUS_BADGE[a.status]
                    return (
                      <TableRow key={a.id}>
                        <TableCell className="text-sm">
                          {nodeById(a.nodeId)?.name ?? "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {a.frpUser}
                        </TableCell>
                        <TableCell className="text-xs">
                          {a.ports.join(", ") || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={badge.variant}>{t(badge.label)}</Badge>
                          {a.reviewNote && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {a.reviewNote}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTime(a.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {a.status === "approved" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openConfig(a)}
                              >
                                <FileCode2 className="h-3.5 w-3.5" />
                                {t("frp.apps.genConfig")}
                              </Button>
                            )}
                            {a.status === "pending" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground"
                                onClick={() => void handleCancel(a)}
                              >
                                <X className="h-3.5 w-3.5" />
                                {t("frp.apps.withdraw")}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {approved.length === 0 && data.applications.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("frp.apps.genHint")}
          </p>
        )}
      </div>

      {/* 申请弹窗 */}
      <ApplyDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        node={nodeById(form.nodeId)}
        form={form}
        setForm={setForm}
        selectedPorts={selectedPorts}
        setSelectedPorts={setSelectedPorts}
        portInput={portInput}
        setPortInput={setPortInput}
        takenSet={takenSet}
        onAddPort={addPort}
        tunnels={tunnels}
        setTunnels={setTunnels}
        onAddTunnel={addTunnel}
        patchTunnel={patchTunnel}
        notifyOptions={data.notifyOptions}
        busy={busy}
        onConfirm={() => void handleApply()}
      />

      {/* 配置生成弹窗 */}
      <Dialog
        open={configApp !== null}
        onOpenChange={(o) => {
          if (!o) {
            setConfigApp(null)
            setConfigText("")
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("frp.dlg.configTitle")}</DialogTitle>
            <DialogDescription>
              {t("frp.dlg.configDesc")}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {configText}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => void copyConfig()}>
              <Copy className="h-4 w-4" />
              {t("frp.dlg.copy")}
            </Button>
            <Button onClick={downloadConfig}>
              <Download className="h-4 w-4" />
              {t("frp.dlg.download")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface ApplyDialogProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  node: FrpNode | null
  form: { nodeId: string; frpUser: string; frpPassword: string; notifyEmail: string; remark: string }
  setForm: React.Dispatch<React.SetStateAction<ApplyDialogProps["form"]>>
  selectedPorts: number[]
  setSelectedPorts: React.Dispatch<React.SetStateAction<number[]>>
  portInput: string
  setPortInput: (v: string) => void
  takenSet: Set<number>
  onAddPort: () => void
  tunnels: FrpTunnel[]
  setTunnels: React.Dispatch<React.SetStateAction<FrpTunnel[]>>
  onAddTunnel: () => void
  patchTunnel: (i: number, patch: Partial<FrpTunnel>) => void
  notifyOptions: { email: string; kind: "site" | "real" }[]
  busy: boolean
  onConfirm: () => void
}

function ApplyDialog({
  open,
  onOpenChange,
  node,
  form,
  setForm,
  selectedPorts,
  setSelectedPorts,
  portInput,
  setPortInput,
  takenSet,
  onAddPort,
  tunnels,
  setTunnels,
  onAddTunnel,
  patchTunnel,
  notifyOptions,
  busy,
  onConfirm,
}: ApplyDialogProps) {
  const { t } = useT()
  // 这个节点要不要填「每用户账号 + 密码」——与后端 needsUserAccount() 同一个判断：
  //   token_user / custom → 需要
  //   token（只用全局 auth.token）/ none（无鉴权）→ **不需要**
  // node 还没加载出来时保守地当作需要（别把该填的字段藏掉）。
  const needAccount =
    !node || node.authMode === "token_user" || node.authMode === "custom"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("frp.dlg.applyTitle", { name: node?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {t("frp.dlg.applyDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* 账号密码：**只有需要「每用户账号」的节点才要填**（2026-09-30 修）。
              全局 auth.token / 无鉴权的节点上没有按用户区分的账号，填了也用不上：
              后端不会存，生成的 config.toml 里也不会出现 user / metadatas.token。 */}
          {needAccount ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="frpUser">{t("frp.dlg.user")}</Label>
                <Input
                  id="frpUser"
                  placeholder={t("frp.dlg.userPh")}
                  value={form.frpUser}
                  onChange={(e) => setForm((f) => ({ ...f, frpUser: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="frpPw">{t("settings.pw.new")}</Label>
                <Input
                  id="frpPw"
                  type="text"
                  placeholder={t("frp.dlg.pwPh")}
                  value={form.frpPassword}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, frpPassword: e.target.value }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t("frp.dlg.pwNote1a")}
                  <code>metadatas.token</code>
                  {t("frp.dlg.pwNote1b")}
                  {t("frp.dlg.pwNote2")}
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
              {t("frp.dlg.thisNode")}
              <span className="text-foreground">{t("frp.dlg.noAccountNeeded")}</span>
              {node?.authMode === "none"
                ? t("frp.dlg.noAuth")
                : t("frp.dlg.globalTokenOnly")}
              {t("frp.dlg.noAccountNoteA")}{" "}
              <code>user</code>
              {t("frp.dlg.noAccountNoteB")}
              <code>metadatas.token</code>
              {t("frp.dlg.noAccountNoteC")}
            </div>
          )}

          {/* 端口 */}
          <div className="space-y-2">
            <Label>
              {t("frp.dlg.ports", { n: node?.maxPorts ?? 5 })}
            </Label>
            <div className="flex gap-2">
              <Input
                placeholder={`${node?.portMin ?? 20000}-${node?.portMax ?? 50000}`}
                value={portInput}
                onChange={(e) => setPortInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    onAddPort()
                  }
                }}
              />
              <Button variant="outline" onClick={onAddPort} type="button">
                <Plus className="h-4 w-4" />
                {t("common.add")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedPorts.map((p) => (
                <Badge key={p} variant="secondary" className="gap-1 font-mono">
                  {p}
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedPorts((prev) => prev.filter((x) => x !== p))
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              {selectedPorts.length === 0 && (
                <span className="text-xs text-muted-foreground">{t("frp.dlg.noPorts")}</span>
              )}
            </div>
            {takenSet.size > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("frp.dlg.taken", { list: [...takenSet].sort((a, b) => a - b).slice(0, 20).join(", ") })}
                {takenSet.size > 20 ? " …" : ""}
              </p>
            )}
          </div>

          <Separator />

          {/* 隧道 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t("frp.dlg.tunnels", { n: tunnels.length })}</Label>
              <Button variant="outline" size="sm" onClick={onAddTunnel} type="button">
                <Plus className="h-3.5 w-3.5" />
                {t("frp.dlg.addTunnel")}
              </Button>
            </div>
            {tunnels.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("frp.dlg.tunnelHint")}
              </p>
            )}
            {tunnels.map((tn, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    placeholder={t("frp.dlg.tunnelName")}
                    value={tn.name}
                    onChange={(e) => patchTunnel(i, { name: e.target.value })}
                  />
                  <Select
                    value={tn.type}
                    onValueChange={(v) => patchTunnel(i, { type: v as "tcp" | "udp" })}
                  >
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tcp">tcp</SelectItem>
                      <SelectItem value="udp">udp</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setTunnels((prev) => prev.filter((_, x) => x !== i))}
                    type="button"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Input
                    placeholder={t("frp.dlg.localIp")}
                    value={tn.localIP}
                    onChange={(e) => patchTunnel(i, { localIP: e.target.value })}
                  />
                  <Input
                    type="number"
                    placeholder={t("frp.dlg.localPort")}
                    value={tn.localPort}
                    onChange={(e) =>
                      patchTunnel(i, { localPort: Number(e.target.value) })
                    }
                  />
                  <Input
                    type="number"
                    placeholder={t("frp.dlg.remotePort")}
                    value={tn.remotePort}
                    onChange={(e) =>
                      patchTunnel(i, { remotePort: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
            ))}
          </div>

          <Separator />

          {/* 通知邮箱 */}
          <div className="space-y-2">
            <Label htmlFor="notify">{t("frp.dlg.notify")}</Label>
            <Select
              value={form.notifyEmail}
              onValueChange={(v) => setForm((f) => ({ ...f, notifyEmail: v }))}
            >
              <SelectTrigger id="notify">
                <SelectValue placeholder={t("frp.dlg.notifyPh")} />
              </SelectTrigger>
              <SelectContent>
                {notifyOptions.map((o) => (
                  <SelectItem key={o.email} value={o.email}>
                    {o.email}
                    {o.kind === "real" ? t("frp.dlg.realMailbox") : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {notifyOptions.length === 0 && (
              <p className="text-xs text-destructive">
                {t("frp.dlg.noMailbox")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("frp.dlg.mailboxHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="remark">{t("frp.dlg.remark")}</Label>
            <Input
              id="remark"
              placeholder={t("frp.dlg.remarkPh")}
              value={form.remark}
              onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))}
            />
          </div>

          <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              {t("frp.dlg.footer")}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={
              busy ||
              !form.frpUser ||
              form.frpPassword.length < 6 ||
              selectedPorts.length === 0 ||
              !form.notifyEmail
            }
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("frp.dlg.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}