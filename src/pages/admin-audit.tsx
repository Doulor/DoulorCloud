/**
 * 管理面板 →「管理审计」。
 *
 * 独立文件（同 admin-feedback.tsx 的考量）：admin.tsx 已 6000+ 行，且常有别人在改。
 *
 * 展示 audit_logs 里「管理员/站长作为操作者」的记录，按时间倒序成时间线。
 * 也支持切到「全部」看普通用户的敏感操作，以及按动作前缀（donation. / admin. …）筛选。
 *
 * ⚠️ 关于回退：**本页只做展示，不提供回退按钮**——不是不做，是现在做不了。
 * audit_logs 只存了 `action + detail`（人类可读文本），没有变更前后的结构化快照：
 * 删掉的子域名、被覆盖的设置旧值都无法从这条记录恢复。要做「单个/批量回退」，
 * 前提是先让各写入点把 before/after 记进日志（那是逐个 handler 的改造），
 * 且删除类、外部系统类（NewAPI/CF/邮件）操作本质上不可逆。见页面底部的说明。
 */
import * as React from "react"
import { toast } from "sonner"
import { ChevronLeft, ChevronRight, History, RefreshCw, ScrollText } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { LoadingBlock } from "@/components/loading-block"
import { EmptyState } from "@/components/empty-state"
import { auditApi, HttpError } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import type { AdminAuditData } from "@/types"
import { useT, tStatic } from "@/i18n"

/** 操作者徽章：管理员 / 超级管理员 / 站长 */
function actorRoleBadge(role: string) {
  if (role === "root") return tStatic("au.role.root")
  if (role === "superadmin") return tStatic("au.role.superadmin")
  if (role === "admin") return tStatic("au.role.admin")
  return ""
}

export function AuditPanel() {
  const { t } = useT()
  const [data, setData] = React.useState<AdminAuditData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [scope, setScope] = React.useState<"admins" | "all">("admins")
  /**
   * 类型筛选："" 全部 / "__mgmt__" 仅管理面板操作 / 其他值 = 具体动作前缀。
   * 用哨兵值而不是单独一个布尔，因为下拉里三个选项互斥、同一时刻只生效一个。
   */
  const [actionFilter, setActionFilter] = React.useState("")
  const [page, setPage] = React.useState(1)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(
        await auditApi.list({
          scope,
          mgmt: actionFilter === "__mgmt__" || undefined,
          action: actionFilter && actionFilter !== "__mgmt__" ? actionFilter : undefined,
          page,
        })
      )
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("au.err.load"))
    } finally {
      setLoading(false)
    }
  }, [scope, actionFilter, page])

  React.useEffect(() => {
    void load()
  }, [load])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* 范围切换 */}
          <Select
            value={scope}
            onValueChange={(v) => {
              setScope(v as "admins" | "all")
              setPage(1)
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admins">{t("au.onlyAdmins")}</SelectItem>
              <SelectItem value="all">{t("au.allRecords")}</SelectItem>
            </SelectContent>
          </Select>
          {/* 操作类型筛选 */}
          <Select
            value={actionFilter || "all"}
            onValueChange={(v) => {
              setActionFilter(v === "all" ? "" : v)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder={t("au.allActions")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("au.allActions")}</SelectItem>
              <SelectItem value="__mgmt__">{t("au.onlyMgmt")}</SelectItem>
              {(data?.actions ?? []).map((a) => (
                <SelectItem key={a.action} value={a.action}>
                  {a.action}（{a.c}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      {loading && !data ? (
        <LoadingBlock variant="list" />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={t("au.empty")}
          description={t("au.emptyDesc")}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4 text-muted-foreground" />
              {t("au.timeline")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            {data.items.map((it, i) => {
              const badge = actorRoleBadge(it.role)
              return (
                <div key={it.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {/* 时间线竖线（最后一条不画） */}
                  {i < data.items.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="absolute left-[7px] top-5 h-full w-px bg-border"
                    />
                  )}
                  <span
                    aria-hidden="true"
                    className="relative mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-primary/60 bg-background"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-medium">{it.nickname || it.username}</span>
                      {badge && (
                        <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                          {badge}
                        </span>
                      )}
                      <span className="rounded bg-primary/10 px-1.5 py-px font-mono text-[10px] text-primary">
                        {it.action}
                      </span>
                      <span className="text-muted-foreground">{fmtDateTime(it.createdAt)}</span>
                      {it.ip && (
                        <span className="font-mono text-[10px] text-muted-foreground/60">
                          {it.ip}
                        </span>
                      )}
                    </div>
                    {it.detail && (
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground/90">
                        {it.detail}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* 分页 */}
      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t("common.prev")}
          </Button>
          <span className="tabular-nums">
            {t("au.pageInfo", { page: data.page, total: totalPages, n: data.total })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("common.next")}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* 为什么没有回退按钮（诚实说明边界） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("au.rollback.title")}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          <p>
            {t("au.rollback.p1")}
          </p>
          <p className="mt-1.5">
            {t("au.rollback.p2")}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
