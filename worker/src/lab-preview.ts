/**
 * 把「多文件作品」内联成一份单文件 HTML —— **服务端版**。
 *
 * 为什么要在服务端也做一遍（前端 `src/lib/lab-agent.ts` 里已经有一份）：
 *   造物集要给出一个**能分享出去的固定链接**（`https://tyu.me/p/<id>`），
 *   它必须是一个真正的 URL、任何人不登录也能打开。前端那份只能活在浏览器内存里，
 *   分享不了。所以这里按同样的规则再实现一次，供 `/api/gallery/:id/raw` 使用。
 *
 * ⚠️ 两份实现要**成对修改**：入口挑选规则、link/script 内联、localStorage 垫片，
 *    任何一处改了这里也要跟着改（`src/lib/lab-agent.ts` 的 `buildPreviewDoc` / `STORAGE_SHIM`）。
 *
 * ⚠️ `type="module"` 的脚本**不能**像普通脚本那样摊平内联（2026-10-20，配合 JSX/TS 编译）：
 *    丢掉了 type 就是语法错误，保留 type 又因为内联后没有目录基准而 import 失败。
 *    所以这里把整张相对依赖图编成一串 `data:` URL 再让浏览器去 import。
 *    前端那份用 blob URL（浏览器本地）、这里用 data URL（自包含）——
 *    两边的差异仅此一处，其余规则必须保持一致。
 */

/**
 * 沙箱里的本地存储垫片。
 *
 * 作品跑在带 `sandbox`、**不含 `allow-same-origin`** 的 iframe 里 —— 文档是不透明源，
 * 此时**读 `window.localStorage` 本身就会抛 SecurityError**，
 * 于是开局就 `localStorage.getItem()` 的作品（小游戏几乎都会）会在第一行崩掉，
 * 表现是「页面能打开但按钮点了没反应」。
 * 垫片先探真身能不能用，能用就不碰；不能用就换成内存版 Storage。
 *
 * 必须早于作品自己的脚本执行，所以插在 `<head>` 之后第一个位置。
 */
export const STORAGE_SHIM = `<script>(function(){var make=function(){var m={};var api={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[String(k)]=String(v)},removeItem:function(k){delete m[String(k)]},clear:function(){m={}},key:function(i){var ks=Object.keys(m);return i>=0&&i<ks.length?ks[i]:null}};try{Object.defineProperty(api,"length",{get:function(){return Object.keys(m).length}})}catch(e){}return api};var live=function(s){try{s.setItem("__lab_probe__","1");s.removeItem("__lab_probe__");return true}catch(e){return false}};var install=function(name,fallback){var real=null;try{real=window[name]}catch(e){real=null}if(real&&live(real))return;try{Object.defineProperty(window,name,{configurable:true,get:function(){return fallback}})}catch(e){}};install("localStorage",make());install("sessionStorage",make());})();</script>`

const EXTERNAL_RE = /^(?:[a-z]+:)?\/\//i

/** 把垫片插到最前面（紧跟 `<head>`，确保早于作品自己的脚本） */
function withStorageShim(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + STORAGE_SHIM)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + STORAGE_SHIM)
  return STORAGE_SHIM + html
}

/**
 * 挑入口文件：优先 `index.html`，否则第一个 `.html`，再否则第一个文件。
 * 返回空串 = 这个作品没有可展示的页面。
 */
export function pickEntry(files: Record<string, string>): string {
  const paths = Object.keys(files)
  if (!paths.length) return ""
  if (paths.includes("index.html")) return "index.html"
  return paths.find((p) => p.toLowerCase().endsWith(".html")) ?? paths[0]
}

/** 匹配 `from "…"` / `import("…")` / `import "…"`，捕获前缀、引号、引用路径 */
const IMPORT_REF_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g

/** 把 `from` 所在目录 + 相对引用解析成作品内的绝对路径 */
function resolveInProject(from: string, ref: string): string {
  const base = from.includes("/") ? from.replace(/[^/]+$/, "") : ""
  const stack: string[] = []
  for (const seg of (base + ref).split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") stack.pop()
    else stack.push(seg)
  }
  return stack.join("/")
}

/** 把 JS 源码编成 `data:` URL（浏览器能直接 import，服务端不需要 Blob） */
function toDataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return "data:text/javascript;base64," + btoa(bin)
}

/**
 * 把 ESM 依赖图内联成一串 `data:` URL，返回入口的 URL。
 *
 * 为什么服务端要用 data URL 而不是 blob：
 *   blob URL 是**创建它的进程**本地的，服务端生成一个 blob 链接给浏览器是打不开的。
 *   data URL 是自包含的，浏览器可以直接 `import`。
 *
 * 循环依赖返回 null（data URL 也是先编后引用，做不到互相指向），调用方保持原样输出。
 */
export function inlineModuleGraphData(
  files: Record<string, string>,
  entryPath: string
): string | null {
  if (files[entryPath] == null) return null
  const order: string[] = []
  const state = new Map<string, "visiting" | "done">()

  const visit = (path: string): boolean => {
    const st = state.get(path)
    if (st === "done") return true
    if (st === "visiting") return false
    const code = files[path]
    if (code == null) return false
    state.set(path, "visiting")
    for (const m of code.matchAll(IMPORT_REF_RE)) {
      const dep = resolveInProject(path, m[3])
      if (files[dep] == null) continue
      if (!visit(dep)) return false
    }
    state.set(path, "done")
    order.push(path) // 后序：依赖先入列
    return true
  }

  if (!visit(entryPath)) return null

  const urls = new Map<string, string>()
  for (const path of order) {
    const code = files[path].replace(
      IMPORT_REF_RE,
      (whole, prefix: string, quote: string, ref: string) => {
        const depUrl = urls.get(resolveInProject(path, ref))
        return depUrl ? `${prefix}${quote}${depUrl}${quote}` : whole
      }
    )
    urls.set(path, toDataUrl(code))
  }
  return urls.get(entryPath) ?? null
}

/**
 * 内联成单文件 HTML。
 * iframe 里没有「域名 + 目录」的概念，`./style.css`、`./app.js` 这类相对引用
 * 必须先塞进去，否则样式与脚本都会 404（页面能打开但没样式、按钮没反应）。
 */
export function buildPreviewDoc(files: Record<string, string>): string {
  const entry = pickEntry(files)
  if (!entry) return ""
  let html = files[entry]
  if (!html) return ""

  /**
   * 与前端 `lookup` 同口径，但返回**解析后的项目内路径** ——
   * ESM 依赖图内联需要入口的真实路径，不能只有内容。
   */
  const resolvePath = (ref: string): string | undefined => {
    const clean = ref.split("?")[0].split("#")[0]
    const direct = clean.replace(/^\.\//, "").replace(/^\/+/, "")
    if (files[direct] != null) return direct
    // 相对入口文件所在目录解析（入口在子目录时也能对上）
    const base = entry.includes("/") ? entry.replace(/[^/]+$/, "") : ""
    const joined = base + direct
    return files[joined] != null ? joined : undefined
  }

  const lookup = (ref: string): string | undefined => {
    const path = resolvePath(ref)
    return path == null ? undefined : files[path]
  }

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (!href || EXTERNAL_RE.test(href)) return tag
    const css = lookup(href)
    return css == null ? tag : `<style>\n${css}\n</style>`
  })

  html = html.replace(
    /<script\b([^>]*?)\ssrc\s*=\s*["']([^"']+)["']([^>]*?)>\s*<\/script>/gi,
    (tag, pre: string, src: string, post: string) => {
      if (EXTERNAL_RE.test(src)) return tag
      const attrsRaw = `${pre}${post}`
      const path = resolvePath(src)
      if (path == null) return tag

      /**
       * `type="module"` 单独处理（2026-10-20，配合 JSX/TS 编译）。
       * 普通脚本摊平成内联脚本没问题；module 不行 —— 丢了 type 就是语法错误，
       * 而不丢 type 又因为没有目录基准而 import 失败。所以整张相对依赖图编成 data URL。
       */
      if (/\stype\s*=\s*["']module["']/i.test(attrsRaw)) {
        const url = inlineModuleGraphData(files, path)
        if (url) {
          const attrs = attrsRaw.replace(/\stype\s*=\s*["']module["']/i, "")
          return `<script type="module"${attrs} src="${url}"></script>`
        }
        return tag
      }

      const js = files[path]
      const attrs = attrsRaw.replace(/\stype\s*=\s*["'][^"']*["']/i, "")
      return `<script${attrs}>\n${js}\n</script>`
    }
  )

  return withStorageShim(html)
}
