import * as React from "react"

import { zh } from "./zh"
import { en } from "./en"

export type Lang = "zh" | "en"
export type Dict = Record<string, string>

const DICTS: Record<Lang, Dict> = { zh, en }

const STORAGE_KEY = "doulor-lang"

/** 支持的语言（顺序即切换按钮里的顺序） */
export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: "zh", label: "简体中文", short: "中" },
  { id: "en", label: "English", short: "EN" },
]

/**
 * 初始语言：优先用户上次选的（localStorage），否则按系统语言判断。
 * 系统语言以 zh 开头（zh-CN / zh-Hant…）就用中文，其余一律英文 ——
 * 站点面向的是能看懂英文的用户群，未匹配到中文时给英文比给中文更稳妥。
 */
export function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === "zh" || saved === "en") return saved
  } catch {
    // localStorage 在隐私模式下可能抛错，忽略即可
  }
  const list =
    (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || []
  for (const l of list) {
    if (typeof l === "string" && l.toLowerCase().startsWith("zh")) return "zh"
  }
  return "en"
}

interface I18nValue {
  lang: Lang
  setLang: (l: Lang) => void
  /** 取词。缺失时回落到中文；再没有就原样返回 key（方便一眼看出漏翻） */
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = React.createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>(() => detectInitialLang())

  const setLang = React.useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      // 存不下就算了，只影响下次记不住选择
    }
  }, [])

  // 同步 <html lang>，让浏览器/读屏器/字体回退拿到正确语种
  React.useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"
  }, [lang])

  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const raw = DICTS[lang][key] ?? DICTS.zh[key] ?? key
      if (!vars) return raw
      return raw.replace(/\{(\w+)\}/g, (m, name) =>
        vars[name] !== undefined ? String(vars[name]) : m
      )
    },
    [lang]
  )

  const value = React.useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT(): I18nValue {
  const ctx = React.useContext(I18nContext)
  if (!ctx) throw new Error("useT 必须在 <I18nProvider> 内使用")
  return ctx
}

/** 当前语言的 BCP47 标记，给 toLocaleString / toLocaleDateString 用 */
export function localeOf(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en-US"
}
