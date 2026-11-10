import * as React from "react"
import { ImagePlus, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useT } from "@/i18n"
import { compressToLimit } from "@/lib/image-compress"

/**
 * 管理后台 → 设置 → 「捐献页赞赏码」（2026-11-02）
 *
 * - 上传：直接 PUT 二进制到 /api/admin/tip-qr（content-type 用图片真实类型）
 * - 预览：/api/tip-qr?v=时间戳，绕开 5 分钟缓存
 * - 移除：DELETE /api/admin/tip-qr
 *
 * 图片存在 R2，D1 只记对象 key；捐献页看到 404 就会整块隐藏。
 */
const MAX_BYTES = 600 * 1024
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml"

export function AdminTipQrCard() {
  const { t } = useT()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [version, setVersion] = React.useState<number>(() => Date.now())
  const [hasImage, setHasImage] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  const previewSrc = `/api/tip-qr?v=${version}`

  async function onPick(file: File) {
    if (file.size > MAX_BYTES) {
      toast.error(t("adm.tip.tooLarge"))
      return
    }
    setBusy(true)
    try {
      // 手机截图常在 2~8MB，且可能是 HEIC；先在浏览器里压到 1.5MB 以内，
      // 统一转成浏览器能解码的位图，避免服务端因为格式/体积直接 400。
      let upload: File | Blob = file
      if (file.type && !file.type.startsWith("image/")) {
        toast.error(t("adm.tip.badType"))
        return
      }
      if (file.size > 450_000) {
        const compressed = await compressToLimit(file, 450_000)
        if (compressed) upload = compressed
      }
      const res = await fetch("/api/admin/tip-qr", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": upload.type || "image/png" },
        body: upload,
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error || t("adm.tip.failed"))
      }
      setVersion(Date.now())
      setHasImage(true)
      toast.success(t("adm.tip.done"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("adm.tip.failed"))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  async function remove() {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/tip-qr", {
        method: "DELETE",
        credentials: "include",
      })
      if (!res.ok) throw new Error(t("adm.tip.failed"))
      setHasImage(false)
      toast.success(t("adm.tip.removed"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("adm.tip.failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("adm.tip.title")}</CardTitle>
        <CardDescription>{t("adm.tip.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-40 w-40 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
            {hasImage ? (
              <img
                src={previewSrc}
                alt={t("adm.tip.previewAlt")}
                className="h-full w-full object-contain p-1"
                onError={() => setHasImage(false)}
              />
            ) : (
              <span className="px-3 text-center text-xs text-muted-foreground">
                {t("adm.tip.empty")}
              </span>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="h-3.5 w-3.5" />
                )}
                {hasImage ? t("adm.tip.replace") : t("adm.tip.upload")}
              </Button>
              {hasImage && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void remove()}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("adm.tip.remove")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("adm.tip.hint")}</p>
            <p className="text-xs text-muted-foreground">{t("adm.tip.where")}</p>
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onPick(file)
          }}
        />
      </CardContent>
    </Card>
  )
}
