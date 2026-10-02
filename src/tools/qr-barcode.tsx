import * as React from "react"
import { Download } from "lucide-react"
import * as QRCode from "qrcode"
import JsBarcode from "jsbarcode"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { canvasToBlob, downloadBlob } from "@/lib/toolbox/utils"
import { useT } from "@/i18n"

export default function QrBarcodeTool() {
  const { t } = useT()
  return (
    <ToolShell
      title={t("toolbox.qrBarcode.name")}
      description={t("qr.desc")}
    >
      <Tabs defaultValue="qr">
        <TabsList>
          <TabsTrigger value="qr">{t("qr.tab.qr")}</TabsTrigger>
          <TabsTrigger value="barcode">{t("qr.tab.barcode")}</TabsTrigger>
        </TabsList>
        <TabsContent value="qr" className="mt-4">
          <QrPanel />
        </TabsContent>
        <TabsContent value="barcode" className="mt-4">
          <BarcodePanel />
        </TabsContent>
      </Tabs>
    </ToolShell>
  )
}

type QrKind = "text" | "wifi" | "vcard"

function QrPanel() {
  const { t } = useT()
  const [kind, setKind] = React.useState<QrKind>("text")
  const [text, setText] = React.useState("https://cloud.doulor.cn")
  const [ssid, setSsid] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [encryption, setEncryption] = React.useState("WPA")
  const [vName, setVName] = React.useState("")
  const [vPhone, setVPhone] = React.useState("")
  const [vOrg, setVOrg] = React.useState("")
  const [size, setSize] = React.useState(512)
  const [level, setLevel] = React.useState<"L" | "M" | "Q" | "H">("M")
  const [dark, setDark] = React.useState("#000000")
  const [light, setLight] = React.useState("#ffffff")
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // 生成用的画布始终隐藏。不用它直接当预览，是因为 qrcode 会往 canvas 上写死
  // 行内 style="width:Npx;height:Npx"，把预览的宽度压到 max-w 后高度却还留着原值，
  // 二维码就会被横向挤扁。改成取出 dataURL 用 <img> 显示，尺寸完全由我们控制。
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  const payload = React.useMemo(() => {
    if (kind === "wifi") {
      const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1")
      return `WIFI:T:${encryption};S:${esc(ssid)};${password ? `P:${esc(password)};` : ""};`
    }
    if (kind === "vcard") {
      return [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${vName}`,
        vOrg ? `ORG:${vOrg}` : "",
        vPhone ? `TEL;TYPE=CELL:${vPhone}` : "",
        "END:VCARD",
      ]
        .filter(Boolean)
        .join("\n")
    }
    return text
  }, [kind, text, ssid, password, encryption, vName, vOrg, vPhone])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!payload.trim()) {
      setError(null)
      setDataUrl(null)
      return
    }
    let cancelled = false
    QRCode.toCanvas(canvas, payload, {
      width: size,
      margin: 2,
      errorCorrectionLevel: level,
      color: { dark, light },
    })
      .then(() => {
        if (cancelled) return
        setDataUrl(canvas.toDataURL("image/png"))
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setDataUrl(null)
        setError(e instanceof Error ? e.message : t("qr.err.generate"))
      })
    return () => {
      cancelled = true
    }
  }, [payload, size, level, dark, light])

  const download = async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const blob = await canvasToBlob(canvas, "image/png")
    downloadBlob(blob, `qrcode-${Date.now()}.png`)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <ToolSection title={t("qr.section.content")}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("qr.type")}</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as QrKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">{t("qr.type.text")}</SelectItem>
                  <SelectItem value="wifi">{t("qr.type.wifi")}</SelectItem>
                  <SelectItem value="vcard">{t("qr.type.vcard")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("qr.size")}</Label>
              <Select value={String(size)} onValueChange={(v) => setSize(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[256, 512, 1024, 2048].map((s) => (
                    <SelectItem key={s} value={String(s)}>
                      {s} × {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {kind === "text" && (
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder={t("qr.textPlaceholder")}
            />
          )}

          {kind === "wifi" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("qr.ssid")}</Label>
                <Input value={ssid} onChange={(e) => setSsid(e.target.value)} placeholder="MyWiFi" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("qr.password")}</Label>
                <Input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("qr.passwordPlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("qr.encryption")}</Label>
                <Select value={encryption} onValueChange={setEncryption}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WPA">WPA / WPA2 / WPA3</SelectItem>
                    <SelectItem value="WEP">WEP</SelectItem>
                    <SelectItem value="nopass">{t("qr.enc.nopass")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {kind === "vcard" && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("qr.vcard.name")}</Label>
                <Input value={vName} onChange={(e) => setVName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("qr.vcard.phone")}</Label>
                <Input value={vPhone} onChange={(e) => setVPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("qr.vcard.org")}</Label>
                <Input value={vOrg} onChange={(e) => setVOrg(e.target.value)} />
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("qr.ecLevel")}</Label>
              <Select value={level} onValueChange={(v) => setLevel(v as "L" | "M" | "Q" | "H")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="L">L · 7%</SelectItem>
                  <SelectItem value="M">M · 15%</SelectItem>
                  <SelectItem value="Q">Q · 25%</SelectItem>
                  <SelectItem value="H">H · 30%</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("qr.fg")}</Label>
              <Input type="color" value={dark} onChange={(e) => setDark(e.target.value)} className="h-9 p-1" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("qr.bg")}</Label>
              <Input type="color" value={light} onChange={(e) => setLight(e.target.value)} className="h-9 p-1" />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("qr.colorHint")}
          </p>
        </div>
      </ToolSection>

      <ToolSection title={t("qr.section.preview")}>
        <div className="flex flex-col items-center gap-3">
          <div className="flex w-full items-center justify-center rounded-lg border bg-white p-3">
            {dataUrl ? (
              <img
                src={dataUrl}
                alt={t("qr.alt.qr")}
                className="block aspect-square w-full max-w-[240px]"
              />
            ) : (
              <div className="aspect-square w-full max-w-[240px] rounded bg-muted" />
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button onClick={() => void download()} disabled={!payload.trim() || !!error} className="w-full">
            <Download className="h-4 w-4" />
            {t("qr.downloadPng")}
          </Button>
        </div>
      </ToolSection>
    </div>
  )
}

const BARCODE_FORMATS = [
  { id: "CODE128", label: "qr.fmt.code128", sample: "ABC-12345" },
  { id: "CODE39", label: "qr.fmt.code39", sample: "ABC123" },
  { id: "EAN13", label: "qr.fmt.ean13", sample: "6901234567892" },
  { id: "EAN8", label: "qr.fmt.ean8", sample: "12345670" },
  { id: "UPC", label: "qr.fmt.upca", sample: "123456789012" },
  { id: "ITF14", label: "qr.fmt.itf14", sample: "10012345000017" },
  { id: "MSI", label: "qr.fmt.msi", sample: "1234567" },
  { id: "pharmacode", label: "qr.fmt.pharmacode", sample: "1234" },
  { id: "codabar", label: "qr.fmt.codabar", sample: "A123456789B" },
]

function BarcodePanel() {
  const { t } = useT()
  const [format, setFormat] = React.useState("CODE128")
  const [value, setValue] = React.useState("ABC-12345")
  const [barWidth, setBarWidth] = React.useState(2)
  const [height, setHeight] = React.useState(100)
  const [showText, setShowText] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!value.trim()) {
      const ctx = canvas.getContext("2d")
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
      setError(null)
      return
    }
    try {
      JsBarcode(canvas, value, {
        format,
        width: barWidth,
        height,
        displayValue: showText,
        margin: 12,
        background: "#ffffff",
        lineColor: "#000000",
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("qr.err.generateFormat"))
      const ctx = canvas.getContext("2d")
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [value, format, barWidth, height, showText])

  const current = BARCODE_FORMATS.find((f) => f.id === format)

  const download = async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const blob = await canvasToBlob(canvas, "image/png")
    downloadBlob(blob, `barcode-${Date.now()}.png`)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <ToolSection title={t("qr.section.content")}>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("qr.barcode.format")}</Label>
            <Select
              value={format}
              onValueChange={(v) => {
                setFormat(v)
                const f = BARCODE_FORMATS.find((x) => x.id === v)
                if (f) setValue(f.sample)
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BARCODE_FORMATS.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {t(f.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("qr.barcode.content")}</Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={current?.sample}
            />
            {current && (
              <p className="text-xs text-muted-foreground">{t("qr.barcode.sample", { sample: current.sample })}</p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("qr.barcode.barWidth", { n: barWidth })}</Label>
              <input
                type="range"
                min={1}
                max={6}
                value={barWidth}
                onChange={(e) => setBarWidth(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("qr.barcode.height", { n: height })}</Label>
              <input
                type="range"
                min={40}
                max={240}
                step={10}
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showText}
              onChange={(e) => setShowText(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            {t("qr.barcode.showText")}
          </label>
        </div>
      </ToolSection>

      <ToolSection title={t("qr.section.preview")}>
        <div className="flex flex-col items-center gap-3">
          <div className="flex w-full items-center justify-center overflow-hidden rounded-lg border bg-white p-3">
            <canvas ref={canvasRef} className="h-auto max-w-full" />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button onClick={() => void download()} disabled={!value.trim() || !!error} className="w-full">
            <Download className="h-4 w-4" />
            {t("qr.downloadPng")}
          </Button>
        </div>
      </ToolSection>
    </div>
  )
}
