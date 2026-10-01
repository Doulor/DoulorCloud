import * as React from "react"
import { Upload } from "lucide-react"

import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

interface FileDropProps {
  accept?: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  label?: string
  hint?: string
  disabled?: boolean
  className?: string
}

/** 统一的「拖拽 / 点击」选文件区，工具箱所有需要输入文件的工具共用 */
export function FileDrop({
  accept,
  multiple,
  onFiles,
  label,
  hint,
  disabled,
  className,
}: FileDropProps) {
  const { t } = useT()
  const [over, setOver] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const emit = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const files = Array.from(list)
    onFiles(multiple ? files : files.slice(0, 1))
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          if (!disabled) inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!disabled) emit(e.dataTransfer.files)
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
        over ? "border-primary bg-accent/60" : "border-border hover:border-primary/50 hover:bg-accent/30",
        disabled && "pointer-events-none opacity-60",
        className
      )}
    >
      <Upload className="h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium">{label ?? t("fd.defaultLabel")}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          emit(e.target.files)
          e.target.value = ""
        }}
      />
    </div>
  )
}
