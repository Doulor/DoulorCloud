import * as React from "react"
import { Link, useParams } from "react-router-dom"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { getTool } from "@/lib/toolbox/registry"
import { useT } from "@/i18n"

/**
 * 工具详情页。每个工具是一个独立的分包，只有点到它才会下载 ——
 * 工具箱首页不会因为工具变多而变重。
 */
const LOADERS: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  "fun-links": React.lazy(() => import("@/tools/fun-links")),
  "unit-convert": React.lazy(() => import("@/tools/unit-convert")),
  countdown: React.lazy(() => import("@/tools/countdown")),
  "random-picker": React.lazy(() => import("@/tools/random-picker")),
  "qr-barcode": React.lazy(() => import("@/tools/qr-barcode")),
  "image-convert": React.lazy(() => import("@/tools/image-convert")),
  "image-compress": React.lazy(() => import("@/tools/image-compress")),
  "image-crop": React.lazy(() => import("@/tools/image-crop")),
  "image-watermark": React.lazy(() => import("@/tools/image-watermark")),
  "image-grid": React.lazy(() => import("@/tools/image-grid")),
  "image-stitch": React.lazy(() => import("@/tools/image-stitch")),
  "image-pdf": React.lazy(() => import("@/tools/image-pdf")),
  "image-mosaic": React.lazy(() => import("@/tools/image-mosaic")),
  "id-photo": React.lazy(() => import("@/tools/id-photo")),
  "color-picker": React.lazy(() => import("@/tools/color-picker")),
  "video-gif": React.lazy(() => import("@/tools/video-gif")),
  "video-convert": React.lazy(() => import("@/tools/video-convert")),
  "video-frame": React.lazy(() => import("@/tools/video-frame")),
  "audio-extract": React.lazy(() => import("@/tools/audio-extract")),
  "audio-trim": React.lazy(() => import("@/tools/audio-trim")),
  "audio-tags": React.lazy(() => import("@/tools/audio-tags")),
  "markdown-preview": React.lazy(() => import("@/tools/markdown-preview")),
  "text-diff": React.lazy(() => import("@/tools/text-diff")),
  "data-format": React.lazy(() => import("@/tools/data-format")),
  "encode-decode": React.lazy(() => import("@/tools/encode-decode")),
  "csv-json": React.lazy(() => import("@/tools/csv-json")),
  timestamp: React.lazy(() => import("@/tools/timestamp")),
  "unicode-convert": React.lazy(() => import("@/tools/unicode-convert")),
}

export default function ToolboxDetailPage() {
  const { t } = useT()
  const { toolId } = useParams<{ toolId: string }>()
  const meta = toolId ? getTool(toolId) : undefined
  const Component = toolId ? LOADERS[toolId] : undefined

  if (!meta || !Component || meta.href) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{t("toolbox.notFound")}</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard/toolbox">{t("toolbox.backToToolbox")}</Link>
        </Button>
      </div>
    )
  }

  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <Component />
    </React.Suspense>
  )
}
