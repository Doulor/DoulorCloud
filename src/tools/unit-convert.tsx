import * as React from "react"
import { Check, Copy } from "lucide-react"

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
import { copyText } from "@/lib/toolbox/utils"
import { useT } from "@/i18n"

interface Unit {
  id: string
  label: string
  toBase: (v: number) => number
  fromBase: (v: number) => number
}

/** 线性单位的快捷构造：f = 1 个该单位等于多少个基准单位 */
const lin = (f: number) => ({ toBase: (v: number) => v * f, fromBase: (v: number) => v / f })

const GROUPS: { id: string; label: string; units: Unit[] }[] = [
  {
    id: "length",
    label: "uc.cat.length",
    units: [
      { id: "mm", label: "uc.unit.mm", ...lin(0.001) },
      { id: "cm", label: "uc.unit.cm", ...lin(0.01) },
      { id: "m", label: "uc.unit.m", ...lin(1) },
      { id: "km", label: "uc.unit.km", ...lin(1000) },
      { id: "chi", label: "uc.unit.chi", ...lin(1 / 3) },
      { id: "li", label: "uc.unit.li", ...lin(500) },
      { id: "in", label: "uc.unit.in", ...lin(0.0254) },
      { id: "ft", label: "uc.unit.ft", ...lin(0.3048) },
      { id: "yd", label: "uc.unit.yd", ...lin(0.9144) },
      { id: "mi", label: "uc.unit.mi", ...lin(1609.344) },
      { id: "nmi", label: "uc.unit.nmi", ...lin(1852) },
    ],
  },
  {
    id: "weight",
    label: "uc.cat.weight",
    units: [
      { id: "mg", label: "uc.unit.mg", ...lin(0.000001) },
      { id: "g", label: "uc.unit.g", ...lin(0.001) },
      { id: "kg", label: "uc.unit.kg", ...lin(1) },
      { id: "t", label: "uc.unit.t", ...lin(1000) },
      { id: "liang", label: "uc.unit.liang", ...lin(0.05) },
      { id: "jin", label: "uc.unit.jin", ...lin(0.5) },
      { id: "dan", label: "uc.unit.dan", ...lin(50) },
      { id: "oz", label: "uc.unit.oz", ...lin(0.028349523125) },
      { id: "lb", label: "uc.unit.lb", ...lin(0.45359237) },
    ],
  },
  {
    id: "area",
    label: "uc.cat.area",
    units: [
      { id: "cm2", label: "uc.unit.cm2", ...lin(0.0001) },
      { id: "m2", label: "uc.unit.m2", ...lin(1) },
      { id: "km2", label: "uc.unit.km2", ...lin(1000000) },
      { id: "mu", label: "uc.unit.mu", ...lin(2000 / 3) },
      { id: "ha", label: "uc.unit.ha", ...lin(10000) },
      { id: "ft2", label: "uc.unit.ft2", ...lin(0.09290304) },
      { id: "acre", label: "uc.unit.acre", ...lin(4046.8564224) },
      { id: "mi2", label: "uc.unit.mi2", ...lin(2589988.110336) },
    ],
  },
  {
    id: "volume",
    label: "uc.cat.volume",
    units: [
      { id: "ml", label: "uc.unit.ml", ...lin(0.001) },
      { id: "l", label: "uc.unit.l", ...lin(1) },
      { id: "m3", label: "uc.unit.m3", ...lin(1000) },
      { id: "galus", label: "uc.unit.galus", ...lin(3.785411784) },
      { id: "galuk", label: "uc.unit.galuk", ...lin(4.54609) },
      { id: "ft3", label: "uc.unit.ft3", ...lin(28.316846592) },
    ],
  },
  {
    id: "speed",
    label: "uc.cat.speed",
    units: [
      { id: "ms", label: "uc.unit.ms", ...lin(1) },
      { id: "kmh", label: "uc.unit.kmh", ...lin(1 / 3.6) },
      { id: "mph", label: "uc.unit.mph", ...lin(0.44704) },
      { id: "knot", label: "uc.unit.knot", ...lin(0.5144444444) },
      { id: "fts", label: "uc.unit.fts", ...lin(0.3048) },
    ],
  },
  {
    id: "data",
    label: "uc.cat.data",
    units: [
      { id: "b", label: "uc.unit.b", ...lin(1) },
      { id: "kb", label: "uc.unit.kb", ...lin(1024) },
      { id: "mb", label: "uc.unit.mb", ...lin(1024 ** 2) },
      { id: "gb", label: "uc.unit.gb", ...lin(1024 ** 3) },
      { id: "tb", label: "uc.unit.tb", ...lin(1024 ** 4) },
      { id: "pb", label: "uc.unit.pb", ...lin(1024 ** 5) },
    ],
  },
  {
    id: "temp",
    label: "uc.cat.temperature",
    units: [
      { id: "c", label: "uc.unit.c", toBase: (v) => v, fromBase: (v) => v },
      { id: "f", label: "uc.unit.f", toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
      { id: "k", label: "uc.unit.k", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    ],
  },
]

/** 保留 8 位有效数字，并去掉浮点尾巴 */
function fmt(n: number): string {
  if (!isFinite(n)) return "—"
  if (n === 0) return "0"
  const abs = Math.abs(n)
  if (abs >= 1e15 || abs < 1e-6) return n.toExponential(6)
  return String(Number(n.toPrecision(8)))
}

export default function UnitConvertTool() {
  const { t } = useT()
  const [groupId, setGroupId] = React.useState("length")
  const [fromId, setFromId] = React.useState("m")
  const [raw, setRaw] = React.useState("1")
  const [copied, setCopied] = React.useState<string | null>(null)

  const group = GROUPS.find((g) => g.id === groupId) ?? GROUPS[0]
  const fromUnit = group.units.find((u) => u.id === fromId) ?? group.units[0]

  // 切换类别时把源单位重置成该类别的基准单位，避免残留上一个类别的单位
  const handleGroup = (id: string) => {
    const g = GROUPS.find((x) => x.id === id)
    if (!g) return
    setGroupId(id)
    setFromId(g.units[Math.min(2, g.units.length - 1)].id)
  }

  const value = Number(raw)
  const valid = raw.trim() !== "" && isFinite(value)
  const base = valid ? fromUnit.toBase(value) : NaN

  const handleCopy = async (id: string, text: string) => {
    await copyText(text)
    setCopied(id)
    window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200)
  }

  return (
    <ToolShell title={t("toolbox.unitConvert.name")} description={t("uc.desc")}>
      <ToolSection>
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_200px]">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("uc.category")}</label>
            <Select value={groupId} onValueChange={handleGroup}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPS.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {t(g.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("uc.value")}</label>
            <Input
              inputMode="decimal"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={t("uc.valuePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("uc.unit")}</label>
            <Select value={fromId} onValueChange={setFromId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {group.units.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {t(u.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </ToolSection>

      <ToolSection title={t("uc.results")}>
        {!valid ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("uc.enterValue")}</p>
        ) : (
          <ul className="divide-y">
            {group.units
              .filter((u) => u.id !== fromUnit.id)
              .map((u) => {
                const text = fmt(u.fromBase(base))
                return (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="text-sm text-muted-foreground">{t(u.label)}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm tabular-nums">{text}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t("common.copy")}
                        onClick={() => void handleCopy(u.id, text)}
                      >
                        {copied === u.id ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </li>
                )
              })}
          </ul>
        )}
      </ToolSection>
    </ToolShell>
  )
}
