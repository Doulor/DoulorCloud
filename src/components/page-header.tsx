import * as React from "react"
import { SplitText } from "@/components/motion/split-text"

interface PageHeaderProps {
  title: string
  description?: string
  actions?: React.ReactNode
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        {/* 动效层：标题逐字浮现（关=现状：span 静止且 inline，渲染与纯文本一致） */}
        <h1 className="text-2xl font-semibold tracking-tight">
          <SplitText text={title} />
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
