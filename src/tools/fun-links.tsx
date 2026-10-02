import * as React from "react"
import { ExternalLink, Loader2, Search, Sparkles } from "lucide-react"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { FunLinkIcon } from "@/components/fun-link-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FUN_LINK_CATEGORIES, type FunLinkCategory } from "@/lib/fun-links"
import { funLinkIconUrl, funLinksApi, type FunLink } from "@/services/api"
import { useT } from "@/i18n"

/**
 * 有趣的网页分享。
 *
 * 与工具箱里其它工具不同，这个**不是纯前端**的：列表由站长在管理面板维护，
 * 所以打开时要拉一次接口（ToolShell 的 `local={false}` 会去掉「本地运行」提示）。
 *
 * 列表很短（几十条），一次全量返回，本地做关键字过滤即可，不做分页。
 */

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return url
  }
}

export default function FunLinksTool() {
  const { t } = useT()
  const [links, setLinks] = React.useState<FunLink[] | null>(null)
  const [error, setError] = React.useState("")
  const [keyword, setKeyword] = React.useState("")
  const [category, setCategory] = React.useState<FunLinkCategory | "all">("all")

  const load = React.useCallback(async () => {
    setError("")
    setLinks(null)
    try {
      const res = await funLinksApi.list()
      setLinks(res.links)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("fl.err.load"))
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 各分类的条数，显示在选项卡上 */
  const counts = React.useMemo(() => {
    const m: Record<string, number> = { all: links?.length ?? 0 }
    for (const l of links ?? []) m[l.category] = (m[l.category] ?? 0) + 1
    return m
  }, [links])

  const list = React.useMemo(() => {
    if (!links) return []
    const kw = keyword.trim().toLowerCase()
    return links.filter((l) => {
      if (category !== "all" && l.category !== category) return false
      if (!kw) return true
      return `${l.title} ${l.description} ${l.url}`.toLowerCase().includes(kw)
    })
  }, [links, keyword, category])

  return (
    <ToolShell
      title={t("toolbox.funLinks.name")}
      description={t("fl.desc")}
      local={false}
    >
      <ToolSection>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            value={category}
            onValueChange={(v) => setCategory(v as FunLinkCategory | "all")}
          >
            <TabsList className="h-auto flex-wrap justify-start">
              <TabsTrigger value="all" className="gap-1.5">
                {t("common.all")}
                {links !== null && (
                  <span className="text-[11px] text-muted-foreground">{counts.all ?? 0}</span>
                )}
              </TabsTrigger>
              {FUN_LINK_CATEGORIES.map((c) => (
                <TabsTrigger key={c.id} value={c.id} className="gap-1.5">
                  {c.label}
                  {links !== null && (
                    <span className="text-[11px] text-muted-foreground">
                      {counts[c.id] ?? 0}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("fl.searchPlaceholder")}
              className="pl-9"
            />
          </div>
        </div>

        {error ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : links === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {keyword.trim()
                ? t("fl.empty.search")
                : category !== "all"
                  ? t("fl.empty.category")
                  : t("fl.empty.none")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {list.map((l) => (
              <a
                key={l.id}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="group flex items-start gap-3 rounded-lg border bg-card p-3 transition-all hover:border-primary/50 hover:bg-accent/30"
              >
                <FunLinkIcon
                  src={l.iconUrl ? funLinkIconUrl(l.id) : null}
                  title={l.title}
                  size={36}
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{l.title}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </span>
                  {l.description && (
                    <span className="block text-xs leading-relaxed text-muted-foreground">
                      {l.description}
                    </span>
                  )}
                  <span className="block truncate font-mono text-[11px] text-muted-foreground/70">
                    {hostOf(l.url)}
                  </span>
                </span>
              </a>
            ))}
          </div>
        )}
      </ToolSection>
    </ToolShell>
  )
}
