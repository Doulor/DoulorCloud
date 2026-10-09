import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"

import App from "@/App"
import { I18nProvider } from "@/i18n"
import { AuthProvider } from "@/hooks/use-auth"
import { ErrorBoundary } from "@/components/error-boundary"
import { ExternalLinkDialog } from "@/components/external-link-dialog"
import { ConfirmDialogHost } from "@/components/confirm-dialog"
import { Toaster } from "@/components/ui/sonner"
import { ToastCopyMenu } from "@/components/toast-copy-menu"
import { TooltipProvider } from "@/components/ui/tooltip"
import { reloadOnceForChunkError } from "@/lib/chunk-error"
import "@/index.css"

/**
 * 部署后旧 chunk 404 的兜底（详见 lib/chunk-error.ts）。
 * 这里注册在 React 之外：有些动态导入失败不会走到 ErrorBoundary，
 * 全局监听能更早、更全地接住它们。
 */
// Vite 的模块预加载失败事件（Vite 5+）；类型不在标准 lib 里，用 any 收口
window.addEventListener("vite:preloadError" as never, ((e: Event) => {
  e.preventDefault?.()
  reloadOnceForChunkError((e as unknown as { payload?: unknown }).payload ?? e)
}) as never)

window.addEventListener("error", (e) => {
  reloadOnceForChunkError(e.error ?? e.message)
})

window.addEventListener("unhandledrejection", (e) => {
  reloadOnceForChunkError(e.reason)
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <BrowserRouter>
          <AuthProvider>
            {/*
              TooltipProvider 必须挂在根上。
              背景（2026-10-01 站长反馈「DNS 管理界面用不了，报 Tooltip must be
              used within TooltipProvider」）：admin-dns.tsx 直接用了 <Tooltip>，
              却没人给它套 Provider，Radix 会**抛异常**⇒ ErrorBoundary 接住后整页不可用。
              放在这里之后，任何页面（含懒加载的 admin 子页）用 Tooltip 都不必各自包一层。
              delayDuration 取 200ms：比 Radix 默认的 700ms 跟手，又不至于划过就弹。
            */}
            <TooltipProvider delayDuration={200}>
              <App />
            </TooltipProvider>
            {/*
              外链跳转确认弹窗（2026-10-07）。
              和 Toaster 一样是「全局单例 UI」：Markdown 里的链接点击发生在任意深度，
              在这里挂**一次**，各处只调 requestExternalLink() 即可
              （详见 components/external-link-dialog.tsx）。
            */}
            <ExternalLinkDialog />
            {/*
              全局确认弹窗（2026-10-09）：替代浏览器自带的 confirm / prompt。
              同样是「挂一次、全局可用」—— 各处调 confirmDialog() / promptDialog()，
              详见 components/confirm-dialog.tsx。
            */}
            <ConfirmDialogHost />
            <Toaster />
            {/*
              右下角 toast 的右键复制菜单（2026-10-08 站长要求）。
              toast 可以左右滑动关闭，选文字会被滑动手势抢走 ⇒ 右键弹出「复制」，
              把整条通知的标题 + 描述拷进剪贴板。同样挂一次，全局生效。
            */}
            <ToastCopyMenu />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
