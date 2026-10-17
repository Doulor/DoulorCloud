/**
 * 管理面板「造物集」板块（2026-10-17 站长要求）。
 *
 * 原来造物集相关的东西散在「AI 实验室」里（置顶、审核队列），
 * 站长要的是**一个独立的选项卡**，而且能像作者一样直接管任何作品：
 *   · 置顶管理（置顶的作品在大厅里永远排最前）；
 *   · 作品列表：全部作品（含私有 / 待审 / 已驳回），可搜索、可按状态筛选、服务端分页；
 *   · 每行：打开 / 预览、编辑（**复用作者那一屏同一个弹窗**）、直接改状态、置顶、删除；
 *   · 作品审核队列（待放行 / 已驳回）：从「AI 实验室」整块搬过来，操作台与它处理的对象放在一起。
 *
 * 🔴 后端是**另一组接口**（`/admin/lab/gallery/*`，要求 `lab` 权限），
 *    不是拿管理员的 cookie 去打用户侧 `/lab/projects/*` —— 那组按作者身份鉴权，
 *    改别人作品必然 403。编辑弹窗通过 `actions` 注入这组接口，UI 与作者侧完全同一份
 *    （见 `components/lab-edit-project-dialog.tsx`）。
 *
 * ⚠️ 预览一律塞进 `sandbox`（**不带 allow-same-origin**）的 iframe 里渲染：
 *    待审 / 私有作品同样可能是任意脚本，管理员也是用户。
 */
import * as React from "react"
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  Loader2,
  Pencil,
  Pin,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { confirmDialog, promptDialog } from "@/components/confirm-dialog"
import { EditProjectDialog, type EditProjectActions } from "@/components/lab-edit-project-dialog"
import { UserAvatar } from "@/components/user-avatar"
import { useT } from "@/i18n"
import { buildPreviewDoc, PREVIEW_SHELL_ORIGIN } from "@/lib/lab-agent"
import {
  adminApi,
  errMsg,
  galleryCoverUrl,
  type AdminGalleryProject,
  type AdminLabReview,
} from "@/services/api"
import { cn } from "@/lib/utils"

/** 状态筛选："" = 全部 */
type StatusFilter = "" | "public" | "private" | "pending" | "rejected"

const STATUS_FILTERS: { key: StatusFilter; label: string; countKey: keyof Counts }[] = [
  { key: "", label: "adm.gal.filterAll", countKey: "all" },
  { key: "public", label: "gal.public", countKey: "public" },
  { key: "private", label: "gal.private", countKey: "private" },
  { key: "pending", label: "gal.pending", countKey: "pending" },
  { key: "rejected", label: "gal.rejected", countKey: "rejected" },
]

interface Counts {
  all: number
  public: number
  private: number
  pending: number
  rejected: number
}

/** 状态下拉的四个取值（文案复用 gal.*：与作者看到的完全同一套词） */
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "public", label: "gal.public" },
  { value: "private", label: "gal.private" },
  { value: "pending", label: "gal.pending" },
  { value: "rejected", label: "gal.rejected" },
]

/**
 * 造物集管理动作（注入给编辑弹窗）。
 *
 * 与作者侧 `AUTHOR_EDIT_ACTIONS`（pages/gallery.tsx）一一对应，只是换了一组接口 ——
 * 这样同一份 UI 在两处都能用，且不会出现「作者能改、管理员改不了」的分叉。
 */
const ADMIN_EDIT_ACTIONS: EditProjectActions = {
  getDomain: async (id) => (await adminApi.getGalleryProjectDomain(id)).fqdn,
  setDomain: async (id, fqdn) => (await adminApi.setGalleryProjectDomain(id, fqdn)).fqdn,
  clearDomain: async (id) => {
    await adminApi.clearGalleryProjectDomain(id)
  },
  saveMeta: async (id, meta) => (await adminApi.updateGalleryProjectMeta(id, meta)).project,
  setSlug: async (id, slug) => {
    await adminApi.setGalleryProjectSlug(id, slug)
  },
  uploadCover: async (id, blob) => {
    await adminApi.uploadGalleryProjectCover(id, blob)
  },
  deleteCover: async (id) => {
    await adminApi.deleteGalleryProjectCover(id)
  },
}

export function AdminGalleryTab() {
  const { t } = useT()

  const [q, setQ] = React.useState("")
  /** 真正发给服务端的搜索词（输入停顿 350ms 才同步，免得每敲一个字打一次接口） */
  const [appliedQ, setAppliedQ] = React.useState("")
  const [status, setStatus] = React.useState<StatusFilter>("")
  const [page, setPage] = React.useState(1)

  const [items, setItems] = React.useState<AdminGalleryProject[]>([])
  const [total, setTotal] = React.useState(0)
  const [counts, setCounts] = React.useState<Counts>({
    all: 0,
    public: 0,
    private: 0,
    pending: 0,
    rejected: 0,
  })
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  /** 正在跑动作的那一行（防连点） */
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [refreshStamp, setRefreshStamp] = React.useState(0)

  /** 置顶中的作品（置顶卡片专用；null = 还没拉过） */
  const [pinned, setPinned] = React.useState<AdminGalleryProject[] | null>(null)

  const [editing, setEditing] = React.useState<AdminGalleryProject | null>(null)
  /** 预览弹窗（管理端预览接口拿文件，塞沙箱 iframe） */
  const [preview, setPreview] = React.useState<{ name: string; doc: string } | null>(null)
  const [previewing, setPreviewing] = React.useState<string | null>(null)

  /** 一页 30 条 —— 必须与后端 `admin-lab.ts` 的 GALLERY_PAGE_SIZE 一致（算总页数要用） */
  const pageSize = 30

  // 输入防抖：只有停顿之后才真的发请求
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedQ(q.trim())
      setPage(1)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [q])

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await adminApi.listGalleryProjects({
        page,
        q: appliedQ || undefined,
        status: status || undefined,
      })
      setItems(res.items)
      setTotal(res.total)
      setCounts(res.counts)
    } catch {
      setItems([])
      setTotal(0)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [page, appliedQ, status, refreshStamp])

  const loadPinned = React.useCallback(async () => {
    try {
      // 置顶是人工操作，数量天然很少：只取第一页（30 条）足够
      const res = await adminApi.listGalleryProjects({ pinned: true })
      setPinned(res.items)
    } catch {
      setPinned([])
    }
  }, [refreshStamp])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    void loadPinned()
  }, [loadPinned])

  /** 动作之后统一刷新：列表（含各状态计数）与置顶卡片都要跟着变 */
  const refreshAll = () => setRefreshStamp((n) => n + 1)

  const togglePin = async (project: AdminGalleryProject) => {
    const next = !project.pinnedAt
    setBusyId(project.id)
    try {
      await adminApi.setGalleryPinned(project.id, next)
      toast.success(t(next ? "adm.lab.pinDone" : "adm.lab.unpinDone"))
      refreshAll()
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.pinFailed")))
    } finally {
      setBusyId(null)
    }
  }

  const setVisibility = async (project: AdminGalleryProject, next: string) => {
    if (next === project.visibility) return
    // 驳回必须带理由：它会原样回给作者，空着等于让作者不知道要改什么
    let note: string | undefined
    if (next === "rejected") {
      const input = await promptDialog({
        title: t("adm.gal.rejectTitle"),
        desc: t("adm.gal.rejectDesc", { name: project.name }),
        input: { placeholder: t("adm.gal.rejectPlaceholder"), defaultValue: project.reviewNote },
        okText: t("adm.gal.rejectOk"),
        danger: true,
      })
      if (input === null) return
      note = input.trim()
      if (!note) {
        toast.error(t("adm.gal.rejectNeedNote"))
        return
      }
    }
    setBusyId(project.id)
    try {
      const res = await adminApi.setGalleryProjectVisibility(project.id, next, note)
      toast.success(t("adm.gal.statusDone", { s: t(statusLabelKey(res.project.visibility)) }))
      refreshAll()
    } catch (err) {
      toast.error(errMsg(err, t("adm.gal.statusFailed")))
    } finally {
      setBusyId(null)
    }
  }

  const removeProject = async (project: AdminGalleryProject) => {
    const ok = await confirmDialog({
      title: t("adm.gal.deleteTitle"),
      desc: t("adm.gal.deleteDesc", { name: project.name }),
      okText: t("common.delete"),
      danger: true,
    })
    if (!ok) return
    setBusyId(project.id)
    try {
      await adminApi.deleteGalleryProject(project.id)
      toast.success(t("adm.gal.deleteDone", { name: project.name }))
      // 删掉的是本页最后一条 ⇒ 退回上一页，免得停在一个空页上
      if (items.length === 1 && page > 1) setPage(page - 1)
      else refreshAll()
    } catch (err) {
      toast.error(errMsg(err, t("adm.gal.deleteFailed")))
    } finally {
      setBusyId(null)
    }
  }

  /** 打开作品：公开的有固定地址（tyu.me/<页面名>），私有的只能走沙箱预览 */
  const openProject = (project: AdminGalleryProject) => {
    if (project.visibility === "public" && project.slug) {
      window.open(`${PREVIEW_SHELL_ORIGIN}/${encodeURIComponent(project.slug)}`, "_blank", "noopener")
      return
    }
    void previewProject(project)
  }

  const previewProject = async (project: AdminGalleryProject) => {
    setPreviewing(project.id)
    try {
      // 用户端详情接口看不到未公开作品，管理端有专门的预览接口
      const { project: full } = await adminApi.previewLabReview(project.id)
      const doc = buildPreviewDoc(full.files ?? {})
      if (!doc) {
        toast.error(t("adm.gal.noPreview"))
        return
      }
      setPreview({ name: full.name || project.name, doc })
    } catch (err) {
      toast.error(errMsg(err, t("adm.gal.previewFailed")))
    } finally {
      setPreviewing(null)
    }
  }

  const statusLabelKey = (v: string) =>
    STATUS_OPTIONS.find((o) => o.value === v)?.label ?? "gal.private"

  const visBadge = (v: string) => {
    const label = t(statusLabelKey(v))
    if (v === "public") return <Badge variant="default">{label}</Badge>
    if (v === "pending") {
      return (
        <Badge variant="outline" className="border-amber-500/60 text-amber-600 dark:text-amber-400">
          {label}
        </Badge>
      )
    }
    if (v === "rejected") {
      return (
        <Badge variant="outline" className="border-destructive/60 text-destructive">
          {label}
        </Badge>
      )
    }
    return <Badge variant="outline">{label}</Badge>
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("adm.gal.intro")}</p>

      {/* ---------------- 置顶管理 ----------------
          文案沿用原「AI 实验室 → 造物集置顶」那一套 key（站长要求保留），
          只是把「全部公开作品」收窄成「当前置顶的作品」——
          置顶/取消置顶在下面的作品列表里逐行都有，不必在两处重复同一张全量列表。 */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("adm.lab.pinTitle")}</CardTitle>
            <CardDescription>{t("adm.lab.pinDesc")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="h-4 w-4" />
            {t("adm.gal.refresh")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {pinned === null ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
              {t("adm.lab.pinLoading")}
            </p>
          ) : pinned.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              {t("adm.gal.pinnedEmpty")}
            </p>
          ) : (
            <div className="space-y-1">
              {pinned.map((w) => (
                <div key={w.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                  <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{w.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {w.authorName}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {w.views} / {w.likes}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0 text-xs"
                    disabled={busyId === w.id}
                    onClick={() => void togglePin(w)}
                  >
                    {busyId === w.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      t("adm.lab.pinned")
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">{t("adm.lab.pinHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 作品列表 ---------------- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("adm.gal.listTitle")}</CardTitle>
            <CardDescription>{t("adm.gal.listDesc")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("adm.gal.refresh")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("adm.gal.search")}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key || "all"}
                type="button"
                onClick={() => {
                  setStatus(f.key)
                  setPage(1)
                }}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs transition-colors",
                  status === f.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-accent"
                )}
              >
                {t(f.label)}
                <span className="ml-1.5 tabular-nums opacity-80">{counts[f.countKey]}</span>
              </button>
            ))}
          </div>

          {loading ? (
            <div className="py-8">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : failed ? (
            <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("adm.gal.loadFailed")}
            </p>
          ) : items.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("adm.gal.empty")}
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((it) => (
                <div
                  key={it.id}
                  className="flex flex-wrap items-start gap-3 rounded-md border p-3"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/50 text-lg">
                    {it.hasCover ? (
                      <img
                        src={galleryCoverUrl(it.id, it.coverV)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : it.icon?.trim() ? (
                      <span className="leading-none">{it.icon}</span>
                    ) : (
                      <Sparkles className="h-4 w-4 text-muted-foreground" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium">{it.name}</p>
                      {visBadge(it.visibility)}
                      {it.pinnedAt && (
                        <Badge variant="secondary" className="gap-1">
                          <Pin className="h-3 w-3" />
                          {t("adm.lab.pinned")}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {it.description || t("gal.noDesc")}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <UserAvatar
                          username={it.authorUsername || it.authorName}
                          hasAvatar={!!it.authorAvatar}
                          className="h-4 w-4"
                        />
                        {it.authorName}
                      </span>
                      <span className="tabular-nums">
                        {t("adm.gal.views")} {it.views}
                      </span>
                      <span className="tabular-nums">
                        {t("adm.gal.likes")} {it.likes}
                      </span>
                      {it.slug && (
                        <code className="rounded bg-muted px-1 font-mono">
                          {`tyu.me/${it.slug}`}
                        </code>
                      )}
                    </div>
                    {it.visibility === "rejected" && it.reviewNote && (
                      <p className="mt-1 line-clamp-2 text-xs text-destructive">
                        {t("adm.gal.rejectReason")}
                        {it.reviewNote}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={previewing === it.id}
                      onClick={() => openProject(it)}
                    >
                      {previewing === it.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : it.visibility === "public" ? (
                        <ExternalLink className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                      {it.visibility === "public" ? t("gal.open") : t("adm.gal.preview")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(it)}>
                      <Pencil className="h-4 w-4" />
                      {t("gal.edit")}
                    </Button>
                    {/* 直接设状态（公开 / 私有 / 待审 / 驳回）—— 站长要的「直接设置作品状态」 */}
                    <select
                      aria-label={t("adm.gal.status")}
                      className="h-8 rounded-md border bg-background px-2 text-xs"
                      value={it.visibility}
                      disabled={busyId === it.id}
                      onChange={(e) => void setVisibility(it, e.target.value)}
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {t(o.label)}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant={it.pinnedAt ? "secondary" : "outline"}
                      size="sm"
                      disabled={busyId === it.id}
                      onClick={() => void togglePin(it)}
                    >
                      {busyId === it.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Pin className="h-4 w-4" />
                      )}
                      {it.pinnedAt ? t("adm.lab.pinned") : t("adm.lab.pin")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={busyId === it.id}
                      onClick={() => void removeProject(it)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 分页：服务端分页（作品会一直长，不能一次拉全量） */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-[11px] text-muted-foreground">
              {t("adm.gal.total", { n: total })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage(page - 1)}
              >
                {t("adm.gal.prev")}
              </Button>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t("adm.gal.page", { p: page, n: totalPages })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => setPage(page + 1)}
              >
                {t("adm.gal.next")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 作品审核队列 ----------------
          从「AI 实验室」整块搬来：它是**操作台**（点了即时生效），
          与上面那张「改完要按保存」的配置不是一回事，所以自成一张卡、自己拉数据。 */}
      <LabReviewQueue onChanged={refreshAll} />

      {/* ---------------- 编辑弹窗（与作者那一屏是同一个组件） ---------------- */}
      {editing && (
        <EditProjectDialog
          project={{
            // 弹窗吃的是 `LabProjectSummary` 形状；AdminGalleryProject 字段是它的超集，
            // 这里显式映射一遍，避免哪天两边字段名漂移时悄悄传错值。
            id: editing.id,
            name: editing.name,
            slug: editing.slug,
            icon: editing.icon,
            description: editing.description,
            visibility: editing.visibility,
            reviewNote: editing.reviewNote,
            hasCover: editing.hasCover,
            coverV: editing.coverV,
            views: editing.views,
            likes: editing.likes,
            createdAt: editing.createdAt,
            updatedAt: editing.updatedAt,
            publishedAt: editing.publishedAt,
          }}
          actions={ADMIN_EDIT_ACTIONS}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            toast.success(t("gal.saved"))
            refreshAll()
          }}
        />
      )}

      {/* ---------------- 沙箱预览 ---------------- */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background/80 p-2 backdrop-blur-sm sm:p-5"
          onClick={() => setPreview(null)}
        >
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-3 border-b px-4 py-2.5">
              <p className="min-w-0 flex-1 truncate font-medium">{preview.name}</p>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPreview(null)}
                aria-label={t("common.close")}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>
            <div className="min-h-0 flex-1 bg-white">
              {/* ⚠️ sandbox 不带 allow-same-origin：作品脚本拿不到本站身份 */}
              <iframe
                title={preview.name}
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-modals allow-forms allow-popups"
                srcDoc={preview.doc}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 造物集待审队列（2026-10-17 从「AI 实验室」搬来 —— 操作台与它处理的对象放在一起）。
 *
 * · 「待审核」列出等放行的作品，「已驳回」留个记录（也方便反悔 —— 但驳回后再通过
 *   要用户重新提交，因为 `reviewLabProject` 只处理 pending，这里只读不写）；
 * · 预览走管理端专用接口（用户端详情接口看不到待审作品）；
 * · 作品一律塞进 `sandbox`（**不带 allow-same-origin**）的 iframe 里渲染。
 * · `onChanged`：放行 / 驳回之后通知外层刷新作品列表（状态变了，列表要跟着变）。
 */
function LabReviewQueue({ onChanged }: { onChanged?: () => void }) {
  const { t } = useT()
  const [status, setStatus] = React.useState<"pending" | "rejected">("pending")
  const [items, setItems] = React.useState<AdminLabReview[]>([])
  const [pendingCount, setPendingCount] = React.useState(0)
  const [rejectedCount, setRejectedCount] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  /** 正在写驳回理由的那一条 */
  const [rejecting, setRejecting] = React.useState<AdminLabReview | null>(null)
  /** 正在预览的作品文件 */
  const [preview, setPreview] = React.useState<{ name: string; doc: string } | null>(null)
  const [previewing, setPreviewing] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await adminApi.listLabReviews(status)
      setItems(res.items)
      setPendingCount(res.pendingCount)
      setRejectedCount(res.rejectedCount)
    } catch {
      setItems([])
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [status])

  React.useEffect(() => {
    void load()
  }, [load])

  const approve = async (item: AdminLabReview) => {
    setBusyId(item.id)
    try {
      await adminApi.reviewLabProject(item.id, "approve")
      toast.success(t("adm.lab.reviewApproved", { name: item.name }))
      await load()
      onChanged?.()
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.reviewFailed")))
    } finally {
      setBusyId(null)
    }
  }

  const reject = async (item: AdminLabReview, note: string) => {
    setBusyId(item.id)
    try {
      await adminApi.reviewLabProject(item.id, "reject", note)
      toast.success(t("adm.lab.reviewRejected", { name: item.name }))
      setRejecting(null)
      await load()
      onChanged?.()
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.reviewFailed")))
    } finally {
      setBusyId(null)
    }
  }

  const openPreview = async (item: AdminLabReview) => {
    setPreviewing(item.id)
    try {
      const { project } = await adminApi.previewLabReview(item.id)
      const doc = buildPreviewDoc(project.files ?? {})
      if (!doc) {
        toast.error(t("adm.lab.reviewNoPreview"))
        return
      }
      setPreview({ name: project.name || item.name, doc })
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.reviewFailed")))
    } finally {
      setPreviewing(null)
    }
  }

  const tabBtn = (key: "pending" | "rejected", label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setStatus(key)}
      className={cn(
        "rounded-md border px-3 py-1.5 text-xs transition-colors",
        status === key
          ? "border-primary bg-primary text-primary-foreground"
          : "hover:bg-accent"
      )}
    >
      {label}
      {count > 0 && <span className="ml-1.5 tabular-nums opacity-80">{count}</span>}
    </button>
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("adm.lab.reviewQueueTitle")}</CardTitle>
          <CardDescription>{t("adm.lab.reviewQueueDesc")}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("adm.lab.reviewRefresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {tabBtn("pending", t("adm.lab.reviewPending"), pendingCount)}
          {tabBtn("rejected", t("adm.lab.reviewRejectedTab"), rejectedCount)}
        </div>

        {loading ? (
          <div className="py-8">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : failed ? (
          <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            {t("adm.lab.reviewLoadFailed")}
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            {status === "pending" ? t("adm.lab.reviewEmptyPending") : t("adm.lab.reviewEmptyRejected")}
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div
                key={it.id}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/50 text-lg">
                  {it.hasCover ? (
                    <img
                      src={galleryCoverUrl(it.id)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : it.icon?.trim() ? (
                    <span className="leading-none">{it.icon}</span>
                  ) : (
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">{it.name}</p>
                    <Badge variant="outline" className="shrink-0">
                      {it.authorName}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {it.description || t("gal.noDesc")}
                  </p>
                  {status === "rejected" && it.reviewNote && (
                    <p className="mt-0.5 truncate text-xs text-destructive">{it.reviewNote}</p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={previewing === it.id}
                    onClick={() => void openPreview(it)}
                  >
                    {previewing === it.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                    {t("adm.lab.reviewPreview")}
                  </Button>
                  {status === "pending" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        disabled={busyId === it.id}
                        onClick={() => setRejecting(it)}
                      >
                        <XCircle className="h-4 w-4" />
                        {t("adm.lab.reviewReject")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyId === it.id}
                        onClick={() => void approve(it)}
                      >
                        {busyId === it.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        {t("adm.lab.reviewApprove")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {rejecting && (
        <RejectDialog
          item={rejecting}
          busy={busyId === rejecting.id}
          onCancel={() => setRejecting(null)}
          onConfirm={(note) => void reject(rejecting, note)}
        />
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background/80 p-2 backdrop-blur-sm sm:p-5"
          onClick={() => setPreview(null)}
        >
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-3 border-b px-4 py-2.5">
              <p className="min-w-0 flex-1 truncate font-medium">{preview.name}</p>
              <Button variant="ghost" size="icon" onClick={() => setPreview(null)} aria-label={t("common.close")}>
                <X className="h-4 w-4" />
              </Button>
            </header>
            <div className="min-h-0 flex-1 bg-white">
              <iframe
                title={preview.name}
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-modals allow-forms allow-popups"
                srcDoc={preview.doc}
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

/** 驳回理由输入框（理由会原样回给作者，所以别写太长） */
function RejectDialog({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: AdminLabReview
  busy: boolean
  onCancel: () => void
  onConfirm: (note: string) => void
}) {
  const { t } = useT()
  const [note, setNote] = React.useState("")

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t("adm.lab.rejectTitle")}</h2>
            <Button variant="ghost" size="icon" onClick={onCancel} aria-label={t("common.close")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("adm.lab.rejectDesc", { name: item.name })}
          </p>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={200}
            placeholder={t("adm.lab.rejectPlaceholder")}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => onConfirm(note.trim())}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.lab.reviewReject")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
