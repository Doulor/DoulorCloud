import * as React from "react"

import { reloadOnceForChunkError } from "@/lib/chunk-error"
import { zh } from "./zh"

export type Lang = "zh" | "en"
export type Dict = Record<string, string>

/**
 * 取词时允许传入的变量类型。
 *
 * 放宽到 boolean / null / undefined 是**故意的**：这些词条多半是从模板字符串
 * 批量搬过来的（`已选 ${n} 个` 之类），原来的 `String(x)` 行为必须保持一致
 * —— 表达式是 `string | undefined` 时，旧代码渲染的就是 "undefined"。
 */
export type TVars = Record<string, string | number | boolean | null | undefined>

/**
 * 中文词典的「宽松字典」视图。
 * zh.ts 用 `as const` 导出（好处是 `MessageKey` 能成为字面量联合，en.ts 靠它保证
 * 一条不漏），但字面量类型没有字符串索引签名，`zh[key]` 会直接 TS7053。
 * 这里显式收宽成 Dict 再索引，类型检查的严谨性留在 en.ts 那边。
 */
const ZH: Dict = zh

/**
 * 词典表：**首屏同步只放中文**。
 *
 * 为什么是中文：
 *   ① 它是站点默认语言（index.html 的 lang="zh-CN"），也是主要用户群；
 *   ② 它是所有语言的兜底词典 —— `t()` 里 `dict[key] ?? ZH[key]`，
 *      任何语言缺词都要回落到它，所以它必须同步可用。
 *
 * 另外两份词典（en.ts ~490KB、api-messages.ts ~110KB 源码）**不进首屏**：
 * 一个用户只需要一种语言，把另一种也塞进首屏等于让所有人都多下几百 KB。
 * 英文走下面的 ensureDict() 按需 import，中文用户一个字节都不多付。
 */
const DICTS: Partial<Record<Lang, Dict>> = { zh: ZH }

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

/**
 * 后端错误消息词表（`api-messages.ts`，源码 ~110KB）的加载器。
 *
 * 只有「英文界面 + 后端抛了中文消息」这一种情况才用得到：中文界面下
 * translateApiMessage() 直接原样返回，一个词都不查。所以它同样不进首屏。
 *
 * 用 `typeof import(...)` 取类型，好处是不必静态 import —— 否则打包器会
 * 认为它是静态依赖，又给塞回首屏了。
 */
type ApiMessagesModule = typeof import("./api-messages")
let apiMessages: ApiMessagesModule | null = null
/** 模板正则只编译一次；词表没到之前保持 null */
let apiPatterns: { re: RegExp; en: string }[] | null = null
let apiLoading = false

function loadApiMessages() {
  if (apiMessages || apiLoading) return
  apiLoading = true
  void import("./api-messages")
    .then((m) => {
      apiMessages = m
      // 词表与正则要配套：换了一份词表就得重编译
      apiPatterns = null
    })
    .catch(() => {
      // 网络抖动：允许下次调用再试，不要让一次失败永久关掉翻译
      apiLoading = false
    })
}

/**
 * 按需取词典（目前只有英文）。
 *
 * ⚠️ 这里的 import 必须写成**字面量**的 `import("./en")`：
 * 写成 `import(\`./${lang}\`)` 这种变量形式，Rolldown 无法静态判断具体模块，
 * 会把 zh 和 en 一起塞进**同一个**动态 chunk —— 那等于没拆（首屏照样下两份）。
 * 字面量写法才能让 zh 留在入口 chunk、en 单独成 chunk。
 */
function ensureDict(l: Lang): Promise<void> {
  if (DICTS[l]) return Promise.resolve()
  if (l !== "en") return Promise.resolve()
  // 英文界面才需要后端词表，与词典并行拉，别串行等
  loadApiMessages()
  return import("./en").then((m) => {
    DICTS.en = m.en
  })
}

/**
 * 启动预取：**在模块顶层**（而不是 Provider 的 effect 里）就发起 import()。
 *
 * 为什么放这里：i18n/index.tsx 是入口 chunk 里最早执行的模块之一，此时发起
 * 请求能与首屏渲染并行；若等到 effect，渲染已经空转一轮，英文用户会明显多等。
 * 中文用户 `BOOT_LANG === "zh"` 时这里什么都不做 —— 也正是本次优化的主要收益。
 */
const BOOT_LANG: Lang = detectInitialLang()
// 失败在这里**先吞掉**：错误处理统一交给 Provider（它会先试全局的「旧 chunk 自动刷新」，
// 再不济也是用中文兜底把页面渲染出来）。两处都处理反而会触发两次刷新。
if (BOOT_LANG !== "zh") ensureDict(BOOT_LANG).catch(() => {})

interface I18nValue {
  lang: Lang
  setLang: (l: Lang) => void
  /** 取词。缺失时回落到中文；再没有就原样返回 key（方便一眼看出漏翻） */
  t: (key: string, vars?: TVars) => string
}

const I18nContext = React.createContext<I18nValue | null>(null)

/**
 * 当前语言的模块级镜像。
 *
 * 为什么要它：hooks 只能在组件里用，而有些地方取词发生在
 * 「class 组件（错误边界）」「模块级工具函数（toast 文案）」里。
 * Provider 每次渲染都会把它同步成最新语言。
 */
let currentLang: Lang = "zh"

/** 取词（非 hook 版本）：给 class 组件与组件外代码用；组件里请优先 useT() */
export function tStatic(key: string, vars?: TVars): string {
  // 当前语言的词典可能还没到（英文首屏的头几十毫秒），回落中文先顶着
  const dict = DICTS[currentLang] ?? ZH
  const raw = dict[key] ?? ZH[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

/**
 * 后端错误消息的英文化。
 *
 * 背景：`worker/src` 里的 `ApiError(status, message)` 一律是中文（那是运维/日志
 * 也认的原文），前端拿到 `err.message` 直接显示，于是英文界面上会蹦出中文
 * ——注册时那句「密码至少需要 8 位」就是这么来的。
 *
 * 做法：**按消息原文**查一份独立词表（`api-messages.ts`），不按错误码 ——
 * `NOT_FOUND` 这类码一条对十几句，按码翻会把「商品不存在」说成「未找到」。
 * 中文界面下直接原样返回；查不到也原样返回（宁可显示中文，不要空白）。
 */
export function translateApiMessage(message: string): string {
  if (!message || currentLang === "zh") return message
  if (!apiMessages) {
    // 词表还没落地（英文首屏最初的几十毫秒）：先原文返回，顺手补一次下载。
    // 这条路上宁可短暂显示中文，也不为它把 ~94KB 词表塞进中文用户的首屏 ——
    // 那 94KB 对中文界面是**永远用不到**的死重量。
    loadApiMessages()
    return message
  }
  const exact = apiMessages.API_MESSAGES_EN[message]
  if (exact) return exact
  const label = apiMessages.API_LABELS_EN[message]
  if (label) return label
  if (!apiPatterns) {
    apiPatterns = apiMessages.API_MESSAGE_PATTERNS.map((p) => ({ re: new RegExp(p.src), en: p.en }))
  }
  for (const p of apiPatterns) {
    const m = message.match(p.re)
    if (!m) continue
    return p.en.replace(/\{v(\d+)\}/g, (_, i) => m[Number(i) + 1] ?? "")
  }
  return message
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>(() => BOOT_LANG)

  /**
   * 词典是否就绪。英文词典要等 import() 落地，**落地前先不渲染**：
   * 否则第一帧查不到英文词条、会回落成中文闪一下（视觉上是「先中文后英文」）。
   * 中文用户这里是 true（zh 已同步在内），挂载时机与改动前完全一致。
   */
  const [ready, setReady] = React.useState(() => DICTS[BOOT_LANG] !== undefined)

  React.useEffect(() => {
    if (ready) return
    let alive = true
    void ensureDict(lang)
      .catch((err) => {
        // 词典 chunk 拉不下来（部署换了哈希之后的旧页面、或断网）：
        //   ① 先交给全局那套「旧 chunk 自动刷新」逻辑（与懒加载页面同一套机制），
        //   ② 没触发刷新（不是 chunk 错误 / 已经刷够次数）就把 ready 置真，
        //      用中文兜底词典把界面渲染出来 —— 英文用户看到中文，好过停在空白页。
        reloadOnceForChunkError(err)
      })
      .then(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [lang, ready])

  // 让 tStatic 也能拿到当前语言（含首帧：Provider 渲染时写入）
  currentLang = lang

  const setLang = React.useCallback(
    (l: Lang) => {
      if (l === lang) return
      try {
        localStorage.setItem(STORAGE_KEY, l)
      } catch {
        // 存不下就算了，只影响下次记不住选择
      }
      // 词典已在内存：立刻切（与改动前一样的同步手感）
      if (DICTS[l]) {
        setLangState(l)
        return
      }
      // 第一次切到该语言：等词条到齐再切。中间界面保持旧语言不动，
      // 不闪空白、也不出现「一半中文一半英文」的过渡帧。
      // 拉不下来就保持当前语言（切换看起来「没反应」），并交给全局兜底决定是否刷新。
      void ensureDict(l).then(
        () => setLangState(l),
        (err) => reloadOnceForChunkError(err)
      )
    },
    [lang]
  )

  // 同步 <html lang>，让浏览器/读屏器/字体回退拿到正确语种
  React.useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"
  }, [lang])

  const t = React.useCallback(
    (key: string, vars?: TVars) => {
      const dict = DICTS[lang] ?? ZH
      const raw = dict[key] ?? ZH[key] ?? key
      if (!vars) return raw
      return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
    },
    [lang]
  )

  const value = React.useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  if (!ready) return null
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
