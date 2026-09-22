import { Cloud } from "lucide-react"
import { Link } from "react-router-dom"

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      className={`flex items-center gap-2 font-semibold tracking-tight ${className ?? ""}`}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-background">
        <Cloud className="h-4 w-4" />
      </span>
      <span>Doulor Cloud</span>
    </Link>
  )
}
