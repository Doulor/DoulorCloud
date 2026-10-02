import * as React from "react"
import { ExternalLink, Loader2, Pencil, Plus, Sparkles, Trash2, Wand2 } from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { FunLinkIcon } from "@/components/fun-link-icon"
import { Badge } from "@/components/ui/badge"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  FUN_LINK_CATEGORIES,
  funLinkCategoryLabel,
  type FunLinkCategory,
} from "@/lib/fun-links"
import { adminFunLinksApi, funLinkIconUrl, type FunLink } from "@/services/api"
import { errMsg } from "@/services/api"
import { useT } from "@/i18n"

/**
 * 管理面板 → 网页分享。
 *
 * 维护工具箱「有趣的网页分享」那个模块的内容。
 * 列表很短，一次全量拉取，前端不做分页。
 */
export function FunLinksAdminPanel() {
  const { t } = useT()
  const [links, setLinks] = React.useState<FunLink[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const [open, setOpen] = React.useState(false)
  const [probing, setProbing] = React.useState(false)
  /** null = 新增 */
  const [editId, setEditId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState({
    title: "",
    url: "",
    description: "",
    category: "tool" as FunLinkCategory,
    iconUrl: "",
    sortOrder: "0",
    enabled: true,
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminFunLinksApi.list()
      setLinks(res.links)
    } catch (err) {
      toast.error(errMsg(err, t("fl.err.load")))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const openDialog = (link?: FunLink) => {
    if (link) {
      setEditId(link.id)
      setDraft({
        title: link.title,
        url: link.url,
        description: link.description,
        category: link.category,
        iconUrl: link.iconUrl,
        sortOrder: String(link.sortOrder),
        enabled: link.enabled,
      })
    } else {
      setEditId(null)
      setDraft({
        title: "",
        url: "",
        description: "",
        category: "tool",
        iconUrl: "",
        // 新增默认排到最后
        sortOrder: String((links?.length ?? 0) * 10),
        enabled: true,
      })
    }
    setOpen(true)
  }

  const handleProbe = async () => {
    const url = draft.url.trim()
    if (!url) {
      toast.error(t("afl.err.urlFirst"))
      return
    }
    setProbing(true)
    try {
      const res = await adminFunLinksApi.probe(url)
      setDraft((d) => ({
        ...d,
        // 标题和图标识别到就覆盖（点这个按钮本来就是想要它们）
        title: res.title || d.title,
        iconUrl: res.iconUrl || d.iconUrl,
        // 一句话说明只在空着时补：别把你自己写的那句冲掉
        description: d.description.trim() ? d.description : res.description,
      }))
      if (res.title) {
        toast.success(t("afl.ok.recognized", { title: res.title }))
      } else if (res.iconUrl) {
        toast.success(t("afl.ok.iconOnly"))
      } else {
        toast.warning(t("afl.warn.nothing"))
      }
    } catch (err) {
      toast.error(errMsg(err, t("afl.err.recognize")))
    } finally {
      setProbing(false)
    }
  }

  const handleSave = async () => {
    if (!draft.title.trim() || !draft.url.trim()) {
      toast.error(t("afl.err.nameUrl"))
      return
    }
    setBusy(true)
    try {
      const payload = {
        title: draft.title.trim(),
        url: draft.url.trim(),
        description: draft.description.trim(),
        category: draft.category,
        iconUrl: draft.iconUrl.trim(),
        sortOrder: Number(draft.sortOrder) || 0,
        enabled: draft.enabled,
      }
      if (editId) {
        await adminFunLinksApi.update(editId, payload)
        toast.success(t("cm.ok.updated"))
      } else {
        await adminFunLinksApi.create(payload)
        toast.success(t("afl.ok.added"))
      }
      setOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("em.err.save")))
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = async (link: FunLink) => {
    try {
      await adminFunLinksApi.update(link.id, { enabled: !link.enabled })
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("em.err.op")))
    }
  }

  const handleDelete = async (link: FunLink) => {
    if (!confirm(t("afl.confirmDelete", { title: link.title }))) return
    try {
      await adminFunLinksApi.remove(link.id)
      toast.success(t("at.ok.deleted"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("em.err.delete")))
    }
  }

  const enabledCount = (links ?? []).filter((l) => l.enabled).length

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">{t("toolbox.funLinks.name")}</CardTitle>
              <CardDescription>
                {t("afl.desc", { total: links?.length ?? 0, enabled: enabledCount })}
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => openDialog()}>
              <Plus className="h-4 w-4" />
              {t("afl.add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !links ? (
            <LoadingBlock />
          ) : (links?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={t("afl.empty")}
              description={t("afl.emptyDesc")}
            />
          ) : (
            <div className="divide-y rounded-md border">
              {links!.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span className="w-12 shrink-0 text-center font-mono text-xs text-muted-foreground">
                    {l.sortOrder}
                  </span>
                  <FunLinkIcon
                    src={l.iconUrl ? funLinkIconUrl(l.id) : null}
                    title={l.title}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{l.title}</span>
                      <Badge variant="outline">{t(funLinkCategoryLabel(l.category))}</Badge>
                      {!l.enabled && <Badge variant="secondary">{t("afl.unlisted")}</Badge>}
                    </div>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:underline"
                    >
                      {l.url}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                    {l.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {l.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => void handleToggle(l)}
                    >
                      {l.enabled ? t("afl.unlist") : t("afl.list")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={t("common.edit")}
                      onClick={() => openDialog(l)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label={t("common.delete")}
                      onClick={() => void handleDelete(l)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? t("afl.edit") : t("afl.add")}</DialogTitle>
            <DialogDescription>
              {t("afl.dlg.note")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="flTitle">{t("afl.dlg.title")}</Label>
              <Input
                id="flTitle"
                placeholder={t("afl.dlg.titlePh")}
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="flUrl">{t("afl.dlg.url")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={probing || !draft.url.trim()}
                  onClick={() => void handleProbe()}
                >
                  {probing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="h-3.5 w-3.5" />
                  )}
                  {probing ? t("afl.dlg.probing") : t("afl.dlg.autoDetect")}
                </Button>
              </div>
              <Input
                id="flUrl"
                className="font-mono text-xs"
                placeholder="https://example.com"
                value={draft.url}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                {t("afl.dlg.detectHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="flIcon">{t("afl.dlg.icon")}</Label>
              <div className="flex items-center gap-2">
                <FunLinkIcon
                  src={draft.iconUrl.trim() || null}
                  title={draft.title}
                  size={36}
                  className="border"
                />
                <Input
                  id="flIcon"
                  className="font-mono text-xs"
                  placeholder={t("afl.dlg.iconPh")}
                  value={draft.iconUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, iconUrl: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="flDesc">{t("afl.dlg.desc")}</Label>
              <Textarea
                id="flDesc"
                rows={2}
                placeholder={t("afl.dlg.descPh")}
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="flCategory">{t("afl.dlg.category")}</Label>
                <Select
                  value={draft.category}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, category: v as FunLinkCategory }))
                  }
                >
                  <SelectTrigger id="flCategory">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FUN_LINK_CATEGORIES.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {t(c.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="flSort">{t("afl.dlg.sort")}</Label>
                <Input
                  id="flSort"
                  type="number"
                  value={draft.sortOrder}
                  onChange={(e) => setDraft((d) => ({ ...d, sortOrder: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm font-medium">{t("afl.list")}</span>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {editId ? t("common.save") : t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
