import * as React from "react"
import { Link } from "react-router-dom"
import { Search, Wrench } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CATEGORIES, TOOLS, type ToolCategory } from "@/lib/toolbox/registry"
import { cn } from "@/lib/utils"

/**
 * 工具箱首页：顶部按分类切换，下面是一格一格的工具卡片。
 *
 * 所有工具都在浏览器里跑，打开本页不会产生任何服务端请求 ——
 * 每个工具的代码是独立的懒加载分包，不点进去就不会下载。
 */
export default function ToolboxPage() {
  const [tab, setTab] = React.useState<ToolCategory | "all">("all")
  const [keyword, setKeyword] = React.useState("")

  const counts = React.useMemo(() => {
    const m: Record<string, number> = { all: TOOLS.length }
    for (const t of TOOLS) m[t.category] = (m[t.category] ?? 0) + 1
    return m
  }, [])

  const list = React.useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return TOOLS.filter((t) => {
      if (tab !== "all" && t.category !== tab) return false
      if (!kw) return true
      return `${t.name} ${t.desc} ${t.id}`.toLowerCase().includes(kw)
    })
  }, [tab, keyword])

  return (
    <div className="space-y-6">
      <PageHeader
        title="工具箱"
        description="常用的小工具集合，全部在你的浏览器里运行，文件不会上传"
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as ToolCategory | "all")}>
          <TabsList className="h-auto flex-wrap justify-start">
            {CATEGORIES.map((c) => (
              <TabsTrigger key={c.id} value={c.id} className="gap-1.5">
                {c.label}
                <span className="text-[11px] text-muted-foreground">{counts[c.id] ?? 0}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索工具…"
            className="pl-9"
          />
        </div>
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Wrench className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">没有找到匹配的工具</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolCard({ tool }: { tool: (typeof TOOLS)[number] }) {
  const to = tool.href ?? `/dashboard/toolbox/${tool.id}`
  return (
    <Link
      to={to}
      className="group flex flex-col gap-3 rounded-lg border bg-card p-4 transition-all hover:border-primary/50 hover:bg-accent/30"
    >
      <span
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-lg",
          tool.tone
        )}
      >
        <tool.icon className="h-5 w-5" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium leading-tight">{tool.name}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{tool.desc}</p>
      </div>
    </Link>
  )
}
