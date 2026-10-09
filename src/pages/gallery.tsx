import * as React from "react"
import { Link } from "react-router-dom"
import {
  Clock,
  Eye,
  ExternalLink,
  FlaskConical,
  Heart,
  ImagePlus,
  LayoutGrid,
  Link2,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { NavItem } from "@/components/sub-nav"
import { UserAvatar } from "@/components/user-avatar"
import { SkeletonCards } from "@/components/skeletons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useT } from "@/i18n"
import {
  galleryApi,
  galleryCoverUrl,
  labApi,
  errMsg,
  HttpError,
  type GalleryDetail,
  type GalleryItem,
  type LabProjectSummary,
} from "@/services/api"
import { buildPreviewDoc, openPreviewInNewTab, PREVIEW_SHARE_URL } from "@/lib/lab-agent"
import { compressToLimit } from "@/lib/image-compress"
import { cn } from "@/lib/utils"

/** 两个视图：大厅（别人的 + 自己的公开作品）与「我的造物集」（含未公开） */
type View = "hall" | "mine"

/** 点赞的本地乐观态：id → 最新计数与「我赞没赞」 */
type LikeMap = Record<string, { likes: number; liked: boolean }>

/** 封面图允许的 MIME（与后端 COVER_TYPES 一致） */
const COVER_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
/** 封面大小上限（与后端 COVER_MAX_BYTES 一致，前端先压到这个数以内） */
const COVER_MAX_BYTES = 600 * 1024

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
  const [view, setView] = React.useState<View>("hall")

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
        <aside className="w-full shrink-0 lg:w-48">
          <nav className="flex flex-col gap-0.5">
            <NavItem
              active={view === "hall"}
              icon={LayoutGrid}
              label={t("gal.tab.hall")}
              onClick={() => setView("hall")}
            />
            <NavItem
              active={view === "mine"}
              icon={FlaskConical}
              label={t("gal.tab.mine")}
              onClick={() => setView("mine")}
            />
          </nav>
        </aside>

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
      .list({ page, q: query })
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
  }, [page, query])

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
        <EditDialog
          project={editing}
          onCancel={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

/**
 * 编辑对外信息（封面 / 名字 / 简介 / 图标）。
 *
 * 走的是 publish 接口而不是 saveProject：后者是「保存代码」，
 * 会把文件一并提交；这里只是改对外展示的字段，不该碰代码。
 *
 * ⚠️ 保存时**不传 `visibility`** —— 只改介绍信息，可见性原样不动。
 * 否则编辑一个「待审核」作品的名字会顺手把它的公开申请撤掉。
 *
 * 封面是**即时上传**（选好图就传，不必等保存）：这样用户马上能看到效果，
 * 而且不必等整个表单校验通过。图片在本地先压到 600KB 以内再传。
 */
function EditDialog({
  project,
  onCancel,
  onSaved,
}: {
  project: LabProjectSummary
  onCancel: () => void
  onSaved: (p: LabProjectSummary) => void
}) {
  const { t } = useT()
  const [name, setName] = React.useState(project.name)
  const [description, setDescription] = React.useState(project.description ?? "")
  const [icon, setIcon] = React.useState(project.icon ?? "")
  const [saving, setSaving] = React.useState(false)

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
      const { project: updated } = await labApi.publish(project.id, {
        name: trimmed,
        description: description.trim(),
        icon: icon.trim(),
      })
      onSaved({ ...(updated as LabProjectSummary), hasCover })
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
      await labApi.uploadCover(project.id, out)
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
      await labApi.deleteCover(project.id)
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
      <Card
        className="w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
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
  /** 公开作品有**固定可分享地址**（`tyu.me/p/<id>`），未公开/没保存的只能本地注入 */
  const shareUrl =
    detail && detail.visibility === "public"
      ? `${PREVIEW_SHARE_URL}/${encodeURIComponent(detail.id)}`
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
