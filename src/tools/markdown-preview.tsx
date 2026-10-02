import * as React from "react"
import { Download } from "lucide-react"

import { Markdown } from "@/components/markdown"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { downloadBlob } from "@/lib/toolbox/utils"
import { useT, tStatic } from "@/i18n"

const SAMPLE = () => tStatic("md.sample")

export default function MarkdownPreviewTool() {
  const { t } = useT()
  const [text, setText] = React.useState(SAMPLE())
  const [busy, setBusy] = React.useState(false)
  const previewRef = React.useRef<HTMLDivElement>(null)

  const exportHtml = async () => {
    const node = previewRef.current
    if (!node) return
    setBusy(true)
    try {
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{tStatic("md.htmlTitle")}</title>
<style>
  body { max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.75;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #24292f; }
  h1, h2, h3 { line-height: 1.3; margin-top: 1.6em; }
  code { background: #f6f8fa; padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
  pre { background: #f6f8fa; padding: 14px; border-radius: 8px; overflow: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0; padding-left: 16px; border-left: 4px solid #d0d7de; color: #57606a; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; }
  img { max-width: 100%; }
</style>
</head>
<body>
${node.innerHTML}
</body>
</html>`
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), t("md.fileName", { ts: Date.now(), ext: "html" }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolShell
      title={t("toolbox.markdown.name")}
      description={t("md.desc")}
      wide
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <ToolSection title={t("md.section.source")}>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={22}
            className="min-h-[420px] font-mono text-[13px] leading-relaxed"
            placeholder={t("md.placeholder")}
          />
        </ToolSection>

        <ToolSection
          title={t("md.section.preview")}
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadBlob(
                    new Blob([text], { type: "text/markdown;charset=utf-8" }),
                    t("md.fileName", { ts: Date.now(), ext: "md" })
                  )
                }
              >
                {t("md.downloadMd")}
              </Button>
              <Button size="sm" onClick={() => void exportHtml()} disabled={busy}>
                <Download className="h-4 w-4" />
                {t("md.exportHtml")}
              </Button>
            </div>
          }
        >
          <div
            ref={previewRef}
            className="max-h-[520px] min-h-[420px] overflow-auto rounded-lg border bg-background p-4"
          >
            <Markdown>{text}</Markdown>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
