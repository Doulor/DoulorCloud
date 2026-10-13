import * as React from "react"
import { Link } from "react-router-dom"
import { Loader2, Play, Sparkles } from "lucide-react"

import { CollectionAside } from "@/components/collection-nav"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { collectionApi, type CollectionPlugin } from "@/services/api"
import { DEFAULT_PLUGIN_ACCENT, pluginViewFor } from "@/lib/collection-plugins"
import { useT } from "@/i18n"

/**
 * 造物典藏 —— **游戏大厅**。
 *
 * 与造物集的展示大厅同构（左侧导航 + 右侧卡片网格），但定位不同：
 *   · 展示大厅放的是**用户做的网页**（数量多、卡片小而密、沙箱运行）；
 *   · 造物典藏放的是**高级游戏**（数量注定很少、卡片做大、每个游戏自带全屏界面）。
 *
 * 卡片全部来自服务端清单（`/api/collection/plugins`），**没有任何硬编码的游戏列表**。
 * 「在线投资」只是清单里的第一行 —— 将来站长加游戏、或开放用户发布，
 * 这个页面一行都不用改。
 */
export default function CollectionPage() {
  const { t } = useT()
  const [plugins, setPlugins] = React.useState<CollectionPlugin[]>([])
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)

  const load = React.useCallback(() => {
    setLoading(true)
    setFailed(false)
    collectionApi
      .plugins()
      .then((res) => setPlugins(res.plugins ?? []))
      .catch(() => {
        setPlugins([])
        setFailed(true)
      })
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      <PageHeader title={t("col.title")} description={t("col.desc")} />

      <div className="flex flex-col gap-6 lg:flex-row">
        <CollectionAside />

        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="flex min-h-[240px] items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : failed ? (
            <EmptyState
              title={t("col.loadFailed")}
              description={t("col.loadFailedDesc")}
              icon={Sparkles}
              action={
                <Button variant="secondary" size="sm" onClick={load}>
                  {t("col.retry")}
                </Button>
              }
            />
          ) : plugins.length === 0 ? (
            <EmptyState
              title={t("col.empty")}
              description={t("col.emptyDesc")}
              icon={Sparkles}
            />
          ) : (
            <div className="space-y-3">
              {/* 游戏注定不多 ⇒ 卡片做大、两列即满，视觉上「一屏一个游戏」 */}
              <div className="grid gap-4 sm:grid-cols-2">
                {plugins.map((p) => (
                  <PluginCard key={p.slug} plugin={p} />
                ))}
              </div>
              <p className="pt-1 text-xs text-muted-foreground">
                {t("col.count").replace("{n}", String(plugins.length))}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 清单里的名字 / 简介是**服务端下发的中文默认值**（清单要能被动态增删，
 * 不能把文案硬编码在前端）。但站点有中英切换 —— 英文界面下直接显示中文会很难看。
 *
 * 折中：如果词典里有 `col.plugin.<slug>.<field>` 这个词条就用词条，否则回落清单值。
 * `t()` 取不到时会**原样返回 key**，正是靠这一点判断「有没有这个词条」。
 *
 * ⚠️ 这套词条是**可选的**：新插件不写也能正常显示（只是不本地化）。
 *    不要把它变成必填 —— 那会让「服务端加一个插件」变成必须改前端。
 */
function localized(t: (k: string) => string, key: string, fallback: string): string {
  const v = t(key)
  return v === key ? fallback : v
}

/**
 * 一张游戏卡。
 *
 * 视觉上刻意比造物集的作品卡**更重**：大圆角、插件自带的强调色做一层径向渐变底、
 * emoji 放大到 4xl。颜色来自清单的 `accent`（服务端校验过是 hex），
 * 所以每个游戏有自己的一眼辨识度，而不是清一色的灰卡片。
 */
function PluginCard({ plugin }: { plugin: CollectionPlugin }) {
  const { t } = useT()
  const accent = plugin.accent || DEFAULT_PLUGIN_ACCENT
  const view = pluginViewFor(plugin.slug)
  // 清单里有、组件没接上 ⇒ 只展示不能进（vs 已下架的插件根本不该出现在这里）
  const playable = Boolean(view)

  const name = localized(t, `col.plugin.${plugin.slug}.name`, plugin.name)
  const tagline = localized(t, `col.plugin.${plugin.slug}.tagline`, plugin.tagline)
  const description = localized(t, `col.plugin.${plugin.slug}.description`, plugin.description)

  const inner = (
    <>
      {/* 强调色光晕：只影响装饰层，不影响文字可读性 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.16] transition-opacity duration-300 group-hover:opacity-30"
        style={{
          background: `radial-gradient(115% 85% at 10% 0%, ${accent}, transparent 68%)`,
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-6 -top-6 h-28 w-28 rounded-full opacity-20 blur-2xl transition-opacity duration-300 group-hover:opacity-40"
        style={{ background: accent }}
      />

      <span className="relative flex items-start justify-between gap-3">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-background/70 text-3xl shadow-sm backdrop-blur">
          {plugin.icon || "🎮"}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {plugin.kind === "builtin" && (
            <Badge variant="secondary" className="bg-background/70 backdrop-blur">
              {t("col.official")}
            </Badge>
          )}
          {!playable && (
            <Badge variant="outline" className="bg-background/70 backdrop-blur">
              {t("col.soon")}
            </Badge>
          )}
        </span>
      </span>

      <span className="relative mt-4 block min-w-0">
        <span className="block truncate text-lg font-semibold tracking-tight">{name}</span>
        <span className="mt-1 block text-sm text-muted-foreground">{tagline}</span>
        <span className="mt-2 line-clamp-3 block text-xs leading-relaxed text-muted-foreground/80">
          {playable ? description : t("col.soonDesc")}
        </span>
      </span>

      <span className="relative mt-auto flex items-center gap-1.5 pt-4 text-sm font-medium">
        {playable ? (
          <>
            <Play className="h-4 w-4" />
            {t("col.play")}
          </>
        ) : (
          <span className="text-muted-foreground">{t("col.soon")}</span>
        )}
      </span>
    </>
  )

  const base =
    "group relative flex min-h-[232px] flex-col overflow-hidden rounded-3xl border bg-card p-5 shadow-sm transition-all"

  if (!playable) {
    return <div className={base + " opacity-70"}>{inner}</div>
  }

  return (
    <Link
      to={plugin.entry}
      className={base + " hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg"}
    >
      {inner}
    </Link>
  )
}
