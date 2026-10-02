import * as React from "react"
import { useSearchParams } from "react-router-dom"
import {
  Box,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Link2,
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
import { useT, tStatic } from "@/i18n"
import { formatBytes } from "@/lib/format"
import { useAuth } from "@/hooks/use-auth"
import type { TempboxBatch, TempboxConfig } from "@/types"

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
      else reject(new Error(tStatic("tb.err.r2Http", { status: xhr.status })))
    }
    xhr.onerror = () => reject(new Error(tStatic("tb.err.network")))
    xhr.ontimeout = () => reject(new Error(tStatic("tb.err.timeout")))
    xhr.timeout = 30 * 60 * 1000
    xhr.send(file)
  })
}

/** 传输列表：逐项显示进度与状态，上传者可据此观察是否传完 */
function TransferList({ items }: { items: TransferItem[] }) {
  const { t } = useT()
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
                  <span className="text-destructive">{it.error ?? t("tb.transfer.failed")}</span>
                ) : it.status === "done" ? (
                  <span className="text-emerald-600">{t("tb.transfer.done")}</span>
                ) : it.status === "uploading" ? (
                  `${pct}% · ${formatBytes(it.sent)} / ${formatBytes(it.size)}`
                ) : (
                  t("tb.transfer.pending")
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
  const { t } = useT()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
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
      toast.error(err instanceof HttpError ? err.message : t("tb.err.loadConfig"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /**
   * 解锁接收码。`raw` 用于「从分享链接进入」时直接把码传进来，
   * 省略则用输入框里的值（手动输入 / 点按钮都走这条）。
   */
  const unlock = React.useCallback(
    async (raw?: string) => {
      const code = (raw ?? codeInput).trim().toUpperCase()
      // 现用 6 位数字；历史上出现过 4 位数字与 8 位字母数字，服务端按字符串匹配，
      // 所以这里放宽到 4–12 位字母数字，让所有旧码都还能解锁。
      if (!/^[A-Z0-9]{4,12}$/.test(code)) {
        toast.error(t("tb.err.enterCode"))
        return
      }
      setBusy(true)
      try {
        setBatch(await tempboxApi.get(code))
        setPreviewText(null)
      } catch (err) {
        setBatch(null)
        toast.error(err instanceof HttpError ? err.message : t("tb.err.unlock"))
      } finally {
        setBusy(false)
      }
    },
    [codeInput]
  )

  const handleUnlock = () => void unlock()

  /**
   * 分享链接进入：`/t?code=123456` 自动填入并解锁。
   * 用 ref 防止 React StrictMode 下 effect 跑两次、白白多打一次接口
   * （那会白白消耗限流额度）。
   */
  const autoUnlocked = React.useRef(false)
  React.useEffect(() => {
    if (autoUnlocked.current) return
    const fromUrl = searchParams.get("code")?.trim().toUpperCase() ?? ""
    if (!fromUrl) return
    autoUnlocked.current = true
    setCodeInput(fromUrl)
    void unlock(fromUrl)
  }, [searchParams, unlock])

  /** 批量上传文件（一次选择多个；共用一个接收码，逐个回报进度） */
  const uploadFiles = async (files: File[]) => {
    if (!config || files.length === 0) return
    const list = files.filter((f) => {
      if (f.size > config.maxFileBytes) {
        toast.error(
          t("tb.err.tooLarge", {
            name: f.name,
            mb: Math.round(config.maxFileBytes / 1024 / 1024),
          })
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
            error:
              err instanceof HttpError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : t("tb.transfer.failed"),
          })
        }
      }

      const ok = list.length - failed
      if (ok > 0) toast.success(t("tb.ok.uploaded", { n: ok }))
      if (failed > 0) toast.error(t("tb.err.uploadFailedN", { n: failed }))

      // 上传后刷新左侧列表，方便上传者核对传输内容
      setBatch(await tempboxApi.get(code))
    } catch (err) {
      toast.error(
        err instanceof HttpError
          ? err.message
          : err instanceof Error
            ? t("tb.err.uploadFailedMsg", { msg: err.message })
            : t("tb.err.uploadFailed")
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
      toast.error(t("tb.err.emptyText"))
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
      toast.success(t("tb.ok.textShared"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("tb.err.share"))
    } finally {
      setTextBusy(false)
    }
  }

  const copyCode = async () => {
    if (!createdCode) return
    try {
      await navigator.clipboard.writeText(createdCode)
      toast.success(t("tb.ok.codeCopied"))
    } catch {
      toast.error(t("tb.err.copy"))
    }
  }

  /**
   * 分享链接：接收码进 URL，对方点开自动填入并解锁，完全不用手输。
   *
   * ⚠️ 路径必须是 `/t`（无需登录的公开页），**不是** `/tempbox`
   * —— 后者只存在于 `/dashboard/tempbox`（需登录），访客打开会撞到 404。
   * 用 `window.location.origin` 而不是写死域名，本地/其他域名部署也能用。
   */
  const shareUrl = createdCode
    ? `${window.location.origin}/t?code=${encodeURIComponent(createdCode)}`
    : ""

  const copyShareLink = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast.success(t("tb.ok.linkCopied"))
    } catch {
      toast.error(t("tb.err.copy"))
    }
  }

  const fileDownloadUrl = (code: string, name: string) =>
    `/api/tempbox/${encodeURIComponent(code)}/${encodeURIComponent(name)}`

  if (loading) {
    return (
      <div>
        <PageHeader title={t("tb.title")} description={t("tb.tagline")} />
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (!config?.enabled) {
    return (
      <div>
        <PageHeader title={t("tb.title")} description={t("tb.tagline")} />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t("tb.closed")}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={t("tb.title")}
        description={t("tb.desc")}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 解锁查看 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-muted-foreground" />
              {t("tb.unlockTitle")}
            </CardTitle>
            <CardDescription>{t("tb.unlockDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder={t("tb.codePlaceholder")}
                maxLength={12}
                className="w-48 font-mono text-lg tracking-widest uppercase"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleUnlock()
                }}
              />
              <Button onClick={() => void handleUnlock()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("tb.unlock")}
              </Button>
            </div>

            {uploading && !batch && (
              <div className="space-y-3 rounded-md border p-4">
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("tb.uploadingCode")} <span className="font-mono font-semibold">{createdCode}</span>
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
                    {t("tb.remaining", { n: batch.remainingMinutes })}
                  </Badge>
                  {batch.isText ? (
                    <Badge variant="success">{t("tb.textBadge")}</Badge>
                  ) : (
                    <Badge variant="outline">
                      {t("tb.fileSummary", { n: batch.fileCount, size: formatBytes(batch.totalBytes) })}
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
                          .then(() => toast.success(t("tb.ok.textCopied")))
                          .catch(() => toast.error(t("tb.err.copy")))
                      }
                    >
                      <Copy className="h-3.5 w-3.5" />
                      {t("tb.copyText")}
                    </Button>
                  </div>
                ) : batch.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("tb.noFiles")}</p>
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
                            {formatBytes(f.size)}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {isPreviewable(f.name) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPreviewText(f.name)}
                              title={t("tb.preview")}
                            >
                              <Box className="h-4 w-4" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" asChild title={t("tb.download")}>
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
              {t("tb.shareTitle")}
            </CardTitle>
            <CardDescription>
              {config.uploadRequiresLogin
                ? t("tb.shareHint.authed")
                : t("tb.shareHint.guest")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-center text-xs text-muted-foreground">
              <div className="rounded-md border p-3">
                <p className="text-base font-semibold text-foreground">
                  {t("tb.minutes", { n: config.defaultMinutes })}
                </p>
                {t("tb.defaultRetention")}
              </div>
              <div className="rounded-md border p-3">
                <p className="text-base font-semibold text-foreground">
                  {Math.round(config.maxFileBytes / 1024 / 1024)} MB
                </p>
                {t("tb.maxFileSize")}
              </div>
              <div className="rounded-md border p-3">
                <p className="text-base font-semibold text-foreground">
                  {config.maxFiles}
                </p>
                {t("tb.maxFiles")}
              </div>
            </div>

            {!user && config.uploadRequiresLogin ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                {t("tb.loginToShare")}
              </div>
            ) : createdCode ? (
              <div className="space-y-3">
                <div className="rounded-md border p-4 text-center">
                  <p className="text-sm text-muted-foreground">{t("tb.yourCode")}</p>
                  <p className="mt-1 font-mono text-5xl font-bold tracking-widest">
                    {createdCode}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("tb.shareLinkHint")}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => void copyShareLink()}>
                      <Link2 className="h-3.5 w-3.5" />
                      {t("tb.copyLink")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void copyCode()}>
                      <Copy className="h-3.5 w-3.5" />
                      {t("tb.copyCodeOnly")}
                    </Button>
                  </div>
                  <p className="mt-2 break-all px-1 font-mono text-[11px] text-muted-foreground/70">
                    {shareUrl}
                  </p>
                </div>
                {batch?.isText ? (
                  <p className="text-xs text-muted-foreground">
                    {t("tb.textSharedNote")}
                  </p>
                ) : (
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground hover:bg-accent/40">
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    {t("tb.uploadAnother")}
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
                  {t("tb.restart")}
                </Button>
              </div>
            ) : (
              <Tabs defaultValue="text">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="text">
                    <MessageSquareText className="mr-1.5 h-3.5 w-3.5" />
                    {t("tb.tab.text")}
                  </TabsTrigger>
                  <TabsTrigger value="file">
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    {t("tb.tab.files")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="text" className="space-y-2">
                  <Label htmlFor="tempboxText">{t("tb.textLabel")}</Label>
                  <Textarea
                    id="tempboxText"
                    rows={6}
                    placeholder={t("tb.textPlaceholder")}
                    value={textDraft}
                    onChange={(e) => setTextDraft(e.target.value)}
                  />
                  <Button onClick={() => void shareText()} disabled={textBusy || !textDraft.trim()}>
                    {textBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("tb.createCode")}
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
                      {uploading ? t("tb.uploading") : t("tb.chooseFiles")}
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
                  {t("tb.transfers")}
                  {uploading ? t("tb.transfersBusy") : ""}
                </p>
                <TransferList items={transfers} />
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t("tb.storageNote")}
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
                  {t("tb.previewNote")}
                </DialogDescription>
              </DialogHeader>
              <TextPreview url={fileDownloadUrl(batch.code, previewText)} />
              <DialogFooter>
                <Button variant="outline" asChild>
                  <a href={fileDownloadUrl(batch.code, previewText)} download>
                    <Download className="h-4 w-4" />
                    {t("tb.downloadOriginal")}
                  </a>
                </Button>
                <Button onClick={() => setPreviewText(null)}>{t("common.close")}</Button>
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
  const { t } = useT()
  const [text, setText] = React.useState<string>("")
  React.useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t.slice(0, 20000))
      })
      .catch(() => {
        if (!cancelled) setText(t("tb.previewFailed"))
      })
    return () => {
      cancelled = true
    }
  }, [url])
  return (
    <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {text || t("common.loading")}
    </pre>
  )
}