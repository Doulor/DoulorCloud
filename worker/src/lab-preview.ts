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

  const lookup = (ref: string): string | undefined => {
    const clean = ref.split("?")[0].split("#")[0]
    const direct = clean.replace(/^\.\//, "").replace(/^\/+/, "")
    if (files[direct] != null) return files[direct]
    // 相对入口文件所在目录解析（入口在子目录时也能对上）
    const base = entry.includes("/") ? entry.replace(/[^/]+$/, "") : ""
    return files[base + direct]
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
      const js = lookup(src)
      if (js == null) return tag
      const attrs = `${pre}${post}`.replace(/\stype\s*=\s*["'][^"']*["']/i, "")
      return `<script${attrs}>\n${js}\n</script>`
    }
  )

  return withStorageShim(html)
}
