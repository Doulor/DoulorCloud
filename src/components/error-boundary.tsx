import * as React from "react"
import { AlertTriangle, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { isChunkLoadError, reloadOnceForChunkError } from "@/lib/chunk-error"

interface State {
  error: Error | null
}

/**
 * 全局错误边界：任意页面组件抛错时兜底，避免整站白屏。
 * React 只能通过 class 组件捕获渲染期异常。
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 线上没有错误上报服务，先落到控制台，便于用户反馈时排查
    console.error("[ErrorBoundary]", error, info.componentStack)

    // 部署后旧 chunk 404（React.lazy 失败会走到这里）：自动刷新换到新版本，
    // 不等用户点按钮。触发了刷新就把错误状态清掉，免得闪一下错误页。
    if (reloadOnceForChunkError(error)) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="glass-card w-full max-w-md rounded-xl border p-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <h1 className="text-base font-semibold">页面出错了</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isChunkLoadError(error)
              ? "站点刚更新过版本，已自动尝试刷新但没恢复。再点一次「刷新页面」即可。"
              : "页面渲染时遇到异常，可以刷新重试。如果反复出现，请把下面的信息反馈给管理员。"}
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-muted/50 p-2.5 text-left text-xs text-muted-foreground">
            {error.message || String(error)}
          </pre>
          <div className="mt-4 flex justify-center gap-2">
            <Button size="sm" onClick={() => window.location.reload()}>
              <RotateCw className="h-4 w-4" /> 刷新页面
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                this.setState({ error: null })
                window.location.href = "/"
              }}
            >
              回到首页
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
