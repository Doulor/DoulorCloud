import * as React from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
  Clock,
  Eye,
  ExternalLink,
  FlaskConical,
  Heart,
  Link2,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  X,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { CollectionAside } from "@/components/collection-nav"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { EditProjectDialog, type EditProjectActions } from "@/components/lab-edit-project-dialog"
import { UserAvatar } from "@/components/user-avatar"
import { SkeletonCards } from "@/components/skeletons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useT } from "@/i18n"

/** 排序选项（key 与后端 sort 参数、i18n 词条一一对应） */
const GALLERY_SORTS: { key: GallerySort; label: string }[] = [
  { key: "latest", label: "gal.sort.latest" },
  { key: "views", label: "gal.sort.views" },
  { key: "likes", label: "gal.sort.likes" },
]
import {
  galleryApi,
  galleryCoverUrl,
  type GallerySort,
  labApi,
  errMsg,
  HttpError,
  type GalleryDetail,
  type GalleryItem,
  type LabProjectSummary,
} from "@/services/api"
import { buildPreviewDoc, openPreviewInNewTab, PREVIEW_SHELL_ORIGIN } from "@/lib/lab-agent"
import { cn } from "@/lib/utils"

/** 两个视图：大厅（别人的 + 自己的公开作品）与「我的造物集」（含未公开） */
type View = "hall" | "mine"

/** 点赞的本地乐观态：id → 最新计数与「我赞没赞」 */
type LikeMap = Record<string, { likes: number; liked: boolean }>

/**
 * 作者本人的编辑动作：全部走 `/api/lab/projects/*`（后端按 `user_id` 校验归属）。
 *
 * ⚠️ 管理端用的是**同一个弹窗组件**，只是换成注入一组走 `/api/admin/lab/gallery/*`
 *    的动作（见 `components/admin-gallery-tab.tsx`）。这里不要把 labApi 直接写进
 *    组件里 —— 那样管理员点保存必然 403。
 */
const AUTHOR_EDIT_ACTIONS: EditProjectActions = {
  getDomain: async (id) => (await labApi.getProjectDomain(id)).fqdn,
  setDomain: async (id, fqdn) => (await labApi.setProjectDomain(id, fqdn)).fqdn,
  clearDomain: async (id) => {
    await labApi.clearProjectDomain(id)
  },
  saveMeta: async (id, meta) => (await labApi.publish(id, meta)).project,
  setSlug: async (id, slug) => {
    await labApi.setSlug(id, slug)
  },
  uploadCover: async (id, blob) => {
    await labApi.uploadCover(id, blob)
  },
  deleteCover: async (id) => {
    await labApi.deleteCover(id)
  },
}

/**
 * 造物集 —— AI 实验室做出来的网页，可以公开托管到这里。
 *
 * · 展示大厅：所有人的公开作品，点开就能在沙箱里**直接运行**，不必下载；
 * · 我的造物集：自己的全部作品，在这里改对外信息（名字 / 简介 / 图标）与是否公开。
 *
 * ⚠️ 渲染别人的作品一律走 `sandbox`（**不带 allow-same-origin**）的 iframe + srcDoc。
 * 少了这一层，作品里的脚本就能带着会话 cookie 打 `/api/*`，等于把账号交出去。
 */
export default function GalleryPage() {
  const { t } = useT()
  /**
   * 视图（展示大厅 / 我的造物集）**放在 URL 里**，不再用组件 state。
   *
   * 为什么改：造物集左侧导航现在有四项，其中「造物典藏」「典藏设置」是
   * **独立页面**（走 react-router）。一个侧边栏里既有按钮切 state、又有链接跳页面，
   * 高亮逻辑必然漂移（改一处忘另一处）。统一成 URL 之后：
   *   · `/dashboard/gallery`            展示大厅
   *   · `/dashboard/gallery?view=mine`  我的造物集
   * 高亮、刷新、分享、前进后退全都自然成立。侧边栏见 `CollectionAside`。
   */
  const [searchParams] = useSearchParams()
  const view: View = searchParams.get("view") === "mine" ? "mine" : "hall"

  /**
   * 点赞的本地覆盖表。
   *
   * 为什么提到页面级：同一个作品可能同时出现在「大厅卡片」和「详情浮层」上，
   * 各自维护一份状态就会出现「在大厅点了赞，点进详情又变回没赞」。
   * 这里存一份覆盖，两处都读它，任何一处点赞都会同时更新两边。
   */
  const [likeOverrides, setLikeOverrides] = React.useState<LikeMap>({})
  const onLikeChange = React.useCallback(
    (id: string, next: { likes: number; liked: boolean }) => {
      setLikeOverrides((prev) => ({ ...prev, [id]: next }))
    },
    []
  )

  /**
   * 作品公开前是否需要管理员审核（站点设置）。
   * 只影响按钮文案：开启时点「公开」其实是「提交审核」，得说清楚。
   */
  const [reviewRequired, setReviewRequired] = React.useState(false)
  React.useEffect(() => {
    let alive = true
    labApi
      .settings()
      .then((r) => {
        if (alive) setReviewRequired(!!r.reviewRequired)
      })
      .catch(() => {
        /* 拿不到就当不需要审核：与后端「取不到设置时默认开启」不一致也没关系，
           反正这只是文案；真正的流转由后端决定 */
      })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 详情浮层。刻意提在页面级而不是各自的视图里：
   * 「我的造物集」点开自己未公开的作品也要走这套渲染与安全沙箱，
   * 放在外层才能保证两条入口共用同一份实现。
   */
  const [detail, setDetail] = React.useState<GalleryDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detailSeq, setDetailSeq] = React.useState(0)

  const openDetail = React.useCallback(
    async (id: string) => {
      setDetailLoading(true)
      setDetail(null)
      setDetailSeq((s) => s + 1)
      try {
        const { project } = await galleryApi.get(id)
        setDetail(project)
      } catch (err) {
        const msg =
          err instanceof HttpError && err.code === "NOT_FOUND"
            ? t("gal.notFound")
            : t("gal.loadFailed")
        toast.error(msg)
        setDetailSeq((s) => s + 1)
      } finally {
        setDetailLoading(false)
      }
    },
    [t]
  )

  const closeDetail = React.useCallback(() => {
    setDetail(null)
    setDetailLoading(false)
    setDetailSeq((s) => s + 1)
  }, [])

  // Esc 关闭详情浮层
  React.useEffect(() => {
    if (!detail && !detailLoading) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [detail, detailLoading, closeDetail])

  return (
    <div>
      <PageHeader title={t("gal.title")} description={t("gal.desc")} />

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* 侧边栏是共享组件（造物典藏 / 典藏设置两个页面用同一份），四项统一走 URL */}
        <CollectionAside />

        <div className="min-w-0 flex-1">
          {view === "hall" ? (
            <HallView
              onOpen={openDetail}
              likeOverrides={likeOverrides}
            />
          ) : (
            <MineView onOpen={openDetail} reviewRequired={reviewRequired} />
          )}
        </div>
      </div>

      {(detailLoading || detail) && (
        <DetailOverlay
          key={detailSeq}
          detail={detail}
          loading={detailLoading}
          onClose={closeDetail}
          likeOverrides={likeOverrides}
          onLikeChange={onLikeChange}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 展示大厅                                                            */
/* ------------------------------------------------------------------ */

function HallView({
  onOpen,
  likeOverrides,
}: {
  onOpen: (id: string) => void
  likeOverrides: LikeMap
}) {
  const { t } = useT()
  const [input, setInput] = React.useState("")
  const [query, setQuery] = React.useState("")
  /**
   * 排序方式（2026-10-10 站长要求）：最新 / 浏览最多 / 点赞最多。
   * ⚠️ 换排序要**回到第 1 页**，否则可能停在一个新排序下不存在的页码上（空列表）。
   */
  const [sort, setSort] = React.useState<GallerySort>("latest")
  const [page, setPage] = React.useState(1)
  const [items, setItems] = React.useState<GalleryItem[]>([])
  const [total, setTotal] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(24)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    setFailed(false)
    galleryApi
      .list({ page, q: query, sort })
      .then((res) => {
        if (!alive) return
        setItems(res.items ?? [])
        setTotal(res.total ?? 0)
        setPageSize(res.pageSize || 24)
      })
      .catch(() => {
        if (alive) {
          setItems([])
          setTotal(0)
          setFailed(true)
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, query, sort])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setQuery(input.trim())
    setPage(1)
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("gal.search")}
            className="pl-9"
            maxLength={40}
          />
        </div>
        <Button type="submit" variant="secondary">
          {t("common.search")}
        </Button>
        {query && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setInput("")
              setQuery("")
              setPage(1)
            }}
          >
            {t("gal.clearSearch")}
          </Button>
        )}
      </form>

      {/* 排序：三个平铺按钮（和站内其它分段控件一个样式，不引新组件） */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {GALLERY_SORTS.map((s) => (
          <Button
            key={s.key}
            type="button"
            size="sm"
            variant={sort === s.key ? "secondary" : "ghost"}
            className="text-xs"
            onClick={() => {
              if (sort === s.key) return
              setSort(s.key)
              setPage(1)
            }}
          >
            {t(s.label)}
          </Button>
        ))}
      </div>

      {loading ? (
        <SkeletonCards count={6} />
      ) : failed ? (
        <EmptyState
          title={t("gal.loadFailed")}
          description={t("gal.loadFailedDesc")}
          icon={Sparkles}
        />
      ) : items.length === 0 ? (
        query ? (
          <EmptyState title={t("gal.empty.search")} description={t("gal.empty.searchDesc")} icon={Search} />
        ) : (
          <EmptyState
            title={t("gal.empty.hall")}
            description={t("gal.empty.hallDesc")}
            icon={Sparkles}
            action={
              <Button asChild variant="secondary" size="sm">
                <Link to="/dashboard/lab">
                  <FlaskConical className="h-4 w-4" />
                  {t("gal.goLab")}
                </Link>
              </Button>
            }
          />
        )
      ) : (
        <>
          <GalleryGrid
            items={items}
            onOpen={onOpen}
            likeOverrides={likeOverrides}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <p className="text-xs text-muted-foreground">
              {t("gal.total").replace("{n}", String(total))}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  {t("gal.prev")}
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  {t("gal.next")}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 作品封面。
 *
 * 有上传过就显示图片，否则回退到作者填的那个 emoji —— 两条路都撑满同一个方框，
 * 卡片大小不会因为有没有封面而参差。
 */
function CoverMedia({
  id,
  hasCover,
  coverV,
  icon,
  emojiClass,
  fallback,
}: {
  id: string
  hasCover?: boolean
  /** 封面版本号：带上它，换封面后 URL 变化 ⇒ 立刻能看到新图而不是缓存里的旧图 */
  coverV?: string
  icon?: string
  /** emoji 的字号 class（不同位置尺寸不一样） */
  emojiClass: string
  /** icon 也是空的时候显示什么 */
  fallback: React.ReactNode
}) {
  if (hasCover) {
    return (
      <img
        src={galleryCoverUrl(id, coverV)}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
    )
  }
  if (icon?.trim()) return <span className={cn("leading-none", emojiClass)}>{icon}</span>
  return <>{fallback}</>
}

/**
 * 点赞按钮。
 *
 * 计数与「我赞没赞」都读父级那份 `likeOverrides`（可能还没有 ⇒ 用服务端给的值），
 * 点击时先乐观更新、再拿服务端返回的权威数字覆盖，失败则回滚。
 * ⚠️ 卡片本身是个按钮，这个按钮又在卡片里 ⇒ 必须自己截断事件冒泡，
 *    否则点个赞就把详情浮层也打开了。
 */
function LikeButton({
  id,
  likes,
  liked,
  override,
  onChange,
}: {
  id: string
  likes: number
  liked: boolean
  override?: { likes: number; liked: boolean }
  onChange: (id: string, next: { likes: number; liked: boolean }) => void
}) {
  const { t } = useT()
  const cur = override ?? { likes, liked }
  const [busy, setBusy] = React.useState(false)

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    const before = cur
    // 乐观更新：先让数字动起来，网络往返回来再用权威值覆盖
    onChange(id, {
      likes: Math.max(0, before.likes + (before.liked ? -1 : 1)),
      liked: !before.liked,
    })
    try {
      const res = await galleryApi.like(id)
      onChange(id, { likes: res.likes, liked: res.liked })
    } catch (err) {
      onChange(id, before)
      toast.error(errMsg(err, t("gal.likeFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={cur.liked}
      title={cur.liked ? t("gal.unlike") : t("gal.like")}
      className={cn(
        "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs tabular-nums transition-colors",
        cur.liked
          ? "text-rose-500 hover:bg-rose-500/10"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      <Heart className={cn("h-3.5 w-3.5", cur.liked && "fill-current")} />
      {cur.likes}
    </button>
  )
}

function GalleryGrid({
  items,
  onOpen,
  likeOverrides,
}: {
  items: GalleryItem[]
  onOpen: (id: string) => void
  likeOverrides: LikeMap
}) {
  const { t } = useT()
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((it) => (
        <div
          key={it.id}
          className="group flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm transition-transform hover:-translate-y-0.5 hover:shadow-md"
        >
          {/* 可点区域只包住「封面 + 文字」，点赞按钮放在外面当兄弟节点 ——
              按钮套按钮是非法 HTML，拆开最省心 */}
          <button
            type="button"
            onClick={() => onOpen(it.id)}
            className="flex flex-1 flex-col text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <div className="flex h-24 items-center justify-center overflow-hidden bg-muted/40 text-3xl">
              <CoverMedia
                id={it.id}
                hasCover={it.hasCover}
                coverV={it.coverV}
                icon={it.icon}
                emojiClass="text-3xl"
                fallback={<Sparkles className="h-7 w-7 text-muted-foreground" />}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3 pb-1.5">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{it.name}</p>
                {it.isMine && (
                  <Badge variant="secondary" className="shrink-0">
                    {t("gal.mineBadge")}
                  </Badge>
                )}
              </div>
              <p className="line-clamp-2 min-h-[2.5rem] text-xs text-muted-foreground">
                {it.description || t("gal.noDesc")}
              </p>
            </div>
          </button>

          <div className="mt-auto flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <UserAvatar
                // ⚠️ 必须传**用户名**而不是显示名：头像 URL 是 /u/<用户名>/avatar，
                //    后端给的 authorName 是「昵称优先」，昵称和用户名不一致时会 404 ⇒ 头像空白。
                username={it.authorUsername || it.authorName}
                hasAvatar={!!it.authorAvatar}
                className="h-5 w-5"
              />
              <span className="truncate text-xs text-muted-foreground">{it.authorName}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />
                {it.views}
              </span>
              {/* 点赞的**按钮**只在预览浮层右上角；卡片上留一个只读的计数当热度参考 */}
              <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                <Heart className="h-3.5 w-3.5" />
                {likeOverrides[it.id]?.likes ?? it.likes}
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 我的造物集                                                          */
/* ------------------------------------------------------------------ */

function MineView({
  onOpen,
  reviewRequired,
}: {
  onOpen: (id: string) => void
  reviewRequired: boolean
}) {
  const { t } = useT()
  const [projects, setProjects] = React.useState<LabProjectSummary[]>([])
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<LabProjectSummary | null>(null)

  const load = React.useCallback(() => {
    setLoading(true)
    setFailed(false)
    labApi
      .listProjects()
      .then((res) => setProjects(res.projects ?? []))
      .catch(() => {
        setProjects([])
        setFailed(true)
      })
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  /**
   * 切换公开状态。
   *
   * 四种状态各自的目标不一样，别用一个 `public ? private : public` 糊过去：
   *   private  → public   （开了审核则实际落到 pending）
   *   pending  → private  （撤回申请）
   *   public   → private  （取消公开）
   *   rejected → public   （改了之后重新送审）
   */
  const nextVisibility = (v: string): "public" | "private" =>
    v === "public" || v === "pending" ? "private" : "public"

  const togglePublish = async (p: LabProjectSummary) => {
    const next = nextVisibility(p.visibility)
    setBusyId(p.id)
    try {
      const { project } = await labApi.publish(p.id, { visibility: next })
      setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...project } : x)))
      // 服务端可能把 public 改判成 pending（审核开启时）—— 按它实际返回的状态提示
      if (next === "public" && project.visibility === "pending") {
        toast.success(t("gal.submitted"))
      } else {
        toast.success(next === "public" ? t("gal.published") : t("gal.unpublished"))
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "NO_HTML_ENTRY") {
        toast.error(t("gal.noHtml"))
      } else {
        toast.error(err instanceof Error ? err.message : t("gal.saveFailed"))
      }
    } finally {
      setBusyId(null)
    }
  }

  const onSaved = (updated: LabProjectSummary) => {
    setProjects((prev) => prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)))
    setEditing(null)
    toast.success(t("gal.saved"))
  }

  /** 可见性徽章：四种状态各有各的样子，别再用「不是 public 就是私密」糊过去 */
  const visBadge = (v: string) => {
    if (v === "public") return <Badge variant="default">{t("gal.public")}</Badge>
    if (v === "pending") {
      return (
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/60 text-amber-600 dark:text-amber-400"
        >
          <Clock className="h-3 w-3" />
          {t("gal.pending")}
        </Badge>
      )
    }
    if (v === "rejected") {
      return (
        <Badge variant="outline" className="gap-1 border-destructive/60 text-destructive">
          <XCircle className="h-3 w-3" />
          {t("gal.rejected")}
        </Badge>
      )
    }
    return <Badge variant="outline">{t("gal.private")}</Badge>
  }

  /** 主按钮文案：开着审核时「公开」实际是「提交审核」，得说清楚 */
  const pubLabel = (v: string) => {
    if (v === "public") return t("gal.unpublish")
    if (v === "pending") return t("gal.withdraw")
    if (v === "rejected") return t("gal.resubmit")
    return reviewRequired ? t("gal.submitReview") : t("gal.publish")
  }

  if (loading) return <SkeletonCards count={4} />

  if (failed) {
    return (
      <EmptyState
        title={t("gal.loadFailed")}
        description={t("gal.loadFailedDesc")}
        icon={Sparkles}
        action={
          <Button variant="secondary" size="sm" onClick={load}>
            {t("lab.err.retry")}
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("gal.mineHint")}</p>

      {projects.length === 0 ? (
        <EmptyState
          title={t("gal.empty.mine")}
          description={t("gal.empty.mineDesc")}
          icon={FlaskConical}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link to="/dashboard/lab">
                <FlaskConical className="h-4 w-4" />
                {t("gal.goLab")}
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/50 text-lg">
                  <CoverMedia
                    id={p.id}
                    hasCover={p.hasCover}
                    coverV={p.coverV}
                    icon={p.icon}
                    emojiClass="text-lg"
                    fallback={<Sparkles className="h-4 w-4 text-muted-foreground" />}
                  />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">{p.name}</p>
                    {visBadge(p.visibility)}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.description || t("gal.noDesc")}
                  </p>
                  {p.visibility === "rejected" && p.reviewNote && (
                    <p className="mt-1 line-clamp-2 text-xs text-destructive">
                      {t("gal.rejectReason")}
                      {p.reviewNote}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                    <Eye className="h-3.5 w-3.5" />
                    {p.views}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => onOpen(p.id)}>
                    <ExternalLink className="h-4 w-4" />
                    {t("gal.open")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                    <Pencil className="h-4 w-4" />
                    {t("gal.edit")}
                  </Button>
                  <Button
                    variant={p.visibility === "public" || p.visibility === "pending" ? "outline" : "default"}
                    size="sm"
                    disabled={busyId === p.id}
                    onClick={() => togglePublish(p)}
                  >
                    {busyId === p.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    {pubLabel(p.visibility)}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <EditProjectDialog
          project={editing}
          actions={AUTHOR_EDIT_ACTIONS}
          onCancel={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 详情浮层：在安全沙箱里直接运行作品                                   */
/* ------------------------------------------------------------------ */

function DetailOverlay({
  detail,
  loading,
  onClose,
  likeOverrides,
  onLikeChange,
}: {
  detail: GalleryDetail | null
  loading: boolean
  onClose: () => void
  likeOverrides: LikeMap
  onLikeChange: (id: string, next: { likes: number; liked: boolean }) => void
}) {
  const { t } = useT()
  const navigate = useNavigate()
  const [continueBusy, setContinueBusy] = React.useState(false)

  /**
   * 🔴「继续创作」（2026-10-12 站长要求）：把已发布作品的文件拉回 AI 实验室。
   *
   * 路径：详情接口本来带 files（渲染预览就在用）⇒ 塞进 sessionStorage，
   * 跳实验室；实验室挂载时认领这份载荷（见 lab.tsx 的 LAB_IMPORT_KEY），
   * 载入工作区并当作草稿继续。**只对作品主人显示**（别人没有改它的权利）。
   */
  const continueInLab = async () => {
    if (!detail) return
    setContinueBusy(true)
    try {
      // 详情里已有文件就不再多拉一次；防御性兜底：没有就按 id 取
      let files = detail.files ?? {}
      if (!Object.keys(files).length) {
        const { project } = await labApi.getProject(detail.id)
        files = project.files ?? {}
      }
      sessionStorage.setItem(
        "doulor.lab.import",
        JSON.stringify({
          id: detail.id,
          name: detail.name,
          description: detail.description ?? "",
          files,
          at: Date.now(),
        })
      )
      navigate("/dashboard/lab")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("gal.continueFailed"))
    } finally {
      setContinueBusy(false)
    }
  }

  // 渲染用的文档只在作品加载出来后算一次（文件可能不少，别每渲染都拼）
  const doc = React.useMemo(
    () => (detail ? buildPreviewDoc(detail.files ?? {}) : ""),
    [detail]
  )

  /**
   * 在新标签页打开。
   *
   * ⚠️ 不能直接把作品 HTML 做成 blob 再 window.open：blob 的 origin 就是本站，
   * 顶层打开会拿到完整身份（详见 `lib/lab-agent.ts` 的 `openPreviewInNewTab`）。
   * 这里和实验室走**同一份**实现：优先 tyu.me 空壳页，失败就地降级。
   */
  /**
   * 公开作品有**固定可分享地址**：`https://tyu.me/<页面名>`（根级单段路径，
   * 由 scripts/tyu-site-worker 承载；早期注释写的 `tyu.me/p/<id>` 是过时的形态）。
   * 未公开/没保存的作品没有真链接，只能本地注入空壳。
   *
   * 🔴 这个地址能打开的前提是 **tyu.me 顶点有代理记录**：通配符 `*.tyu.me`
   * 不覆盖顶点，泛解析配得再好也救不了 `tyu.me/...`。线上踩过这个坑
   * （链接能复制、界面显示正常，点开却是 DNS 解析失败）。
   */
  const shareUrl =
    detail && detail.visibility === "public"
      ? `${PREVIEW_SHELL_ORIGIN}/${encodeURIComponent(detail.slug || detail.id)}`
      : ""

  const openInNewTab = () => {
    // 已公开 ⇒ 打开真链接：任何人（包括没登录的）都能打开，可以直接分享出去
    if (shareUrl) {
      window.open(shareUrl, "_blank", "noopener")
      return
    }
    // 未公开 / 还没保存 ⇒ 内容只活在内存里，退回到「本地注入空壳」的老办法
    if (!doc) return
    if (!openPreviewInNewTab(doc)) toast.error(t("gal.popupBlocked"))
  }

  /** 复制分享链接（只有公开作品才有） */
  const copyShareLink = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast.success(t("gal.shareCopied"))
    } catch {
      // 浏览器不给剪贴板（非 HTTPS / 用户拒绝）⇒ 退化成让用户自己复制
      window.prompt(t("gal.shareCopy"), shareUrl)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/80 p-2 backdrop-blur-sm sm:p-5"
      onClick={onClose}
    >
      <div
        className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-wrap items-center gap-3 border-b px-3 py-2.5 sm:px-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/50 text-lg">
            {detail ? (
              <CoverMedia
                id={detail.id}
                hasCover={detail.hasCover}
                coverV={detail.coverV}
                icon={detail.icon}
                emojiClass="text-lg"
                fallback={<Sparkles className="h-4 w-4 text-muted-foreground" />}
              />
            ) : (
              <Sparkles className="h-4 w-4 text-muted-foreground" />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{detail?.name ?? t("gal.loading")}</p>
            <p className="truncate text-xs text-muted-foreground">
              {detail?.description || t("gal.noDesc")}
            </p>
          </div>

          {detail && (
            <div className="flex shrink-0 items-center gap-3">
              <span className="hidden items-center gap-1.5 sm:flex">
                <UserAvatar
                  // 同卡片：头像 URL 要用户名，不能用昵称优先的显示名
                  username={detail.authorUsername || detail.authorName}
                  hasAvatar={!!detail.authorAvatar}
                  className="h-5 w-5"
                />
                <span className="text-xs text-muted-foreground">{detail.authorName}</span>
              </span>
              <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />
                {detail.views}
              </span>
              {/* 自己的作品不能给自己点赞：后端也会拒（未公开/不存在都算 404） */}
              {!detail.isMine && (
                <LikeButton
                  id={detail.id}
                  likes={detail.likes}
                  liked={!!detail.liked}
                  override={likeOverrides[detail.id]}
                  onChange={onLikeChange}
                />
              )}
            </div>
          )}

          <div className="flex shrink-0 items-center gap-2">
            {/* 继续创作：把文件拉回 AI 实验室（只给作品主人） */}
            {detail?.isMine && (
              <Button
                variant="outline"
                size="sm"
                disabled={continueBusy}
                onClick={() => void continueInLab()}
                title={t("gal.continueHint")}
              >
                {continueBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">{t("gal.continue")}</span>
              </Button>
            )}
            {shareUrl && (
              <Button variant="outline" size="sm" onClick={() => void copyShareLink()}>
                <Link2 className="h-4 w-4" />
                <span className="hidden sm:inline">{t("gal.share")}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={openInNewTab}
              disabled={!doc && !shareUrl}
            >
              <ExternalLink className="h-4 w-4" />
              <span className="hidden sm:inline">
                {shareUrl ? t("gal.openShare") : t("gal.newTab")}
              </span>
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("common.close")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 bg-white">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t("gal.loading")}</span>
            </div>
          ) : doc ? (
            <iframe
              title={detail?.name ?? "preview"}
              className={cn("h-full w-full border-0")}
              sandbox="allow-scripts allow-modals allow-forms allow-popups"
              srcDoc={doc}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
              <Sparkles className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium">{t("gal.noPreview")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">{t("gal.noPreviewDesc")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
