import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * 站点当前**实际**的深浅色 —— 就是 `<html>` 上有没有 `.dark`
 * （见 `hooks/use-theme.ts`：用户选日间/夜间/跟随系统，最终都落到这个 class 上）。
 */
function siteTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light"
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

const Toaster = ({ ...props }: ToasterProps) => {
  /**
   * 🔴 这里**不能**用 sonner 的 `theme="system"`：它只认操作系统的
   * `prefers-color-scheme`，而本站主题是用户可以手选的（写 `<html class="dark">`）。
   * 两者不一致时（典型：系统深色 + 站点手动切到日间）右下角 toast 会保持暗色 —— 就是这个 bug。
   * 改成直接读站点的最终主题，并监听 class 变化实时同步。
   */
  const [theme, setTheme] = React.useState<"light" | "dark">(siteTheme)

  React.useEffect(() => {
    const sync = () => setTheme(siteTheme())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
