import * as React from "react"
import { Loader2, Medal, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react"
import { toast } from "sonner"

import { CustomTitleBadge } from "@/components/custom-title-badge"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { adminTitlesApi, errMsg, type AdminTitle } from "@/services/api"

/**
 * 管理面板 → 自定义称号。
 *
 * 创建徽章式称号（名称 + 渐变双色），授予指定用户；
 * 样式对标管理员/站长徽章（扫光 + 描边流光），颜色全部自动衍生。
 *
 * 规则（由后端表结构保证）：
 *   · 一人最多一个自定义称号，新授予会顶掉旧的；
 *   · 与角色徽章（管理员/站长）并排展示，不冲突。
 */

/** hex 输入的受控值 → 组件要的格式（非法时给一个灰色兜底，预览不至于是白的） */
const safeColor = (v: string) => (/^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : "#64748b")

export function TitlesAdminPanel() {
  const [titles, setTitles] = React.useState<AdminTitle[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // ---- 创建 / 编辑 ----
  const [open, setOpen] = React.useState(false)
  /** null = 新增 */
  const [editId, setEditId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState({ name: "", colorFrom: "#7c3aed", colorTo: "#3b82f6" })

  // ---- 授予 ----
  const [grantFor, setGrantFor] = React.useState<AdminTitle | null>(null)
  const [grantUsername, setGrantUsername] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminTitlesApi.list()
      setTitles(res.titles)
    } catch (err) {
      toast.error(errMsg(err, "加载失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const openDialog = (t?: AdminTitle) => {
    if (t) {
      setEditId(t.id)
      setDraft({ name: t.name, colorFrom: t.colorFrom, colorTo: t.colorTo })
    } else {
      setEditId(null)
      setDraft({ name: "", colorFrom: "#7c3aed", colorTo: "#3b82f6" })
    }
    setOpen(true)
  }

  const handleSave = async () => {
    const name = draft.name.trim()
    if (!name) {
      toast.error("称号名称要填")
      return
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(draft.colorFrom) || !/^#[0-9a-fA-F]{6}$/.test(draft.colorTo)) {
      toast.error("颜色格式不对（要 #RRGGBB 六位十六进制）")
      return
    }
    setBusy(true)
    try {
      const payload = { name, colorFrom: draft.colorFrom.toLowerCase(), colorTo: draft.colorTo.toLowerCase() }
      if (editId) {
        await adminTitlesApi.update(editId, payload)
        toast.success("已更新，所有持有者的徽章会一起变")
      } else {
        await adminTitlesApi.create(payload)
        toast.success("已创建，接下来把它授予用户")
      }
      setOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, "保存失败"))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (t: AdminTitle) => {
    if (!confirm(`删除称号「${t.name}」？${t.holders.length > 0 ? `${t.holders.length} 名持有者的徽章会一起消失。` : ""}`)) return
    try {
      await adminTitlesApi.remove(t.id)
      toast.success("已删除")
      await load()
    } catch (err) {
      toast.error(errMsg(err, "删除失败"))
    }
  }

  const openGrant = (t: AdminTitle) => {
    setGrantFor(t)
    setGrantUsername("")
  }

  const handleGrant = async () => {
    if (!grantFor) return
    const username = grantUsername.trim()
    if (!username) {
      toast.error("用户名要填")
      return
    }
    setBusy(true)
    try {
      await adminTitlesApi.grant(grantFor.id, username)
      toast.success(`已授予 ${username}`)
      setGrantFor(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, "授予失败"))
    } finally {
      setBusy(false)
    }
  }

  const handleRevoke = async (t: AdminTitle, username: string) => {
    try {
      await adminTitlesApi.revoke(t.id, username)
      toast.success(`已收回 ${username} 的「${t.name}」`)
      await load()
    } catch (err) {
      toast.error(errMsg(err, "收回失败"))
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">自定义称号</CardTitle>
              <CardDescription>
                创建徽章式称号并授予用户，样式与管理员/站长徽章同款（扫光 + 流光描边），
                颜色自定义。展示位置：社区广场、个人空间、头像悬浮卡片。
                每人最多一个自定义称号，新授予会顶掉旧的。
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => openDialog()}>
              <Plus className="h-4 w-4" />
              新建称号
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !titles ? (
            <LoadingBlock />
          ) : (titles?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Medal}
              title="还没有称号"
              description="点右上角「新建称号」创建第一个，比如「元老」「社区之星」。"
            />
          ) : (
            <div className="divide-y rounded-md border">
              {titles!.map((t) => (
                <div key={t.id} className="space-y-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <CustomTitleBadge
                      title={{ name: t.name || "（未命名）", colorFrom: t.colorFrom, colorTo: t.colorTo }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {t.colorFrom} → {t.colorTo}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => openGrant(t)}
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        授予
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="编辑"
                        onClick={() => openDialog(t)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        aria-label="删除"
                        onClick={() => void handleDelete(t)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {t.holders.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">持有者：</span>
                      {t.holders.map((h) => (
                        <span
                          key={h.userId}
                          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs"
                        >
                          {h.nickname ?? h.username}
                          <span className="text-muted-foreground">@{h.username}</span>
                          <button
                            type="button"
                            className="rounded-sm text-muted-foreground transition-colors hover:text-destructive"
                            aria-label={`收回 ${h.username} 的称号`}
                            title={`收回 ${h.username} 的称号`}
                            onClick={() => void handleRevoke(t, h.username)}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 创建 / 编辑 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? "编辑称号" : "新建称号"}</DialogTitle>
            <DialogDescription>
              名称最多 20 字；两端颜色不同就是渐变，相同就是纯色。文字黑/白和描边流光会按颜色自动算。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tName">名称</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="tName"
                  placeholder="比如：元老 / 社区之星 / 摸鱼冠军"
                  maxLength={20}
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
                <div className="shrink-0">
                  <CustomTitleBadge
                    title={{
                      name: draft.name.trim() || "预览",
                      colorFrom: safeColor(draft.colorFrom),
                      colorTo: safeColor(draft.colorTo),
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(["colorFrom", "colorTo"] as const).map((key, i) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`t-${key}`}>{i === 0 ? "颜色（起点）" : "颜色（终点）"}</Label>
                  <div className="flex items-center gap-2">
                    <input
                      id={`t-picker-${key}`}
                      type="color"
                      className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
                      value={safeColor(draft[key])}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                    <Input
                      id={`t-${key}`}
                      className="font-mono text-xs"
                      placeholder="#7c3aed"
                      value={draft[key]}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {editId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 授予 */}
      <Dialog open={grantFor !== null} onOpenChange={(v) => !v && setGrantFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>授予「{grantFor?.name}」</DialogTitle>
            <DialogDescription>
              填要授予的用户名。这个人已有的其它自定义称号会被顶掉（每人最多一个）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="tGrantUser">用户名</Label>
            <Input
              id="tGrantUser"
              placeholder="username"
              value={grantUsername}
              onChange={(e) => setGrantUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleGrant()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantFor(null)}>
              取消
            </Button>
            <Button onClick={() => void handleGrant()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              授予
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
