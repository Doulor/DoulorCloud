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
import { useT } from "@/i18n"

/**
 * 管理面板 → 自定义称号。
 *
 * 创建徽章式称号（名称 + 渐变双色），授予指定用户；
 * 样式对标管理员/站长徽章（扫光 + 描边流光），颜色全部自动衍生。
 *
 * 规则（由后端表结构保证）：
 *   · 一人可同时持有**多个**自定义称号（2026-10-01 起 user_titles 多对多，
 *     迁移见 0093_user_titles_multi.sql）；重复授予同一个是幂等的，不会重复添加；
 *   · 同一时间只**展示**其中一个，用户可以自己切换展示哪个；
 *   · 与角色徽章（管理员/站长）并排展示，不冲突。
 */

/** hex 输入的受控值 → 组件要的格式（非法时给一个灰色兜底，预览不至于是白的） */
const safeColor = (v: string) => (/^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : "#64748b")

export function TitlesAdminPanel() {
  const { t } = useT()
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
      toast.error(errMsg(err, t("at.err.load")))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const openDialog = (title?: AdminTitle) => {
    if (title) {
      setEditId(title.id)
      setDraft({ name: title.name, colorFrom: title.colorFrom, colorTo: title.colorTo })
    } else {
      setEditId(null)
      setDraft({ name: "", colorFrom: "#7c3aed", colorTo: "#3b82f6" })
    }
    setOpen(true)
  }

  const handleSave = async () => {
    const name = draft.name.trim()
    if (!name) {
      toast.error(t("at.err.nameRequired"))
      return
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(draft.colorFrom) || !/^#[0-9a-fA-F]{6}$/.test(draft.colorTo)) {
      toast.error(t("at.err.colorFormat"))
      return
    }
    setBusy(true)
    try {
      const payload = { name, colorFrom: draft.colorFrom.toLowerCase(), colorTo: draft.colorTo.toLowerCase() }
      if (editId) {
        await adminTitlesApi.update(editId, payload)
        toast.success(t("at.ok.updated"))
      } else {
        await adminTitlesApi.create(payload)
        toast.success(t("at.ok.created"))
      }
      setOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("at.err.save")))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (title: AdminTitle) => {
    if (!confirm(t("at.confirmDelete", { name: title.name }))) return
    try {
      await adminTitlesApi.remove(title.id)
      toast.success(t("at.ok.deleted"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("at.err.delete")))
    }
  }

  const openGrant = (title: AdminTitle) => {
    setGrantFor(title)
    setGrantUsername("")
  }

  const handleGrant = async () => {
    if (!grantFor) return
    const username = grantUsername.trim()
    if (!username) {
      toast.error(t("at.err.usernameRequired"))
      return
    }
    setBusy(true)
    try {
      await adminTitlesApi.grant(grantFor.id, username)
      toast.success(t("at.ok.granted", { username }))
      setGrantFor(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("at.err.grant")))
    } finally {
      setBusy(false)
    }
  }

  const handleRevoke = async (title: AdminTitle, username: string) => {
    try {
      await adminTitlesApi.revoke(title.id, username)
      toast.success(t("at.ok.revoked", { username, name: title.name }))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("at.err.revoke")))
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">{t("at.card")}</CardTitle>
              <CardDescription>
                {t("at.cardDesc")}
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => openDialog()}>
              <Plus className="h-4 w-4" />
              {t("at.new")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !titles ? (
            <LoadingBlock />
          ) : (titles?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Medal}
              title={t("at.empty")}
              description={t("at.emptyDesc")}
            />
          ) : (
            <div className="divide-y rounded-md border">
              {titles!.map((title) => (
                <div key={title.id} className="space-y-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <CustomTitleBadge
                      title={{
                        name: title.name || t("at.unnamed"),
                        colorFrom: title.colorFrom,
                        colorTo: title.colorTo,
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {title.colorFrom} → {title.colorTo}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => openGrant(title)}
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        {t("at.grant")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={t("common.edit")}
                        onClick={() => openDialog(title)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        aria-label={t("common.delete")}
                        onClick={() => void handleDelete(title)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {title.holders.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{t("at.holdersLabel")}</span>
                      {title.holders.map((h) => (
                        <span
                          key={h.userId}
                          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs"
                        >
                          {h.nickname ?? h.username}
                          <span className="text-muted-foreground">@{h.username}</span>
                          <button
                            type="button"
                            className="rounded-sm text-muted-foreground transition-colors hover:text-destructive"
                            aria-label={t("at.revokeAria", { username: h.username })}
                            title={t("at.revokeAria", { username: h.username })}
                            onClick={() => void handleRevoke(title, h.username)}
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
            <DialogTitle>{editId ? t("at.edit") : t("at.new")}</DialogTitle>
            <DialogDescription>
              {t("at.dialogDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tName">{t("at.name")}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="tName"
                  placeholder={t("at.namePlaceholder")}
                  maxLength={20}
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
                <div className="shrink-0">
                  <CustomTitleBadge
                    title={{
                      name: draft.name.trim() || t("at.preview"),
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
                  <Label htmlFor={`t-${key}`}>{i === 0 ? t("at.colorFrom") : t("at.colorTo")}</Label>
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
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {editId ? t("common.save") : t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 授予 */}
      <Dialog open={grantFor !== null} onOpenChange={(v) => !v && setGrantFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("at.grantTitle", { name: grantFor?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("at.grantDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="tGrantUser">{t("settings.label.username")}</Label>
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
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleGrant()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("at.grant")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
