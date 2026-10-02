import type { LucideIcon } from "lucide-react"
import {
  Binary,
  Braces,
  CalendarClock,
  Camera,
  Clock,
  Combine,
  Contact,
  Crop,
  Dices,
  Droplets,
  FileImage,
  FileText,
  Film,
  GitCompare,
  Languages,
  LayoutGrid,
  Minimize2,
  Music,
  Package,
  Pipette,
  QrCode,
  RefreshCw,
  Ruler,
  ScanEye,
  Scissors,
  Sparkles,
  Table2,
  Video,
} from "lucide-react"

/**
 * 工具箱注册表。
 *
 * 新增一个工具只需要两步：
 *   1. 在 `src/tools/` 下新建一个组件文件（默认导出）；
 *   2. 在这里加一条记录，并在 `src/pages/toolbox-detail.tsx` 的 LOADERS 里
 *      补一行 `id: lazy(() => import("@/tools/xxx"))`。
 * 网格页、选项卡、搜索全部自动跟着走，不需要改 UI。
 *
 * 工具全部是纯前端实现（Canvas / WebCodecs / Web Audio），
 * 打开工具箱不会产生任何服务端请求。
 */

export type ToolCategory = "daily" | "image" | "media" | "doc" | "share"

export interface ToolMeta {
  id: string
  name: string
  /** 一句话说明，网格卡片和详情页都用它 */
  desc: string
  icon: LucideIcon
  category: ToolCategory
  /** 卡片图标底色（Tailwind 类名必须字面写出，否则不会被编译进去） */
  tone: string
  /** 外链型工具：不走详情页，直接跳这个路由（如临时分享箱） */
  href?: string
}

/** 卡片配色。键名只是内部标识，值必须是可以被 Tailwind 扫到的字面量类名。 */
const TONES = {
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  rose: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  cyan: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  orange: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  slate: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
} as const

export const TOOLS: ToolMeta[] = [
  // ── 分享 ──────────────────────────────────────────────────────────────
  {
    id: "tempbox",
    name: "toolbox.tempbox.name",
    desc: "toolbox.tempbox.desc",
    icon: Package,
    category: "share",
    tone: TONES.blue,
    href: "/dashboard/tempbox",
  },
  {
    id: "fun-links",
    name: "toolbox.funLinks.name",
    desc: "toolbox.funLinks.desc",
    icon: Sparkles,
    category: "share",
    tone: TONES.rose,
  },

  // ── 日常 ──────────────────────────────────────────────────────────────
  {
    id: "unit-convert",
    name: "toolbox.unitConvert.name",
    desc: "toolbox.unitConvert.desc",
    icon: Ruler,
    category: "daily",
    tone: TONES.green,
  },
  {
    id: "countdown",
    name: "toolbox.countdown.name",
    desc: "toolbox.countdown.desc",
    icon: CalendarClock,
    category: "daily",
    tone: TONES.amber,
  },
  {
    id: "random-picker",
    name: "toolbox.randomPicker.name",
    desc: "toolbox.randomPicker.desc",
    icon: Dices,
    category: "daily",
    tone: TONES.violet,
  },
  {
    id: "qr-barcode",
    name: "toolbox.qrBarcode.name",
    desc: "toolbox.qrBarcode.desc",
    icon: QrCode,
    category: "daily",
    tone: TONES.slate,
  },

  // ── 图片 ──────────────────────────────────────────────────────────────
  {
    id: "image-convert",
    name: "toolbox.imageConvert.name",
    desc: "toolbox.imageConvert.desc",
    icon: RefreshCw,
    category: "image",
    tone: TONES.blue,
  },
  {
    id: "image-compress",
    name: "toolbox.imageCompress.name",
    desc: "toolbox.imageCompress.desc",
    icon: Minimize2,
    category: "image",
    tone: TONES.green,
  },
  {
    id: "image-crop",
    name: "toolbox.imageCrop.name",
    desc: "toolbox.imageCrop.desc",
    icon: Crop,
    category: "image",
    tone: TONES.cyan,
  },
  {
    id: "image-watermark",
    name: "toolbox.imageWatermark.name",
    desc: "toolbox.imageWatermark.desc",
    icon: Droplets,
    category: "image",
    tone: TONES.amber,
  },
  {
    id: "image-grid",
    name: "toolbox.imageGrid.name",
    desc: "toolbox.imageGrid.desc",
    icon: LayoutGrid,
    category: "image",
    tone: TONES.violet,
  },
  {
    id: "image-stitch",
    name: "toolbox.imageStitch.name",
    desc: "toolbox.imageStitch.desc",
    icon: Combine,
    category: "image",
    tone: TONES.orange,
  },
  {
    id: "image-pdf",
    name: "toolbox.imagePdf.name",
    desc: "toolbox.imagePdf.desc",
    icon: FileImage,
    category: "image",
    tone: TONES.rose,
  },
  {
    id: "image-mosaic",
    name: "toolbox.imageMosaic.name",
    desc: "toolbox.imageMosaic.desc",
    icon: ScanEye,
    category: "image",
    tone: TONES.slate,
  },
  {
    id: "id-photo",
    name: "toolbox.idPhoto.name",
    desc: "toolbox.idPhoto.desc",
    icon: Contact,
    category: "image",
    tone: TONES.blue,
  },
  {
    id: "color-picker",
    name: "toolbox.colorPicker.name",
    desc: "toolbox.colorPicker.desc",
    icon: Pipette,
    category: "image",
    tone: TONES.cyan,
  },

  // ── 音视频 ────────────────────────────────────────────────────────────
  {
    id: "video-gif",
    name: "toolbox.videoGif.name",
    desc: "toolbox.videoGif.desc",
    icon: Film,
    category: "media",
    tone: TONES.violet,
  },
  {
    id: "video-convert",
    name: "toolbox.videoConvert.name",
    desc: "toolbox.videoConvert.desc",
    icon: Video,
    category: "media",
    tone: TONES.orange,
  },
  {
    id: "video-frame",
    name: "toolbox.videoFrame.name",
    desc: "toolbox.videoFrame.desc",
    icon: Camera,
    category: "media",
    tone: TONES.cyan,
  },
  {
    id: "audio-extract",
    name: "toolbox.audioExtract.name",
    desc: "toolbox.audioExtract.desc",
    icon: Music,
    category: "media",
    tone: TONES.green,
  },
  {
    id: "audio-trim",
    name: "toolbox.audioTrim.name",
    desc: "toolbox.audioTrim.desc",
    icon: Scissors,
    category: "media",
    tone: TONES.rose,
  },

  // ── 文档与文本 ────────────────────────────────────────────────────────
  {
    id: "markdown-preview",
    name: "toolbox.markdown.name",
    desc: "toolbox.markdown.desc",
    icon: FileText,
    category: "doc",
    tone: TONES.slate,
  },
  {
    id: "text-diff",
    name: "toolbox.textDiff.name",
    desc: "toolbox.textDiff.desc",
    icon: GitCompare,
    category: "doc",
    tone: TONES.amber,
  },
  {
    id: "data-format",
    name: "toolbox.dataFormat.name",
    desc: "toolbox.dataFormat.desc",
    icon: Braces,
    category: "doc",
    tone: TONES.blue,
  },
  {
    id: "encode-decode",
    name: "toolbox.encodeDecode.name",
    desc: "toolbox.encodeDecode.desc",
    icon: Binary,
    category: "doc",
    tone: TONES.violet,
  },
  {
    id: "csv-json",
    name: "toolbox.csvJson.name",
    desc: "toolbox.csvJson.desc",
    icon: Table2,
    category: "doc",
    tone: TONES.green,
  },
  {
    id: "timestamp",
    name: "toolbox.timestamp.name",
    desc: "toolbox.timestamp.desc",
    icon: Clock,
    category: "doc",
    tone: TONES.cyan,
  },
  {
    id: "unicode-convert",
    name: "toolbox.unicode.name",
    desc: "toolbox.unicode.desc",
    icon: Languages,
    category: "doc",
    tone: TONES.rose,
  },
]

export const CATEGORIES: { id: ToolCategory | "all"; label: string }[] = [
  { id: "all", label: "toolbox.cat.all" },
  { id: "daily", label: "toolbox.cat.daily" },
  { id: "image", label: "toolbox.cat.image" },
  { id: "media", label: "toolbox.cat.media" },
  { id: "doc", label: "toolbox.cat.doc" },
  { id: "share", label: "toolbox.cat.share" },
]

export function getTool(id: string): ToolMeta | undefined {
  return TOOLS.find((t) => t.id === id)
}

export function toolsOf(category: ToolCategory | "all"): ToolMeta[] {
  return category === "all" ? TOOLS : TOOLS.filter((t) => t.category === category)
}

/**
 * 取工具名称 / 说明 / 分类名。
 *
 * 注册表存的是 **i18n key**（见 ToolMeta.name 的注释）：注册表是模块级常量，
 * 直接放译好的字符串会在模块加载时把语言冻结成初始值，切语言后不跟着变。
 */
export function toolName(t: (k: string) => string, tool: ToolMeta): string {
  return t(tool.name)
}

export function toolDesc(t: (k: string) => string, tool: ToolMeta): string {
  return t(tool.desc)
}

export function categoryLabel(t: (k: string) => string, id: ToolCategory | "all"): string {
  return t(`toolbox.cat.${id}`)
}
