import * as React from "react"
import { Palette } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { SHOP_ICON_COUNT, SHOP_ICON_GROUPS, shopIcon } from "@/lib/shop-icons"
import { useT } from "@/i18n"

/**
 * 积分商城的商品图标选择器（可折叠）。
 *
 * 抽成独立组件是因为**管理端和用户端都要用**：
 *   · 管理端 admin-points.tsx —— 上架官方商品
 *   · 用户端 points.tsx —— 用户上架自己的商品
 * 放在管理端文件里再被用户端 import 会把整个管理端页面拖进用户 bundle。
 *
 * 为什么不做成 Popover：弹窗里再套一层浮层，点选时焦点与滚动容易打架；
 * 展开在表单里反而更好点、也能一眼看到全部图标。
 */
export function ShopIconPicker({
  value,
  onChange,
  disabled,
}: {
  /** 当前选中的图标 slug；空串 = 没选 */
  value: string
  onChange: (slug: string) => void
  disabled?: boolean
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const Current = shopIcon(value)

  const q = query.trim().toLowerCase()
  const groups = React.useMemo(() => {
    if (!q) return SHOP_ICON_GROUPS
    return SHOP_ICON_GROUPS.map((g) => ({
      label: g.label,
      icons: g.icons.filter((i) => i.name.includes(q)),
    })).filter((g) => g.icons.length > 0)
  }, [q])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t("si.label")}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <Palette className="mr-1 h-3.5 w-3.5" />
          {open ? t("lg.collapse") : value ? t("si.change") : t("si.pickFrom", { n: SHOP_ICON_COUNT })}
        </Button>
      </div>

      <div className="flex items-center gap-3 rounded-md border p-2.5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <Current className="h-6 w-6 text-primary" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          {value ? (
            <p className="truncate font-mono">{value}</p>
          ) : (
            <p>{t("si.note1")}</p>
          )}
          <p className="mt-0.5">{t("si.note2")}</p>
        </div>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange("")}
          >
            {t("si.clear")}
          </Button>
        )}
      </div>

      {open && (
        <div className="rounded-md border">
          <div className="border-b p-2">
            <Input
              className="h-8 text-xs"
              placeholder={t("si.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="max-h-60 space-y-3 overflow-y-auto p-2">
            {groups.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{t("si.noMatch")}</p>
            ) : (
              groups.map((g) => (
                <div key={g.label}>
                  <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">{t(g.label)}</p>
                  <div className="grid grid-cols-8 gap-1">
                    {g.icons.map(({ name, Icon }) => (
                      <button
                        key={name}
                        type="button"
                        title={name}
                        disabled={disabled}
                        onClick={() => onChange(name)}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent",
                          value === name && "bg-primary/15 ring-1 ring-primary"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
