import * as React from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, ShieldCheck } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * 工具详情页的统一外壳：返回入口 + 标题 + 说明 + 隐私提示。
 *
 * 「本地运行」提示刻意做成默认展示 —— 工具箱里绝大多数工具都在用户自己的
 * 设备上算，明说出来能显著降低「上传文件会不会泄露」的顾虑。
 */
export function ToolShell({
  title,
  description,
  local = true,
  children,
  wide,
}: {
  title: string
  description?: string
  /** 是否在浏览器本地处理（默认是）；纯在线查询类工具传 false */
  local?: boolean
  children: React.ReactNode
  /** 宽版布局：拼图 / 长图这类需要横向铺开的工具用 */
  wide?: boolean
}) {
  return (
    <div className={cn("space-y-6", wide ? "w-full" : "")}>
      <div className="space-y-3">
        <Link
          to="/dashboard/toolbox"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回工具箱
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {local && (
          <p className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            本工具在你的浏览器本地运行，文件不会上传到服务器
          </p>
        )}
      </div>
      {children}
    </div>
  )
}

/** 工具页里的分区标题 */
export function ToolSection({
  title,
  children,
  actions,
}: {
  title?: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="glass-card space-y-3 rounded-lg border p-4">
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-medium">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}
