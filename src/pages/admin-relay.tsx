/**
 * 管理面板 → 中转站入驻（审核制，2026-10-16 站长要求）。
 *
 * 背景：中转站登记原本「入驻即生效」——任何登录用户填一把管理员令牌 + 一个地址，
 * 他的站就出现在所有人的「去看看其他中转站」列表里。现在改为
 * **入驻 → 待审核 → 站长批准后才生效**，本站长面板就是那道闸。
 *
 * 两件事在这里分开做，界面上也不混：
 *   · **审核**：批准 / 拒绝（拒绝必须写理由，理由会展示给登记人）—— 一次性判定；
 *   · **启用 / 停用**：已进体系的站随时可以刹车（批准之后也仍然有效）—— 两把锁。
 *
 * 🔒 安全口径（改这个文件之前先读）：
 *   · `token_enc` 是**管理员令牌的密文**，等价于对方站的管理权。
 *     这里**不显示、不下载、不解密**它 —— 界面上只显示站点地址，
 *     并且明确告诉站长「令牌不回显」；要换令牌由登记人自己在用户侧编辑。
 *   · 这一页的每个接口都要求 `newapi.subscriptions` 权限域（后端 assertAdminScope），
 *     所以侧边栏入口复用的是 `newapi` 那一栏的可见性判断。
 */
import * as React from "react"
import { toast } from "sonner"
import { Check, Loader2, RefreshCw, Search, ShieldCheck, ShieldX } from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  adminRelayApi,
  errMsg,
  type AdminRelayProvider,
  type RelayReviewStatus,
} from "@/services/api"
import { useT } from "@/i18n"
import { fmtTime } from "@/lib/format"

/** 审核态徽章：三种颜色的语义与用户侧一致（绿=可用、灰=等、红=否） */
function ReviewBadge({ status }: { status: RelayReviewStatus }) {
  const { t } = useT()
  if (status === "approved") {
    return (
      <Badge className="bg-emerald-600/90 text-white hover:bg-emerald-600/90">
        {t("adm.relay.status.approved")}
      </Badge>
    )
  }
  if (status === "rejected") {
    return <Badge variant="destructive">{t("adm.relay.status.rejected")}</Badge>
  }
  return <Badge variant="secondary">{t("adm.relay.status.pending")}</Badge>
}

export function RelayAdminPanel() {
  const { t } = useT()
  const [providers, setProviders] = React.useState<AdminRelayProvider[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  /** 正在处理中的行 id（按钮转圈 + 防重复点击） */
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const [keyword, setKeyword] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<"all" | RelayReviewStatus>("all")

  /** 拒绝弹窗的目标行 + 理由输入 */
  const [rejectTarget, setRejectTarget] = React.useState<AdminRelayProvider | null>(null)
  const [rejectNote, setRejectNote] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminRelayApi.list()
      setProviders(res.providers)
    } catch (err) {
      toast.error(errMsg(err, t("adm.relay.err.load")))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const list = providers ?? []
  const pendingCount = list.filter((p) => p.reviewStatus === "pending").length

  const q = keyword.trim().toLowerCase()
  const filtered = list.filter((p) => {
    if (statusFilter !== "all" && p.reviewStatus !== statusFilter) return false
    if (!q) return true
    // 搜索只覆盖「名称 / 所有者」两项：地址含密钥风险（有的站把 token 写在 query 里），
    // 而且站长找人时脑子里想的就是这两个。
    return (
      p.name.toLowerCase().includes(q) || (p.ownerUsername ?? "").toLowerCase().includes(q)
    )
  })

  /** 批准 / 拒绝的统一入口；拒绝走弹窗（理由必填） */
  const review = async (p: AdminRelayProvider, action: "approve" | "reject", note?: string) => {
    setBusyId(p.id)
    try {
      await adminRelayApi.review(p.id, action, note)
      toast.success(action === "approve" ? t("adm.relay.ok.approved") : t("adm.relay.ok.rejected"))
      setRejectTarget(null)
      setRejectNote("")
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("adm.relay.err.op")))
    } finally {
      setBusyId(null)
    }
  }

  const toggleEnabled = async (p: AdminRelayProvider) => {
    setBusyId(p.id)
    try {
      const res = await adminRelayApi.setEnabled(p.id, !p.enabled)
      if (res.enabled && !res.usable) {
        // 已启用但还没批准 ⇒ 用户侧依然不可用。这里必须说清楚，
        // 否则站长会以为「我恢复了它怎么还是 403」。
        toast.warning(t("adm.relay.warn.notApproved"))
      } else {
        toast.success(res.enabled ? t("adm.relay.ok.enabled") : t("adm.relay.ok.disabled"))
      }
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("adm.relay.err.op")))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            {t("adm.relay.title")}
          </CardTitle>
          <CardDescription>{t("adm.relay.desc")}</CardDescription>
          {pendingCount > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("adm.relay.pendingCount", { n: String(pendingCount) })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="w-56 pl-8"
              placeholder={t("adm.relay.search")}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as "all" | RelayReviewStatus)}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("adm.relay.filter.all")}</SelectItem>
              <SelectItem value="pending">{t("adm.relay.filter.pending")}</SelectItem>
              <SelectItem value="approved">{t("adm.relay.filter.approved")}</SelectItem>
              <SelectItem value="rejected">{t("adm.relay.filter.rejected")}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("adm.relay.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 令牌永不回显 —— 这句话要挂在列表旁边，站长才知道这里看不到 Key 是设计如此 */}
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("adm.relay.tokenNote")}
        </p>

        {providers === null ? (
          <LoadingBlock variant="table" />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={list.length === 0 ? t("adm.relay.empty") : t("adm.relay.emptyFiltered")}
            icon={ShieldCheck}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adm.relay.col.name")}</TableHead>
                  <TableHead>{t("adm.relay.col.kind")}</TableHead>
                  <TableHead>{t("adm.relay.col.baseUrl")}</TableHead>
                  <TableHead>{t("adm.relay.col.owner")}</TableHead>
                  <TableHead>{t("adm.relay.col.review")}</TableHead>
                  <TableHead>{t("adm.relay.col.enabled")}</TableHead>
                  <TableHead>{t("adm.relay.col.sort")}</TableHead>
                  <TableHead>{t("adm.relay.col.created")}</TableHead>
                  <TableHead className="text-right">{t("adm.relay.col.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => {
                  const busy = busyId === p.id
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{t(`relayp.kind.${p.kind}`)}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground">
                        {p.baseUrl}
                      </TableCell>
                      <TableCell className="text-sm">{p.ownerUsername ?? "—"}</TableCell>
                      <TableCell className="space-y-1">
                        <ReviewBadge status={p.reviewStatus} />
                        {/* 拒绝理由：站长复核「上次为什么拒的」唯一的地方 */}
                        {p.reviewStatus === "rejected" && p.reviewNote && (
                          <p className="max-w-[16rem] text-xs text-muted-foreground">
                            {t("adm.relay.reason", { note: p.reviewNote })}
                          </p>
                        )}
                        {p.reviewedAt && (
                          <p className="text-[11px] text-muted-foreground">
                            {t("adm.relay.reviewedAt", { time: fmtTime(p.reviewedAt) })}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {p.enabled ? (
                          <Badge variant="secondary">{t("adm.relay.enabledOn")}</Badge>
                        ) : (
                          <Badge variant="destructive">{t("adm.relay.enabledOff")}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-muted-foreground">
                        {p.sort}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(p.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-2">
                          {p.reviewStatus !== "approved" && (
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => void review(p, "approve")}
                            >
                              {busy ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {t("adm.relay.approve")}
                            </Button>
                          )}
                          {p.reviewStatus !== "rejected" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => {
                                setRejectTarget(p)
                                setRejectNote("")
                              }}
                            >
                              <ShieldX className="mr-1.5 h-3.5 w-3.5" />
                              {t("adm.relay.reject")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant={p.enabled ? "ghost" : "outline"}
                            disabled={busy}
                            onClick={() => void toggleEnabled(p)}
                          >
                            {p.enabled ? t("adm.relay.disable") : t("adm.relay.enable")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* 拒绝：理由必填（后端也拦），因为它是登记人唯一能据以修改的东西 */}
      <Dialog open={rejectTarget !== null} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("adm.relay.reject.title", { name: rejectTarget?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("adm.relay.reject.desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="relay-reject-note">{t("adm.relay.reject.note")}</Label>
            <Input
              id="relay-reject-note"
              value={rejectNote}
              maxLength={200}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder={t("adm.relay.reject.notePh")}
            />
            <p className="text-xs text-muted-foreground">{t("adm.relay.reject.noteHint")}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectTarget(null)}
              disabled={busyId !== null}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busyId !== null || !rejectNote.trim()}
              onClick={() =>
                rejectTarget && void review(rejectTarget, "reject", rejectNote.trim())
              }
            >
              {busyId !== null && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("adm.relay.reject.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
