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

const STATUS_BADGE: Record<
  FrpApplication["status"],
  { label: string; variant: "success" | "secondary" | "destructive" }
> = {
  pending: { label: "待审核", variant: "secondary" },
  approved: { label: "已通过", variant: "success" },
  rejected: { label: "未通过", variant: "destructive" },
}

const NODE_STATUS: Record<
  FrpNode["status"],
  { label: string; variant: "success" | "secondary" | "destructive" | "outline" }
> = {
  online: { label: "运行中", variant: "success" },
  offline: { label: "不可用", variant: "destructive" },
  maintenance: { label: "维护中", variant: "secondary" },
  unknown: { label: "状态未知", variant: "outline" },
}

function NodeStatusBadge({ node }: { node: FrpNode }) {
  const cfg = NODE_STATUS[node.status] ?? NODE_STATUS.unknown
  return (
    <Badge variant={cfg.variant} className="text-xs">
      {node.status === "online" && (
        <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {cfg.label}
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
      ? "# 你还没有添加隧道，请在网页上添加后重新生成"
      : app.tunnels
          .map((t) =>
            [
              "[[proxies]]",
              `name = "${t.name}"`,
              `type = "${t.type}"`,
              `localIP = "${t.localIP}"`,
              `localPort = ${t.localPort}`,
              `remotePort = ${t.remotePort}`,
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

  return `${body.replace(/\n{3,}/g, "\n\n").trimEnd()}\n\n# 由 Doulor Cloud 生成 · ${new Date().toLocaleString("zh-CN")}\n`
}

export default function FrpPage() {
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
      toast.error(err instanceof HttpError ? err.message : "加载失败")
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
      toast.error("请先选择节点")
      return
    }
    const p = Math.trunc(Number(portInput))
    if (!Number.isFinite(p)) {
      toast.error("请输入端口号")
      return
    }
    if (p < node.portMin || p > node.portMax) {
      toast.error(`端口需在 ${node.portMin}-${node.portMax} 之间`)
      return
    }
    if (takenSet.has(p)) {
      toast.error(`端口 ${p} 已被占用，请换一个`)
      return
    }
    if (selectedPorts.includes(p)) {
      toast.error("该端口已添加")
      return
    }
    if (selectedPorts.length >= node.maxPorts) {
      toast.error(`最多选择 ${node.maxPorts} 个端口`)
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
      toast.success("已启用内网穿透")
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
      await frpApi.disable()
      toast.success("已关闭内网穿透（已通过的端口占用仍保留）")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
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
      toast.success("申请已提交，等待管理员审核（结果会发到通知邮箱）")
      setApplyOpen(false)
      setSelectedPorts([])
      setTunnels([])
      setForm((f) => ({ ...f, frpPassword: "", remark: "" }))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "提交失败")
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async (app: FrpApplication) => {
    try {
      await frpApi.cancel(app.id)
      toast.success("已撤回申请")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "撤回失败")
    }
  }

  /** 打开配置生成：只对已通过的申请可用（后端已批准并分配端口） */
  const openConfig = (app: FrpApplication) => {
    const node = nodeById(app.nodeId)
    if (!node) {
      toast.error("节点信息缺失")
      return
    }
    setConfigApp(app)
    if (!app.configAuthToken) {
      toast.error("缺少节点密钥，请联系管理员")
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
      toast.success("config.toml 内容已复制")
    } catch {
      toast.error("复制失败，请手动选择复制")
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
    toast.success("config.toml 已下载")
  }

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="frp"
        featureLabel="内网穿透"
        description="你的账号未被授予「内网穿透」权限。站长资源有限，该服务暂未全量开放。"
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="内网穿透" description="frp 内网穿透" />
        <LoadingBlock />
      </div>
    )
  }

  if (!data?.featureEnabled) {
    return (
      <div>
        <PageHeader title="内网穿透" description="frp 内网穿透" />
        <EmptyState
          title="功能已关闭"
          description="管理员暂时关闭了内网穿透功能。"
        />
      </div>
    )
  }

  // 未启用：与网盘/中转站一致，先让用户手动启用
  if (!data.activated) {
    return (
      <div>
        <PageHeader title="内网穿透" description="frp 内网穿透" />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Network className="h-4 w-4 text-muted-foreground" />
              启用内网穿透
            </CardTitle>
            <CardDescription>
              启用后可以选择节点、申请账号与端口，并生成 config.toml。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>· 第一步：下载 frp 核心包并解压</li>
              <li>· 第二步：选择节点，提交账号 / 端口 / 隧道申请</li>
              <li>· 第三步：管理员审核通过后，生成 config.toml 替换到核心目录</li>
            </ul>
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              申请需要人工审核，结果会发送到你选择的邮箱（本站邮箱或已验证的真实邮箱）。
            </div>
            <Button onClick={() => void handleEnable()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              启用内网穿透
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
        title="内网穿透"
        description="把本机服务通过 frp 暴露到公网"
        actions={
          <Button variant="outline" size="sm" onClick={() => void handleDisable()} disabled={busy}>
            关闭功能
          </Button>
        }
      />

      <div className="space-y-6">
        {/* 下载核心 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-muted-foreground" />
              第一步：下载 frp 核心
            </CardTitle>
            <CardDescription>
              下载后解压，再用下方生成的 config.toml 替换压缩包内的同名文件。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href={data.coreUrl} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" />
                下载 frp 核心包
              </a>
            </Button>
          </CardContent>
        </Card>

        {/* 节点 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4 text-muted-foreground" />
              可用节点
            </CardTitle>
            <CardDescription>
              选择节点后提交申请，管理员人工审核通过后即可使用。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.nodes.length === 0 ? (
              <EmptyState title="暂无可用节点" description="请联系管理员添加节点。" />
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
                          {n.serverAddr}:{n.serverPort} · 端口 {n.portMin}-
                          {n.portMax} · 最多 {n.maxPorts} 个
                        </p>
                        {n.note && (
                          <p className="text-xs text-muted-foreground">{n.note}</p>
                        )}
                        {n.status === "offline" && (
                          <p className="text-xs text-destructive">
                            该节点当前不可用，请选择其它节点
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
                            已占用 {used} 个端口
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
                          {n.status === "maintenance" ? "维护中" : "申请账号"}
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
              我的申请（{data.applications.length}）
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.applications.length === 0 ? (
              <EmptyState
                title="还没有申请"
                description="选择上方节点提交申请。"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>节点</TableHead>
                    <TableHead>账号</TableHead>
                    <TableHead>端口</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>提交时间</TableHead>
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
                          <Badge variant={badge.variant}>{badge.label}</Badge>
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
                                生成配置
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
                                撤回
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
            申请通过后这里会出现「生成配置」按钮。
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
            <DialogTitle>生成 config.toml</DialogTitle>
            <DialogDescription>
              复制或下载后，替换 frp 核心压缩包里的 config.toml，然后启动 frpc。
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {configText}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => void copyConfig()}>
              <Copy className="h-4 w-4" />
              复制内容
            </Button>
            <Button onClick={downloadConfig}>
              <Download className="h-4 w-4" />
              下载 config.toml
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
          <DialogTitle>申请内网穿透账号 · {node?.name ?? ""}</DialogTitle>
          <DialogDescription>
            提交后由管理员人工审核，结果会发送到你选择的邮箱。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* 账号密码：**只有需要「每用户账号」的节点才要填**（2026-09-30 修）。
              全局 auth.token / 无鉴权的节点上没有按用户区分的账号，填了也用不上：
              后端不会存，生成的 config.toml 里也不会出现 user / metadatas.token。 */}
          {needAccount ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="frpUser">账号名</Label>
                <Input
                  id="frpUser"
                  placeholder="字母/数字/_-"
                  value={form.frpUser}
                  onChange={(e) => setForm((f) => ({ ...f, frpUser: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="frpPw">密码</Label>
                <Input
                  id="frpPw"
                  type="text"
                  placeholder="6-64 位"
                  value={form.frpPassword}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, frpPassword: e.target.value }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  该密码会作为 config.toml 里的 <code>metadatas.token</code>，
                  也是管理员在 frps-panel 为你建号时使用的 token，请牢记。
                  只允许字母、数字和半角符号 <code>_!@#$%^&amp;*().-</code>，不要用空格或中文符号。
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
              这个节点
              <span className="text-foreground">不需要账号和密码</span>
              {node?.authMode === "none"
                ? "（它没有开启任何鉴权）"
                : "（它只用服务端全局 auth.token 鉴权）"}
              —— 直接选端口提交即可，生成的配置里也不会出现{" "}
              <code>user</code> / <code>metadatas.token</code> 这两行。
            </div>
          )}

          {/* 端口 */}
          <div className="space-y-2">
            <Label>
              选择端口（最多 {node?.maxPorts ?? 5} 个）
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
                添加
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
                <span className="text-xs text-muted-foreground">尚未选择端口</span>
              )}
            </div>
            {takenSet.size > 0 && (
              <p className="text-xs text-muted-foreground">
                该节点已占用：{[...takenSet].sort((a, b) => a - b).slice(0, 20).join(", ")}
                {takenSet.size > 20 ? " …" : ""}
              </p>
            )}
          </div>

          <Separator />

          {/* 隧道 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>隧道（{tunnels.length}）</Label>
              <Button variant="outline" size="sm" onClick={onAddTunnel} type="button">
                <Plus className="h-3.5 w-3.5" />
                添加隧道
              </Button>
            </div>
            {tunnels.length === 0 && (
              <p className="text-xs text-muted-foreground">
                可先提交申请，通过后再补隧道；也可以现在就配置好。
              </p>
            )}
            {tunnels.map((t, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="隧道名称"
                    value={t.name}
                    onChange={(e) => patchTunnel(i, { name: e.target.value })}
                  />
                  <Select
                    value={t.type}
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
                    placeholder="本地 IP"
                    value={t.localIP}
                    onChange={(e) => patchTunnel(i, { localIP: e.target.value })}
                  />
                  <Input
                    type="number"
                    placeholder="本地端口"
                    value={t.localPort}
                    onChange={(e) =>
                      patchTunnel(i, { localPort: Number(e.target.value) })
                    }
                  />
                  <Input
                    type="number"
                    placeholder="公网端口"
                    value={t.remotePort}
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
            <Label htmlFor="notify">结果通知邮箱</Label>
            <Select
              value={form.notifyEmail}
              onValueChange={(v) => setForm((f) => ({ ...f, notifyEmail: v }))}
            >
              <SelectTrigger id="notify">
                <SelectValue placeholder="选择邮箱" />
              </SelectTrigger>
              <SelectContent>
                {notifyOptions.map((o) => (
                  <SelectItem key={o.email} value={o.email}>
                    {o.email}
                    {o.kind === "real" ? "（真实邮箱）" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {notifyOptions.length === 0 && (
              <p className="text-xs text-destructive">
                没有可用邮箱：请先创建本站邮箱，或在「设置」中验证真实邮箱。
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              只能使用本站邮箱，或已验证的真实邮箱。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="remark">备注（可选）</Label>
            <Input
              id="remark"
              placeholder="用途说明，便于管理员审核"
              value={form.remark}
              onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))}
            />
          </div>

          <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              审核通过后，请到「我的申请」点「生成配置」拿到 config.toml。
              frp 会把你的本地服务暴露到公网，请自行确保服务安全。
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
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
            提交申请
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}