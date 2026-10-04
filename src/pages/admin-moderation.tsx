import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Trash2,
  UserX,
  X,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { adminApi, adminModerationApi, errMsg } from "@/services/api"
import { useT } from "@/i18n"
import type {
  AccountAppeal,
  RiskAccount,
  ModerationLists,
  ModerationConditionOp,
  ModerationConditionMetric,
} from "@/types"

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-CN") : "—"

/** 风险等级 → 文案 key + Badge 样式（label 在组件内用 t() 取，切语言才会跟着变） */
const LEVEL_META: Record<
  RiskAccount["riskLevel"],
  { key: string; variant: "default" | "secondary" | "destructive" }
> = {
  high: { key: "mod.level.high", variant: "destructive" },
  medium: { key: "mod.level.medium", variant: "default" },
  low: { key: "mod.level.low", variant: "secondary" },
}

const RISK_STATUS_KEY: Record<RiskAccount["status"], string> = {
  open: "mod.status.open",
  watching: "mod.status.watching",
  banned: "mod.status.banned",
  cleared: "mod.status.cleared",
}

/** 解析 reasons（JSON 字符串数组），坏数据不抛错 */
function parseReasons(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.map((x) => String(x)) : [raw]
  } catch {
    return [raw]
  }
}

/**
 * 管理面板「监管」栏目。
 *
 * 两块内容：
 *   · 风险账户 —— `risk-scan.ts` 每 10 分钟从中转站日志里扫出来的异常账号
 *   · 封禁申诉 —— 被封禁用户在登录页/`/appeal` 提交的申诉，通过即解封
 *
 * 这个栏目刻意做成「可以继续往里加东西」的容器：后续新的风控规则
 * （比如异地登录、多账号同 IP）只要往 risk_accounts.reasons 里塞一条即可，
 * 不需要改这里的结构。
 */
export function ModerationAdminPanel() {
  const { t } = useT()
  const [appeals, setAppeals] = React.useState<AccountAppeal[]>([])
  const [risks, setRisks] = React.useState<RiskAccount[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)

  // ---- 白名单 / 自动条件 / 黑名单（2026-10-03 站长要求） ----
  const [lists, setLists] = React.useState<ModerationLists | null>(null)
  const [listBusy, setListBusy] = React.useState(false)
  const [wlInput, setWlInput] = React.useState("")
  const [blInput, setBlInput] = React.useState("")
  const [blReason, setBlReason] = React.useState("")
  const [condMetric, setCondMetric] = React.useState<ModerationConditionMetric>("achievement_points")
  const [condOp, setCondOp] = React.useState<ModerationConditionOp>("gt")
  const [condValue, setCondValue] = React.useState("20")

  const loadLists = React.useCallback(async () => {
    try {
      setLists(await adminModerationApi.lists())
    } catch (err) {
      toast.error(errMsg(err, t("mod.err.load")))
    }
  }, [t])

  React.useEffect(() => {
    void loadLists()
  }, [loadLists])

  /** 列表操作统一包一层：开关 loading、失败提示、成功后重拉（后端会按条件重新同步一次） */
  const runList = async (fn: () => Promise<unknown>) => {
    setListBusy(true)
    try {
      await fn()
      await loadLists()
    } catch (err) {
      toast.error(errMsg(err, t("mod.err.load")))
    } finally {
      setListBusy(false)
    }
  }

  const addWhitelist = () =>
    runList(async () => {
      await adminModerationApi.whitelistUpdate("add", wlInput.trim())
      setWlInput("")
      toast.success(t("mod.wl.added"))
    })
  const removeWhitelist = (username: string) =>
    runList(() => adminModerationApi.whitelistUpdate("remove", username))
  const addCondition = () =>
    runList(() =>
      adminModerationApi.conditionUpdate({
        action: "create",
        metric: condMetric,
        op: condOp,
        value: Math.trunc(Number(condValue) || 0),
      })
    )
  const toggleCondition = (id: string, enabled: boolean) =>
    runList(() => adminModerationApi.conditionUpdate({ action: "toggle", id, enabled }))
  const deleteCondition = (id: string) =>
    runList(() => adminModerationApi.conditionUpdate({ action: "delete", id }))
  const addBlacklist = () =>
    runList(async () => {
      await adminModerationApi.blacklistUpdate("add", blInput.trim(), blReason.trim())
      setBlInput("")
      setBlReason("")
    })
  const removeBlacklist = (ip: string) =>
    runList(() => adminModerationApi.blacklistUpdate("remove", ip))

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [a, r] = await Promise.all([
        adminModerationApi.appeals(),
        adminModerationApi.riskAccounts(),
      ])
      setAppeals(a.appeals)
      setRisks(r.accounts)
    } catch (err) {
      toast.error(errMsg(err, t("mod.err.load")))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  // 处理弹窗（2026-10-02 加）：回复要展示给被封禁的用户，所以走弹窗填写而不是直接 confirm
  const [reviewTarget, setReviewTarget] = React.useState<{
    appeal: AccountAppeal
    action: "accept" | "reject"
  } | null>(null)
  const [reviewNote, setReviewNote] = React.useState("")
  const [reviewBusy, setReviewBusy] = React.useState(false)

  /** 打开处理弹窗 */
  const openReview = (a: AccountAppeal, action: "accept" | "reject") => {
    setReviewTarget({ appeal: a, action })
    setReviewNote("")
  }

  /**
   * 提交处理结果（带管理员回复）。
   *
   * ⚠️ **驳回必须写理由**：被封禁的用户登不进来、收不到站内信，
   *    登录页的这段回复是他唯一能看到处理结果的地方。
   *    不写理由等于他申诉完什么也等不到 —— 那正是这次要修的问题。
   *    （通过时可以不写，因为那时他已经能登录了。）
   */
  const submitReview = async () => {
    const tgt = reviewTarget
    if (!tgt) return
    const note = reviewNote.trim()
    if (!note && tgt.action === "reject") {
      toast.error(t("mod.needRejectNote"))
      return
    }
    setReviewBusy(true)
    try {
      const res = await adminModerationApi.reviewAppeal(
        tgt.appeal.id,
        tgt.action,
        note || undefined
      )
      if (tgt.action === "accept") {
        toast.success(res.unblocked ? t("mod.ok.accepted") : t("mod.ok.acceptedNoChange"))
      } else {
        toast.success(t("mod.ok.rejected"))
      }
      setReviewTarget(null)
      setReviewNote("")
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("mod.err.review")))
    } finally {
      setReviewBusy(false)
    }
  }

  const setRiskStatus = async (r: RiskAccount, status: RiskAccount["status"]) => {
    setBusy(r.userId)
    try {
      await adminModerationApi.updateRiskStatus(r.userId, status)
      toast.success(t("mod.ok.status", { status: t(RISK_STATUS_KEY[status]) }))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("mod.err.status")))
    } finally {
      setBusy(null)
    }
  }

  const banUser = async (r: RiskAccount) => {
    if (!confirm(t("mod.confirmBan", { username: r.username }))) return
    setBusy(r.userId)
    try {
      await adminApi.updateUser(r.username, { status: "suspended" })
      await adminModerationApi.updateRiskStatus(r.userId, "banned")
      toast.success(t("mod.ok.banned", { username: r.username }))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("mod.err.ban")))
    } finally {
      setBusy(null)
    }
  }

  const pendingAppeals = appeals.filter((a) => a.status === "pending").length
  const openRisks = risks.filter((r) => r.status === "open").length
  const whitelistTotal = lists
    ? lists.whitelist.manual.length +
      lists.whitelist.groups.reduce((n, g) => n + g.users.length, 0)
    : 0
  const blacklistTotal = lists
    ? lists.blacklist.manual.length + lists.blacklist.auto.length
    : 0

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("mod.desc")}</p>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          {t("mod.refresh")}
        </Button>
      </div>

      <Tabs defaultValue="risk">
        <TabsList>
          <TabsTrigger value="risk" className="gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5" />
            {t("mod.tab.risk")}
            {openRisks > 0 && (
              <Badge variant="destructive" className="h-4 px-1 text-[10px] tabular-nums">
                {openRisks}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="appeals" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("mod.tab.appeals")}
            {pendingAppeals > 0 && (
              <Badge variant="destructive" className="h-4 px-1 text-[10px] tabular-nums">
                {pendingAppeals}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="whitelist" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("mod.tab.whitelist")}
            {whitelistTotal > 0 && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums">
                {whitelistTotal}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="blacklist" className="gap-1.5">
            <ShieldBan className="h-3.5 w-3.5" />
            {t("mod.tab.blacklist")}
            {blacklistTotal > 0 && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums">
                {blacklistTotal}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ---- 风险账户 ---- */}
        <TabsContent value="risk" className="mt-4">
          {loading ? (
            <LoadingBlock />
          ) : risks.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={t("mod.risk.empty")}
              description={t("mod.risk.emptyDesc")}
            />
          ) : (
            <div className="space-y-3">
              {risks.map((r) => (
                <Card key={r.userId}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={LEVEL_META[r.riskLevel].variant}>
                        {t("mod.riskTag", { level: t(LEVEL_META[r.riskLevel].key) })}
                      </Badge>
                      <span className="font-medium">{r.username}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("mod.peakScore", { peak: r.peakPerMin, score: r.score })}
                      </span>
                      <Badge variant="outline">{t(RISK_STATUS_KEY[r.status])}</Badge>
                      {r.userStatus === "suspended" && (
                        <Badge variant="destructive">{t("mod.userSuspended")}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {t("mod.lastHit", { time: fmt(r.lastSeenAt) })}
                      </span>
                    </div>
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {parseReasons(r.reasons).map((reason, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                          {reason}
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {r.userStatus !== "suspended" && (
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7"
                          disabled={busy === r.userId}
                          onClick={() => void banUser(r)}
                        >
                          {busy === r.userId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <UserX className="h-3.5 w-3.5" />
                          )}
                          {t("mod.ban")}
                        </Button>
                      )}
                      {r.status !== "watching" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          disabled={busy === r.userId}
                          onClick={() => void setRiskStatus(r, "watching")}
                        >
                          {t("mod.watch")}
                        </Button>
                      )}
                      {r.status !== "cleared" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          disabled={busy === r.userId}
                          onClick={() => void setRiskStatus(r, "cleared")}
                        >
                          {t("mod.clear")}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---- 封禁申诉 ---- */}
        <TabsContent value="appeals" className="mt-4">
          {loading ? (
            <LoadingBlock />
          ) : appeals.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={t("mod.appeal.empty")}
              description={t("mod.appeal.emptyDesc")}
            />
          ) : (
            <div className="space-y-3">
              {appeals.map((a) => (
                <Card key={a.id}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.username}</span>
                      <Badge
                        variant={
                          a.status === "pending"
                            ? "default"
                            : a.status === "accepted"
                              ? "success"
                              : "secondary"
                        }
                      >
                        {a.status === "pending"
                          ? t("mod.appeal.pending")
                          : a.status === "accepted"
                            ? t("mod.appeal.accepted")
                            : t("mod.appeal.rejected")}
                      </Badge>
                      {a.userStatus === "suspended" ? (
                        <Badge variant="destructive">{t("mod.userStillBanned")}</Badge>
                      ) : (
                        <Badge variant="outline">{t("mod.userNormal")}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{fmt(a.createdAt)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{a.content}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("mod.contactIp", {
                        contact: a.contact || t("mod.notFilled"),
                        ip: a.ip || "—",
                      })}
                    </p>
                    {a.reviewNote && (
                      <p className="text-xs text-muted-foreground">
                        {t("mod.reviewNote", { note: a.reviewNote })}
                      </p>
                    )}
                    {a.status === "pending" && (
                      <div className="flex items-center gap-2 pt-1">
                        <Button size="sm" className="h-7" onClick={() => openReview(a, "accept")}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {t("mod.accept")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => openReview(a, "reject")}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          {t("mod.reject")}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
        {/* ---- 白名单（2026-10-03） ---- */}
        <TabsContent value="whitelist" className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">{t("mod.wl.desc")}</p>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder={t("mod.wl.placeholder")}
              value={wlInput}
              onChange={(e) => setWlInput(e.target.value)}
              className="max-w-xs"
            />
            <Button
              size="sm"
              onClick={() => void addWhitelist()}
              disabled={listBusy || !wlInput.trim()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("mod.wl.add")}
            </Button>
          </div>

          {!lists ? (
            <LoadingBlock />
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-2 text-sm font-medium">{t("mod.wl.manualTitle")}</p>
                {lists.whitelist.manual.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("mod.wl.empty")}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {lists.whitelist.manual.map((u) => (
                      <span
                        key={u.username}
                        className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs"
                      >
                        {u.nickname ?? u.username}
                        <span className="text-muted-foreground">@{u.username}</span>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => void removeWhitelist(u.username)}
                          aria-label={t("common.delete")}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {lists.whitelist.groups.map((g) => (
                <div key={g.id} className="rounded-lg border bg-card p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {g.metric === "custom_title"
                        ? t("mod.wl.groupTitleCustom")
                        : t("mod.wl.groupTitle", { op: t(`mod.op.${g.op}`), n: g.value })}
                    </p>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={g.enabled}
                        onCheckedChange={(v) => void toggleCondition(g.id, v)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void deleteCondition(g.id)}
                        aria-label={t("common.delete")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {!g.enabled ? (
                    <p className="text-xs text-muted-foreground">{t("mod.wl.condOff")}</p>
                  ) : g.users.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("mod.wl.empty")}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {g.users.map((u) => (
                        <span
                          key={u.username}
                          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs"
                        >
                          {u.nickname ?? u.username}
                          <span className="text-muted-foreground">@{u.username}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              <div className="rounded-lg border border-dashed p-4">
                <p className="mb-2 text-sm font-medium">{t("mod.wl.newCond")}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={condMetric}
                    onValueChange={(v) => setCondMetric(v as ModerationConditionMetric)}
                  >
                    <SelectTrigger className="h-8 w-36 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="achievement_points">
                        {t("mod.wl.metric.achievement")}
                      </SelectItem>
                      <SelectItem value="custom_title">
                        {t("mod.wl.metric.customTitle")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {condMetric === "achievement_points" && (
                    <>
                      <Select
                        value={condOp}
                        onValueChange={(v) => setCondOp(v as ModerationConditionOp)}
                      >
                        <SelectTrigger className="h-8 w-24 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gt">{t("mod.op.gt")}</SelectItem>
                          <SelectItem value="gte">{t("mod.op.gte")}</SelectItem>
                          <SelectItem value="lt">{t("mod.op.lt")}</SelectItem>
                          <SelectItem value="lte">{t("mod.op.lte")}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min={0}
                        className="h-8 w-20"
                        value={condValue}
                        onChange={(e) => setCondValue(e.target.value)}
                      />
                    </>
                  )}
                  <Button size="sm" onClick={() => void addCondition()} disabled={listBusy}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    {t("mod.wl.addCond")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ---- 黑名单（2026-10-03） ---- */}
        <TabsContent value="blacklist" className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">{t("mod.bl.desc")}</p>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder={t("mod.bl.placeholder")}
              value={blInput}
              onChange={(e) => setBlInput(e.target.value)}
              className="max-w-xs"
            />
            <Input
              placeholder={t("mod.bl.reasonPlaceholder")}
              value={blReason}
              onChange={(e) => setBlReason(e.target.value)}
              className="max-w-xs"
            />
            <Button
              size="sm"
              onClick={() => void addBlacklist()}
              disabled={listBusy || !blInput.trim()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("mod.bl.add")}
            </Button>
          </div>

          {!lists ? (
            <LoadingBlock />
          ) : (
            <div className="space-y-3">
              {(["manual", "auto"] as const).map((src) => {
                const items = lists.blacklist[src]
                return (
                  <div key={src} className="rounded-lg border bg-card p-4">
                    <p className="mb-2 text-sm font-medium">
                      {src === "manual" ? t("mod.bl.manualTitle") : t("mod.bl.autoTitle")}
                    </p>
                    {items.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("mod.bl.empty")}</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {items.map((e) => (
                          <li key={e.ip} className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate font-mono text-xs">{e.ip}</p>
                              {e.reason && (
                                <p className="truncate text-xs text-muted-foreground">{e.reason}</p>
                              )}
                            </div>
                            <button
                              type="button"
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              onClick={() => void removeBlacklist(e.ip)}
                              aria-label={t("common.delete")}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* 处理申诉：填写给用户看的回复（2026-10-02 加） */}
      <Dialog
        open={!!reviewTarget}
        onOpenChange={(o) => {
          if (!o && !reviewBusy) setReviewTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewTarget?.action === "accept"
                ? t("mod.appealDialog.acceptTitle")
                : t("mod.appealDialog.rejectTitle")}
            </DialogTitle>
            {reviewTarget && (
              <DialogDescription>
                {reviewTarget.action === "accept"
                  ? t("mod.appealDialog.acceptDesc", { username: reviewTarget.appeal.username })
                  : t("mod.appealDialog.rejectDesc", { username: reviewTarget.appeal.username })}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="appealNote">{t("mod.appealDialog.noteLabel")}</Label>
            <Textarea
              id="appealNote"
              rows={4}
              maxLength={300}
              placeholder={
                reviewTarget?.action === "accept"
                  ? t("mod.appealDialog.acceptPlaceholder")
                  : t("mod.appealDialog.rejectPlaceholder")
              }
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("mod.appealDialog.noteHint")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewTarget(null)} disabled={reviewBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitReview()} disabled={reviewBusy}>
              {reviewBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {reviewTarget?.action === "accept"
                ? t("mod.appealDialog.accept")
                : t("mod.appealDialog.reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
