import * as React from "react"
import {
  Check,
  ChevronDown,
  ChevronUp,
  Contact,
  Copy,
  ExternalLink,
  Eye,
  Image as ImageIcon,
  Loader2,
  Music,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { profileApi, HttpError } from "@/services/api"
import { compressImage } from "@/lib/image-compress"
import { cn } from "@/lib/utils"
import type {
  ContactType,
  ProfileContact,
  ProfileGalleryItem,
  ProfileModule,
  ProfileModuleId,
  ProfileOverview,
  ProfileTimelineItem,
} from "@/types"

/** 联系方式的展示名、输入提示与「只填原始值」的说明 */
const CONTACT_META: Record<
  ContactType,
  { label: string; placeholder: string; hint?: string }
> = {
  email: { label: "邮箱", placeholder: "you@example.com" },
  qq: { label: "QQ", placeholder: "2737855297", hint: "只填 QQ 号" },
  wechat: {
    label: "微信",
    placeholder: "微信号，或二维码图片链接",
    hint: "微信无跳转链接；填图片链接可展示二维码",
  },
  bilibili: {
    label: "Bilibili",
    placeholder: "1307574205",
    hint: "填数字 UID 即可，带 UID: 前缀或整条空间链接也能识别",
  },
  discord: {
    label: "Discord",
    placeholder: "邀请码，或完整邀请链接",
    hint: "个人主页无固定链接，建议用服务器邀请链接",
  },
  telegram: { label: "Telegram", placeholder: "username", hint: "填用户名即可，@ 可省略" },
  youtube: { label: "YouTube", placeholder: "@channel 或频道链接" },
  github: { label: "GitHub", placeholder: "username" },
  x: { label: "X / Twitter", placeholder: "@username" },
  custom: { label: "自定义链接", placeholder: "https://…" },
}

const THEME_LABEL: Record<string, string> = {
  void: "虚空",
  neon: "霓虹",
  glass: "玻璃",
  aurora: "极光",
  cyber: "赛博",
  blossom: "绽放",
  paper: "纸刊",
  ink: "水墨",
  terminal: "终端",
  solar: "暖阳",
  royal: "紫金",
}

/**
 * 主题缩略图：用内联 style 微缩还原各皮肤的气质（配色/材质/装饰），
 * 并实时反映 accent 色。精确效果以右侧实时预览为准。
 */
const THEME_PREVIEW: Record<
  string,
  {
    accent: string
    container: (a: string) => React.CSSProperties
    avatar: (a: string) => React.CSSProperties
    name: () => React.CSSProperties
    link: (a: string) => React.CSSProperties
  }
> = {
  void: {
    accent: "#6366f1",
    container: () => ({ background: "#050505" }),
    avatar: (a) => ({ boxShadow: `0 0 10px ${a}66`, border: `2px solid ${a}55` }),
    name: () => ({ background: "#ececec" }),
    link: () => ({ background: "transparent", border: "1px solid rgba(255,255,255,.14)" }),
  },
  neon: {
    accent: "#22d3ee",
    container: (a) => ({ background: "#07070f", border: `1px solid ${a}55`, boxShadow: `0 0 12px ${a}30` }),
    avatar: (a) => ({ border: `2px solid ${a}`, boxShadow: `0 0 8px ${a}88` }),
    name: () => ({ background: "linear-gradient(90deg,#22d3ee,#f472b6)" }),
    link: (a) => ({ background: "transparent", border: `1px solid ${a}66` }),
  },
  glass: {
    accent: "#a78bfa",
    container: () => ({ background: "linear-gradient(135deg,#312e81,#0f172a)", border: "1px solid rgba(255,255,255,.22)" }),
    avatar: () => ({ border: "2px solid rgba(255,255,255,.6)" }),
    name: () => ({ background: "rgba(255,255,255,.8)" }),
    link: () => ({ background: "rgba(255,255,255,.2)" }),
  },
  aurora: {
    accent: "#ec4899",
    container: () => ({ background: "linear-gradient(135deg,#6366f1,#ec4899,#f59e0b)", border: "1px solid rgba(255,255,255,.16)" }),
    avatar: () => ({ border: "2px solid rgba(255,255,255,.7)" }),
    name: () => ({ background: "rgba(255,255,255,.88)" }),
    link: () => ({ background: "rgba(255,255,255,.22)" }),
  },
  cyber: {
    accent: "#4ade80",
    container: (a) => ({ background: "#06060d", border: `1px solid ${a}44` }),
    avatar: (a) => ({ borderRadius: 2, border: `2px solid ${a}66` }),
    name: () => ({ background: "#d2f8dc" }),
    link: (a) => ({ background: "rgba(255,255,255,.04)", border: `1px solid ${a}44`, borderRadius: 2 }),
  },
  blossom: {
    accent: "#e868a8",
    container: () => ({ background: "#fdf4f8", border: "1px solid #fbdfec" }),
    avatar: () => ({ border: "2px solid #fff", boxShadow: "0 2px 8px rgba(232,104,168,.3)" }),
    name: () => ({ background: "#6d2145" }),
    link: () => ({ background: "#fff", border: "1px solid #fbd6e8" }),
  },
  paper: {
    accent: "#9d3b2e",
    container: () => ({ background: "#f5f0e5", border: "1px solid #e2d9c8" }),
    avatar: () => ({ borderRadius: 2, border: "1px solid rgba(33,27,18,.3)" }),
    name: () => ({ background: "#211b12", borderRadius: 0 }),
    link: () => ({ background: "transparent", borderBottom: "1px solid rgba(33,27,18,.25)", borderRadius: 0 }),
  },
  ink: {
    accent: "#b3332b",
    container: () => ({ background: "#f3efe6", border: "1px solid #ddd5c4" }),
    avatar: () => ({ borderRadius: 3, border: "1px solid rgba(26,22,16,.4)" }),
    name: () => ({ background: "#1a1610", borderRadius: 0 }),
    link: () => ({ background: "transparent", border: "1px solid rgba(26,22,16,.35)", borderRadius: 2 }),
  },
  terminal: {
    accent: "#33ff66",
    container: (a) => ({ background: "#070c07", border: `1px solid ${a}33` }),
    avatar: (a) => ({ borderRadius: 2, border: `1px solid ${a}88` }),
    name: () => ({ background: "#b7f3c9" }),
    link: (a) => ({ background: "transparent", border: `1px solid ${a}44`, borderRadius: 2 }),
  },
  solar: {
    accent: "#dd6b20",
    container: () => ({ background: "#fff6ea", border: "1px solid rgba(221,107,32,.2)" }),
    avatar: () => ({ borderRadius: "36%", border: "2px solid #fff", boxShadow: "0 2px 8px rgba(221,107,32,.3)" }),
    name: () => ({ background: "#503018" }),
    link: () => ({ background: "#fffaf2", border: "1px solid rgba(221,107,32,.25)", borderRadius: 999 }),
  },
  royal: {
    accent: "#d4af6a",
    container: (a) => ({ background: "#150e20", border: `2px double ${a}77` }),
    avatar: (a) => ({ borderRadius: 3, border: `1px solid ${a}` }),
    name: ( ) => ({ background: "#d4af6a" }),
    link: (a) => ({ background: "transparent", border: `1px solid ${a}55`, borderRadius: 2 }),
  },
}

function ThemeThumbnail({ theme, accent }: { theme: string; accent: string }) {
  const preview = THEME_PREVIEW[theme] ?? THEME_PREVIEW.void
  const a = accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : preview.accent
  const ls = preview.link(a)
  return (
    <div
      className="flex h-20 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-md px-2 py-2"
      style={preview.container(a)}
    >
      <div className="h-4 w-4 rounded-full" style={{ ...preview.avatar(a), background: a }} />
      <div className="h-1 w-9 rounded-full" style={preview.name()} />
      <div className="h-1.5 w-14 rounded-[2px]" style={ls} />
      <div className="h-1.5 w-10 rounded-[2px]" style={ls} />
    </div>
  )
}

/** 布局线框图：6 种结构的缩略示意 */
function LayoutWireframe({ id }: { id: string }) {
  const c = "currentColor"
  const common = { vectorEffect: "non-scaling-stroke" } as const
  return (
    <svg viewBox="0 0 48 32" className="h-8 w-full text-muted-foreground" fill="none">
      {id === "center" && (
        <>
          <rect x="19" y="3" width="10" height="10" rx="5" fill={c} opacity=".35" {...common} />
          <rect x="16" y="15" width="16" height="2" rx="1" fill={c} opacity=".5" />
          <rect x="10" y="20" width="28" height="3" rx="1.5" stroke={c} opacity=".4" {...common} />
          <rect x="10" y="25" width="28" height="3" rx="1.5" stroke={c} opacity=".4" {...common} />
        </>
      )}
      {id === "side" && (
        <>
          <rect x="4" y="4" width="10" height="10" rx="5" fill={c} opacity=".35" {...common} />
          <rect x="4" y="17" width="10" height="2" rx="1" fill={c} opacity=".5" />
          <rect x="18" y="5" width="26" height="3" rx="1.5" stroke={c} opacity=".4" {...common} />
          <rect x="18" y="11" width="26" height="3" rx="1.5" stroke={c} opacity=".4" {...common} />
          <rect x="18" y="17" width="26" height="8" rx="1.5" stroke={c} opacity=".4" {...common} />
        </>
      )}
      {id === "split" && (
        <>
          <rect x="2" y="2" width="44" height="28" rx="2" fill={c} opacity=".14" {...common} />
          <rect x="7" y="14" width="34" height="14" rx="2" fill={c} opacity=".32" {...common} />
        </>
      )}
      {id === "plain" && (
        <>
          <rect x="4" y="4" width="8" height="8" rx="4" fill={c} opacity=".35" {...common} />
          <rect x="15" y="7" width="14" height="2" rx="1" fill={c} opacity=".5" />
          <rect x="4" y="18" width="40" height="1.5" rx=".75" fill={c} opacity=".3" />
          <rect x="4" y="24" width="40" height="1.5" rx=".75" fill={c} opacity=".3" />
        </>
      )}
      {id === "bento" && (
        <>
          <rect x="3" y="3" width="42" height="8" rx="1.5" fill={c} opacity=".3" {...common} />
          <rect x="3" y="13" width="20" height="8" rx="1.5" stroke={c} opacity=".4" {...common} />
          <rect x="25" y="13" width="20" height="8" rx="1.5" stroke={c} opacity=".4" {...common} />
          <rect x="3" y="23" width="42" height="6" rx="1.5" stroke={c} opacity=".4" {...common} />
        </>
      )}
      {id === "banner" && (
        <>
          <rect x="2" y="2" width="44" height="10" rx="1.5" fill={c} opacity=".3" {...common} />
          <rect x="6" y="8" width="10" height="10" rx="5" fill={c} opacity=".45" {...common} />
          <rect x="19" y="15" width="16" height="2" rx="1" fill={c} opacity=".5" />
          <rect x="6" y="22" width="36" height="3" rx="1.5" stroke={c} opacity=".4" {...common} />
          <rect x="6" y="27" width="36" height="3" rx="1.5" stroke={c} opacity=".4" {...common} />
        </>
      )}
    </svg>
  )
}

/** 一行可复制的地址：显示 + 复制 + 新窗口打开 */
function AddressRow({ url }: { url: string }) {
  const [done, setDone] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setDone(true)
      setTimeout(() => setDone(false), 1500)
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={url} className="font-mono text-xs" />
      <Button variant="outline" size="icon" onClick={() => void copy()} aria-label="复制">
        {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
      <Button variant="outline" size="icon" asChild aria-label="打开">
        <a href={url} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
    </div>
  )
}

function formatBytes(n: number) {
  return n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`
}

// ---- 模块系统 ----

/** canvas 类动效互斥组（与服务端 CANVAS_EFFECTS 一致） */
const CANVAS_EFFECTS = ["particles", "rain", "sakura", "snow"]

/** 中间区可排序模块的默认顺序（与服务端 DEFAULT_MODULE_ORDER 一致） */
const MIDDLE_MODULE_ORDER: ProfileModuleId[] = [
  "tags",
  "quote",
  "links",
  "timeline",
  "gallery",
  "music",
]

const MODULE_DEFAULT_ENABLED: Partial<Record<ProfileModuleId, boolean>> = {
  identity: true,
  status: false,
  tags: false,
  quote: false,
  links: true,
  timeline: false,
  gallery: false,
  music: true,
  stats: true,
}

/** 可配置内容的模块（其余只有开关） */
const CONFIGURABLE_MODULES: ProfileModuleId[] = [
  "status",
  "tags",
  "quote",
  "timeline",
  "gallery",
]

/**
 * 把服务端下发的 modules 规整成编辑器用的完整列表：
 * 所有模块都在列（缺的按默认值补），identity 恒首、status 次位、stats 恒尾，
 * 中间区按存储顺序 + 默认顺序补位。
 */
function normalizeModules(stored: ProfileModule[] | undefined): ProfileModule[] {
  const map = new Map<ProfileModuleId, ProfileModule>()
  for (const m of stored ?? []) map.set(m.id, m)
  const fallback = (id: ProfileModuleId): ProfileModule => ({
    id,
    enabled: MODULE_DEFAULT_ENABLED[id] ?? false,
  })
  const storedMiddle = (stored ?? [])
    .map((m) => m.id)
    .filter((id) => MIDDLE_MODULE_ORDER.includes(id))
  const middleIds = [
    ...storedMiddle,
    ...MIDDLE_MODULE_ORDER.filter((id) => !storedMiddle.includes(id)),
  ]
  return [
    map.get("identity") ?? fallback("identity"),
    map.get("status") ?? fallback("status"),
    ...middleIds.map((id) => map.get(id) ?? fallback(id)),
    map.get("stats") ?? fallback("stats"),
  ]
}

export default function ProfilePage() {
  const [data, setData] = React.useState<ProfileOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [enabling, setEnabling] = React.useState(false)
  const [uploading, setUploading] = React.useState<string | null>(null)

  const [form, setForm] = React.useState({
    slug: "",
    displayName: "",
    bio: "",
    avatarUrl: "",
    backgroundUrl: "",
    musicUrl: "",
    musicTitle: "",
    musicAutoplay: false,
    musicCoverUrl: "",
    theme: "void",
    accent: "",
    effects: [] as string[],
    intro: "none",
    font: "system",
    cjkFont: "system",
    layout: "center",
  })
  const [contacts, setContacts] = React.useState<ProfileContact[]>([])
  const [modules, setModules] = React.useState<ProfileModule[]>(() => normalizeModules([]))
  const [published, setPublished] = React.useState(false)

  const [previewHtml, setPreviewHtml] = React.useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await profileApi.get()
      setData(res)
      const p = res.profile
      if (!p) {
        // 未开通：不填充表单，由下方开通引导页接管
        return
      }
      setForm({
        slug: p.slug,
        displayName: p.displayName ?? "",
        bio: p.bio ?? "",
        avatarUrl: p.avatarUrl ?? "",
        backgroundUrl: p.backgroundUrl ?? "",
        musicUrl: p.musicUrl ?? "",
        musicTitle: p.musicTitle ?? "",
        musicAutoplay: p.musicAutoplay,
        musicCoverUrl: p.musicCoverUrl ?? "",
        theme: p.theme,
        accent: p.accent ?? "",
        effects: p.effects ?? [],
        intro: p.intro ?? "none",
        font: p.font ?? "system",
        cjkFont: p.cjkFont ?? "system",
        layout: p.layout ?? "center",
      })
      setContacts(p.contacts)
      setModules(normalizeModules(p.modules))
      setPublished(p.published)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载名片失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const profile = data?.profile
  const defaultUrl = `${window.location.origin}${profile?.profilePath ?? ""}`
  const customUrl = profile?.fqdn ? `https://${profile.fqdn}` : null

  const boundToRootDomain =
    !!profile?.fqdn && profile.fqdn === window.location.hostname.replace(/^cloud\./, "")

  // 实时预览：表单/联系方式/模块任一变化，防抖后请求服务端渲染公开页 HTML。
  // 渲染走与线上完全相同的 renderProfileHtml，所见即所得。
  const hasProfile = Boolean(data?.profile)
  React.useEffect(() => {
    if (!hasProfile) return
    setPreviewLoading(true)
    const timer = setTimeout(() => {
      profileApi
        .preview({ ...form, contacts, modules })
        .then((res) => setPreviewHtml(res.html))
        .catch(() => {
          // 预览失败静默：不影响编辑
        })
        .finally(() => setPreviewLoading(false))
    }, 650)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, contacts, modules, hasProfile])

  const handleEnable = async () => {
    setEnabling(true)
    try {
      await profileApi.enable()
      await load()
      toast.success("名片已开通，接下来填写资料并点「启用」对外展示")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "开通失败")
    } finally {
      setEnabling(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await profileApi.update({ ...form, contacts, modules })
      setData((d) => (d ? { ...d, profile: res.profile } : d))
      toast.success("已保存")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const handleTogglePublish = async (next: boolean) => {
    try {
      await profileApi.publish(next)
      setPublished(next)
      toast.success(next ? "名片已启用，任何人可访问" : "名片已停用")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    }
  }

  const handleUpload = async (
    kind: "avatar" | "background" | "music" | "music-cover",
    file: File | undefined
  ) => {
    if (!file) return
    setUploading(kind)
    try {
      await profileApi.uploadAsset(kind, file)
      await load()
      toast.success("上传成功")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "上传失败")
    } finally {
      setUploading(null)
    }
  }

  const handleRemoveAsset = async (kind: "avatar" | "background" | "music" | "music-cover") => {
    try {
      await profileApi.deleteAsset(kind)
      await load()
      toast.success("已移除")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "移除失败")
    }
  }

  const addContact = () => {
    setContacts((c) => [...c, { type: "github", value: "", visible: true }])
  }

  const updateContact = (i: number, patch: Partial<ProfileContact>) => {
    setContacts((c) => c.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
  }

  // 动效勾选：canvas 类（particles/rain/sakura/snow）互斥
  const toggleEffect = (id: string, checked: boolean) => {
    setForm((f) => {
      if (!checked) return { ...f, effects: f.effects.filter((e) => e !== id) }
      const isCanvas = CANVAS_EFFECTS.includes(id)
      const next = isCanvas
        ? [...f.effects.filter((e) => !CANVAS_EFFECTS.includes(e)), id]
        : [...f.effects, id]
      return { ...f, effects: Array.from(new Set(next)) }
    })
  }

  // ---- 模块操作 ----
  const updateModule = (id: ProfileModuleId, patch: Partial<ProfileModule>) => {
    setModules((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  }

  /** 中间区排序：把 idx 位置的模块与 idx+delta 交换（只允许中间区） */
  const moveModule = (idx: number, delta: -1 | 1) => {
    setModules((list) => {
      const next = [...list]
      const j = idx + delta
      if (j < 2 || j >= next.length - 1 || idx < 2 || idx >= next.length - 1) return next
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="个人名片" description="对外展示的个人主页" />
        <LoadingBlock />
      </div>
    )
  }

  // 未开通：照搬网盘/中转站的做法，先显示引导页，点击开通后才进入编辑界面
  if (!data?.enabled || !data.profile) {
    return (
      <div>
        <PageHeader title="个人名片" description="对外展示的个人主页" />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Contact className="h-4 w-4 text-muted-foreground" />
              开通个人名片
            </CardTitle>
            <CardDescription>
              开通后你会得到一个对外展示的个人主页——11 种皮肤、6 种骨架、
              可自由组装的模块（标签 / 名言 / 大事记 / 图片墙 / 音乐 …），
              还能绑定自己的子域名。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>· 默认地址：{window.location.origin}/profile/&lt;你的用户名&gt;</li>
              <li>· 支持 QQ、Bilibili、Telegram、GitHub、邮箱等，填写原始值即可自动生成链接</li>
              <li>· 模块可开关、可排序，皮肤 × 骨架 × 字体 × 动效自由混搭</li>
              <li>· 开通后默认不对外展示，需要再手动点「启用」</li>
            </ul>
            <Button onClick={() => void handleEnable()} disabled={enabling}>
              {enabling && <Loader2 className="h-4 w-4 animate-spin" />}
              开通名片
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const limits = data?.limits

  return (
    <div>
      <PageHeader
        title="个人名片"
        description="皮肤 × 骨架 × 模块自由组装，右侧实时预览。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => void load()} aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
        {/* 左：设置 */}
        <div className="min-w-0">
          <Tabs defaultValue="basic">
            <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
              <TabsTrigger value="basic">资料</TabsTrigger>
              <TabsTrigger value="appearance">外观</TabsTrigger>
              <TabsTrigger value="modules">模块</TabsTrigger>
              <TabsTrigger value="contacts">联系方式</TabsTrigger>
              <TabsTrigger value="music">音乐</TabsTrigger>
              <TabsTrigger value="publish">发布</TabsTrigger>
            </TabsList>

            {/* ============ 资料 ============ */}
            <TabsContent value="basic" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">基本资料</CardTitle>
                  <CardDescription>昵称与签名，名片最显眼的两行字</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="displayName">昵称</Label>
                    <Input
                      id="displayName"
                      placeholder="你的名字"
                      value={form.displayName}
                      onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bio">个性签名</Label>
                    <Textarea
                      id="bio"
                      placeholder="一句话介绍自己（支持换行）"
                      value={form.bio}
                      onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
                      rows={3}
                      className="resize-none"
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">当前状态</CardTitle>
                  <CardDescription>昵称下方的小状态签（在「模块」页可开关）</CardDescription>
                </CardHeader>
                <CardContent>
                  <StatusEditor
                    module={modules.find((m) => m.id === "status")}
                    onChange={(patch) => updateModule("status", patch)}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* ============ 外观 ============ */}
            <TabsContent value="appearance" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">皮肤</CardTitle>
                  <CardDescription>11 套完整视觉语言，右侧预览实时生效</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                    {(data?.themes ?? []).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, theme: t }))}
                        className={cn(
                          "relative rounded-lg border-2 p-1.5 transition-all",
                          form.theme === t
                            ? "border-primary ring-2 ring-primary/20"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <ThemeThumbnail theme={t} accent={form.accent} />
                        <span className="mt-1 block text-center text-xs font-medium">
                          {THEME_LABEL[t] ?? t}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="accent">主题色（可选，留空用皮肤默认色）</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={/^#[0-9a-f]{6}$/i.test(form.accent) ? form.accent : "#6366f1"}
                        onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))}
                        className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
                        aria-label="选择主题色"
                      />
                      <Input
                        id="accent"
                        placeholder="#6366f1"
                        value={form.accent}
                        onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))}
                        className="w-32 font-mono text-xs"
                      />
                      {form.accent && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setForm((f) => ({ ...f, accent: "" }))}
                        >
                          清除
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">骨架</CardTitle>
                  <CardDescription>页面的结构方式，与皮肤自由混搭</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {(data?.layoutOptions ?? []).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, layout: opt.id }))}
                        className={cn(
                          "rounded-lg border p-2.5 text-left transition-all",
                          form.layout === opt.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <LayoutWireframe id={opt.id} />
                        <div className="mt-1.5 text-sm font-medium">{opt.label}</div>
                        <div className="text-xs text-muted-foreground">{opt.desc}</div>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">字体</CardTitle>
                  <CardDescription>英文标题字与中文正文字体，相互独立</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>英文标题字</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {(data?.fontOptions ?? []).map((opt) => {
                        const family =
                          opt.id === "system" ? undefined : `'${opt.label}', sans-serif`
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setForm((f) => ({ ...f, font: opt.id }))}
                            style={family ? { fontFamily: family } : undefined}
                            className={cn(
                              "rounded-lg border px-2 py-2 text-center text-sm transition-all",
                              form.font === opt.id
                                ? "border-primary bg-primary/5"
                                : "border-border hover:border-primary/50"
                            )}
                          >
                            {opt.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>中文正文字体</Label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {(data?.cjkFontOptions ?? []).map((opt) => {
                        const family =
                          opt.id === "song"
                            ? "'Songti SC','STSong','SimSun',serif"
                            : opt.id === "kai"
                              ? "'Kaiti SC','STKaiti','KaiTi',serif"
                              : opt.id === "yuan"
                                ? "'Yuanti SC','YouYuan','PingFang SC',sans-serif"
                                : undefined
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setForm((f) => ({ ...f, cjkFont: opt.id }))}
                            style={family ? { fontFamily: family } : undefined}
                            className={cn(
                              "rounded-lg border px-2 py-2 text-center transition-all",
                              form.cjkFont === opt.id
                                ? "border-primary bg-primary/5"
                                : "border-border hover:border-primary/50"
                            )}
                          >
                            <div className="text-sm font-medium">{opt.label}</div>
                            <div className="text-xs text-muted-foreground">{opt.desc}</div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">头像与背景</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {/* 头像 */}
                    <div className="space-y-2">
                      <Label>头像</Label>
                      <div className="flex items-center gap-3">
                        {profile?.avatarKey || form.avatarUrl ? (
                          <img
                            src={
                              profile?.avatarKey ? `/api/profile/asset?kind=avatar` : form.avatarUrl
                            }
                            alt="头像"
                            className="h-14 w-14 rounded-full border object-cover"
                          />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded-full border bg-muted">
                            <ImageIcon className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex flex-col gap-1.5">
                          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent">
                            {uploading === "avatar" ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Upload className="h-3.5 w-3.5" />
                            )}
                            上传
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp,image/gif"
                              className="hidden"
                              onChange={(e) => void handleUpload("avatar", e.target.files?.[0])}
                            />
                          </label>
                          {profile?.avatarKey && (
                            <button
                              type="button"
                              className="text-left text-xs text-muted-foreground hover:text-destructive"
                              onClick={() => void handleRemoveAsset("avatar")}
                            >
                              移除已上传
                            </button>
                          )}
                        </div>
                      </div>
                      <Input
                        placeholder="或粘贴图片链接"
                        value={form.avatarUrl}
                        onChange={(e) => setForm((f) => ({ ...f, avatarUrl: e.target.value }))}
                        className="text-xs"
                      />
                      {limits && (
                        <p className="text-xs text-muted-foreground">
                          上传上限 {formatBytes(limits.avatar)}
                        </p>
                      )}
                    </div>

                    {/* 背景图 */}
                    <div className="space-y-2">
                      <Label>背景图片</Label>
                      <div className="flex items-center gap-3">
                        {profile?.backgroundKey || form.backgroundUrl ? (
                          <img
                            src={
                              profile?.backgroundKey
                                ? `/api/profile/asset?kind=background`
                                : form.backgroundUrl
                            }
                            alt="背景"
                            className="h-14 w-24 rounded-md border object-cover"
                          />
                        ) : (
                          <div className="flex h-14 w-24 items-center justify-center rounded-md border bg-muted">
                            <ImageIcon className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex flex-col gap-1.5">
                          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent">
                            {uploading === "background" ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Upload className="h-3.5 w-3.5" />
                            )}
                            上传
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp,image/gif"
                              className="hidden"
                              onChange={(e) => void handleUpload("background", e.target.files?.[0])}
                            />
                          </label>
                          {profile?.backgroundKey && (
                            <button
                              type="button"
                              className="text-left text-xs text-muted-foreground hover:text-destructive"
                              onClick={() => void handleRemoveAsset("background")}
                            >
                              移除已上传
                            </button>
                          )}
                        </div>
                      </div>
                      <Input
                        placeholder="或粘贴图片链接"
                        value={form.backgroundUrl}
                        onChange={(e) => setForm((f) => ({ ...f, backgroundUrl: e.target.value }))}
                        className="text-xs"
                      />
                      {limits && (
                        <p className="text-xs text-muted-foreground">
                          上传上限 {formatBytes(limits.background)}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">动效与开屏</CardTitle>
                  <CardDescription>
                    动效可多选（粒子 / 代码雨 / 樱花 / 落雪共用画布，互斥）
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {(data?.effectOptions ?? []).map((opt) => {
                      const checked = form.effects.includes(opt.id)
                      const blockedBy =
                        CANVAS_EFFECTS.includes(opt.id) && !checked
                          ? form.effects.some(
                              (e) => CANVAS_EFFECTS.includes(e) && e !== opt.id
                            )
                          : false
                      return (
                        <label
                          key={opt.id}
                          className={cn(
                            "flex items-start gap-2 rounded-lg border p-2.5 transition-all",
                            checked ? "border-primary bg-primary/5" : "border-border",
                            blockedBy && "cursor-not-allowed opacity-40"
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={checked}
                            disabled={blockedBy}
                            onChange={(e) => toggleEffect(opt.id, e.target.checked)}
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-medium">{opt.label}</div>
                            <div className="text-xs text-muted-foreground">{opt.desc}</div>
                          </div>
                        </label>
                      )
                    })}
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label>开屏动画</Label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {(data?.introOptions ?? []).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, intro: opt.id }))}
                          className={cn(
                            "rounded-lg border p-2.5 text-left transition-all",
                            form.intro === opt.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/50"
                          )}
                        >
                          <div className="text-sm font-medium">{opt.label}</div>
                          <div className="text-xs text-muted-foreground">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ============ 模块 ============ */}
            <TabsContent value="modules" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                名片由模块组装而成：开关决定显示与否，中间几个模块可用箭头调整顺序。
                启用但还没填内容的模块不会出现在名片上。
              </p>
              {modules.map((m, idx) => {
                const meta = data?.moduleOptions.find((o) => o.id === m.id)
                const isMiddle = idx >= 2 && idx <= modules.length - 2
                const configurable = CONFIGURABLE_MODULES.includes(m.id)
                return (
                  <Card key={m.id} className={cn(!m.enabled && "opacity-70")}>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-center gap-3">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          {isMiddle && (
                            <div className="flex flex-col">
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                                onClick={() => moveModule(idx, -1)}
                                disabled={idx === 2}
                                aria-label="上移"
                              >
                                <ChevronUp className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                                onClick={() => moveModule(idx, 1)}
                                disabled={idx === modules.length - 2}
                                aria-label="下移"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium">{meta?.label ?? m.id}</div>
                            <div className="text-xs text-muted-foreground">{meta?.desc}</div>
                          </div>
                        </div>
                        <Switch
                          checked={m.enabled}
                          disabled={m.id === "identity"}
                          onCheckedChange={(v) => updateModule(m.id, { enabled: v })}
                        />
                      </div>

                      {m.enabled && configurable && (
                        <ModuleConfigEditor
                          module={m}
                          onChange={(patch) => updateModule(m.id, patch)}
                        />
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </TabsContent>

            {/* ============ 联系方式 ============ */}
            <TabsContent value="contacts">
              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-base">联系方式</CardTitle>
                      <CardDescription>
                        只填原始值即可（QQ 号、UID、用户名），链接由系统自动生成
                      </CardDescription>
                    </div>
                    <Button size="sm" variant="outline" onClick={addContact}>
                      <Plus className="h-4 w-4" />
                      添加
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {contacts.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      还没有联系方式，点右上角「添加」。
                    </p>
                  ) : (
                    contacts.map((c, i) => (
                      <div key={i} className="space-y-2 rounded-md border p-3">
                        <div className="flex items-center gap-2">
                          <Select
                            value={c.type}
                            onValueChange={(v) => updateContact(i, { type: v as ContactType })}
                          >
                            <SelectTrigger className="w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(data?.contactTypes ?? []).map((t) => (
                                <SelectItem key={t} value={t}>
                                  {CONTACT_META[t]?.label ?? t}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            placeholder={CONTACT_META[c.type]?.placeholder}
                            value={c.value}
                            onChange={(e) => updateContact(i, { value: e.target.value })}
                            className="flex-1"
                          />
                          <Input
                            placeholder="显示文字（可选）"
                            value={c.label ?? ""}
                            onChange={(e) => updateContact(i, { label: e.target.value })}
                            className="w-32"
                          />
                          <Switch
                            checked={c.visible !== false}
                            onCheckedChange={(v) => updateContact(i, { visible: v })}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => setContacts((list) => list.filter((_, idx) => idx !== i))}
                            aria-label="删除"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        {CONTACT_META[c.type]?.hint && (
                          <p className="text-xs text-muted-foreground">{CONTACT_META[c.type].hint}</p>
                        )}
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ============ 音乐 ============ */}
            <TabsContent value="music">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Music className="h-4 w-4 text-muted-foreground" />
                    背景音乐
                  </CardTitle>
                  <CardDescription>
                    上传音频文件，或粘贴外部直链（需是可直接播放的音频地址）
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-accent">
                      {uploading === "music" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      上传音乐
                      <input
                        type="file"
                        accept="audio/mpeg,audio/mp4,audio/ogg,audio/wav"
                        className="hidden"
                        onChange={(e) => void handleUpload("music", e.target.files?.[0])}
                      />
                    </label>
                    {profile?.musicKey && (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => void handleRemoveAsset("music")}
                      >
                        移除已上传
                      </button>
                    )}
                    {limits && (
                      <span className="text-xs text-muted-foreground">
                        上限 {formatBytes(limits.music)}
                      </span>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="musicUrl">或粘贴音频链接</Label>
                    <Input
                      id="musicUrl"
                      placeholder="https://…/song.mp3"
                      value={form.musicUrl}
                      onChange={(e) => setForm((f) => ({ ...f, musicUrl: e.target.value }))}
                      className="text-xs"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="musicTitle">音乐标题（可选）</Label>
                    <Input
                      id="musicTitle"
                      placeholder="曲名"
                      value={form.musicTitle}
                      onChange={(e) => setForm((f) => ({ ...f, musicTitle: e.target.value }))}
                    />
                  </div>

                  {/* 专辑封面 */}
                  <div className="space-y-2">
                    <Label>专辑封面（可选）</Label>
                    <div className="flex items-center gap-3">
                      {profile?.musicCoverKey || form.musicCoverUrl ? (
                        <img
                          src={
                            profile?.musicCoverKey
                              ? `/api/profile/asset?kind=music-cover`
                              : form.musicCoverUrl
                          }
                          alt="封面"
                          className="h-14 w-14 rounded-md border object-cover"
                        />
                      ) : (
                        <div className="flex h-14 w-14 items-center justify-center rounded-md border bg-muted">
                          <Music className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent">
                          {uploading === "music-cover" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Upload className="h-3.5 w-3.5" />
                          )}
                          上传封面
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            className="hidden"
                            onChange={(e) => void handleUpload("music-cover", e.target.files?.[0])}
                          />
                        </label>
                        {profile?.musicCoverKey && (
                          <button
                            type="button"
                            className="text-left text-xs text-muted-foreground hover:text-destructive"
                            onClick={() => void handleRemoveAsset("music-cover")}
                          >
                            移除已上传
                          </button>
                        )}
                      </div>
                    </div>
                    <Input
                      placeholder="或粘贴封面图片链接"
                      value={form.musicCoverUrl}
                      onChange={(e) => setForm((f) => ({ ...f, musicCoverUrl: e.target.value }))}
                      className="text-xs"
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border px-4 py-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">自动播放</p>
                      <p className="text-xs text-muted-foreground">
                        多数浏览器会拦截自动播放，通常需访问者手动点击
                      </p>
                    </div>
                    <Switch
                      checked={form.musicAutoplay}
                      onCheckedChange={(v) => setForm((f) => ({ ...f, musicAutoplay: v }))}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ============ 发布 ============ */}
            <TabsContent value="publish">
              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <UserRound className="h-4 w-4 text-muted-foreground" />
                        对外展示
                      </CardTitle>
                      <CardDescription>
                        {published
                          ? "已启用，任何拿到链接的人都能访问。"
                          : "未启用时，访问者只会看到「名片不存在」。"}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant={published ? "success" : "secondary"}>
                        {published ? "已启用" : "未启用"}
                      </Badge>
                      <Switch
                        checked={published}
                        onCheckedChange={(v) => void handleTogglePublish(v)}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>默认地址</Label>
                    <AddressRow url={defaultUrl} />
                  </div>

                  <div className="space-y-2">
                    <Label>自定义域名</Label>
                    {profile?.fqdn ? (
                      <>
                        <AddressRow url={customUrl!} />
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-destructive"
                          onClick={async () => {
                            try {
                              await profileApi.unbindDomain()
                              await load()
                              toast.success("已解绑")
                            } catch (err) {
                              toast.error(err instanceof HttpError ? err.message : "解绑失败")
                            }
                          }}
                        >
                          解绑该域名
                        </button>
                      </>
                    ) : (data?.availableSubdomains.length ?? 0) === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        没有可用的子域名。请先到「域名」创建，或确认它没有被网盘直链占用。
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {data?.availableSubdomains.map((sub) => (
                          <Button
                            key={sub.id}
                            variant="outline"
                            size="sm"
                            className="font-mono text-xs"
                            onClick={async () => {
                              try {
                                const res = await profileApi.bindDomain(sub.id)
                                await load()
                                toast.success(
                                  res.dnsCreated ? "已绑定，DNS 生效约需 1-2 分钟" : "已绑定"
                                )
                              } catch (err) {
                                toast.error(err instanceof HttpError ? err.message : "绑定失败")
                              }
                            }}
                          >
                            {sub.fqdn}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>

                  {boundToRootDomain && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                      <p className="text-xs font-medium text-destructive">
                        当前绑定的是根域名 {profile?.fqdn}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        根域名是平台入口，绑给名片会导致整站无法访问。请解绑后改用子域名
                        （如 card.doulor.cn）。
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* 右：实时预览 */}
        <div className="min-w-0">
          <div className="xl:sticky xl:top-6">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Eye className="h-4 w-4 text-muted-foreground" />
                实时预览
                {previewLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              {published && (
                <Button variant="ghost" size="sm" asChild>
                  <a href={defaultUrl} target="_blank" rel="noopener noreferrer">
                    打开公开页
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
            </div>
            <div className="overflow-hidden rounded-xl border bg-neutral-950 shadow-sm">
              {previewHtml ? (
                <iframe
                  title="名片实时预览"
                  sandbox="allow-scripts allow-popups"
                  srcDoc={previewHtml}
                  className="h-[70vh] min-h-[520px] w-full border-0"
                />
              ) : (
                <div className="flex h-[70vh] min-h-[520px] items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              预览由服务端按线上同样的方式渲染；未保存的改动也会实时反映，不计访客数。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- 模块配置编辑器 ----

function StatusEditor({
  module,
  onChange,
}: {
  module: ProfileModule | undefined
  onChange: (patch: Partial<ProfileModule>) => void
}) {
  if (!module) return null
  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="🎧"
        value={module.emoji ?? ""}
        onChange={(e) => onChange({ emoji: e.target.value })}
        className="w-16 text-center"
        maxLength={8}
      />
      <Input
        placeholder="在做什么？（如：在听歌 / 闭关写代码）"
        value={module.text ?? ""}
        onChange={(e) => onChange({ text: e.target.value })}
        className="flex-1"
        maxLength={30}
      />
    </div>
  )
}

function TagsEditor({
  module,
  onChange,
}: {
  module: ProfileModule
  onChange: (patch: Partial<ProfileModule>) => void
}) {
  const [draft, setDraft] = React.useState("")
  const tags = (module.items ?? []).filter((x): x is string => typeof x === "string")
  const add = () => {
    const t = draft.trim().slice(0, 12)
    if (!t || tags.includes(t) || tags.length >= 12) return
    onChange({ items: [...tags, t] })
    setDraft("")
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          placeholder="输入标签后回车添加（最多 12 个）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          className="flex-1"
        />
        <Button size="sm" variant="outline" onClick={add}>
          添加
        </Button>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
            >
              {t}
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onChange({ items: tags.filter((_, idx) => idx !== i) })}
                aria-label="移除标签"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function TimelineEditor({
  module,
  onChange,
}: {
  module: ProfileModule
  onChange: (patch: Partial<ProfileModule>) => void
}) {
  const items = (module.items ?? []).filter(
    (x): x is ProfileTimelineItem => typeof x === "object" && x !== null && "title" in x
  )
  const setItem = (i: number, patch: Partial<ProfileTimelineItem>) => {
    onChange({ items: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) })
  }
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2 rounded-md border p-2.5">
          <Input
            placeholder="时间"
            value={it.date}
            onChange={(e) => setItem(i, { date: e.target.value })}
            className="w-24 shrink-0 text-xs"
            maxLength={20}
          />
          <div className="flex-1 space-y-1.5">
            <Input
              placeholder="标题（如：开始学摄影）"
              value={it.title}
              onChange={(e) => setItem(i, { title: e.target.value })}
              maxLength={30}
            />
            <Input
              placeholder="补充说明（可选）"
              value={it.desc}
              onChange={(e) => setItem(i, { desc: e.target.value })}
              className="text-xs"
              maxLength={80}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange({ items: items.filter((_, idx) => idx !== i) })}
            aria-label="删除"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {items.length < 8 && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange({ items: [...items, { date: "", title: "", desc: "" }] })}
        >
          <Plus className="h-4 w-4" />
          添加一条
        </Button>
      )}
    </div>
  )
}

function GalleryEditor({
  module,
  onChange,
}: {
  module: ProfileModule
  onChange: (patch: Partial<ProfileModule>) => void
}) {
  const items = (module.items ?? []).filter(
    (x): x is ProfileGalleryItem => typeof x === "object" && x !== null && "url" in x
  )
  const [busy, setBusy] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const setItem = (i: number, patch: Partial<ProfileGalleryItem>) => {
    onChange({ items: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) })
  }

  /** 本地选图 → 压缩 → 上传，拿回相对 URL 存进模块配置 */
  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return
    const room = 9 - items.length
    if (room <= 0) return
    setBusy(true)
    const added: ProfileGalleryItem[] = []
    try {
      for (const file of Array.from(files).slice(0, room)) {
        const compressed = await compressImage(file, 1600, 0.82).catch(() => file)
        const res = await profileApi.uploadAsset("gallery", compressed)
        if (res.url) added.push({ url: res.url, caption: "" })
      }
      if (added.length) {
        onChange({ items: [...items, ...added] })
        toast.success(`已上传 ${added.length} 张图片`)
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "上传失败")
      // 部分成功也要落盘，避免已上传的图丢失
      if (added.length) onChange({ items: [...items, ...added] })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        可直接从本机上传（自动压缩），也可粘贴 https 图片链接。最多 9 张，展示为三列网格。
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 rounded-md border p-2.5">
          {it.url && (
            <img
              src={it.url}
              alt=""
              className="h-10 w-10 shrink-0 rounded border object-cover"
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden"
              }}
            />
          )}
          <Input
            placeholder="https://…/photo.jpg 或本机上传"
            value={it.url}
            onChange={(e) => setItem(i, { url: e.target.value })}
            className="flex-1 font-mono text-xs"
            maxLength={1000}
          />
          <Input
            placeholder="说明（可选）"
            value={it.caption}
            onChange={(e) => setItem(i, { caption: e.target.value })}
            className="w-28"
            maxLength={20}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange({ items: items.filter((_, idx) => idx !== i) })}
            aria-label="删除"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {items.length < 9 && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {busy ? "上传中…" : "上传图片"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange({ items: [...items, { url: "", caption: "" }] })}
          >
            <Plus className="h-4 w-4" />
            粘贴链接
          </Button>
        </div>
      )}
    </div>
  )
}

function ModuleConfigEditor({
  module,
  onChange,
}: {
  module: ProfileModule
  onChange: (patch: Partial<ProfileModule>) => void
}) {
  switch (module.id) {
    case "status":
      return <StatusEditor module={module} onChange={onChange} />
    case "tags":
      return <TagsEditor module={module} onChange={onChange} />
    case "quote":
      return (
        <div className="space-y-2">
          <Textarea
            placeholder="一句喜欢的话（可换行，最多 5 行）"
            value={module.text ?? ""}
            onChange={(e) => onChange({ text: e.target.value })}
            rows={4}
            className="resize-y"
            maxLength={200}
          />
          <Input
            placeholder="出处 / 作者（可选）"
            value={module.author ?? ""}
            onChange={(e) => onChange({ author: e.target.value })}
            maxLength={20}
          />
        </div>
      )
    case "timeline":
      return <TimelineEditor module={module} onChange={onChange} />
    case "gallery":
      return <GalleryEditor module={module} onChange={onChange} />
    default:
      return null
  }
}
