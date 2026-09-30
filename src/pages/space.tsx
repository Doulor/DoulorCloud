import * as React from "react"
import { Link, useParams } from "react-router-dom"
import {
  ArrowLeft,
  ExternalLink,
  Gift,
  Heart,
  Loader2,
  Lock,
  MessageSquare,
  Settings2,
  Sparkles,
  Trophy,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"

import { UserAvatar } from "@/components/user-avatar"
import { LoadingBlock } from "@/components/loading-block"
import { RoleBadge } from "@/components/role-badge"
import { CustomTitleBadge } from "@/components/custom-title-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { achievementIcon } from "@/lib/achievement-icons"
import { fmtTime, fmtUid, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { HttpError, spaceApi } from "@/services/api"
import type { MySpaceSettings, SpaceData } from "@/types"

/**
 * 个人空间（公开主页）。
 *
 * 谁能看：任何人（含未登录访客）—— 空间是拿来分享、贴在社区里的。
 * 看到多少由**服务端**决定：主人可以关掉某个分区；访客看「历史贡献」时，
 * 缺少对应模块权限的条目会被服务端打码（这里只负责画成高斯模糊 + 锁）。
 */

/** 展示设置草稿 → 提交 */
function SettingsDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = React.useState<MySpaceSettings | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setDraft(null)
    void (async () => {
      try {
        const res = await spaceApi.getMine()
        setDraft(res.settings)
      } catch (err) {
        toast.error(err instanceof HttpError ? err.message : "读取展示设置失败")
      }
    })()
  }, [open])

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await spaceApi.saveMine(draft)
      toast.success("展示设置已保存")
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const rows: { key: keyof MySpaceSettings; label: string; desc: string }[] = [
    { key: "showAchievements", label: "成就与称号", desc: "展示已解锁的徽章、称号与成就点" },
    { key: "showStats", label: "统计数据", desc: "域名/邮箱/帖子/获赞/邀请/捐献等数字" },
    { key: "showPosts", label: "历史帖子", desc: "最近 10 条社区帖子（社区关闭或访客无权限时自动隐藏）" },
    {
      key: "showContributions",
      label: "历史贡献",
      desc: "捐献记录的类型与次数 —— 缺少对应模块权限的访客只能看到打码条目",
    },
    {
      key: "showProfileLink",
      label: "显示名片入口",
      desc: "在空间顶部显示「查看名片」按钮，跳转到你的个人名片（自定义域名优先）",
    },
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>空间展示设置</DialogTitle>
          <DialogDescription>决定别人打开你的个人空间时能看到什么</DialogDescription>
        </DialogHeader>

        {!draft ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="spaceMotto">一句话签名（可留空）</Label>
              <Input
                id="spaceMotto"
                maxLength={40}
                placeholder="例如：折腾不停的人"
                value={draft.motto}
                onChange={(e) => setDraft({ ...draft, motto: e.target.value })}
              />
            </div>
            <Separator />
            {rows.map((r) => (
              <div key={r.key} className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-muted-foreground">{r.desc}</p>
                </div>
                <Switch
                  checked={Boolean(draft[r.key])}
                  onCheckedChange={(v) => setDraft({ ...draft, [r.key]: v })}
                />
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={busy || !draft}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 一个统计数字 */
function StatItem({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border px-3 py-2.5">
      <p className="text-lg font-semibold leading-tight">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

export default function SpacePage() {
  const { username = "" } = useParams()
  const [data, setData] = React.useState<SpaceData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await spaceApi.get(username)
      setData(res)
      setNotFound(false)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        setNotFound(true)
      } else {
        toast.error(err instanceof HttpError ? err.message : "加载个人空间失败")
      }
    } finally {
      setLoading(false)
    }
  }, [username])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <LoadingBlock />
      </div>
    )
  }

  if (notFound || !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-16 text-center">
        <UserRound className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">没找到这个用户</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" />
            回到控制台
          </Link>
        </Button>
      </div>
    )
  }

  const { user, space, achievements, stats, posts, contributions } = data
  const display = user.nickname || user.username

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      {/* 顶部：回控制台出口 + 查看名片入口（有已发布名片且开关打开时） */}
      <div className="flex items-center justify-between">
        <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 inline h-3.5 w-3.5" />
          控制台
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Doulor Cloud · 个人空间</span>
          {data.profileUrl && space.showProfileLink && (
            <Button variant="outline" size="sm" asChild>
              <a href={data.profileUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                查看名片
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* 身份 */}
      <Card>
        <CardContent className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center">
          <UserAvatar
            username={user.username}
            nickname={user.nickname}
            hasAvatar={user.hasAvatar}
            className="h-20 w-20 shrink-0 text-2xl"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{display}</h1>
              {user.isAdmin && (
                <RoleBadge role={user.isRoot ? "root" : "admin"} />
              )}
              {user.customTitle && <CustomTitleBadge title={user.customTitle} />}
              {space.isOwner && (
                <Badge variant="secondary" className="text-[10px]">
                  这是你的空间
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {fmtUid(user.uid) && (
                <span className="mr-1.5 font-medium text-foreground/70">{fmtUid(user.uid)}</span>
              )}
              @{user.username} · 加入 {user.days} 天（
              {new Date(user.joinedAt).toLocaleDateString("zh-CN")}）
            </p>
            {space.motto && (
              <p className="text-sm italic text-muted-foreground">「{space.motto}」</p>
            )}
          </div>
          {space.isOwner && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 className="h-4 w-4" />
              展示设置
            </Button>
          )}
        </CardContent>
      </Card>

      {/* 成就与称号 */}
      {achievements && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Trophy className="h-4 w-4 text-muted-foreground" />
                  成就
                </CardTitle>
                <CardDescription>
                  称号「{achievements.title.name}」· 成就点 {achievements.points} /{" "}
                  {achievements.maxPoints} · 已解锁 {achievements.unlocked} /{" "}
                  {achievements.total}
                </CardDescription>
              </div>
              <span className="shrink-0 text-2xl font-semibold tracking-tight">
                {achievements.unlocked}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {achievements.badges.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有解锁任何成就</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {achievements.badges.map((b) => {
                  const Icon = achievementIcon(b.icon)
                  const maxed = b.level >= b.maxLevel
                  return (
                    <div
                      key={b.id}
                      title={`${b.name}${b.maxLevel > 1 ? ` Lv.${b.level}/${b.maxLevel}` : ""}`}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                        maxed
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border bg-muted/40"
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{b.name}</span>
                      {b.maxLevel > 1 && (
                        <span className="text-[10px] text-muted-foreground">
                          {b.level}/{b.maxLevel}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 统计 */}
      {stats && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              数据
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatItem label="加入天数" value={stats.days} />
              <StatItem label="子域名" value={stats.subdomains} />
              <StatItem label="邮箱" value={stats.mailboxes} />
              <StatItem label="帖子" value={stats.posts} />
              <StatItem label="评论" value={stats.comments} />
              <StatItem label="获赞" value={stats.likesReceived} />
              <StatItem label="邀请" value={stats.invited} />
              <StatItem label="捐献" value={stats.donations} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* 历史帖子 */}
      {posts && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              历史帖子
            </CardTitle>
            {posts.hiddenReason && (
              <CardDescription>{posts.hiddenReason}</CardDescription>
            )}
          </CardHeader>
          {posts.items.length > 0 && (
            <CardContent className="space-y-2">
              {posts.items.map((p) => (
                <Link
                  key={p.id}
                  to={`/dashboard/community/${p.id}`}
                  className="block rounded-md border px-3 py-2.5 transition-colors hover:border-primary/50"
                >
                  <p className="line-clamp-3 whitespace-pre-wrap text-sm">{p.excerpt}</p>
                  <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Heart className="h-3 w-3" />
                      {p.likeCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {p.commentCount}
                    </span>
                    <span className="ml-auto">{relTime(p.createdAt)}</span>
                  </div>
                </Link>
              ))}
            </CardContent>
          )}
          {!posts.hiddenReason && posts.items.length === 0 && (
            <CardContent>
              <p className="text-sm text-muted-foreground">还没有发过帖子</p>
            </CardContent>
          )}
        </Card>
      )}

      {/* 历史贡献 */}
      {contributions && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift className="h-4 w-4 text-muted-foreground" />
              历史贡献
            </CardTitle>
            <CardDescription>
              TA 为本站贡献过的资源（贡献详情受权限限制，不展示凭据）
            </CardDescription>
          </CardHeader>
          {contributions.items.length > 0 ? (
            <CardContent className="space-y-2">
              {contributions.items.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-md border px-3 py-2.5"
                >
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {c.label}
                  </Badge>
                  {c.masked ? (
                    // ⚠️ 这里的内容**根本没从服务端下发**（summary=null）。
                    // 模糊只是视觉提示，不是「靠 CSS 藏内容」。
                    <span className="relative flex-1 overflow-hidden">
                      <span
                        aria-hidden
                        className="select-none text-sm blur-[3px] opacity-70"
                      >
                        ██████████
                      </span>
                      <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock className="h-3 w-3" />
                        需要「{c.needLabel ?? "对应模块"}」权限
                      </span>
                    </span>
                  ) : (
                    <span className="flex-1 text-sm">{c.summary}</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {fmtTime(c.at)}
                  </span>
                </div>
              ))}
              {contributions.items.some((c) => c.masked) && (
                <p className="text-xs text-muted-foreground">{data.maskHint}</p>
              )}
            </CardContent>
          ) : (
            <CardContent>
              <p className="text-sm text-muted-foreground">还没有通过审核的捐献</p>
            </CardContent>
          )}
        </Card>
      )}

      {!achievements && !stats && !posts && !contributions && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            这个用户关闭了空间展示
          </CardContent>
        </Card>
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void load()}
      />
    </div>
  )
}
