import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        页面不存在
      </h1>
      <p className="text-sm text-muted-foreground">
        你访问的页面可能已被移动或删除。
      </p>
      <Button asChild className="mt-2">
        <Link to="/">返回首页</Link>
      </Button>
    </div>
  )
}
