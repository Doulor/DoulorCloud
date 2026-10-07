import * as React from "react"
import { Coins, Dices, Shuffle, Sparkles, Users } from "lucide-react"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

type Mode = "draw" | "dice" | "coin" | "group"

/**
 * 单次能掷的骰子个数上限。
 * 2026-10-08 站长要求从 12 提到 100（跑团/大批量随机时够用）。
 * 上限的两处约束（输入框 max 与 onChange 的夹逼）共用它，别只改一处。
 */
const MAX_DICE = 100

function parseNames(text: string): string[] {
  return text
    .split(/[\n,，、;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export default function RandomPickerTool() {
  const { t } = useT()
  const [mode, setMode] = React.useState<Mode>("draw")

  return (
    <ToolShell
      title={t("toolbox.randomPicker.name")}
      description={t("rp.desc")}
    >
      <div className="flex flex-wrap gap-2">
        {(
          [
            { id: "draw", label: "rp.tab.draw", icon: Sparkles },
            { id: "dice", label: "rp.tab.dice", icon: Dices },
            { id: "coin", label: "rp.tab.coin", icon: Coins },
            { id: "group", label: "rp.tab.group", icon: Users },
          ] as const
        ).map((m) => (
          <Button
            key={m.id}
            variant={mode === m.id ? "default" : "outline"}
            size="sm"
            onClick={() => setMode(m.id)}
          >
            <m.icon className="h-4 w-4" />
            {t(m.label)}
          </Button>
        ))}
      </div>

      {mode === "draw" && <DrawPanel />}
      {mode === "dice" && <DicePanel />}
      {mode === "coin" && <CoinPanel />}
      {mode === "group" && <GroupPanel />}
    </ToolShell>
  )
}

function DrawPanel() {
  const { t } = useT()
  const [text, setText] = React.useState(t("rp.sampleNames"))
  const [highlight, setHighlight] = React.useState(-1)
  const [winner, setWinner] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState(false)
  const timer = React.useRef<number | null>(null)

  const names = parseNames(text)

  React.useEffect(() => () => { if (timer.current) window.clearInterval(timer.current) }, [])

  const start = () => {
    if (names.length < 2 || running) return
    setWinner(null)
    setRunning(true)
    let elapsed = 0
    timer.current = window.setInterval(() => {
      setHighlight(Math.floor(Math.random() * names.length))
      elapsed += 80
      if (elapsed >= 1600) {
        if (timer.current) window.clearInterval(timer.current)
        const idx = Math.floor(Math.random() * names.length)
        setHighlight(idx)
        setWinner(names[idx])
        setRunning(false)
      }
    }, 80)
  }

  return (
    <ToolSection title={t("rp.draw.section")}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className="font-mono text-sm"
          placeholder={t("rp.draw.placeholder")}
        />
        <div className="space-y-3">
          <Button onClick={start} disabled={names.length < 2 || running} className="w-full">
            {running ? t("rp.draw.running") : t("rp.draw.start")}
          </Button>
          <div className="rounded-lg border bg-background p-3">
            <p className="mb-2 text-xs text-muted-foreground">{t("rp.draw.count", { n: names.length })}</p>
            <div className="flex flex-wrap gap-2">
              {names.map((n, i) => (
                <span
                  key={`${n}-${i}`}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-sm transition-colors",
                    highlight === i
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border"
                  )}
                >
                  {n}
                </span>
              ))}
            </div>
          </div>
          {winner && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-center">
              <p className="text-xs text-muted-foreground">{t("rp.draw.picked")}</p>
              <p className="mt-1 text-xl font-medium">{winner}</p>
            </div>
          )}
        </div>
      </div>
    </ToolSection>
  )
}

function DicePanel() {
  const { t } = useT()
  const [count, setCount] = React.useState(2)
  const [sides, setSides] = React.useState(6)
  const [values, setValues] = React.useState<number[]>([])
  const [rolling, setRolling] = React.useState(false)

  const roll = () => {
    setRolling(true)
    let ticks = 0
    const t = window.setInterval(() => {
      setValues(Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides)))
      ticks++
      if (ticks >= 8) {
        window.clearInterval(t)
        setValues(Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides)))
        setRolling(false)
      }
    }, 70)
  }

  const total = values.reduce((a, b) => a + b, 0)
  // 骰子多的时候按比例缩小，否则 100 个 64px 的方块会铺满好几屏。
  const compact = count > 40
  const chip = compact ? "h-10 w-10 text-sm" : "h-16 w-16 text-2xl"

  return (
    <ToolSection title={t("rp.dice.section")}>
      <div className="grid gap-3 sm:grid-cols-[140px_160px_auto]">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">{t("rp.dice.count")}</label>
          <Input
            type="number"
            min={1}
            max={MAX_DICE}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(MAX_DICE, Number(e.target.value) || 1)))}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">{t("rp.dice.faces")}</label>
          <Select value={String(sides)} onValueChange={(v) => setSides(Number(v))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[4, 6, 8, 10, 12, 20, 100].map((s) => (
                <SelectItem key={s} value={String(s)}>
                  D{s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button onClick={roll} disabled={rolling} className="w-full sm:w-auto">
            <Dices className="h-4 w-4" />
            {rolling ? t("rp.dice.rolling") : t("rp.dice.roll")}
          </Button>
        </div>
      </div>

      <div className="mt-4 flex min-h-[88px] flex-wrap items-center gap-3">
        {values.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("rp.dice.hint")}</p>
        ) : (
          values.map((v, i) => (
            <span
              key={i}
              className={cn(
                "flex items-center justify-center rounded-lg border bg-background font-mono font-medium tabular-nums",
                chip
              )}
            >
              {v}
            </span>
          ))
        )}
      </div>
      {values.length > 1 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("rp.dice.total")} <span className="font-mono text-foreground">{total}</span>
        </p>
      )}
    </ToolSection>
  )
}

function CoinPanel() {
  const { t } = useT()
  const [result, setResult] = React.useState<"H" | "T" | null>(null)
  const [flipping, setFlipping] = React.useState(false)
  const [history, setHistory] = React.useState<("H" | "T")[]>([])

  const flip = () => {
    if (flipping) return
    setFlipping(true)
    let ticks = 0
    const t = window.setInterval(() => {
      setResult(Math.random() < 0.5 ? "H" : "T")
      ticks++
      if (ticks >= 10) {
        window.clearInterval(t)
        const r: "H" | "T" = Math.random() < 0.5 ? "H" : "T"
        setResult(r)
        setHistory((h) => [r, ...h].slice(0, 30))
        setFlipping(false)
      }
    }, 70)
  }

  return (
    <ToolSection title={t("rp.coin.section")}>
      <div className="flex flex-col items-center gap-4 py-4">
        <div
          className={cn(
            "flex h-28 w-28 items-center justify-center rounded-full border-4 text-4xl font-medium transition-transform",
            flipping && "scale-95",
            result ? "border-primary/50 bg-primary/10" : "border-border"
          )}
        >
          {result ? t(`rp.coin.${result}`) : "?"}
        </div>
        <Button onClick={flip} disabled={flipping}>
          {flipping ? t("rp.coin.flipping") : t("rp.coin.flip")}
        </Button>
      </div>
      {history.length > 0 && (
        <div className="mt-2 border-t pt-3">
          <p className="mb-2 text-xs text-muted-foreground">
            {t("rp.coin.history", { n: history.length, heads: history.filter((h) => h === "H").length })}
          </p>
          <div className="flex flex-wrap gap-1.5 font-mono text-sm">
            {history.map((h, i) => (
              <span
                key={i}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded border",
                  h === "H" ? "border-primary/40 bg-primary/10" : "border-border"
                )}
              >
                {t(`rp.coin.${h}`)}
              </span>
            ))}
          </div>
        </div>
      )}
    </ToolSection>
  )
}

function GroupPanel() {
  const { t } = useT()
  const [text, setText] = React.useState(t("rp.sampleNamesLong"))
  const [by, setBy] = React.useState<"count" | "size">("count")
  const [n, setN] = React.useState(2)
  const [groups, setGroups] = React.useState<string[][]>([])

  const names = parseNames(text)

  const split = () => {
    if (names.length === 0) return
    const shuffled = shuffle(names)
    const groupCount =
      by === "count"
        ? Math.max(1, Math.min(n, shuffled.length))
        : Math.max(1, Math.ceil(shuffled.length / Math.max(1, n)))
    const out: string[][] = Array.from({ length: groupCount }, () => [])
    shuffled.forEach((name, i) => out[i % groupCount].push(name))
    setGroups(out)
  }

  return (
    <ToolSection title={t("rp.group.section")}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className="font-mono text-sm"
          placeholder={t("rp.draw.placeholder")}
        />
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Select value={by} onValueChange={(v) => setBy(v as "count" | "size")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="count">{t("rp.group.byCount")}</SelectItem>
                <SelectItem value="size">{t("rp.group.bySize")}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={1}
              value={n}
              onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <Button onClick={split} disabled={names.length === 0} className="w-full">
            <Shuffle className="h-4 w-4" />
            {t("rp.group.title", { n: names.length })}
          </Button>
          <div className="space-y-2">
            {groups.map((g, i) => (
              <div key={i} className="rounded-lg border bg-background p-3">
                <p className="mb-1.5 text-xs text-muted-foreground">
                  {t("rp.group.groupN", { i: i + 1, n: g.length })}
                </p>
                <p className="text-sm">{g.join("、")}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ToolSection>
  )
}
