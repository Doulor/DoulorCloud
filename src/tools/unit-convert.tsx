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
    label: "长度",
    units: [
      { id: "mm", label: "毫米 mm", ...lin(0.001) },
      { id: "cm", label: "厘米 cm", ...lin(0.01) },
      { id: "m", label: "米 m", ...lin(1) },
      { id: "km", label: "千米 km", ...lin(1000) },
      { id: "chi", label: "市尺", ...lin(1 / 3) },
      { id: "li", label: "市里", ...lin(500) },
      { id: "in", label: "英寸 in", ...lin(0.0254) },
      { id: "ft", label: "英尺 ft", ...lin(0.3048) },
      { id: "yd", label: "码 yd", ...lin(0.9144) },
      { id: "mi", label: "英里 mi", ...lin(1609.344) },
      { id: "nmi", label: "海里 nmi", ...lin(1852) },
    ],
  },
  {
    id: "weight",
    label: "重量",
    units: [
      { id: "mg", label: "毫克 mg", ...lin(0.000001) },
      { id: "g", label: "克 g", ...lin(0.001) },
      { id: "kg", label: "千克 kg", ...lin(1) },
      { id: "t", label: "吨 t", ...lin(1000) },
      { id: "liang", label: "两", ...lin(0.05) },
      { id: "jin", label: "斤", ...lin(0.5) },
      { id: "dan", label: "担", ...lin(50) },
      { id: "oz", label: "盎司 oz", ...lin(0.028349523125) },
      { id: "lb", label: "磅 lb", ...lin(0.45359237) },
    ],
  },
  {
    id: "area",
    label: "面积",
    units: [
      { id: "cm2", label: "平方厘米", ...lin(0.0001) },
      { id: "m2", label: "平方米", ...lin(1) },
      { id: "km2", label: "平方千米", ...lin(1000000) },
      { id: "mu", label: "亩", ...lin(2000 / 3) },
      { id: "ha", label: "公顷", ...lin(10000) },
      { id: "ft2", label: "平方英尺", ...lin(0.09290304) },
      { id: "acre", label: "英亩", ...lin(4046.8564224) },
      { id: "mi2", label: "平方英里", ...lin(2589988.110336) },
    ],
  },
  {
    id: "volume",
    label: "体积",
    units: [
      { id: "ml", label: "毫升 mL", ...lin(0.001) },
      { id: "l", label: "升 L", ...lin(1) },
      { id: "m3", label: "立方米", ...lin(1000) },
      { id: "galus", label: "加仑（美）", ...lin(3.785411784) },
      { id: "galuk", label: "加仑（英）", ...lin(4.54609) },
      { id: "ft3", label: "立方英尺", ...lin(28.316846592) },
    ],
  },
  {
    id: "speed",
    label: "速度",
    units: [
      { id: "ms", label: "米/秒", ...lin(1) },
      { id: "kmh", label: "千米/时", ...lin(1 / 3.6) },
      { id: "mph", label: "英里/时", ...lin(0.44704) },
      { id: "knot", label: "节", ...lin(0.5144444444) },
      { id: "fts", label: "英尺/秒", ...lin(0.3048) },
    ],
  },
  {
    id: "data",
    label: "数据大小",
    units: [
      { id: "b", label: "字节 B", ...lin(1) },
      { id: "kb", label: "KB", ...lin(1024) },
      { id: "mb", label: "MB", ...lin(1024 ** 2) },
      { id: "gb", label: "GB", ...lin(1024 ** 3) },
      { id: "tb", label: "TB", ...lin(1024 ** 4) },
      { id: "pb", label: "PB", ...lin(1024 ** 5) },
    ],
  },
  {
    id: "temp",
    label: "温度",
    units: [
      { id: "c", label: "摄氏度 °C", toBase: (v) => v, fromBase: (v) => v },
      { id: "f", label: "华氏度 °F", toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
      { id: "k", label: "开尔文 K", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
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
    <ToolShell
      title="单位换算"
      description="输入一个数值，下面立刻列出它在同一类别里所有单位下的结果，点一下即可复制。"
    >
      <ToolSection>
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_200px]">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">类别</label>
            <Select value={groupId} onValueChange={handleGroup}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPS.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">数值</label>
            <Input
              inputMode="decimal"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="输入数值"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">单位</label>
            <Select value={fromId} onValueChange={setFromId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {group.units.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </ToolSection>

      <ToolSection title="换算结果">
        {!valid ? (
          <p className="py-6 text-center text-sm text-muted-foreground">请输入一个数值</p>
        ) : (
          <ul className="divide-y">
            {group.units
              .filter((u) => u.id !== fromUnit.id)
              .map((u) => {
                const text = fmt(u.fromBase(base))
                return (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="text-sm text-muted-foreground">{u.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm tabular-nums">{text}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label="复制"
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
