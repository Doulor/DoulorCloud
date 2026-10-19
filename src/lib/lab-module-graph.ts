/**
 * 把 ESM 依赖图内联成可直接在 `<iframe srcdoc>` 里跑的 blob URL。
 *
 * 为什么需要
 * ----------
 * 编辑器里的预览是把整篇作品塞进 `srcdoc` 里跑的，**没有目录、没有文件系统**。
 * 一旦作品用了 `<script type="module" src="./main.js">`，里面的 `import "./App.js"`
 * 会以文档 URL 为基准去请求一个根本不存在的地址 —— 结果就是白屏，而同一份作品
 * 发布到域名后却完全正常。这种「预览坏、发布好」的割裂最难让人理解。
 *
 * 做法
 * ----
 *   1. 从入口出发 DFS 收集所有**相对** import 的模块（后序入列 ⇒ 依赖在前）；
 *   2. 从最底层开始逐个 `Blob` → `URL.createObjectURL`，
 *      并把该模块里指向别处的 import 改写成**已经建好的 blob URL**；
 *   3. 返回入口的 blob URL，调用方拿它当 `<script type="module" src="…">`。
 *
 * 裸模块（react、vue…）和 CDN 地址原样保留，交给作品自己的 importmap 解析。
 *
 * 为什么单独一个文件
 * ------------------
 * 这里只有纯函数、零依赖。`lab-agent.ts` 是刻意做成零依赖的（它会被算进首屏
 * 附近的 chunk），不能因为要用这几十行就把 Sucrase（~195KB）连带拉进去。
 */

/** 匹配 `from "…"` / `import("…")` / `import "…"`，捕获前缀、引号、引用路径 */
const IMPORT_REF_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g

/** 把 `from` 所在目录 + 相对引用解析成作品内的绝对路径 */
export function resolveInProject(from: string, ref: string): string {
  const base = from.includes("/") ? from.replace(/[^/]+$/, "") : ""
  const stack: string[] = []
  for (const seg of (base + ref).split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") stack.pop()
    else stack.push(seg)
  }
  return stack.join("/")
}

export type ModuleGraphResult = {
  /** 入口模块的 blob URL */
  url: string
  /** 参与内联的模块（依赖在前，入口最后） */
  modules: string[]
}

/**
 * 把入口模块及其相对依赖打包成 blob URL。
 *
 * 遇到**循环依赖**时返回 null：blob 一旦创建就不可变，做不到两个模块互相引用。
 * 调用方拿到 null 应保持原样输出（宁可让浏览器报真实的网络错误，也不要把
 * `type="module"` 弄丢导致语法错误）。
 */
export function inlineModuleGraph(
  files: Record<string, string>,
  entryPath: string
): ModuleGraphResult | null {
  if (files[entryPath] == null) return null

  const order: string[] = []
  const state = new Map<string, "visiting" | "done">()

  const visit = (path: string): boolean => {
    const st = state.get(path)
    if (st === "done") return true
    if (st === "visiting") return false // 环
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

  // 叶子在前建 blob；每个模块里的相对 import 改写成已建好的 blob URL
  const urls = new Map<string, string>()
  for (const path of order) {
    const code = files[path].replace(
      IMPORT_REF_RE,
      (whole, prefix: string, quote: string, ref: string) => {
        const depUrl = urls.get(resolveInProject(path, ref))
        return depUrl ? `${prefix}${quote}${depUrl}${quote}` : whole
      }
    )
    urls.set(
      path,
      URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
    )
  }

  const url = urls.get(entryPath)
  return url ? { url, modules: order } : null
}
