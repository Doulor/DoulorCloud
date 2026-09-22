import * as React from "react"
import {
  Check,
  Contact,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Music,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  UserRound,
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
import { profileApi, HttpError } from "@/services/api"
import type { ContactType, ProfileContact, ProfileOverview } from "@/types"

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
  bilibili: { label: "Bilibili", placeholder: "1307574205", hint: "只填 UID" },
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
  minimal: "极简",
  gradient: "渐变",
  glass: "毛玻璃",
  terminal: "终端",
  card: "卡片",
  dark: "暗夜",
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
    theme: "minimal",
    accent: "",
  })
  const [contacts, setContacts] = React.useState<ProfileContact[]>([])
  const [published, setPublished] = React.useState(false)

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
        theme: p.theme,
        accent: p.accent ?? "",
      })
      setContacts(p.contacts)
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
  // 默认地址：始终存在（服务端算好的 profilePath），与是否绑自定义域无关
  const defaultUrl = `${window.location.origin}${profile?.profilePath ?? ""}`
  // 自定义域名地址（未绑定时为 null）
  const customUrl = profile?.fqdn ? `https://${profile.fqdn}` : null

  // 误绑根域的保护提示：根域是整站入口，绑给名片会让站点打不开
  const boundToRootDomain =
    !!profile?.fqdn && profile.fqdn === window.location.hostname.replace(/^cloud\./, "")

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
      const res = await profileApi.update({ ...form, contacts })
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
    kind: "avatar" | "background" | "music",
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

  const handleRemoveAsset = async (kind: "avatar" | "background" | "music") => {
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
              开通后你会得到一个对外展示的个人主页，可放头像、签名、各种联系方式，
              也可以绑定自己的子域名。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>· 默认地址：{window.location.origin}/profile/&lt;你的用户名&gt;</li>
              <li>· 支持 QQ、Bilibili、Telegram、GitHub、邮箱等，填写原始值即可自动生成链接</li>
              <li>· 可上传头像、背景图片与背景音乐</li>
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
        description="一个对外展示的个人主页，可绑定自己的子域名。"
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

      {/* 启用开关 + 分享链接 */}
      <Card className="mb-6">
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
              <Switch checked={published} onCheckedChange={(v) => void handleTogglePublish(v)} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 默认地址：始终显示（不受是否绑定自定义域影响） */}
          <div className="space-y-2">
            <Label>默认地址</Label>
            <AddressRow url={defaultUrl} />
          </div>

          {/* 自定义域名：绑定后额外显示一行，两者并存 */}
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

      {/* 基本资料 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">基本资料</CardTitle>
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
            <Input
              id="bio"
              placeholder="一句话介绍自己"
              value={form.bio}
              onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      {/* 外观 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">外观</CardTitle>
          <CardDescription>头像、背景图与主题风格</CardDescription>
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
                      profile?.avatarKey
                        ? `/api/profile/asset?kind=avatar`
                        : form.avatarUrl
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

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>主题风格</Label>
              <Select
                value={form.theme}
                onValueChange={(v) => setForm((f) => ({ ...f, theme: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(data?.themes ?? []).map((t) => (
                    <SelectItem key={t} value={t}>
                      {THEME_LABEL[t] ?? t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="accent">主题色（可选）</Label>
              <Input
                id="accent"
                placeholder="#6366f1"
                value={form.accent}
                onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 背景音乐 */}
      <Card className="mb-6">
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

      {/* 联系方式 */}
      <Card className="mb-6">
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

    </div>
  )
}