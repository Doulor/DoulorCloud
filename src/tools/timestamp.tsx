import * as React from "react"
import { ArrowRight, Check, Copy } from "lucide-react"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { copyText } from "@/lib/toolbox/utils"

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

function formatLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`
}

function formatUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function relative(d: Date, now: number): string {
  const diff = Math.round((d.getTime() - now) / 1000)
  const abs = Math.abs(diff)
  const unit = (n: number, name: string) => `${n} ${name}${diff > 0 ? "后" : "前"}`
  if (abs < 60) return unit(abs, "秒")
  if (abs < 3600) return unit(Math.round(abs / 60), "分钟")
  if (abs < 86400) return unit(Math.round(abs / 3600), "小时")
  if (abs < 86400 * 30) return unit(Math.round(abs / 86400), "天")
  if (abs < 86400 * 365) return unit(Math.round(abs / (86400 * 30)), "个月")
  return unit(Math.round(abs / (86400 * 365)), "年")
}

export default function TimestampTool() {
  return (
    <ToolShell
      title="时间戳转换"
      description="Unix 时间戳与日期时间互转。看日志、对接口返回的时间字段时很方便。"
    >
      <Tabs defaultValue="to-date">
        <TabsList>
          <TabsTrigger value="to-date">时间戳 → 时间</TabsTrigger>
          <TabsTrigger value="to-ts">时间 → 时间戳</TabsTrigger>
        </TabsList>
        <TabsContent value="to-date" className="mt-4">
          <TsToDate />
        </TabsContent>
        <TabsContent value="to-ts" className="mt-4">
          <DateToTs />
        </TabsContent>
      </Tabs>
    </ToolShell>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{value}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="复制"
          onClick={async () => {
            await copyText(value)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function TsToDate() {
  const [raw, setRaw] = React.useState(String(Math.floor(Date.now() / 1000)))
  const [now, setNow] = React.useState(Date.now())

  React.useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const trimmed = raw.trim()
  const num = Number(trimmed)
  const valid = trimmed !== "" && isFinite(num)
  // 10 位按秒，13 位按毫秒；其它位数按量级猜
  const isSeconds = valid && Math.abs(num) < 1e11
  const date = valid ? new Date(isSeconds ? num * 1000 : num) : null
  const ok = date !== null && !isNaN(date.getTime())

  return (
    <div className="space-y-4">
      <ToolSection title="当前时间">
        <div className="space-y-2">
          <CopyRow label="秒（10 位）" value={String(Math.floor(now / 1000))} />
          <CopyRow label="毫秒（13 位）" value={String(now)} />
          <CopyRow label="本地时间" value={formatLocal(new Date(now))} />
        </div>
      </ToolSection>

      <ToolSection title="输入时间戳">
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="例如 1790590144 或 1790590144000"
              className="font-mono"
            />
            <Button variant="outline" onClick={() => setRaw(String(Math.floor(Date.now() / 1000)))}>
              用当前时间
            </Button>
          </div>

          {!valid && <p className="text-xs text-muted-foreground">请输入纯数字的时间戳</p>}
          {valid && !ok && <p className="text-xs text-destructive">这个数值超出可表示的日期范围</p>}

          {ok && date && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                识别为{isSeconds ? "秒级（10 位）" : "毫秒级（13 位）"}时间戳
              </p>
              <CopyRow label="本地时间" value={formatLocal(date)} />
              <CopyRow label="UTC 时间" value={formatUtc(date)} />
              <CopyRow label="ISO 8601" value={date.toISOString()} />
              <CopyRow label="相对现在" value={relative(date, now)} />
              <CopyRow label="星期" value={["日", "一", "二", "三", "四", "五", "六"][date.getDay()]} />
            </div>
          )}
        </div>
      </ToolSection>
    </div>
  )
}

function DateToTs() {
  const now = new Date()
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}`
  const [value, setValue] = React.useState(local)

  const date = value ? new Date(value) : null
  const ok = date !== null && !isNaN(date.getTime())

  return (
    <div className="space-y-4">
      <ToolSection title="选择日期时间（按你所在时区）">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-64"
          />
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-sm">
            {ok ? Math.floor(date!.getTime() / 1000) : "—"}
          </span>
        </div>
      </ToolSection>

      {ok && date && (
        <ToolSection title="结果">
          <div className="space-y-2">
            <CopyRow label="秒（10 位）" value={String(Math.floor(date.getTime() / 1000))} />
            <CopyRow label="毫秒（13 位）" value={String(date.getTime())} />
            <CopyRow label="UTC 时间" value={formatUtc(date)} />
            <CopyRow label="ISO 8601" value={date.toISOString()} />
          </div>
        </ToolSection>
      )}

      <p className="text-xs text-muted-foreground">
        Unix 时间戳与时区无关，这里按你电脑的本地时区换算。
      </p>
    </div>
  )
}
