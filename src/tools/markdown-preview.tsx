import * as React from "react"
import { Download } from "lucide-react"

import { Markdown } from "@/components/markdown"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { downloadBlob } from "@/lib/toolbox/utils"

const SAMPLE = `# 标题

这是一段**正文**，支持 *斜体*、~~删除线~~ 和 \`行内代码\`。

## 列表

- 第一项
- 第二项
  - 嵌套一项

## 表格

| 项目 | 说明 |
| --- | --- |
| 语法 | GitHub 风格 |
| 导出 | 可存成 HTML |

> 引用一段话。

\`\`\`js
console.log("代码块也支持高亮结构")
\`\`\`
`

export default function MarkdownPreviewTool() {
  const [text, setText] = React.useState(SAMPLE)
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
<title>文档</title>
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
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `文档-${Date.now()}.html`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolShell
      title="Markdown 预览"
      description="左边写、右边看，支持表格、任务列表、代码块。写完可以导出成 HTML 或 .md 文件。"
      wide
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <ToolSection title="Markdown 源码">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={22}
            className="min-h-[420px] font-mono text-[13px] leading-relaxed"
            placeholder="在这里输入 Markdown…"
          />
        </ToolSection>

        <ToolSection
          title="预览"
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadBlob(
                    new Blob([text], { type: "text/markdown;charset=utf-8" }),
                    `文档-${Date.now()}.md`
                  )
                }
              >
                下载 .md
              </Button>
              <Button size="sm" onClick={() => void exportHtml()} disabled={busy}>
                <Download className="h-4 w-4" />
                导出 HTML
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
