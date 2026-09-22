import * as React from "react"
import {
  Box,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Lock,
  Upload,
  MessageSquareText,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
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
import { tempboxApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import type { TempboxBatch, TempboxConfig } from "@/types"

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

/** 文件名 → 是否可以内联预览（图片 / 纯文本） */
function isPreviewable(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|txt|md|log|json|ini|conf|yml|yaml)$/i.test(name)
}

/** 单个传输项（上传进度用） */
interface TransferItem {
  name: string
  size: number
  sent: number
  status: "pending" | "uploading" | "done" | "failed"
  error?: string
}

/**
 * 用 XHR 直传 R2 并回报进度。
 * fetch 无法获取上传进度，所以这里必须用 XHR。
 */
function putWithProgress(
  url: string,
  file: File,
  onProgress: (sent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url, true)
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream")
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`R2 返回 HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error("网络错误或跨域被拒（R2 CORS）"))
    xhr.ontimeout = () => reject(new Error("上传超时"))
    xhr.timeout = 30 * 60 * 1000
    xhr.send(file)
  })
}

/** 传输列表：逐项显示进度与状态，上传者可据此观察是否传完 */
function TransferList({ items }: { items: TransferItem[] }) {
  if (items.length === 0) return null
  return (
    <div className="space-y-2">
      {items.map((it) => {
        const pct = it.size > 0 ? Math.min(100, Math.round((it.sent / it.size) * 100)) : 0
        return (
          <div key={it.name} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{it.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {it.status === "failed" ? (
                  <span className="text-destructive">{it.error ?? "失败"}</span>
                ) : it.status === "done" ? (
                  <span className="text-emerald-600">完成</span>
                ) : it.status === "uploading" ? (
                  `${pct}% · ${fmtBytes(it.sent)} / ${fmtBytes(it.size)}`
                ) : (
                  "等待中"
                )}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full transition-all ${
                  it.status === "failed"
                    ? "bg-destructive"
                    : it.status === "done"
                      ? "bg-emerald-500"
                      : "bg-primary"
                }`}
                style={{ width: it.status === "done" ? "100%" : `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function TempboxPage() {
  const { user } = useAuth()
  const [config, setConfig] = React.useState<TempboxConfig | null>(null)
  const [loading, setLoading] = React.useState(true)

  // 解锁查看
  const [codeInput, setCodeInput] = React.useState("")
  const [batch, setBatch] = React.useState<TempboxBatch | null>(null)
  const [busy, setBusy] = React.useState(false)

  // 上传
  const [uploading, setUploading] = React.useState(false)
  const [createdCode, setCreatedCode] = React.useState<string | null>(null)
  const [previewText, setPreviewText] = React.useState<string | null>(null)
  /** 传输列表：上传者可观察每个文件的进度 / 失败原因 */
  const [transfers, setTransfers] = React.useState<TransferItem[]>([])
  // 纯文本互传
  const [textDraft, setTextDraft] = React.useState("")
  const [textBusy, setTextBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setConfig(await tempboxApi.config())
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载配置失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleUnlock = async () => {
    const code = codeInput.trim()
    if (!/^\d{4}$/.test(code)) {
      toast.error("请输入 4 位数字接收码")
      return
    }
    setBusy(true)
    try {
      setBatch(await tempboxApi.get(code))
      setPreviewText(null)
    } catch (err) {
      setBatch(null)
      toast.error(err instanceof HttpError ? err.message : "解锁失败")
    } finally {
      setBusy(false)
    }
  }

  /** 批量上传文件（一次选择多个；共用一个接收码，逐个回报进度） */
  const uploadFiles = async (files: File[]) => {
    if (!config || files.length === 0) return
    const list = files.filter((f) => {
      if (f.size > config.maxFileBytes) {
        toast.error(
          `${f.name} 超过 ${Math.round(config.maxFileBytes / 1024 / 1024)} MB 上限，已跳过`
        )
        return false
      }
      return true
    })
    if (list.length === 0) return

    // 传输列表：让上传者能逐个观察进度与失败原因
    const items: TransferItem[] = list.map((f) => ({
      name: f.name,
      size: f.size,
      sent: 0,
      status: "pending",
    }))
    // 必须用函数式更新：若用闭包里的 items 覆盖，后续 patch 会把前面的进度冲掉
    const patch = (index: number, next: Partial<TransferItem>) => {
      setTransfers((prev) =>
        prev.map((it, i) => (i === index ? { ...it, ...next } : it))
      )
    }

    setUploading(true)
    setTransfers(items)
    // 用局部变量持有 code，避免依赖 setState 的异步更新（连续多文件时只建一次批次）
    let code = createdCode
    let failed = 0
    try {
      if (!code) {
        const created = await tempboxApi.create()
        code = created.code
        setCreatedCode(code)
      }
      // 上传者立刻看到接收码，边传边等
      setCodeInput(code)

      for (let i = 0; i < list.length; i++) {
        const f = list[i]
        patch(i, { status: "uploading" })
        try {
          const up = await tempboxApi.uploadUrl(code, f.name, f.size)
          await putWithProgress(up.uploadUrl, f, (sent) => patch(i, { sent }))
          await tempboxApi.commit(code, up.key)
          patch(i, { status: "done", sent: f.size })
        } catch (err) {
          failed++
          patch(i, {
            status: "failed",
            error: err instanceof HttpError ? err.message : err instanceof Error ? err.message : "失败",
          })
        }
      }

      const ok = list.length - failed
      if (ok > 0) toast.success(`已上传 ${ok} 个文件`)
      if (failed > 0) toast.error(`${failed} 个文件上传失败，可在传输列表中查看原因`)

      // 上传后刷新左侧列表，方便上传者核对传输内容
      setBatch(await tempboxApi.get(code))
    } catch (err) {
      toast.error(
        err instanceof HttpError
          ? err.message
          : err instanceof Error
            ? `上传失败：${err.message}`
            : "上传失败"
      )
    } finally {
      setUploading(false)
    }
  }

  const resetUpload = () => {
    setCreatedCode(null)
    setBatch(null)
    setTextDraft("")
    setTransfers([])
  }

  /** 纯文本互传：直接生成接收码（文字存 D1，不走 R2） */
  const shareText = async () => {
    if (!textDraft.trim()) {
      toast.error("先输入要分享的文字")
      return
    }
    setTextBusy(true)
    try {
      const created = await tempboxApi.create(textDraft)
      setCreatedCode(created.code)
      const b = await tempboxApi.get(created.code)
      setBatch(b)
      // 文字分享后同样自动填入左侧接收码并展示
      setCodeInput(created.code)
      toast.success("文字已生成接收码")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "分享失败")
    } finally {
      setTextBusy(false)
    }
  }

  const copyCode = async () => {
    if (!createdCode) return
    try {
      await navigator.clipboard.writeText(createdCode)
      toast.success("接收码已复制")
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }

  const fileDownloadUrl = (code: string, name: string) =>
    `/api/tempbox/${encodeURIComponent(code)}/${encodeURIComponent(name)}`

  if (loading) {
    return (
      <div>
        <PageHeader title="临时分享箱" description="即传即取，过期自动消失" />
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (!config?.enabled) {
    return (
      <div>
        <PageHeader title="临时分享箱" description="即传即取，过期自动消失" />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            临时分享箱功能已关闭。
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="临时分享箱"
        description="上传文件生成 4 位接收码，对方输入接收码即可查看/下载；到点自动清除。"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 解锁查看 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-muted-foreground" />
              输入接收码解锁
            </CardTitle>
            <CardDescription>访客无需登录即可查看与下载。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="4 位数字接收码"
                maxLength={4}
                inputMode="numeric"
                pattern="[0-9]*"
                className="w-40 font-mono text-lg tracking-widest"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleUnlock()
                }}
              />
              <Button onClick={() => void handleUnlock()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                解锁
              </Button>
            </div>

            {uploading && !batch && (
              <div className="space-y-3 rounded-md border p-4">
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在上传，接收码 <span className="font-mono font-semibold">{createdCode}</span>
                </p>
                <TransferList items={transfers} />
              </div>
            )}

            {batch && (
              <div className="space-y-3 rounded-md border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="font-mono text-lg">
                    {batch.code}
                  </Badge>
                  <Badge variant="outline">
                    剩余 {batch.remainingMinutes} 分钟
                  </Badge>
                  {batch.isText ? (
                    <Badge variant="success">纯文本</Badge>
                  ) : (
                    <Badge variant="outline">
                      {batch.fileCount} 个文件 · {fmtBytes(batch.totalBytes)}
                    </Badge>
                  )}
                </div>
                <Separator />
                {batch.isText ? (
                  <div className="space-y-2">
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                      {batch.textContent}
                    </pre>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigator.clipboard
                          .writeText(batch.textContent ?? "")
                          .then(() => toast.success("文字已复制"))
                          .catch(() => toast.error("复制失败"))
                      }
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制文字
                    </Button>
                  </div>
                ) : batch.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">该接收码还没有文件。</p>
                ) : (
                  <div className="space-y-2">
                    {batch.files.map((f) => (
                      <div
                        key={f.name}
                        className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {f.name.match(/\.(png|jpe?g|gif|webp|svg)$/i) ? (
                            <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate text-sm">{f.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {fmtBytes(f.size)}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {isPreviewable(f.name) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPreviewText(f.name)}
                              title="预览"
                            >
                              <Box className="h-4 w-4" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" asChild title="下载">
                            <a
                              href={fileDownloadUrl(batch.code, f.name)}
                              download
                            >
                              <Download className="h-4 w-4" />
                            </a>
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 上传 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4 text-muted-foreground" />
              分享临时内容
            </CardTitle>
            <CardDescription>
              {config.uploadRequiresLogin
                ? "需登录后上传；文字 / 图片 / 文件均可。"
                : "无需登录即可分享，访客可用接收码查看。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-center text-xs text-muted-foreground">
              <div className="rounded-md border p-3">
                <p className="text-base font-semibold text-foreground">
                  {config.defaultMinutes} 分钟
                </p>
                默认保存
              </div>
              <div className="rounded-md border p-3">
                <p className="text-base font-semibold text-foreground">
                  {Math.round(config.maxFileBytes / 1024 / 1024)} MB
                </p>
                文件上限
              </div>
              <div className="rounded-md border p-3">
                <p className="text-base font-semibold text-foreground">
                  {config.maxFiles}
                </p>
                最多文件数
              </div>
            </div>

            {!user && config.uploadRequiresLogin ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                分享需要登录。访客只能查看与下载。
              </div>
            ) : createdCode ? (
              <div className="space-y-3">
                <div className="rounded-md border p-4 text-center">
                  <p className="text-sm text-muted-foreground">你的接收码</p>
                  <p className="mt-1 font-mono text-5xl font-bold tracking-widest">
                    {createdCode}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    告诉对方这个 4 位码，或直接分享本页面。
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void copyCode()}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制接收码
                  </Button>
                </div>
                {batch?.isText ? (
                  <p className="text-xs text-muted-foreground">
                    文字已分享。每个接收码只承载一种内容，想再发一条请重新开始。
                  </p>
                ) : (
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground hover:bg-accent/40">
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    再传一个文件到该接收码
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? [])
                        if (files.length > 0) void uploadFiles(files)
                        e.target.value = ""
                      }}
                    />
                  </label>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={resetUpload}
                >
                  重新开始（丢弃当前接收码）
                </Button>
              </div>
            ) : (
              <Tabs defaultValue="text">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="text">
                    <MessageSquareText className="mr-1.5 h-3.5 w-3.5" />
                    文字
                  </TabsTrigger>
                  <TabsTrigger value="file">
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    文件 / 图片
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="text" className="space-y-2">
                  <Label htmlFor="tempboxText">粘贴文字（存数据库，不占存储空间）</Label>
                  <Textarea
                    id="tempboxText"
                    rows={6}
                    placeholder="直接把文字粘贴到这里，生成接收码给对方……"
                    value={textDraft}
                    onChange={(e) => setTextDraft(e.target.value)}
                  />
                  <Button onClick={() => void shareText()} disabled={textBusy || !textDraft.trim()}>
                    {textBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    生成接收码
                  </Button>
                </TabsContent>
                <TabsContent value="file">
                  <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed p-8 text-sm text-muted-foreground hover:bg-accent/40">
                    {uploading ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Upload className="h-5 w-5" />
                    )}
                    <span>
                      {uploading ? "上传中…" : "点击选择文件 / 图片，可多选"}
                    </span>
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? [])
                        if (files.length > 0) void uploadFiles(files)
                        e.target.value = ""
                      }}
                    />
                  </label>
                </TabsContent>
              </Tabs>
            )}

            {transfers.length > 0 && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  传输列表{uploading ? "（上传中）" : ""}
                </p>
                <TransferList items={transfers} />
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              文字直接存于数据库；文件存于 R2 的 temporary 目录。到期后自动清除。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 文本预览 */}
      <Dialog
        open={previewText !== null}
        onOpenChange={(o) => {
          if (!o) setPreviewText(null)
        }}
      >
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          {previewText && batch && (
            <>
              <DialogHeader>
                <DialogTitle>{previewText}</DialogTitle>
                <DialogDescription>
                  文字内容预览（较大文本可能只显示开头）。
                </DialogDescription>
              </DialogHeader>
              <TextPreview url={fileDownloadUrl(batch.code, previewText)} />
              <DialogFooter>
                <Button variant="outline" asChild>
                  <a href={fileDownloadUrl(batch.code, previewText)} download>
                    <Download className="h-4 w-4" />
                    下载原文件
                  </a>
                </Button>
                <Button onClick={() => setPreviewText(null)}>关闭</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 拉取文本内容并展示（限制前 20KB） */
function TextPreview({ url }: { url: string }) {
  const [text, setText] = React.useState<string>("")
  React.useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t.slice(0, 20000))
      })
      .catch(() => {
        if (!cancelled) setText("（预览失败）")
      })
    return () => {
      cancelled = true
    }
  }, [url])
  return (
    <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {text || "加载中…"}
    </pre>
  )
}