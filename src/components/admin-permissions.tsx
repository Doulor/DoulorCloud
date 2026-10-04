/**
 * 管理员权限管理界面（root / superadmin 使用）。
 *
 * 两部分：
 *   1. 权限组：建/改/删权限组、批量套成员。
 *   2. 成员权限：给单个成员设角色 + 引用权限组 + 自定义覆盖（覆盖后标记「自定义」）。
 *
 * 两级勾选：父节点（有 children 的大类）三态（全选 / 半选 / 未选），
 * 子节点单独勾选。白名单语义：只有「勾选 = 拥有」，没有「排除」。
 */
import * as React from "react"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, Plus, Trash2, Loader2, Pencil, Users, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { adminApi, errMsg } from "@/services/api"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"
import type {
  AdminPermGroup,
  AdminPermCategory,
  AdminPermissionGroup,
  AdminPermissionsState,
} from "@/types"

/** 权限组列表里可选成员（用户名 + id） */
interface MemberCandidate {
  id: string
  username: string
  role: string
}

/* ------------------------------------------------------------------ */
/* 两级勾选树                                                          */
/* ------------------------------------------------------------------ */

function PermissionTreePicker({
  categories,
  groups,
  value,
  onChange,
  disabledKeys,
}: {
  categories: AdminPermCategory[]
  groups: AdminPermGroup[]
  value: Set<string>
  onChange: (next: Set<string>) => void
  disabledKeys: Set<string>
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(categories.map((c) => c.key)))

  const toggleLeaf = (key: string) => {
    const next = new Set(value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  const toggleCategory = (cat: AdminPermCategory) => {
    const leaves = cat.children?.map((l) => l.key) ?? [cat.key]
    const allOn = leaves.length > 0 && leaves.every((k) => value.has(k))
    const next = new Set(value)
    for (const k of leaves) {
      if (allOn) next.delete(k)
      else if (!disabledKeys.has(k)) next.add(k)
    }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const cats = categories.filter((c) => c.group === g.key)
        if (cats.length === 0) return null
        return (
          <div key={g.key} className="rounded-lg border">
            <div className="border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
              {g.label}
            </div>
            <div className="px-3 py-1">
              {cats.map((cat) => {
                const leaves = cat.children?.map((l) => l.key) ?? [cat.key]
                const selected = leaves.filter((k) => value.has(k)).length
                const allOn = leaves.length > 0 && selected === leaves.length
                const half = selected > 0 && selected < leaves.length
                const hasChildren = Boolean(cat.children && cat.children.length > 0)
                const expanded = open.has(cat.key)
                return (
                  <div key={cat.key}>
                    <div className="flex items-center gap-1.5 py-1.5">
                      {hasChildren && (
                        <button
                          type="button"
                          onClick={() =>
                            setOpen((prev) => {
                              const next = new Set(prev)
                              if (next.has(cat.key)) next.delete(cat.key)
                              else next.add(cat.key)
                              return next
                            })
                          }
                          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                          aria-label={cat.label}
                        >
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                      <input
                        type="checkbox"
                        ref={(el) => {
                          if (el) el.indeterminate = half
                        }}
                        checked={allOn}
                        onChange={() => toggleCategory(cat)}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="text-sm">{cat.label}</span>
                      {half && (
                        <span className="text-xs text-muted-foreground">
                          {selected}/{leaves.length}
                        </span>
                      )}
                    </div>
                    {hasChildren && expanded && (
                      <div className="ml-7 space-y-0.5 pb-1">
                        {cat.children!.map((leaf) => (
                          <label
                            key={leaf.key}
                            className={cn(
                              "flex items-center gap-2 py-1 text-sm",
                              disabledKeys.has(leaf.key) && "opacity-50"
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={value.has(leaf.key)}
                              disabled={disabledKeys.has(leaf.key)}
                              onChange={() => toggleLeaf(leaf.key)}
                              className="h-4 w-4 accent-primary"
                            />
                            <span>{leaf.label}</span>
                            {leaf.rootOnly && (
                              <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-200">
                                {t("adm.perm.rootOnly")}
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 权限组管理                                                          */
/* ------------------------------------------------------------------ */

function GroupEditorDialog({
  open,
  onClose,
  categories,
  groups,
  existing,
  isRoot,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  categories: AdminPermCategory[]
  groups: AdminPermGroup[]
  existing: AdminPermissionGroup | null
  isRoot: boolean
  onSaved: () => void
}) {
  const { t } = useT()
  const [name, setName] = React.useState(existing?.name ?? "")
  const [scope, setScope] = React.useState<Set<string>>(() => new Set(existing?.scope ?? []))
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setName(existing?.name ?? "")
      setScope(new Set(existing?.scope ?? []))
    }
  }, [open, existing])

  const save = async () => {
    const n = name.trim()
    if (!n) {
      toast.error(t("adm.perm.groupNameRequired"))
      return
    }
    setBusy(true)
    try {
      if (existing) {
        await adminApi.updatePermissionGroup(existing.id, { name: n, scope: Array.from(scope) })
      } else {
        await adminApi.createPermissionGroup(n, Array.from(scope))
      }
      toast.success(t("adm.perm.saved"))
      onSaved()
      onClose()
    } catch (err) {
      toast.error(errMsg(err, t("adm.perm.saveFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? t("adm.perm.editGroup") : t("adm.perm.newGroup")}</DialogTitle>
          <DialogDescription>{t("adm.perm.groupDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pgName">{t("adm.perm.groupName")}</Label>
            <Input id="pgName" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </div>
          <PermissionTreePicker
            categories={categories}
            groups={groups}
            value={scope}
            onChange={setScope}
            disabledKeys={isRoot ? new Set() : new Set()}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* 成员权限编辑                                                        */
/* ------------------------------------------------------------------ */

function MemberEditorDialog({
  open,
  onClose,
  member,
  categories,
  groups,
  permissionGroups,
  isRoot,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  member: MemberCandidate | null
  categories: AdminPermCategory[]
  groups: AdminPermGroup[]
  permissionGroups: AdminPermissionGroup[]
  isRoot: boolean
  onSaved: () => void
}) {
  const { t } = useT()
  const [role, setRole] = React.useState("user")
  const [roleId, setRoleId] = React.useState<string | null>(null)
  const [scope, setScope] = React.useState<Set<string>>(new Set())
  const [custom, setCustom] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open || !member) return
    setLoading(true)
    adminApi
      .getUserAdminPermissions(member.username)
      .then((s: AdminPermissionsState) => {
        setRole(s.role)
        setRoleId(s.adminRoleId)
        setScope(new Set(s.adminScope))
        setCustom(s.custom)
      })
      .catch((err) => toast.error(errMsg(err, t("adm.perm.loadFailed"))))
      .finally(() => setLoading(false))
  }, [open, member, t])

  const save = async () => {
    if (!member) return
    setBusy(true)
    try {
      const payload: { role?: string; adminRoleId?: string | null; adminScope?: string[] } = {}
      payload.role = role
      if (role === "admin") {
        if (custom) {
          payload.adminScope = Array.from(scope)
          payload.adminRoleId = roleId
        } else {
          payload.adminScope = []
          payload.adminRoleId = roleId
        }
      }
      await adminApi.setUserAdminPermissions(member.username, payload)
      toast.success(t("adm.perm.saved"))
      onSaved()
      onClose()
    } catch (err) {
      toast.error(errMsg(err, t("adm.perm.saveFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {member ? member.username : ""} {t("adm.perm.title")}
          </DialogTitle>
          <DialogDescription>{t("adm.perm.memberDesc")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("adm.perm.role")}</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { v: "user", label: t("adm.perm.roleUser") },
                  { v: "admin", label: t("adm.perm.roleAdmin") },
                  ...(isRoot ? [{ v: "superadmin", label: t("adm.perm.roleSuperadmin") }] : []),
                ].map((r) => (
                  <button
                    key={r.v}
                    type="button"
                    onClick={() => setRole(r.v)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-sm transition-colors",
                      role === r.v
                        ? "border-primary bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/50"
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {role === "admin" && (
              <>
                <div className="space-y-1.5">
                  <Label>{t("adm.perm.groupRef")}</Label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setRoleId(null)
                        setCustom(true)
                      }}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-sm",
                        roleId === null && custom
                          ? "border-primary bg-accent font-medium"
                          : "text-muted-foreground hover:bg-accent/50"
                      )}
                    >
                      {t("adm.perm.noGroup")}
                    </button>
                    {permissionGroups.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          setRoleId(g.id)
                          setCustom(false)
                        }}
                        className={cn(
                          "rounded-md border px-3 py-1.5 text-sm",
                          roleId === g.id && !custom
                            ? "border-primary bg-accent font-medium"
                            : "text-muted-foreground hover:bg-accent/50"
                        )}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={custom}
                    onChange={(e) => {
                      setCustom(e.target.checked)
                      if (e.target.checked) {
                        setScope(new Set(permissionGroups.find((g) => g.id === roleId)?.scope ?? []))
                      }
                    }}
                    className="h-4 w-4 accent-primary"
                  />
                  {t("adm.perm.customOverride")}
                </label>
                {custom && (
                  <div className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {t("adm.perm.customHint")}
                  </div>
                )}
                {custom && (
                  <PermissionTreePicker
                    categories={categories}
                    groups={groups}
                    value={scope}
                    onChange={setScope}
                    disabledKeys={new Set()}
                  />
                )}
              </>
            )}
            {!custom && role === "admin" && roleId && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t("adm.perm.inheritFrom", { name: permissionGroups.find((g) => g.id === roleId)?.name ?? "" })}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                {t("common.save")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* 主面板                                                              */
/* ------------------------------------------------------------------ */

export function AdminPermissionsPanel({ isRoot }: { isRoot: boolean }) {
  const { t } = useT()
  const [categories, setCategories] = React.useState<AdminPermCategory[]>([])
  const [groups, setGroups] = React.useState<AdminPermGroup[]>([])
  const [permissionGroups, setPermissionGroups] = React.useState<AdminPermissionGroup[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editor, setEditor] = React.useState<AdminPermissionGroup | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [memberOpen, setMemberOpen] = React.useState(false)
  const [member, setMember] = React.useState<MemberCandidate | null>(null)
  const [memberSearch, setMemberSearch] = React.useState("")
  const [candidates, setCandidates] = React.useState<MemberCandidate[]>([])
  /** superadmin 能否管权限组（默认关，root 可切换） */
  const [superadminCanManage, setSuperadminCanManage] = React.useState(false)
  const [toggleBusy, setToggleBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const [tree, pg, settings] = await Promise.all([
        adminApi.getPermissionTree(),
        adminApi.listPermissionGroups(),
        isRoot ? adminApi.getSettings() : Promise.resolve(null),
      ])
      setCategories(tree.categories)
      setGroups(tree.groups)
      setPermissionGroups(pg.groups)
      if (settings) {
        setSuperadminCanManage(settings.settings.superadmin_manage_permission_groups === "1")
      }
    } catch (err) {
      toast.error(errMsg(err, t("adm.perm.loadFailed")))
    } finally {
      setLoading(false)
    }
  }, [t, isRoot])

  React.useEffect(() => {
    void load()
  }, [load])

  const toggleSuperadminCanManage = async (v: boolean) => {
    setToggleBusy(true)
    try {
      await adminApi.updateSettings({ superadmin_manage_permission_groups: v ? "1" : "0" })
      setSuperadminCanManage(v)
      toast.success(t("adm.perm.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("adm.perm.saveFailed")))
    } finally {
      setToggleBusy(false)
    }
  }

  const searchMembers = async (q: string) => {
    setMemberSearch(q)
    if (q.trim().length < 1) {
      setCandidates([])
      return
    }
    try {
      const res = await adminApi.listUsers()
      setCandidates(
        res.users
          .filter((u) => u.username.toLowerCase().includes(q.trim().toLowerCase()))
          .slice(0, 10)
          .map((u) => ({ id: u.id, username: u.username, role: u.role }))
      )
    } catch {
      /* 静默 */
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {isRoot && (
        <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
          <div className="text-sm">
            <div className="font-medium">{t("adm.perm.superadminToggle")}</div>
            <div className="text-xs text-muted-foreground">{t("adm.perm.superadminToggleHint")}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={superadminCanManage}
            disabled={toggleBusy}
            onClick={() => void toggleSuperadminCanManage(!superadminCanManage)}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors",
              superadminCanManage ? "bg-primary" : "bg-muted-foreground/30"
            )}
          >
            <span
              className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
              style={{ left: superadminCanManage ? "22px" : "2px" }}
            />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">{t("adm.perm.groups")}</h3>
          <p className="text-xs text-muted-foreground">{t("adm.perm.groupsDesc")}</p>
        </div>
        <Button size="sm" onClick={() => { setEditor(null); setEditorOpen(true) }}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("adm.perm.newGroup")}
        </Button>
      </div>

      {permissionGroups.length === 0 ? (
        <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          {t("adm.perm.noGroups")}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {permissionGroups.map((g) => (
            <div key={g.id} className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{g.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t("adm.perm.groupMeta", { n: g.memberCount, m: g.scope.length })}
                </span>
              </div>
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => { setEditor(g); setEditorOpen(true) }}>
                  <Pencil className="mr-1 h-3 w-3" />
                  {t("common.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (!confirm(t("adm.perm.deleteConfirm", { name: g.name }))) return
                    try {
                      await adminApi.deletePermissionGroup(g.id)
                      toast.success(t("adm.perm.deleted"))
                      void load()
                    } catch (err) {
                      toast.error(errMsg(err, t("adm.perm.saveFailed")))
                    }
                  }}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  {t("common.delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t pt-6">
        <h3 className="text-sm font-medium">{t("adm.perm.memberTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("adm.perm.memberHint")}</p>
        <div className="mt-3 flex max-w-sm gap-2">
          <Input
            placeholder={t("adm.perm.searchPlaceholder")}
            value={memberSearch}
            onChange={(e) => void searchMembers(e.target.value)}
          />
        </div>
        {candidates.length > 0 && (
          <div className="mt-2 max-w-sm space-y-1 rounded-lg border p-1">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setMember(c)
                  setMemberOpen(true)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{c.username}</span>
                <Badge variant="outline" className="ml-auto text-[10px]">
                  {c.role}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      <GroupEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        categories={categories}
        groups={groups}
        existing={editor}
        isRoot={isRoot}
        onSaved={() => void load()}
      />
      <MemberEditorDialog
        open={memberOpen}
        onClose={() => setMemberOpen(false)}
        member={member}
        categories={categories}
        groups={groups}
        permissionGroups={permissionGroups}
        isRoot={isRoot}
        onSaved={() => void load()}
      />
    </div>
  )
}
