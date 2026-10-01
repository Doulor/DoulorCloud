import * as React from "react"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

type Kind = "same" | "add" | "del"

interface Row {
  kind: Kind
  aNo: number | null
  bNo: number | null
  text: string
}

/** 行级 LCS 差异；行数太多时退化成「整段替换」，避免卡住浏览器 */
function diffLines(a: string[], b: string[]): Row[] {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    return [
      ...a.map((t, i) => ({ kind: "del" as Kind, aNo: i + 1, bNo: null, text: t })),
      ...b.map((t, i) => ({ kind: "add" as Kind, aNo: null, bNo: i + 1, text: t })),
    ]
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows: Row[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", aNo: i + 1, bNo: j + 1, text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "del", aNo: i + 1, bNo: null, text: a[i] })
      i++
    } else {
      rows.push({ kind: "add", aNo: null, bNo: j + 1, text: b[j] })
      j++
    }
  }
  while (i < n) {
    rows.push({ kind: "del", aNo: i + 1, bNo: null, text: a[i] })
    i++
  }
  while (j < m) {
    rows.push({ kind: "add", aNo: null, bNo: j + 1, text: b[j] })
    j++
  }
  return rows
}

export default function TextDiffTool() {
  const { t } = useT()
  const [left, setLeft] = React.useState("")
  const [right, setRight] = React.useState("")
  const [ignoreCase, setIgnoreCase] = React.useState(false)
  const [ignoreSpace, setIgnoreSpace] = React.useState(false)

  const rows = React.useMemo(() => {
    const norm = (s: string) => {
      let out = s
      if (ignoreSpace) out = out.replace(/\s+/g, " ").trim()
      if (ignoreCase) out = out.toLowerCase()
      return out
    }
    const a = left.split("\n").map(norm)
    const b = right.split("\n").map(norm)
    const aRaw = left.split("\n")
    const bRaw = right.split("\n")
    return diffLines(a, b).map((r) => ({
      ...r,
      text: r.kind === "del" ? aRaw[(r.aNo ?? 1) - 1] : r.kind === "add" ? bRaw[(r.bNo ?? 1) - 1] : aRaw[(r.aNo ?? 1) - 1],
    }))
  }, [left, right, ignoreCase, ignoreSpace])

  const added = rows.filter((r) => r.kind === "add").length
  const removed = rows.filter((r) => r.kind === "del").length
  const hasInput = left.length > 0 || right.length > 0

  return (
    <ToolShell
      title={t("toolbox.textDiff.name")}
      description={t("td.desc")}
      wide
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <ToolSection title={t("td.section.old")}>
          <Textarea
            value={left}
            onChange={(e) => setLeft(e.target.value)}
            rows={14}
            className="min-h-[260px] font-mono text-[13px]"
            placeholder={t("td.placeholderOld")}
          />
        </ToolSection>
        <ToolSection title={t("td.section.new")}>
          <Textarea
            value={right}
            onChange={(e) => setRight(e.target.value)}
            rows={14}
            className="min-h-[260px] font-mono text-[13px]"
            placeholder={t("td.placeholderNew")}
          />
        </ToolSection>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ignoreCase}
            onChange={(e) => setIgnoreCase(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          {t("td.ignoreCase")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ignoreSpace}
            onChange={(e) => setIgnoreSpace(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          {t("td.ignoreSpaces")}
        </label>
        <span className="text-sm text-muted-foreground">
          {t("td.addedPrefix")}
          <span className="font-medium text-emerald-600 dark:text-emerald-400">{added}</span>
          {t("td.addedSuffix")}
          {t("td.removedPrefix")}
          <span className="font-medium text-red-600 dark:text-red-400">{removed}</span>
          {t("td.removedSuffix")}
        </span>
      </div>

      <ToolSection title={t("td.section.result")}>
        {!hasInput ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("td.empty")}
          </p>
        ) : (
          <div className="max-h-[520px] overflow-auto rounded-lg border">
            <table className="w-full border-collapse font-mono text-[12.5px]">
              <tbody>
                {rows.map((r, idx) => (
                  <tr
                    key={idx}
                    className={cn(
                      r.kind === "add" && "bg-emerald-500/10",
                      r.kind === "del" && "bg-red-500/10"
                    )}
                  >
                    <td className="w-12 select-none border-r px-2 py-0.5 text-right text-muted-foreground">
                      {r.aNo ?? ""}
                    </td>
                    <td className="w-12 select-none border-r px-2 py-0.5 text-right text-muted-foreground">
                      {r.bNo ?? ""}
                    </td>
                    <td className="w-5 select-none px-1 py-0.5 text-center text-muted-foreground">
                      {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                    </td>
                    <td className="whitespace-pre-wrap break-all px-2 py-0.5">{r.text || "\u00a0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ToolSection>

      <div className="flex justify-end">
        <Label className="text-xs text-muted-foreground">
          {t("td.legend")}
        </Label>
      </div>
    </ToolShell>
  )
}
