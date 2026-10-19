/**
 * 浏览器内编译：把 JSX / TSX / TS 源码转成浏览器能直接跑的 JS。
 *
 * 为什么需要它
 * ------------
 * AI 实验室的作品最终就是「一堆静态文件」——预览和发布都不经过构建服务器。
 * 所以天然跑不了 JSX/TS：浏览器不认识这些语法。常见做法是每台机器配一个
 * 构建容器（Google AI Studio 就是每个 app 一个 Cloud Run 容器），但那是另一套
 * 产品形态和账单。
 *
 * 这里选了另一条路：**把编译器搬进浏览器**。用 Sucrase（纯 JS、约 60KB、
 * 只做语法转换不做打包），在预览/保存前把源码就地编译成 .js 产物写回文件集。
 * 产物是普通静态文件，后续预览、发布、绑域名全部照旧走同一条链路 ——
 * **后端、存储、发布流程一行都不用改**。
 *
 * 约定（很重要）
 * --------------
 *   App.jsx  ──编译──►  App.js        （同目录、同名、只换扩展名）
 *   ui/Card.tsx ─────►  ui/Card.js
 *
 * 引用路径也一并改写（`./App.jsx` → `./App.js`），这样 AI 无论写
 * `import App from "./App.jsx"` 还是 `src="./App.jsx"`，产物都能正确加载。
 * 源码文件**保留**，方便后续继续改。
 *
 * 不做什么
 * --------
 * · 不打包（不做 bundle）：多个 .js 之间靠浏览器原生 ESM + importmap 解析，
 *   裸模块（react、vue…）由作品里声明的 importmap 指向 CDN（esm.sh）。
 * · 不做类型检查：TS 只剥离类型标注，类型错误不阻塞（跟 esbuild 口径一致）。
 * · 不处理 .vue 单文件：那需要 @vue/compiler-sfc，另外的活。
 */

/** 需要编译的扩展名 → Sucrase 的 transforms 参数 */
const COMPILE_MAP: Record<string, ("jsx" | "typescript")[]> = {
  jsx: ["jsx"],
  tsx: ["jsx", "typescript"],
  ts: ["typescript"],
}

export type CompileError = {
  /** 出错的源文件路径 */
  path: string
  /** 错误信息（已简化，直接能给用户看） */
  message: string
}

export type CompileResult = {
  /** 编译后的完整文件集（源码 + 产物） */
  files: Record<string, string>
  /** 新生成/覆盖的产物路径 */
  outputs: string[]
  /** 编译失败的文件（失败的源文件不会产生产物） */
  errors: CompileError[]
}

export type LabCompileOptions = {
  /**
   * JSX 运行时。
   *
   * · `automatic`（默认）：产物里自动 `import { jsx as _jsx } from "react/jsx-runtime"`，
   *   要求作品的 importmap 里有 `"react/jsx-runtime"` 映射。
   *   好处是 AI 不用记得每个文件都 `import React` —— 它经常忘。
   * · `classic`：产物里是 `React.createElement(...)`，要求源码里有 `import React`。
   */
  jsxRuntime?: "automatic" | "classic"
}

/** 判断某个路径是否需要编译 */
export function needsCompile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return ext in COMPILE_MAP
}

/** 源码路径 → 产物路径（只换扩展名） */
export function outputPathFor(path: string): string {
  return path.replace(/\.(jsx|tsx|ts)$/i, ".js")
}

/**
 * 把代码里的相对引用从源码扩展名改成产物扩展名。
 *
 * 覆盖三种常见写法：
 *   import x from "./App.jsx"
 *   import("./App.jsx")
 *   <script src="./App.jsx">  /  <link href="./style.tsx">
 *
 * 只改**相对路径**（./ 或 ../），裸模块名和 http(s) 地址一律不动。
 */
function rewriteSpecifiers(code: string): string {
  const re = /(\.{1,2}\/[^"'`\s)]+)\.(jsx|tsx|ts)\b/g
  return code.replace(re, "$1.js")
}

/**
 * 编译作品里的 JSX/TS 源码。
 *
 * 没有可编译文件时**不会加载 Sucrase**（`import()` 是懒加载的），
 * 所以纯 HTML/CSS/JS 的作品零额外开销、零网络请求。
 */
export async function compileLabSources(
  files: Record<string, string>,
  opts: LabCompileOptions = {}
): Promise<CompileResult> {
  const sources = Object.keys(files).filter(needsCompile)
  if (!sources.length) {
    return { files, outputs: [], errors: [] }
  }

  // 懒加载：只有真的有 JSX/TS 才把编译器拉下来
  const { transform } = await import("sucrase")
  const jsxRuntime = opts.jsxRuntime ?? "automatic"

  const out: Record<string, string> = { ...files }
  const outputs: string[] = []
  const errors: CompileError[] = []

  for (const path of sources) {
    const ext = path.split(".").pop()?.toLowerCase() ?? ""
    const transforms = COMPILE_MAP[ext]
    const source = files[path]
    if (!transforms || source === undefined) continue

    try {
      const result = transform(source, {
        transforms,
        // 产物要看不出是编译出来的：去掉 __self/__source 这些开发期参数
        production: true,
        // 只剥离 TS 类型，不做类型检查
        disableESTransforms: true,
        jsxRuntime,
        filePath: path,
      })
      // 产物路径：同目录同名换扩展名
      const target = outputPathFor(path)
      out[target] = rewriteSpecifiers(result.code)
      outputs.push(target)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "compile failed")
      // Sucrase 的报错常带一大段堆栈/定位，只留第一行给人看
      errors.push({ path, message: message.split("\n")[0].slice(0, 300) })
    }
  }

  // HTML 里的引用也要跟着改写（AI 写 src="./App.jsx" 也能跑）
  for (const path of Object.keys(out)) {
    if (path.toLowerCase().endsWith(".html")) {
      out[path] = rewriteSpecifiers(out[path])
    }
  }

  return { files: out, outputs, errors }
}

