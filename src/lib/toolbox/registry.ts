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
    name: "临时分享箱",
    desc: "上传文件生成取件码，对方凭码下载",
    icon: Package,
    category: "share",
    tone: TONES.blue,
    href: "/dashboard/tempbox",
  },
  {
    id: "fun-links",
    name: "有趣的网页分享",
    desc: "站长精选的一批有意思的网站，点开即走",
    icon: Sparkles,
    category: "share",
    tone: TONES.rose,
  },

  // ── 日常 ──────────────────────────────────────────────────────────────
  {
    id: "unit-convert",
    name: "单位换算",
    desc: "长度、重量、面积、体积、温度、速度、数据大小互转",
    icon: Ruler,
    category: "daily",
    tone: TONES.green,
  },
  {
    id: "countdown",
    name: "倒计时与纪念日",
    desc: "算还有多少天，或已经过去了多少天；数据存在本机",
    icon: CalendarClock,
    category: "daily",
    tone: TONES.amber,
  },
  {
    id: "random-picker",
    name: "随机抽签",
    desc: "抽签转盘、掷骰子、抛硬币、名单随机分组",
    icon: Dices,
    category: "daily",
    tone: TONES.violet,
  },
  {
    id: "qr-barcode",
    name: "二维码与条形码",
    desc: "把网址、文字、WiFi 密码生成二维码或条形码图片",
    icon: QrCode,
    category: "daily",
    tone: TONES.slate,
  },

  // ── 图片 ──────────────────────────────────────────────────────────────
  {
    id: "image-convert",
    name: "图片格式互转",
    desc: "PNG / JPG / WebP / ICO 互相转换，ICO 可打包多尺寸",
    icon: RefreshCw,
    category: "image",
    tone: TONES.blue,
  },
  {
    id: "image-compress",
    name: "图片压缩",
    desc: "按长边和质量压缩，体积能小一大截",
    icon: Minimize2,
    category: "image",
    tone: TONES.green,
  },
  {
    id: "image-crop",
    name: "裁剪旋转翻转",
    desc: "自由裁剪、任意角度旋转、水平垂直翻转",
    icon: Crop,
    category: "image",
    tone: TONES.cyan,
  },
  {
    id: "image-watermark",
    name: "加水印",
    desc: "文字或图片水印，可调位置、大小、透明度、平铺",
    icon: Droplets,
    category: "image",
    tone: TONES.amber,
  },
  {
    id: "image-grid",
    name: "九宫格切图",
    desc: "把一张图切成九宫格，发朋友圈不用愁",
    icon: LayoutGrid,
    category: "image",
    tone: TONES.violet,
  },
  {
    id: "image-stitch",
    name: "长图拼接",
    desc: "多张截图纵向或横向拼成一张长图",
    icon: Combine,
    category: "image",
    tone: TONES.orange,
  },
  {
    id: "image-pdf",
    name: "图片 ⇄ PDF",
    desc: "多张图片合成一个 PDF，或把 PDF 每页导出成图片",
    icon: FileImage,
    category: "image",
    tone: TONES.rose,
  },
  {
    id: "image-mosaic",
    name: "打码与马赛克",
    desc: "框选区域打马赛克或模糊，证件、聊天记录都能用",
    icon: ScanEye,
    category: "image",
    tone: TONES.slate,
  },
  {
    id: "id-photo",
    name: "证件照处理",
    desc: "裁成常见证件尺寸，一键把纯色背景换成白/蓝/红",
    icon: Contact,
    category: "image",
    tone: TONES.blue,
  },
  {
    id: "color-picker",
    name: "取色与配色",
    desc: "从图片里吸取颜色，生成色板并复制色值",
    icon: Pipette,
    category: "image",
    tone: TONES.cyan,
  },

  // ── 音视频 ────────────────────────────────────────────────────────────
  {
    id: "video-gif",
    name: "视频转 GIF",
    desc: "选一段时长导出成 GIF，可调帧率、宽度、速度",
    icon: Film,
    category: "media",
    tone: TONES.violet,
  },
  {
    id: "video-convert",
    name: "视频压缩与转格式",
    desc: "降低分辨率/码率把视频压小，输出 WebM",
    icon: Video,
    category: "media",
    tone: TONES.orange,
  },
  {
    id: "video-frame",
    name: "视频截帧",
    desc: "把视频某一秒画面存成图片，可批量截多张",
    icon: Camera,
    category: "media",
    tone: TONES.cyan,
  },
  {
    id: "audio-extract",
    name: "提取音频",
    desc: "从视频里取出声音，导出成 WAV",
    icon: Music,
    category: "media",
    tone: TONES.green,
  },
  {
    id: "audio-trim",
    name: "音频剪辑",
    desc: "可视化截取一段音频，试听满意再导出",
    icon: Scissors,
    category: "media",
    tone: TONES.rose,
  },

  // ── 文档与文本 ────────────────────────────────────────────────────────
  {
    id: "markdown-preview",
    name: "Markdown 预览",
    desc: "左边写右边看，支持表格、代码块，可导出 HTML",
    icon: FileText,
    category: "doc",
    tone: TONES.slate,
  },
  {
    id: "text-diff",
    name: "文本对比",
    desc: "逐行找出两段文字的差异，改稿校对很省事",
    icon: GitCompare,
    category: "doc",
    tone: TONES.amber,
  },
  {
    id: "data-format",
    name: "JSON / XML / YAML",
    desc: "格式化、压缩、互转三种结构化数据",
    icon: Braces,
    category: "doc",
    tone: TONES.blue,
  },
  {
    id: "encode-decode",
    name: "Base64 / URL 编解码",
    desc: "文本与 Base64、URL 编码互转，含图片转 Base64",
    icon: Binary,
    category: "doc",
    tone: TONES.violet,
  },
  {
    id: "csv-json",
    name: "表格转 JSON",
    desc: "CSV / Excel 转成 JSON，或 JSON 转回 CSV",
    icon: Table2,
    category: "doc",
    tone: TONES.green,
  },
  {
    id: "timestamp",
    name: "时间戳转换",
    desc: "Unix 时间戳与日期时间互转，支持秒和毫秒",
    icon: Clock,
    category: "doc",
    tone: TONES.cyan,
  },
  {
    id: "unicode-convert",
    name: "Unicode 转换",
    desc: "文本与 \\uXXXX 转义互转，查看每个字符的码点与 UTF-8 字节",
    icon: Languages,
    category: "doc",
    tone: TONES.rose,
  },
]

export const CATEGORIES: { id: ToolCategory | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "daily", label: "日常" },
  { id: "image", label: "图片" },
  { id: "media", label: "音视频" },
  { id: "doc", label: "文档文本" },
  { id: "share", label: "分享" },
]

export function getTool(id: string): ToolMeta | undefined {
  return TOOLS.find((t) => t.id === id)
}

export function toolsOf(category: ToolCategory | "all"): ToolMeta[] {
  return category === "all" ? TOOLS : TOOLS.filter((t) => t.category === category)
}
