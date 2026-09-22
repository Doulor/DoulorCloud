import * as React from "react"
import {
  Cloud,
  Copy,
  ExternalLink,
  Globe,
  HardDrive,
  Loader2,
  Power,
  RefreshCw,
  Trash2,
  Upload,
  X,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { storageApi, HttpError } from "@/services/api"
import type { StorageObject, StorageOverview } from "@/types"

/** 与 Worker 端 settings.ts 的 formatBytes 保持一致的展示逻辑 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

function fmtTime(iso: string | null) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * 上传中的进度状态。
 * 必须用唯一 id 而不是文件名做键：一次拖拽可能包含两个同名文件，
 * 用名字做键会导致两者的进度条目互相覆盖/提前消失。
 */
interface Uploading {
  id: string
  name: string
  percent: number
}

export default function StoragePage() {
  const [overview, setOverview] = React.useState<StorageOverview | null>(null)
  const [objects, setObjects] = React.useState<StorageObject[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [uploading, setUploading] = React.useState<Uploading[]>([])
  const [uploadActive, setUploadActive] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [domainOpen, setDomainOpen] = React.useState(false)
  const [selectedSub, setSelectedSub] = React.useState("")
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  /** 拉取概览与文件列表；silent 用于上传/删除后刷新，避免整页 loading 闪烁 */
  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await storageApi.overview()
      setOverview(res)
      if (res.account) {
        const list = await storageApi.list()
        setObjects(list.objects)
      } else {
        setObjects([])
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载网盘信息失败")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleEnable = async () => {
    setBusy(true)
    try {
      await storageApi.enable()
      toast.success("网盘已开通")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "开通失败")
    } finally {
      setBusy(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!overview?.account || busy) return
    setBusy(true)
    try {
      if (overview.account.enabled) {
        await storageApi.disable()
        toast.success("已关闭直链（文件保留）")
      } else {
        await storageApi.enable()
        toast.success("已重新启用")
      }
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  /**
   * 生成文件直链。
   * 若用户设置了「默认分享前缀」，则用 https://<子域名>/<文件名>，
   * 否则回退到 https://<站点>/dl/<用户名>/<文件名>。
   */
  const directLinkFor = (filename: string) => {
    if (!overview?.account) return ""
    const enc = encodeURIComponent(filename)
    if (overview.defaultPrefix) {
      return `https://${overview.defaultPrefix.fqdn}/${enc}`
    }
    return `${window.location.origin}/dl/${encodeURIComponent(
      overview.account.prefix
    )}/${enc}`
  }

  const handleSetDefaultPrefix = async (prefixId: string | null) => {
    setBusy(true)
    try {
      await storageApi.setDefaultPrefix(prefixId)
      toast.success(prefixId ? "已设为默认分享前缀" : "已恢复默认直链前缀")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "设置失败")
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("已复制直链")
    } catch {
      toast.error("复制失败，请手动选择复制")
    }
  }

  /** 单文件上传：预签名直传 R2（XHR 以获得真实进度），再回服务端登记 */
  const uploadOne = (file: File) =>
    new Promise<void>((resolve) => {
      // 用唯一 id 跟踪进度：同名文件不能互相覆盖进度条目
      const uid = crypto.randomUUID()
      setUploading((prev) => [...prev, { id: uid, name: file.name, percent: 0 }])
      const setPercent = (percent: number) =>
        setUploading((prev) =>
          prev.map((u) => (u.id === uid ? { ...u, percent } : u))
        )
      const done = () =>
        setUploading((prev) => prev.filter((u) => u.id !== uid))

      storageApi
        .uploadUrl({
          filename: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        })
        .then(({ uploadUrl, key }) => {
          const xhr = new XMLHttpRequest()
          xhr.open("PUT", uploadUrl, true)
          xhr.setRequestHeader(
            "Content-Type",
            file.type || "application/octet-stream"
          )
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setPercent(Math.round((e.loaded / e.total) * 100))
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              storageApi
                .commit({ key, contentType: file.type })
                .then(() => {
                  toast.success(`${file.name} 上传成功`)
                  done()
                  resolve()
                })
                .catch((err) => {
                  toast.error(
                    err instanceof HttpError ? err.message : `${file.name} 登记失败`
                  )
                  done()
                  resolve()
                })
            } else {
              toast.error(`${file.name} 上传失败 (${xhr.status})`)
              done()
              resolve()
            }
          }
          xhr.onerror = () => {
            toast.error(`${file.name} 上传中断`)
            done()
            resolve()
          }
          xhr.send(file)
        })
        .catch((err) => {
          toast.error(
            err instanceof HttpError ? err.message : `${file.name} 无法上传`
          )
          done()
          resolve()
        })
    })

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !overview?.account) return
    if (uploadActive) return // 防止拖拽与选择框并发触发两批上传

    setUploadActive(true)
    try {
      const max = overview.maxFileBytes
      const list = Array.from(files)

      for (const f of list.filter((f) => f.size > max)) {
        toast.error(`${f.name} 超过单文件上限 ${formatBytes(max)}`)
      }

      for (const file of list.filter((f) => f.size <= max)) {
        await uploadOne(file)
      }
    } finally {
      setUploadActive(false)
      await load(true)
    }
  }

  const handleDelete = async (obj: StorageObject) => {
    try {
      await storageApi.remove(obj.key)
      toast.success(`已删除 ${obj.filename}`)
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  const handleBindDomain = async () => {
    if (!selectedSub) return
    setBusy(true)
    try {
      const res = await storageApi.bindDomain(selectedSub)
      toast.success(
        res.prefix.dnsCreated
          ? "直链域名已绑定，DNS 与证书生效通常需要 1-2 分钟"
          : "直链域名已绑定"
      )
      setDomainOpen(false)
      setSelectedSub("")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "绑定失败")
    } finally {
      setBusy(false)
    }
  }

  const handleUnbind = async (id: string) => {
    try {
      await storageApi.unbindDomain(id)
      toast.success("已解绑")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "解绑失败")
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="网盘" description="R2 直链网盘" />
        <LoadingBlock />
      </div>
    )
  }

  if (!overview?.configured) {
    return (
      <div>
        <PageHeader title="网盘" description="R2 直链网盘" />
        <EmptyState
          title="网盘尚未配置"
          description="管理员还未配置 R2 存储凭据，请稍后再试。"
        />
      </div>
    )
  }

  if (!overview.account) {
    return (
      <div>
        <PageHeader title="网盘" description="R2 直链网盘" />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              开通直链网盘
            </CardTitle>
            <CardDescription>
              开通后会在 R2 中创建以你的用户名命名的目录，配额{" "}
              {formatBytes(overview.defaultQuotaBytes)}，文件可通过直链公开访问。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>· 默认直链：{window.location.origin}/dl/&lt;你的用户名&gt;/&lt;文件名&gt;</li>
              <li>· 可绑定自己的二级域名作为前缀（如 blog.doulor.cn/a.png）</li>
              <li>· 直链是公开的，拿到链接的人都能访问，请勿存放隐私文件</li>
            </ul>
            <Button onClick={() => void handleEnable()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              开通网盘
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const account = overview.account
  const usedPercent =
    account.quotaBytes > 0
      ? Math.min(100, (account.usedBytes / account.quotaBytes) * 100)
      : 0

  return (
    <div>
      <PageHeader
        title="网盘"
        description={`目录 ${account.prefix}/ · ${account.fileCount} 个文件`}
      />

      <div className="space-y-6">
        {/* 用量 + 操作 */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  存储用量
                </CardTitle>
                <CardDescription>
                  {formatBytes(account.usedBytes)} / {formatBytes(account.quotaBytes)}
                  {!account.enabled && " · 直链已关闭（文件保留）"}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void load()}
                  disabled={busy}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  刷新
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleToggleEnabled()}
                  disabled={busy}
                >
                  <Power className="h-3.5 w-3.5" />
                  {account.enabled ? "关闭直链" : "启用直链"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              已使用 {usedPercent.toFixed(1)}% · 单文件上限{" "}
              {formatBytes(overview.maxFileBytes)}
            </p>
          </CardContent>
        </Card>

        {/* 直链地址 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-muted-foreground" />
              直链地址
            </CardTitle>
            <CardDescription>
              默认前缀开箱即用；也可以绑定自己的二级域名作为前缀。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 当前默认分享前缀（复制直链时使用） */}
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={`${overview.shareBase ?? account.directLinkBase}/`}
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  void copyText(`${overview.shareBase ?? account.directLinkBase}/`)
                }
                title="复制"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {overview.defaultPrefix
                ? `默认分享前缀：${overview.defaultPrefix.fqdn}`
                : "默认分享前缀：站点直链路径（可在下方绑定域名后设为默认）"}
            </p>

            {overview.prefixes.length > 0 && (
              <div className="space-y-2">
                {overview.prefixes.map((p) => {
                  const isDefault = account.defaultPrefixId === p.id
                  return (
                    <div key={p.id} className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={`https://${p.fqdn}/`}
                        className="font-mono text-xs"
                      />
                      {isDefault ? (
                        <Badge variant="success" className="shrink-0">
                          默认
                        </Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void handleSetDefaultPrefix(p.id)}
                          disabled={busy}
                          title="设为复制直链时使用的默认前缀"
                        >
                          设为默认
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => void copyText(`https://${p.fqdn}/`)}
                        title="复制"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => void handleUnbind(p.id)}
                        title="解绑"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })}
                {account.defaultPrefixId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => void handleSetDefaultPrefix(null)}
                    disabled={busy}
                  >
                    恢复为站点默认直链
                  </Button>
                )}
              </div>
            )}

            {overview.customDomainSupported ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDomainOpen(true)}
                disabled={overview.availableSubdomains.length === 0}
              >
                <Globe className="h-3.5 w-3.5" />
                绑定二级域名
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                自定义直链域名未启用（管理员需配置 CF_WORKERS_TOKEN）。
              </p>
            )}
          </CardContent>
        </Card>

        {/* 上传 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              文件
            </CardTitle>
            <CardDescription>拖拽到下方区域，或点击选择文件。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                void handleFiles(e.dataTransfer.files)
              }}
              onClick={() => {
                if (!uploadActive) fileInputRef.current?.click()
              }}
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                uploadActive ? "cursor-wait opacity-60" : "cursor-pointer"
              } ${
                dragging ? "border-primary bg-accent/40" : "border-muted-foreground/25"
              }`}
            >
              <Upload className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">
                {uploadActive ? "正在上传…" : "拖拽文件到此处上传"}
              </p>
              <p className="text-xs text-muted-foreground">
                单文件不超过 {formatBytes(overview.maxFileBytes)}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                disabled={uploadActive}
                className="hidden"
                onChange={(e) => {
                  void handleFiles(e.target.files)
                  e.target.value = ""
                }}
              />
            </div>

            {uploading.length > 0 && (
              <div className="space-y-2">
                {uploading.map((u) => (
                  <div key={u.id} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="truncate">{u.name}</span>
                      <span className="text-muted-foreground">{u.percent}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${u.percent}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 文件列表 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">文件列表（{objects.length}）</CardTitle>
          </CardHeader>
          <CardContent>
            {objects.length === 0 ? (
              <EmptyState
                title="还没有文件"
                description="上传第一个文件后，这里会显示直链。"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>文件名</TableHead>
                    <TableHead>大小</TableHead>
                    <TableHead>上传时间</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {objects.map((o) => {
                    const link = directLinkFor(o.filename)
                    return (
                      <TableRow key={o.key}>
                        <TableCell className="max-w-xs truncate font-mono text-xs">
                          {o.filename}
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatBytes(o.size)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTime(o.lastModified)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              onClick={() => void copyText(link)}
                              title="复制直链"
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              asChild
                              title="打开直链"
                            >
                              <a href={link} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleDelete(o)}
                              title="删除"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
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
      </div>

      {/* 绑定二级域名 */}
      <Dialog open={domainOpen} onOpenChange={setDomainOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>绑定自定义直链域名</DialogTitle>
            <DialogDescription>
              该子域名的根路径将直接指向你的网盘目录，可用作图床。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="domainSelect">子域名</Label>
            <Select value={selectedSub} onValueChange={setSelectedSub}>
              <SelectTrigger id="domainSelect">
                <SelectValue placeholder="选择子域名" />
              </SelectTrigger>
              <SelectContent>
                {overview.availableSubdomains.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.fqdn}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              绑定后访问 https://&lt;子域名&gt;/文件名 即可直接读取网盘中的文件。
              该子域名上不能已有 DNS 记录。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDomainOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void handleBindDomain()}
              disabled={busy || !selectedSub}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              绑定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}