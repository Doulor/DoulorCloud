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
  Search,
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
import { profileApi, identityApi, HttpError } from "@/services/api"
import { compressImage } from "@/lib/image-compress"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"
import { useAuth } from "@/hooks/use-auth"
import type {
  ContactType,
  ProfileContact,
  ProfileGalleryItem,
  ProfileModule,
  ProfileModuleId,
  ProfileMusicTrack,
  ProfileOverview,
  ProfileTimelineItem,
} from "@/types"

/** 联系方式的展示名、输入提示与「只填原始值」的说明 */
const CONTACT_META: Record<
  ContactType,
  { label: string; placeholder: string; hint?: string }
> = {
  email: { label: "pf.c.email", placeholder: "you@example.com", hint: "pf.c.emailHint" },
  qq: {
    label: "pf.c.qq",
    placeholder: "pf.c.qqPh",
    hint: "pf.c.qqHint",
  },
  wechat: {
    label: "pf.c.wechat",
    placeholder: "pf.c.wechatPh",
    hint: "pf.c.wechatHint",
  },
  bilibili: {
    label: "Bilibili",
    placeholder: "1307574205",
    hint: "pf.c.biliHint",
  },
  discord: {
    label: "Discord",
    placeholder: "pf.c.discordPh",
    hint: "pf.c.discordHint",
  },
  telegram: {
    label: "Telegram",
    placeholder: "username",
    hint: "pf.c.tgHint",
  },
  youtube: {
    label: "YouTube",
    placeholder: "pf.c.ytPh",
    hint: "pf.c.ytHint",
  },
  github: {
    label: "GitHub",
    placeholder: "username",
    hint: "pf.c.ghHint",
  },
  x: {
    label: "X / Twitter",
    placeholder: "@username",
    hint: "pf.c.xHint",
  },
  custom: { label: "pf.c.custom", placeholder: "https://…", hint: "pf.c.customHint" },
}

const THEME_LABEL: Record<string, string> = {
  void: "pf.theme.void",
  neon: "pf.theme.neon",
  glass: "pf.theme.glass",
  aurora: "pf.theme.aurora",
  cyber: "pf.theme.cyber",
  blossom: "pf.theme.blossom",
  paper: "pf.theme.paper",
  ink: "pf.theme.ink",
  terminal: "pf.theme.terminal",
  solar: "pf.theme.solar",
  royal: "pf.theme.royal",
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
  const { t } = useT()
  const [done, setDone] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setDone(true)
      setTimeout(() => setDone(false), 1500)
    } catch {
      toast.error(t("pf.err.copy"))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={url} className="font-mono text-xs" />
      <Button variant="outline" size="icon" onClick={() => void copy()} aria-label={t("common.copy")}>
        {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
      <Button variant="outline" size="icon" asChild aria-label={t("pf.open")}>
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
  const { t } = useT()
  const { user, setUser } = useAuth()
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
    musicSource: "",
    musicLyrics: "",
    theme: "void",
    accent: "",
    effects: [] as string[],
    intro: "none",
    font: "system",
    cjkFont: "system",
    layout: "center",
    scaleMode: "auto",
    scaleMin: 50,
    scaleManual: 100,
  })
  const [contacts, setContacts] = React.useState<ProfileContact[]>([])
  const [modules, setModules] = React.useState<ProfileModule[]>(() => normalizeModules([]))
  const [published, setPublished] = React.useState(false)

  const [previewHtml, setPreviewHtml] = React.useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  /**
   * 预览视口。
   *
   * 为什么需要它：预览栏固定 440px 宽，**永远触发名片页的窄屏媒体查询**
   * （断点是 640/560px）—— 用户在编辑器里看到的始终是手机版，
   * 到电脑上打开却是另一副样子（bento 变单列、side 变上下堆叠）。
   * 横版模式把 iframe 撑到 1280px 再等比缩回容器里，让他能看到真实的桌面布局。
   */
  const [previewMode, setPreviewMode] = React.useState<"portrait" | "landscape">("portrait")
  const previewBoxRef = React.useRef<HTMLDivElement | null>(null)
  const [previewBox, setPreviewBox] = React.useState({ w: 0, h: 0 })

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
        musicSource: p.musicSource ?? "",
        musicLyrics: p.musicLyrics ?? "",
        theme: p.theme,
        accent: p.accent ?? "",
        effects: p.effects ?? [],
        intro: p.intro ?? "none",
        font: p.font ?? "system",
        cjkFont: p.cjkFont ?? "system",
        layout: p.layout ?? "center",
        scaleMode: p.scaleMode ?? "auto",
        scaleMin: p.scaleMin ?? 50,
        scaleManual: p.scaleManual ?? 100,
      })
      setContacts(p.contacts)
      setModules(normalizeModules(p.modules))
      setPublished(p.published)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pf.err.load"))
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

  // 横版预览要把 1280px 宽的 iframe 等比缩进容器，得先知道容器的真实尺寸。
  // 用 ResizeObserver 而不是一次性测量：预览栏宽度会随窗口/侧边栏变化。
  React.useEffect(() => {
    const el = previewBoxRef.current
    if (!el) return
    const sync = () => setPreviewBox({ w: el.clientWidth, h: el.clientHeight })
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleEnable = async () => {
    setEnabling(true)
    try {
      await profileApi.enable()
      await load()
      toast.success(t("pf.ok.created"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pf.err.create"))
    } finally {
      setEnabling(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await profileApi.update({ ...form, contacts, modules })
      setData((d) => (d ? { ...d, profile: res.profile } : d))
      toast.success(t("pf.ok.saved"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.save"))
    } finally {
      setSaving(false)
    }
  }

  const handleTogglePublish = async (next: boolean) => {
    try {
      await profileApi.publish(next)
      setPublished(next)
      toast.success(next ? t("pf.ok.enabled") : t("pf.ok.disabled"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.op"))
    }
  }

  const handleUpload = async (
    kind: "avatar" | "background" | "music" | "music-cover",
    file: File | undefined
  ) => {
    if (!file) return
    setUploading(kind)
    try {
      if (kind === "avatar") {
        // 头像已统一为账户头像：走 identity 头像接口，与设置页同一份
        await identityApi.uploadAvatar(file)
        if (user) setUser({ ...user, hasAvatar: true })
      } else {
        // 上传音乐前先摘掉「搜索歌曲」。
        // 服务端取用顺序是「搜索歌曲 > 上传文件 > 外链」，库里若还留着来源，
        // 用户会看到「上传成功了，但放出来还是那首歌」这种说不通的故障。
        // 只发这一个字段：后端把 undefined 当「保持不变」，所以不会覆盖
        // 表单里其它还没保存的改动。
        if (kind === "music" && form.musicSource) {
          await profileApi.update({ musicSource: "" })
        }
        await profileApi.uploadAsset(kind, file)
      }
      await load()
      toast.success(t("pf.ok.uploaded"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pf.err.upload"))
    } finally {
      setUploading(null)
    }
  }

  const handleRemoveAsset = async (kind: "avatar" | "background" | "music" | "music-cover") => {
    try {
      if (kind === "avatar") {
        await identityApi.deleteAvatar()
        if (user) setUser({ ...user, hasAvatar: false })
      } else {
        await profileApi.deleteAsset(kind)
      }
      await load()
      toast.success(t("pf.ok.removed"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pf.err.remove"))
    }
  }

  // ---- 音乐搜索 ----

  /**
   * 按歌名搜歌。
   *
   * 搜索结果里**没有播放地址**（音频源给的地址带时效签名，只有服务端能
   * 在播放时实时解析）。这里能落库的只有 `source`（如 `netease:123`）。
   */
  const [musicQuery, setMusicQuery] = React.useState("")
  const [musicResults, setMusicResults] = React.useState<ProfileMusicTrack[]>([])
  const [musicSearching, setMusicSearching] = React.useState(false)

  const handleSearchMusic = async () => {
    const q = musicQuery.trim()
    if (!q) return
    setMusicSearching(true)
    try {
      const res = await profileApi.searchMusic(q)
      setMusicResults(res.tracks)
      // 「没搜到」和「服务挂了」要给不同提示：前者换关键词，后者改用上传/外链
      if (res.tracks.length === 0) {
        toast.info(t("pf.music.notFound"))
      }
    } catch (err) {
      setMusicResults([])
      toast.error(err instanceof HttpError ? err.message : t("pf.err.search"))
    } finally {
      setMusicSearching(false)
    }
  }

  /**
   * 选中一首歌。只填表单，**不删**用户原有的上传文件和外链 ——
   * 服务端按「搜索歌曲 > 上传 > 外链」取用，清掉 `musicSource` 就能回到原来那首。
   */
  const pickMusicTrack = async (track: ProfileMusicTrack) => {
    setForm((f) => ({
      ...f,
      musicSource: track.source,
      // 标题带上歌手：名片上「歌名 - 歌手」比光有歌名清楚得多
      musicTitle: track.artist ? `${track.title} - ${track.artist}` : track.title,
      // 搜索结果的封面是长期有效的地址，可以直接存
      musicCoverUrl: track.cover ?? "",
    }))
    setMusicResults([])
    setMusicQuery("")

    // 歌词单独取：歌词库与音频源是两套曲库，要靠「歌名+歌手」去对。
    // 取不到就留空（用户可手填），绝不因为它失败而取消选歌。
    try {
      const res = await profileApi.fetchLyrics(track.title, track.artist)
      if (res.lyrics) {
        setForm((f) => ({ ...f, musicLyrics: res.lyrics as string }))
        toast.success(t("pf.music.pickedWithLyrics"))
      } else {
        toast.success(t("pf.music.pickedNoLyrics"))
      }
    } catch {
      toast.success(t("pf.music.pickedNoLyrics"))
    }
  }

  /** 清除搜索选择：播放源回到用户自己上传/粘贴的音频（不会被删除） */
  const clearMusicSource = () => {
    setForm((f) => ({ ...f, musicSource: "" }))
    toast.success(t("pf.music.backToCustom"))
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
        <PageHeader title={t("pf.title")} description={t("pf.subtitle")} />
        <LoadingBlock />
      </div>
    )
  }

  // 未开通：照搬网盘/中转站的做法，先显示引导页，点击开通后才进入编辑界面
  if (!data?.enabled || !data.profile) {
    return (
      <div>
        <PageHeader title={t("pf.title")} description={t("pf.subtitle")} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Contact className="h-4 w-4 text-muted-foreground" />
              {t("pf.intro.title")}
            </CardTitle>
            <CardDescription>
              {t("pf.intro.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>{t("pf.intro.b1", { origin: window.location.origin })}</li>
              <li>{t("pf.intro.b2")}</li>
              <li>{t("pf.intro.b3")}</li>
              <li>{t("pf.intro.b4")}</li>
              <li>{t("pf.intro.b5")}</li>
            </ul>
            <Button onClick={() => void handleEnable()} disabled={enabling}>
              {enabling && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("pf.intro.cta")}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const limits = data?.limits

  /** 横版预览模拟的视口宽度：1280px（名片内容最宽 820px，足够触发全部桌面断点） */
  const LANDSCAPE_WIDTH = 1280
  // 容器还没测出宽度时按 440px（预览栏的固定宽度）估一个，避免首帧闪成满尺寸
  const previewScale = Math.min(1, (previewBox.w || 440) / LANDSCAPE_WIDTH)
  // iframe 高度要除以缩放比，缩放后视觉高度才等于容器高度
  const previewFrameH = previewBox.h > 0 ? previewBox.h / previewScale : 520 / previewScale

  return (
    <div>
      <PageHeader
        title={t("pf.title")}
        description={t("pf.editorDesc")}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => void load()} aria-label={t("common.refresh")}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
        {/* 左：设置 */}
        <div className="min-w-0">
          <Tabs defaultValue="basic">
            <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
              <TabsTrigger value="basic">{t("pf.tab.basic")}</TabsTrigger>
              <TabsTrigger value="appearance">{t("pf.tab.appearance")}</TabsTrigger>
              <TabsTrigger value="modules">{t("pf.tab.modules")}</TabsTrigger>
              <TabsTrigger value="contacts">{t("pf.tab.contacts")}</TabsTrigger>
              <TabsTrigger value="music">{t("pf.tab.music")}</TabsTrigger>
              <TabsTrigger value="publish">{t("pf.tab.publish")}</TabsTrigger>
            </TabsList>

            {/* ============ 资料 ============ */}
            <TabsContent value="basic" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("pf.basic.title")}</CardTitle>
                  <CardDescription>{t("pf.basic.desc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="displayName">{t("settings.label.nickname")}</Label>
                    <Input
                      id="displayName"
                      placeholder={t("pf.basic.namePh")}
                      value={form.displayName}
                      onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bio">{t("pf.basic.bio")}</Label>
                    <Textarea
                      id="bio"
                      placeholder={t("pf.basic.bioPh")}
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
                  <CardTitle className="text-base">{t("pf.status.title")}</CardTitle>
                  <CardDescription>{t("pf.status.desc")}</CardDescription>
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
                  <CardTitle className="text-base">{t("pf.theme.title")}</CardTitle>
                  <CardDescription>{t("pf.theme.desc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                    {(data?.themes ?? []).map((theme) => (
                      <button
                        key={theme}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, theme }))}
                        className={cn(
                          "relative rounded-lg border-2 p-1.5 transition-all",
                          form.theme === theme
                            ? "border-primary ring-2 ring-primary/20"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <ThemeThumbnail theme={theme} accent={form.accent} />
                        <span className="mt-1 block text-center text-xs font-medium">
                          {THEME_LABEL[theme] ? t(THEME_LABEL[theme]) : theme}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="accent">{t("pf.theme.accent")}</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={/^#[0-9a-f]{6}$/i.test(form.accent) ? form.accent : "#6366f1"}
                        onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))}
                        className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
                        aria-label={t("pf.theme.accentAria")}
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
                          {t("si.clear")}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("pf.layout.title")}</CardTitle>
                  <CardDescription>{t("pf.layout.desc")}</CardDescription>
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
                  <CardTitle className="text-base">{t("pf.scale.title")}</CardTitle>
                  <CardDescription>
                    {t("pf.scale.desc")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(data?.scaleModeOptions ?? []).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, scaleMode: opt.id }))}
                        className={cn(
                          "rounded-lg border p-3 text-left transition-all",
                          form.scaleMode === opt.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <div className="text-sm font-medium">{opt.label}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</div>
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="scaleManual">
                        {form.scaleMode === "auto" ? t("pf.scale.start") : t("pf.scale.display")}
                      </Label>
                      <span className="font-mono text-sm text-muted-foreground">
                        {form.scaleManual}%
                      </span>
                    </div>
                    <input
                      id="scaleManual"
                      type="range"
                      min={data?.scaleManualRange.min ?? 50}
                      max={data?.scaleManualRange.max ?? 150}
                      step={5}
                      value={form.scaleManual}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, scaleManual: Number(e.target.value) }))
                      }
                      className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    />
                    <p className="text-xs text-muted-foreground">
                      {form.scaleMode === "auto"
                        ? t("pf.scale.autoHint")
                        : t("pf.scale.fixedHint")}
                    </p>
                  </div>

                  {form.scaleMode === "auto" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="scaleMin">{t("pf.scale.min")}</Label>
                        <span className="font-mono text-sm text-muted-foreground">
                          {form.scaleMin}%
                        </span>
                      </div>
                      <input
                        id="scaleMin"
                        type="range"
                        min={data?.scaleMinRange.min ?? 30}
                        max={data?.scaleMinRange.max ?? 100}
                        step={5}
                        value={form.scaleMin}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, scaleMin: Number(e.target.value) }))
                        }
                        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("pf.scale.minHint")}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("pf.font.title")}</CardTitle>
                  <CardDescription>{t("pf.font.desc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>{t("pf.font.heading")}</Label>
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
                    <Label>{t("pf.font.body")}</Label>
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
                  <CardTitle className="text-base">{t("pf.media.title")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {/* 头像 */}
                    <div className="space-y-2">
                      <Label>{t("pf.media.avatar")}</Label>
                      <div className="flex items-center gap-3">
                        {user?.hasAvatar ? (
                          <img
                            src={`/u/${encodeURIComponent(user.username)}/avatar`}
                            alt={t("pf.media.avatar")}
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
                            {t("pf.upload")}
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp,image/gif"
                              className="hidden"
                              onChange={(e) => void handleUpload("avatar", e.target.files?.[0])}
                            />
                          </label>
                          {user?.hasAvatar && (
                            <button
                              type="button"
                              className="text-left text-xs text-muted-foreground hover:text-destructive"
                              onClick={() => void handleRemoveAsset("avatar")}
                            >
                              {t("pf.removeUploaded")}
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("pf.media.avatarIsAccount")}
                      </p>
                      {limits && (
                        <p className="text-xs text-muted-foreground">
                          {t("pf.media.avatarLimit", { size: formatBytes(limits.avatar) })}
                        </p>
                      )}
                    </div>

                    {/* 背景图 */}
                    <div className="space-y-2">
                      <Label>{t("pf.media.background")}</Label>
                      <div className="flex items-center gap-3">
                        {profile?.backgroundKey || form.backgroundUrl ? (
                          <img
                            src={
                              profile?.backgroundKey
                                ? `/api/profile/asset?kind=background`
                                : form.backgroundUrl
                            }
                            alt={t("pf.media.background")}
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
                            {t("pf.upload")}
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
                              {t("pf.removeUploaded")}
                            </button>
                          )}
                        </div>
                      </div>
                      <Input
                        placeholder={t("pf.media.pasteLink")}
                        value={form.backgroundUrl}
                        onChange={(e) => setForm((f) => ({ ...f, backgroundUrl: e.target.value }))}
                        className="text-xs"
                      />
                      {limits && (
                        <p className="text-xs text-muted-foreground">
                          {t("pf.media.bgLimit", { size: formatBytes(limits.background) })}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("pf.fx.title")}</CardTitle>
                  <CardDescription>
                    {t("pf.fx.desc")}
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
                    <Label>{t("pf.fx.splash")}</Label>
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
                {t("pf.modules.desc")}
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
                                aria-label={t("ip.moveUp")}
                              >
                                <ChevronUp className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                                onClick={() => moveModule(idx, 1)}
                                disabled={idx === modules.length - 2}
                                aria-label={t("ip.moveDown")}
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
                        {/* 宽度只在桌面端（≥641px）生效，且只对中间区模块有意义：
                            identity/status 在头部、stats 在页脚，位置固定，宽度管不着。 */}
                        {isMiddle && (
                          <Select
                            value={m.size ?? "auto"}
                            onValueChange={(v) =>
                              updateModule(m.id, {
                                size: v === "auto" ? undefined : (v as "half" | "full"),
                              })
                            }
                          >
                            <SelectTrigger className="w-[92px]" aria-label={t("pf.modules.width")}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(data?.moduleSizeOptions ?? []).map((o) => (
                                <SelectItem key={o.id} value={o.id}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
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
                      <CardTitle className="text-base">{t("pf.contacts.title")}</CardTitle>
                      <CardDescription>
                        {t("pf.contacts.desc")}
                      </CardDescription>
                    </div>
                    <Button size="sm" variant="outline" onClick={addContact}>
                      <Plus className="h-4 w-4" />
                      {t("common.add")}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {contacts.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      {t("pf.contacts.empty")}
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
                              {(data?.contactTypes ?? []).map((ct) => (
                                <SelectItem key={ct} value={ct}>
                                  {CONTACT_META[ct]?.label ? t(CONTACT_META[ct].label) : ct}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            placeholder={CONTACT_META[c.type]?.placeholder ? t(CONTACT_META[c.type].placeholder!) : undefined}
                            value={c.value}
                            onChange={(e) => updateContact(i, { value: e.target.value })}
                            className="flex-1"
                          />
                          <Input
                            placeholder={c.type === "qq" ? t("pf.contacts.labelPhQq") : t("pf.contacts.labelPh")}
                            value={c.label ?? ""}
                            onChange={(e) => updateContact(i, { label: e.target.value })}
                            className="w-36"
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
                            aria-label={t("common.delete")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        {CONTACT_META[c.type]?.hint && (
                          <p className="text-xs text-muted-foreground">{t(CONTACT_META[c.type].hint!)}</p>
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
                    {t("pf.music.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("pf.music.desc")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* ---- 搜索歌曲 ---- */}
                  <div className="space-y-2">
                    <Label htmlFor="musicQuery">{t("pf.music.search")}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="musicQuery"
                        placeholder={t("pf.music.searchPh")}
                        value={musicQuery}
                        onChange={(e) => setMusicQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            void handleSearchMusic()
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={musicSearching || !musicQuery.trim()}
                        onClick={() => void handleSearchMusic()}
                      >
                        {musicSearching ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Search className="h-4 w-4" />
                        )}
                        {t("pf.music.searchBtn")}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("pf.music.note")}
                    </p>
                  </div>

                  {musicResults.length > 0 && (
                    <ul className="divide-y overflow-hidden rounded-md border">
                      {musicResults.map((track) => (
                        <li key={track.source}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 p-2 text-left hover:bg-accent"
                            onClick={() => void pickMusicTrack(track)}
                          >
                            {track.cover ? (
                              <img
                                src={track.cover}
                                alt=""
                                className="h-10 w-10 shrink-0 rounded border object-cover"
                              />
                            ) : (
                              <div className="h-10 w-10 shrink-0 rounded border bg-muted" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{track.title}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {track.artist}
                                {track.album ? ` · ${track.album}` : ""}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {form.musicSource ? (
                    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {t("pf.music.usingSearch")}
                        {form.musicTitle ? `：${form.musicTitle}` : ""}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0"
                        onClick={clearMusicSource}
                      >
                        {t("pf.music.backCustom")}
                      </Button>
                    </div>
                  ) : null}

                  <div className="flex items-center gap-3 border-t pt-4">
                    <span className="text-sm font-medium">{t("pf.music.custom")}</span>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-accent">
                      {uploading === "music" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      {t("pf.music.upload")}
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
                        {t("pf.removeUploaded")}
                      </button>
                    )}
                    {limits && (
                      <span className="text-xs text-muted-foreground">
                        {t("pf.music.limit", { size: formatBytes(limits.music) })}
                      </span>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="musicUrl">{t("pf.music.urlLabel")}</Label>
                    <Input
                      id="musicUrl"
                      placeholder="https://…/song.mp3"
                      value={form.musicUrl}
                      onChange={(e) => setForm((f) => ({ ...f, musicUrl: e.target.value }))}
                      className="text-xs"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="musicTitle">{t("pf.music.titleLabel")}</Label>
                    <Input
                      id="musicTitle"
                      placeholder={t("pf.music.titlePh")}
                      value={form.musicTitle}
                      onChange={(e) => setForm((f) => ({ ...f, musicTitle: e.target.value }))}
                    />
                  </div>

                  {/* 专辑封面 */}
                  <div className="space-y-2">
                    <Label>{t("pf.music.cover")}</Label>
                    <div className="flex items-center gap-3">
                      {profile?.musicCoverKey || form.musicCoverUrl ? (
                        <img
                          src={
                            profile?.musicCoverKey
                              ? `/api/profile/asset?kind=music-cover`
                              : form.musicCoverUrl
                          }
                          alt={t("pf.music.cover")}
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
                          {t("pf.music.uploadCover")}
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
                            {t("pf.removeUploaded")}
                          </button>
                        )}
                      </div>
                    </div>
                    <Input
                      placeholder={t("pf.music.coverPh")}
                      value={form.musicCoverUrl}
                      onChange={(e) => setForm((f) => ({ ...f, musicCoverUrl: e.target.value }))}
                      className="text-xs"
                    />
                  </div>

                  {/* 歌词：搜索选中时会自动填好，也可以手写或整个删掉 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="musicLyrics">{t("pf.music.lyrics")}</Label>
                      {form.musicLyrics ? (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-destructive"
                          onClick={() => setForm((f) => ({ ...f, musicLyrics: "" }))}
                        >
                          {t("pf.music.clearLyrics")}
                        </button>
                      ) : null}
                    </div>
                    <Textarea
                      id="musicLyrics"
                      rows={6}
                      className="font-mono text-xs"
                      placeholder={t("pf.music.lyricsPh")}
                      value={form.musicLyrics}
                      onChange={(e) => setForm((f) => ({ ...f, musicLyrics: e.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("pf.music.lyricsHint")}
                    </p>
                  </div>

                  <div className="flex items-center justify-between rounded-md border px-4 py-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("pf.music.autoplay")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("pf.music.autoplayHint")}
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
                        {t("pf.publish.title")}
                      </CardTitle>
                      <CardDescription>
                        {published
                          ? t("pf.publish.on")
                          : t("pf.publish.off")}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant={published ? "success" : "secondary"}>
                        {published ? t("pf.publish.enabled") : t("pf.publish.disabled")}
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
                    <Label>{t("pf.publish.defaultUrl")}</Label>
                    <AddressRow url={defaultUrl} />
                  </div>

                  <div className="space-y-2">
                    <Label>{t("pf.publish.customDomain")}</Label>
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
                              toast.success(t("pf.ok.unbound"))
                            } catch (err) {
                              toast.error(err instanceof HttpError ? err.message : t("pf.err.unbind"))
                            }
                          }}
                        >
                          {t("pf.publish.unbind")}
                        </button>
                      </>
                    ) : (data?.availableSubdomains.length ?? 0) === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("pf.publish.noSubdomain")}
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
                                  res.dnsCreated ? t("pf.publish.boundDns") : t("pf.publish.bound")
                                )
                              } catch (err) {
                                toast.error(err instanceof HttpError ? err.message : t("pf.err.bind"))
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
                        {t("pf.publish.rootBound", { fqdn: profile?.fqdn ?? "" })}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("pf.publish.rootWarn")}
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
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Eye className="h-4 w-4 text-muted-foreground" />
                {t("pf.preview.title")}
                {previewLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-md border p-0.5">
                  <Button
                    variant={previewMode === "portrait" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setPreviewMode("portrait")}
                  >
                    {t("pf.preview.portrait")}
                  </Button>
                  <Button
                    variant={previewMode === "landscape" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setPreviewMode("landscape")}
                  >
                    {t("pf.preview.landscape")}
                  </Button>
                </div>
                {published && (
                  <Button variant="ghost" size="sm" asChild>
                    <a href={defaultUrl} target="_blank" rel="noopener noreferrer">
                      {t("pf.preview.open")}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            </div>
            <div
              ref={previewBoxRef}
              className="relative h-[70vh] min-h-[520px] overflow-hidden rounded-xl border bg-neutral-950 shadow-sm"
            >
              {previewHtml ? (
                previewMode === "portrait" ? (
                  <iframe
                    title={t("pf.preview.cardTitle")}
                    sandbox="allow-scripts allow-popups"
                    srcDoc={previewHtml}
                    className="h-full w-full border-0"
                  />
                ) : (
                  /* 横版：iframe 内部按 1280px 布局（触发桌面断点），再整体缩进容器里。
                     外层 overflow-hidden 负责裁掉缩放后溢出的部分。 */
                  <iframe
                    title={t("pf.preview.cardTitleLandscape")}
                    sandbox="allow-scripts allow-popups"
                    srcDoc={previewHtml}
                    style={{
                      width: LANDSCAPE_WIDTH,
                      height: previewFrameH,
                      transform: `scale(${previewScale})`,
                      transformOrigin: "top left",
                    }}
                    className="border-0"
                  />
                )
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {previewMode === "portrait"
                ? t("pf.preview.hintPortrait")
                : t("pf.preview.hintLandscape", { w: LANDSCAPE_WIDTH })}
              {" "}{t("pf.preview.note")}
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
  const { t } = useT()
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
        placeholder={t("pf.status.ph")}
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
  const { t } = useT()
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
          placeholder={t("pf.tags.ph")}
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
          {t("common.add")}
        </Button>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
            >
              {tag}
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onChange({ items: tags.filter((_, idx) => idx !== i) })}
                aria-label={t("pf.tags.remove")}
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
  const { t } = useT()
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
            placeholder={t("pf.timeline.time")}
            value={it.date}
            onChange={(e) => setItem(i, { date: e.target.value })}
            className="w-24 shrink-0 text-xs"
            maxLength={20}
          />
          <div className="flex-1 space-y-1.5">
            <Input
              placeholder={t("pf.timeline.titlePh")}
              value={it.title}
              onChange={(e) => setItem(i, { title: e.target.value })}
              maxLength={30}
            />
            <Input
              placeholder={t("pf.timeline.descPh")}
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
            aria-label={t("common.delete")}
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
          {t("pf.timeline.add")}
        </Button>
      )}
    </div>
  )
}

/**
 * 编辑器里图片墙缩略图的地址。
 *
 * ⚠️ 2026-09-25 审计（L10）：`/p/<用户名>/gallery/<id>` 现在对**未发布**的
 * 名片只放行本人（否则草稿内容其实是公开可读的）。但那个路由是公开路由、
 * 拿不到会话，所以编辑器预览必须改走带会话的
 * `/api/profile/asset?kind=gallery&id=<id>`（服务端按当前登录用户解析目录）。
 * 存储的值仍然是公开 URL，发布后公开页照常可读。
 */
function galleryPreviewSrc(url: string): string {
  const m = /^\/p\/[^/]+\/gallery\/([a-z0-9-]+)$/i.exec(url)
  return m ? `/api/profile/asset?kind=gallery&id=${m[1]}` : url
}

function GalleryEditor({
  module,
  onChange,
}: {
  module: ProfileModule
  onChange: (patch: Partial<ProfileModule>) => void
}) {
  const { t } = useT()
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
        toast.success(t("pf.ok.uploadedN", { n: added.length }))
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pf.err.upload"))
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
        {t("pf.gallery.desc")}
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
              src={galleryPreviewSrc(it.url)}
              alt=""
              className="h-10 w-10 shrink-0 rounded border object-cover"
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden"
              }}
            />
          )}
          <Input
            placeholder={t("pf.gallery.urlPh")}
            value={it.url}
            onChange={(e) => setItem(i, { url: e.target.value })}
            className="flex-1 font-mono text-xs"
            maxLength={1000}
          />
          <Input
            placeholder={t("pf.gallery.captionPh")}
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
            aria-label={t("common.delete")}
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
            {busy ? t("pf.uploading") : t("pf.gallery.upload")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange({ items: [...items, { url: "", caption: "" }] })}
          >
            <Plus className="h-4 w-4" />
            {t("pf.gallery.pasteLink")}
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
  const { t } = useT()
  switch (module.id) {
    case "status":
      return <StatusEditor module={module} onChange={onChange} />
    case "tags":
      return <TagsEditor module={module} onChange={onChange} />
    case "quote":
      return (
        <div className="space-y-2">
          <Textarea
            placeholder={t("pf.quote.quotePh")}
            value={module.text ?? ""}
            onChange={(e) => onChange({ text: e.target.value })}
            rows={4}
            className="resize-y"
            maxLength={200}
          />
          <Input
            placeholder={t("pf.quote.authorPh")}
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
