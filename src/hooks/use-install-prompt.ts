import * as React from "react"

/**
 * 捕获浏览器的「安装 PWA」提示（beforeinstallprompt），把它变成可控按钮。
 *
 * 浏览器只在「满足安装条件 + 尚未安装 + 且未被频繁拒绝」时才会派发这个事件；
 * 派发过之后事件不再重来 —— 所以必须第一时间 preventDefault 并缓存起来，
 * 等用户点「安装到桌面」按钮时再手动 prompt()。
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export function useInstallPrompt() {
  const [prompt, setPrompt] = React.useState<BeforeInstallPromptEvent | null>(null)

  React.useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setPrompt(null)
    window.addEventListener("beforeinstallprompt", onPrompt)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  const install = React.useCallback(async () => {
    if (!prompt) return false
    await prompt.prompt()
    const choice = await prompt.userChoice
    if (choice.outcome === "accepted") setPrompt(null)
    return choice.outcome === "accepted"
  }, [prompt])

  return { canInstall: prompt !== null, install }
}
