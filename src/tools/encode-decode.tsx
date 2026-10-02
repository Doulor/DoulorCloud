import * as React from "react"
import { ArrowDownUp, Check, Copy } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { copyText, formatBytes, readAsDataURL } from "@/lib/toolbox/utils"
import { useT } from "@/i18n"

type Mode = "b64e" | "b64d" | "urle" | "urld"

const MODES: { id: Mode; label: string }[] = [
  { id: "b64e", label: "ed.mode.b64e" },
  { id: "b64d", label: "ed.mode.b64d" },
  { id: "urle", label: "ed.mode.urle" },
  { id: "urld", label: "ed.mode.urld" },
]

/** btoa 只认 latin1，先转成 UTF-8 字节再编码，中文才不会乱码 */
function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64decode(text: string): string {
  const clean = text.replace(/\s+/g, "")
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

export default function EncodeDecodeTool() {
  const { t } = useT()
  const [mode, setMode] = React.useState<Mode>("b64e")
  const [input, setInput] = React.useState("")
  const [output, setOutput] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [imgData, setImgData] = React.useState<{ name: string; size: number; url: string; dataUrl: string } | null>(null)

  const run = (text: string, m: Mode) => {
    if (!text) {
      setOutput("")
      setError(null)
      return
    }
    try {
      let result: string
      if (m === "b64e") result = b64encode(text)
      else if (m === "b64d") result = b64decode(text)
      else if (m === "urle") result = encodeURIComponent(text)
      else result = decodeURIComponent(text.replace(/\+/g, " "))
      setOutput(result)
      setError(null)
    } catch {
      setOutput("")
      setError(m === "b64d" ? t("ed.err.badBase64") : t("ed.err.decode"))
    }
  }

  React.useEffect(() => {
    run(input, mode)
  }, [input, mode])

  const copy = async (text: string) => {
    await copyText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <ToolShell
      title={t("toolbox.encodeDecode.name")}
      description={t("ed.desc")}
      wide
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <ToolSection title={t("ed.section.input")}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                title={t("ed.swap")}
                disabled={!output}
                onClick={() => {
                  const flipped: Mode =
                    mode === "b64e" ? "b64d" : mode === "b64d" ? "b64e" : mode === "urle" ? "urld" : "urle"
                  setInput(output)
                  setMode(flipped)
                }}
              >
                <ArrowDownUp className="h-4 w-4" />
              </Button>
            </div>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={14}
              spellCheck={false}
              className="min-h-[300px] font-mono text-[13px]"
              placeholder={t("ed.placeholder")}
            />
          </div>
        </ToolSection>

        <ToolSection
          title={t("ed.section.result")}
          actions={
            <Button variant="ghost" size="sm" disabled={!output} onClick={() => void copy(output)}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          }
        >
          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          ) : (
            <Textarea
              value={output}
              readOnly
              rows={14}
              spellCheck={false}
              className="min-h-[300px] font-mono text-[13px]"
              placeholder={t("ed.resultPlaceholder")}
            />
          )}
        </ToolSection>
      </div>

      <ToolSection title={t("ed.section.image")}>
        {!imgData ? (
          <FileDrop
            accept="image/*"
            onFiles={async (files) => {
              const f = files[0]
              if (!f) return
              const dataUrl = await readAsDataURL(f)
              setImgData({
                name: f.name,
                size: f.size,
                url: URL.createObjectURL(f),
                dataUrl,
              })
            }}
            hint={t("ed.imageHint")}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <img src={imgData.url} alt={imgData.name} className="h-16 w-16 rounded border object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{imgData.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t("ed.imageSize", { orig: formatBytes(imgData.size), b64: formatBytes(imgData.dataUrl.length) })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  URL.revokeObjectURL(imgData.url)
                  setImgData(null)
                }}
              >
                {t("ed.replace")}
              </Button>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                {t("ed.dataUrlLabel")}
              </Label>
              <Textarea
                value={imgData.dataUrl}
                readOnly
                rows={6}
                spellCheck={false}
                className="font-mono text-[11px] break-all"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void copy(imgData.dataUrl)}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {t("ed.copyDataUrl")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(imgData.dataUrl.split(",")[1] ?? "")}
                >
                  {t("ed.copyBase64")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </ToolSection>
    </ToolShell>
  )
}
