import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"

import App from "@/App"
import { I18nProvider } from "@/i18n"
import { AuthProvider } from "@/hooks/use-auth"
import { ErrorBoundary } from "@/components/error-boundary"
import { Toaster } from "@/components/ui/sonner"
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
            <App />
            <Toaster />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
