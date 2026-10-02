import * as React from "react"
import { Plus, Trash2 } from "lucide-react"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

const STORAGE_KEY = "doulor.toolbox.countdown"

interface Item {
  id: string
  name: string
  /** yyyy-mm-dd，本地时区当天 00:00 */
  date: string
  /** countdown = 倒数到那天；since = 从那天起已经过了多久 */
  mode: "countdown" | "since"
}

function load(): Item[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Item[]) : []
  } catch {
    return []
  }
}

function save(items: Item[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    /* 隐私模式下写入会失败，忽略即可 */
  }
}

/** 把 yyyy-mm-dd 解析为本地时区的当天零点 */
function parseLocalDate(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0)
  return isNaN(d.getTime()) ? null : d
}

function daysBetween(a: Date, b: Date): number {
  const A = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const B = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((A - B) / 86400000)
}

export default function CountdownTool() {
  const { t } = useT()
  const [items, setItems] = React.useState<Item[]>([])
  const [name, setName] = React.useState("")
  const [date, setDate] = React.useState("")
  const [mode, setMode] = React.useState<"countdown" | "since">("countdown")
  const [, forceTick] = React.useState(0)

  React.useEffect(() => {
    setItems(load())
    const today = new Date()
    setDate(
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
        today.getDate()
      ).padStart(2, "0")}`
    )
  }, [])

  // 每秒刷新一次，跨天 / 跨小时能自动更新
  React.useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [])

  const update = (next: Item[]) => {
    setItems(next)
    save(next)
  }

  const handleAdd = () => {
    const trimmed = name.trim()
    const d = parseLocalDate(date)
    if (!trimmed || !d) return
    update([
      ...items,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: trimmed, date, mode },
    ])
    setName("")
  }

  const now = new Date()

  return (
    <ToolShell
      title={t("toolbox.countdown.name")}
      description={t("cd.desc")}
    >
      <ToolSection title={t("cd.section.add")}>
        <div className="grid gap-3 sm:grid-cols-[1fr_170px_130px_auto]">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("cd.namePlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Select value={mode} onValueChange={(v) => setMode(v as "countdown" | "since")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="countdown">{t("cd.mode.countdown")}</SelectItem>
              <SelectItem value="since">{t("cd.mode.since")}</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleAdd} disabled={!name.trim() || !parseLocalDate(date)}>
            <Plus className="h-4 w-4" />
            {t("common.add")}
          </Button>
        </div>
      </ToolSection>

      <ToolSection title={t("cd.section.list", { n: items.length })}>
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("cd.empty")}
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {items.map((it) => {
              const target = parseLocalDate(it.date)
              if (!target) return null
              const diffDays = daysBetween(target, now)
              const diffMs = target.getTime() - now.getTime()
              const absMs = Math.abs(diffMs)
              const h = Math.floor(absMs / 3600000)
              const m = Math.floor((absMs % 3600000) / 60000)
              const s = Math.floor((absMs % 60000) / 1000)

              const past = it.mode === "countdown" ? diffDays < 0 : true
              const main = it.mode === "countdown" ? Math.abs(diffDays) : Math.abs(diffDays)

              return (
                <li key={it.id} className="rounded-lg border bg-background p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{it.name}</p>
                      <p className="text-xs text-muted-foreground">{it.date}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={t("common.delete")}
                      onClick={() => update(items.filter((x) => x.id !== it.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="mt-2 flex items-baseline gap-1.5">
                    <span
                      className={cn(
                        "font-mono text-2xl font-medium tabular-nums",
                        it.mode === "countdown" && !past ? "text-primary" : "text-foreground"
                      )}
                    >
                      {main}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {it.mode === "countdown"
                        ? past
                          ? t("cd.daysPastMarked")
                          : t("cd.daysAhead")
                        : t("cd.daysPast")}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {past ? t("cd.past") : t("cd.left")}
                    {t("cd.hms", { h, m, s })}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </ToolSection>
    </ToolShell>
  )
}
