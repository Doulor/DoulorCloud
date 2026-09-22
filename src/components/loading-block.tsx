import { Loader2 } from "lucide-react"

export function LoadingBlock({ className }: { className?: string }) {
  return (
    <div
      className={`flex items-center justify-center py-16 text-muted-foreground ${className ?? ""}`}
    >
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  )
}
