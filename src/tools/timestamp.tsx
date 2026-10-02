import * as React from "react"
import { ArrowRight, Check, Copy } from "lucide-react"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { copyText } from "@/lib/toolbox/utils"
import { useT, tStatic } from "@/i18n"

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
  const unit = (n: number, key: string) =>
    tStatic(diff > 0 ? "ts.rel.after" : "ts.rel.before", { n, unit: tStatic(key) })
  if (abs < 60) return unit(abs, "ts.unit.sec")
  if (abs < 3600) return unit(Math.round(abs / 60), "ts.unit.min")
  if (abs < 86400) return unit(Math.round(abs / 3600), "ts.unit.hour")
  if (abs < 86400 * 30) return unit(Math.round(abs / 86400), "ts.unit.day")
  if (abs < 86400 * 365) return unit(Math.round(abs / (86400 * 30)), "ts.unit.month")
  return unit(Math.round(abs / (86400 * 365)), "ts.unit.year")
}

export default function TimestampTool() {
  const { t } = useT()
  return (
    <ToolShell
      title={t("toolbox.timestamp.name")}
      description={t("ts.desc")}
    >
      <Tabs defaultValue="to-date">
        <TabsList>
          <TabsTrigger value="to-date">{t("ts.tab.toDate")}</TabsTrigger>
          <TabsTrigger value="to-ts">{t("ts.tab.toTs")}</TabsTrigger>
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
  const { t } = useT()
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
          aria-label={t("common.copy")}
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
  const { t } = useT()
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
      <ToolSection title={t("ts.section.now")}>
        <div className="space-y-2">
          <CopyRow label={t("ts.seconds10")} value={String(Math.floor(now / 1000))} />
          <CopyRow label={t("ts.millis13")} value={String(now)} />
          <CopyRow label={t("ts.localTime")} value={formatLocal(new Date(now))} />
        </div>
      </ToolSection>

      <ToolSection title={t("ts.section.inputTs")}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={t("ts.tsPlaceholder")}
              className="font-mono"
            />
            <Button variant="outline" onClick={() => setRaw(String(Math.floor(Date.now() / 1000)))}>
              {t("ts.useNow")}
            </Button>
          </div>

          {!valid && <p className="text-xs text-muted-foreground">{t("ts.err.notNumber")}</p>}
          {valid && !ok && <p className="text-xs text-destructive">{t("ts.err.outOfRange")}</p>}

          {ok && date && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {isSeconds ? t("ts.detectedSeconds") : t("ts.detectedMillis")}
              </p>
              <CopyRow label={t("ts.localTime")} value={formatLocal(date)} />
              <CopyRow label={t("ts.utcTime")} value={formatUtc(date)} />
              <CopyRow label="ISO 8601" value={date.toISOString()} />
              <CopyRow label={t("ts.relative")} value={relative(date, now)} />
              <CopyRow label={t("ts.weekday")} value={t(`ts.day.${date.getDay()}`)} />
            </div>
          )}
        </div>
      </ToolSection>
    </div>
  )
}

function DateToTs() {
  const { t } = useT()
  const now = new Date()
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}`
  const [value, setValue] = React.useState(local)

  const date = value ? new Date(value) : null
  const ok = date !== null && !isNaN(date.getTime())

  return (
    <div className="space-y-4">
      <ToolSection title={t("ts.section.pick")}>
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
        <ToolSection title={t("ts.section.result")}>
          <div className="space-y-2">
            <CopyRow label={t("ts.seconds10")} value={String(Math.floor(date.getTime() / 1000))} />
            <CopyRow label={t("ts.millis13")} value={String(date.getTime())} />
            <CopyRow label={t("ts.utcTime")} value={formatUtc(date)} />
            <CopyRow label="ISO 8601" value={date.toISOString()} />
          </div>
        </ToolSection>
      )}

      <p className="text-xs text-muted-foreground">
        {t("ts.note")}
      </p>
    </div>
  )
}
