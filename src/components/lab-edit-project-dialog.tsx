/**
 * 「编辑作品信息」弹窗 —— 造物集作品对外展示的那一屏。
 *
 * 内容：封面图（16:9，本地先压到 600KB 内再传）+ 自定义链接（slug）+ 子域名绑定
 * + 名称 + 图标 emoji + 简介 + 取消/保存。
 *
 * ⚠️ 为什么把动作抽成 `actions` 注入，而不是在这里直接调 `labApi.*`：
 *    同一屏 UI 有两个操作者 ——
 *      · **作者本人**走 `/api/lab/projects/*`（后端按 `user_id` 校验归属）；
 *      · **管理员**（造物集管理台）改别人的作品，走 `/api/admin/lab/gallery/*`
 *        （后端按 `requireAdminScope(...,"lab")` 鉴权）。
 *    把接口硬编码进来的话，管理员点保存会拿到 403；而复制一份 UI 又必然漂移
 *    （改了一处忘另一处）。所以：**UI 一份，动作两组**。作者侧与管理员侧各自
 *    在调用点定义 adapter（见 `pages/gallery.tsx` 的 AUTHOR_EDIT_ACTIONS 与
 *    `components/admin-gallery-tab.tsx` 的 ADMIN_EDIT_ACTIONS）。
 *
 * 保存走的是 publish / meta 接口而不是 saveProject：后者是「保存代码」，
 * 会把文件一并提交；这里只是改对外展示的字段，不该碰代码。
 *
 * ⚠️ 保存时**不传 `visibility`** —— 只改介绍信息，可见性原样不动。
 * 否则编辑一个「待审核」作品的名字会顺手把它的公开申请撤掉。
 *
 * 封面是**即时上传**（选好图就传，不必等保存）：这样用户马上能看到效果，
 * 而且不必等整个表单校验通过。图片在本地先压到 600KB 以内再传。
 */
import * as React from "react"
import { ImagePlus, Loader2, Sparkles, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useT } from "@/i18n"
import { errMsg, galleryCoverUrl, type LabProjectSummary } from "@/services/api"
import { compressToLimit } from "@/lib/image-compress"

/** 封面图允许的 MIME（与后端 COVER_TYPES 一致） */
const COVER_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
/** 封面大小上限（与后端 COVER_MAX_BYTES 一致，前端先压到这个数以内） */
const COVER_MAX_BYTES = 600 * 1024

/**
 * 操作者要提供的七个动作。
 *
 * 全部是 async：它们的失败原因要**原样透给用户**（撞 slug 的 409、域名不在
 * 自己名下、封面超限……），所以这里不吞异常、也不做二次包装。
 */
export interface EditProjectActions {
  /** 当前绑定的域名（没绑回 null） */
  getDomain: (projectId: string) => Promise<string | null>
  /** 绑定 / 改绑，返回最终生效的 fqdn */
  setDomain: (projectId: string, fqdn: string) => Promise<string>
  /** 解绑 */
  clearDomain: (projectId: string) => Promise<void>
  /** 保存对外信息（名字 / 简介 / 图标），返回更新后的摘要 */
  saveMeta: (
    projectId: string,
    meta: { name: string; description: string; icon: string }
  ) => Promise<LabProjectSummary>
  /** 改页面名（撞名时服务端 409，消息原样给用户看，不要静默加后缀） */
  setSlug: (projectId: string, slug: string) => Promise<void>
  uploadCover: (projectId: string, blob: Blob) => Promise<void>
  deleteCover: (projectId: string) => Promise<void>
}

export function EditProjectDialog({
  project,
  actions,
  onCancel,
  onSaved,
}: {
  project: LabProjectSummary
  actions: EditProjectActions
  onCancel: () => void
  onSaved: (p: LabProjectSummary) => void
}) {
  const { t } = useT()
  const [name, setName] = React.useState(project.name)
  const [description, setDescription] = React.useState(project.description ?? "")
  const [icon, setIcon] = React.useState(project.icon ?? "")
  /** 自定义链接名（分享链接尾部）；留空 = 用自动生成的那个 */
  const [slug, setSlug] = React.useState(project.slug ?? "")
  const [saving, setSaving] = React.useState(false)

  /**
   * 🔴 绑定域名（2026-10-12 从 AI 实验室「我的作品」搬到造物集 —— 站长要求）。
   * 打开编辑框时拉当前绑定；绑定/解绑调注入的 actions（作者与管理员的接口不同）。
   */
  const [domain, setDomain] = React.useState<string | null>(null)
  const [domainLoaded, setDomainLoaded] = React.useState(false)
  const [domainDraft, setDomainDraft] = React.useState("")
  const [domainBusy, setDomainBusy] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    actions
      .getDomain(project.id)
      .then((fqdn) => {
        if (cancelled) return
        setDomain(fqdn)
        setDomainLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setDomainLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // actions 由调用点定义（模块级常量），不随渲染变化；只跟着作品 id 重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const bindDomain = async () => {
    const fqdn = domainDraft.trim().toLowerCase()
    if (!fqdn) return
    setDomainBusy(true)
    try {
      const bound = await actions.setDomain(project.id, fqdn)
      setDomain(bound)
      setDomainDraft("")
      toast.success(t("gal.domain.bound", { d: bound }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("gal.domain.bindFailed"))
    } finally {
      setDomainBusy(false)
    }
  }

  const unbindDomain = async () => {
    setDomainBusy(true)
    try {
      await actions.clearDomain(project.id)
      setDomain(null)
      toast.success(t("gal.domain.unbound"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("gal.domain.bindFailed"))
    } finally {
      setDomainBusy(false)
    }
  }

  const [hasCover, setHasCover] = React.useState(!!project.hasCover)
  /** 换图后用它当查询串，绕开封面接口那 5 分钟的缓存 */
  const [coverStamp, setCoverStamp] = React.useState(0)
  const [coverBusy, setCoverBusy] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement | null>(null)

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error(t("gal.nameRequired"))
      return
    }
    setSaving(true)
    try {
      const updated = await actions.saveMeta(project.id, {
        name: trimmed,
        description: description.trim(),
        icon: icon.trim(),
      })
      // 页面名单独一个接口：撞名（409）时把服务端的话原样抛给用户，不要静默加后缀
      const wanted = slug.trim()
      if (wanted && wanted !== project.slug) {
        await actions.setSlug(project.id, wanted)
      }
      onSaved({ ...(updated as LabProjectSummary), hasCover, slug: wanted || project.slug })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("gal.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  const pickCover = async (file: File | undefined | null) => {
    if (!file) return
    if (!COVER_TYPES.includes(file.type)) {
      toast.error(t("gal.coverType"))
      return
    }
    setCoverBusy(true)
    try {
      // 先压到后端上限以内：直传原图会被 600KB 的硬闸拒掉
      const out = await compressToLimit(file, COVER_MAX_BYTES)
      if (!out) {
        toast.error(t("gal.coverTooLarge"))
        return
      }
      await actions.uploadCover(project.id, out)
      setHasCover(true)
      setCoverStamp(Date.now())
      toast.success(t("gal.coverSaved"))
    } catch (err) {
      toast.error(errMsg(err, t("gal.coverFailed")))
    } finally {
      setCoverBusy(false)
      // 清掉 input 的值，否则连续选同一张图不会再触发 change
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const removeCover = async () => {
    setCoverBusy(true)
    try {
      await actions.deleteCover(project.id)
      setHasCover(false)
      setCoverStamp(Date.now())
      toast.success(t("gal.coverRemoved"))
    } catch (err) {
      toast.error(errMsg(err, t("gal.coverFailed")))
    } finally {
      setCoverBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t("gal.editTitle")}</h2>
            <Button variant="ghost" size="icon" onClick={onCancel} aria-label={t("common.close")}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* ---- 封面 ---- */}
          <div className="space-y-1.5">
            <Label>{t("gal.cover")}</Label>
            <div className="flex items-center gap-3">
              <span className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/40">
                {hasCover ? (
                  <img
                    src={`${galleryCoverUrl(project.id)}${coverStamp ? `?t=${coverStamp}` : ""}`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : icon.trim() ? (
                  <span className="text-2xl leading-none">{icon}</span>
                ) : (
                  <Sparkles className="h-5 w-5 text-muted-foreground" />
                )}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept={COVER_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => void pickCover(e.target.files?.[0])}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={coverBusy}
                  onClick={() => fileRef.current?.click()}
                >
                  {coverBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  {hasCover ? t("gal.coverReplace") : t("gal.coverUpload")}
                </Button>
                {hasCover && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={coverBusy}
                    onClick={() => void removeCover()}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("common.delete")}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("gal.coverHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gal-slug">{t("gal.slug")}</Label>
            <Input
              id="gal-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              maxLength={40}
              placeholder="starwar"
            />
            <p className="text-[11px] text-muted-foreground">
              {t("gal.slugHint").replace("{u}", slug.trim() ? `tyu.me/${slug.trim()}` : "tyu.me/…")}
            </p>
          </div>

          {/* ---- 绑定域名（2026-10-12 站长要求：从 AI 实验室搬来造物集）---- */}
          <div className="space-y-1.5">
            <Label htmlFor="gal-domain">{t("gal.domain.label")}</Label>
            {domainLoaded && domain ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("gal.domain.current")}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{domain}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={domainBusy}
                  onClick={() => void unbindDomain()}
                >
                  {t("gal.domain.unbind")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  id="gal-domain"
                  value={domainDraft}
                  onChange={(e) => setDomainDraft(e.target.value)}
                  placeholder={t("gal.domain.placeholder")}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={domainBusy || !domainDraft.trim()}
                  onClick={() => void bindDomain()}
                >
                  {t("gal.domain.confirm")}
                </Button>
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("gal.domain.hint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gal-name">{t("gal.name")}</Label>
            <Input
              id="gal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gal-icon">{t("gal.iconField")}</Label>
            <Input
              id="gal-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={8}
              placeholder="🌤"
            />
            <p className="text-[11px] text-muted-foreground">{t("gal.iconHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gal-desc">{t("gal.descField")}</Label>
            <Textarea
              id="gal-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
