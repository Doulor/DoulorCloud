#!/usr/bin/env node
/**
 * i18n 覆盖检查：扫描 src/ 下所有 .ts/.tsx，找出「还没国际化」的中文。
 *
 * 做法：
 *   1. 先剥掉注释（块注释、行注释）—— 注释不需要翻译，剥掉才能看清真实工作量。
 *   2. 剩下的内容里只要出现中日韩统一表意文字，就是「面向用户的文案没走 i18n」。
 *   3. src/i18n/ 整个目录跳过 —— 那里是词典本身，中文是正常内容。
 *
 * 退出码非 0 表示还有遗漏，便于以后接进 CI。
 * 用法：node scripts/check-i18n.mjs [--list]
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const SRC = join(ROOT, "src")
const CJK = /[\u4e00-\u9fff]/
const SHOW_LIST = process.argv.includes("--list")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === "i18n" || name === "node_modules") continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

/** 剥掉注释：先块注释，再行注释。 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // 避免误伤 https://
}

const files = walk(SRC)
const hits = []
for (const f of files) {
  const lines = stripComments(readFileSync(f, "utf8")).split("\n")
  lines.forEach((line, i) => {
    if (CJK.test(line)) {
      hits.push({ file: relative(ROOT, f).replace(/\\/g, "/"), line: i + 1, text: line.trim() })
    }
  })
}

const byFile = new Map()
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) || 0) + 1)

console.log("i18n 覆盖检查")
console.log("  src/ 下 .ts/.tsx 文件:", files.length)
console.log("  仍含中文（未国际化）的行:", hits.length)
console.log("  涉及文件:", byFile.size)
console.log("")

if (byFile.size) {
  console.log("  按中文行数排序（前 25 个文件）：")
  ;[...byFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .forEach(([f, n]) => console.log("    " + String(n).padStart(4) + "  " + f))
  console.log("")
}

if (SHOW_LIST) {
  console.log("  逐条清单：")
  for (const h of hits) console.log("    " + h.file + ":" + h.line + "  " + h.text.slice(0, 110))
  console.log("")
}

if (hits.length) {
  console.log("结果：还有 " + hits.length + " 行未国际化。")
  console.log("（加 --list 看逐条清单）")
} else {
  console.log("结果：没有遗漏，中文文案已全部走 i18n。")
}

// —— 第二项检查：代码里引用了、但词典里没有的 key ——
// 这类 bug 检查不出来（没有中文、tsc 也不管），现象是界面上直接显示 "adm.xxx"。
// 只告警不改退出码：动态拼的 key（`landing.f${i}.title`）会被误报，不能硬拦。
const zhSrc = readFileSync(join(ROOT, "src/i18n/zh.ts"), "utf8")
const dict = new Set([...zhSrc.matchAll(/^\s{2}"([^"]+)":/gm)].map((m) => m[1]))
const prefixes = new Set([...dict].map((k) => k.split(".")[0]))
const KEYLIKE = /"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)"/g
const dangling = new Map()
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, "/")
  for (const m of stripComments(readFileSync(f, "utf8")).matchAll(KEYLIKE)) {
    const k = m[1]
    if (dict.has(k) || !prefixes.has(k.split(".")[0])) continue
    if (!dangling.has(k)) dangling.set(k, new Set())
    dangling.get(k).add(rel)
  }
}
if (dangling.size) {
  console.log("")
  console.log("⚠️ 有 " + dangling.size + " 个 key 被引用但词典里没有（界面会直接显示 key）——")
  console.log("   其中可能是动态拼的 key，请自行确认：")
  for (const [k, where] of [...dangling].sort()) {
    console.log("    " + k.padEnd(30) + " " + [...where].join(", "))
  }
}

// —— 第三项检查：后端错误消息有没有英文译文 ——
// worker 抛的 ApiError 消息是中文（也是日志原文），前端按**消息原文**查
// src/i18n/api-messages.ts。后端改了文案而这里没跟，用户就会在英文界面看到中文。
// 做法与运行时一致：先用精确表、再用模板正则试，都不中就报出来。
const apiSrc = readFileSync(join(SRC, "i18n/api-messages.ts"), "utf8")
const apiExact = new Set(
  [...apiSrc.matchAll(/^\s{2}("(?:[^"\\]|\\.)*"):\s*"/gm)].map((m) =>
    JSON.parse(m[1])
  )
)
const apiPatterns = []
for (const m of apiSrc.matchAll(/\{\s*src:\s*("(?:[^"\\]|\\.)*"),/g)) {
  try {
    apiPatterns.push(new RegExp(JSON.parse(m[1])))
  } catch {
    /* 生成的正则一定能编译，这里只是防御 */
  }
}

const WORKER = join(ROOT, "worker/src")
function walkTs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkTs(p, out)
    else if (/\.ts$/.test(name)) out.push(p)
  }
  return out
}
const APIERR = /ApiError\(\s*\d+\s*,\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/gs
const apiMissing = []
for (const f of walkTs(WORKER)) {
  const code = stripComments(readFileSync(f, "utf8"))
  for (const m of code.matchAll(APIERR)) {
    const raw = m[1].slice(1, -1)
    if (!CJK.test(raw)) continue
    if (apiExact.has(raw)) continue
    if (apiPatterns.some((re) => re.test(raw))) continue
    apiMissing.push([relative(ROOT, f).replace(/\\/g, "/"), raw])
  }
}
if (apiMissing.length) {
  console.log("")
  console.log(`⚠️ 有 ${apiMissing.length} 条后端错误消息没有英文译文（英文界面会显示中文）：`)
  for (const [f, raw] of apiMissing.slice(0, 30)) {
    console.log("    " + f + "  " + raw.replace(/\s+/g, " ").slice(0, 70))
  }
  if (apiMissing.length > 30) console.log(`    …还有 ${apiMissing.length - 30} 条`)
  console.log("    → 补进 src/i18n/api-messages.ts（key 用中文原文）")
}

// —— 第四项检查：词典里的「转义没被解释」 ——
// 词条值里写了 `\u201c` 这种双反斜杠转义，运行时不会被解释，界面上会**原样显示** "\u201c"。
// 之前 en.ts 有 100 多处（引号、破折号、¥ 全中招），肉眼在代码里根本看不出来。
// 例外：unicode 转换工具的词条是**故意**展示转义序列的，跳过。
const dictFiles = ["src/i18n/zh.ts", "src/i18n/en.ts"]
const DICT_KEY = /^\s{2}"([^"]+)":\s*"((?:\\.|[^"\\])*)"/gm
const escapeIssues = []
for (const rel of dictFiles) {
  const txt = readFileSync(join(ROOT, rel), "utf8")
  for (const m of txt.matchAll(DICT_KEY)) {
    const key = m[1]
    if (key.startsWith("ucv.") || key.startsWith("toolbox.unicode")) continue
    // 歌词输入框的占位符也是**故意**写着 \n 给人看的
    if (key === "pf.music.lyricsPh") continue
    const bad = [...m[2].matchAll(/\\\\u[0-9a-fA-F]{4}|\\\\[nrt]/g)].map((x) => x[0])
    if (bad.length) escapeIssues.push(`  ${rel}  ${key}  →  ${[...new Set(bad)].join(" ")}`)
  }
}
if (escapeIssues.length) {
  console.log("")
  console.log(`⚠️ 有 ${escapeIssues.length} 条词条里的转义不会被解释（界面会原样显示 \\u201c 这种东西）：`)
  for (const s of escapeIssues.slice(0, 20)) console.log(s)
  if (escapeIssues.length > 20) console.log(`    …还有 ${escapeIssues.length - 20} 条`)
  console.log("    → 改成真正的字符（“ ” – — ¥），或者用单反斜杠转义")
}

// —— 第五项检查：渲染了变量名（key），也就是漏套 t() ——
// 这一类「没有中文、词典里也有这个 key」，前四项一个都抓不到，但用户会直接在按钮上看到
// `ap.review.approved` 这种东西。做法（AST + 简单数据流）：
//   ① 持有者 = 初始值里含 key 字面量的变量，以及「引用了持有者」的变量（迭代到不动点）
//   ② 生产者 = 函数体里有 `return <引用了持有者 / 含 key 字面量>` 的函数
//   ③ 这些名字出现在 JSX 表达式/属性、模板字符串、toast/confirm 实参里，
//      而整段没有 t()/tStatic() ⇒ 报
// 只告警不退出非 0（少量误报：`.variant` 这类非文案属性、名字在不同作用域撞车）。
let parse = null
try {
  ;({ parse } = await import("@babel/parser"))
} catch {
  console.log("")
  console.log("（未安装 @babel/parser，跳过「渲染了变量名」检查；npm i -D @babel/parser 可开启）")
}

if (parse) {
  const SKIP_KEYS = new Set([
    "loc", "start", "end", "extra", "comments", "tokens", "errors",
    "leadingComments", "trailingComments", "innerComments",
  ])
  const tw = (node, fn, parent) => {
    if (!node || typeof node.type !== "string") return
    node.__p = parent
    fn(node)
    for (const k of Object.keys(node)) {
      if (k.startsWith("__") || SKIP_KEYS.has(k)) continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && tw(c, fn, node))
      else if (v && typeof v.type === "string") tw(v, fn, node)
    }
  }
  const isKeyValue = (x) => {
    const p = x.__p
    if (!p) return false
    if (p.type === "CallExpression" && (p.callee.name === "t" || p.callee.name === "tStatic")) return false
    return (
      (p.type === "ObjectProperty" && p.value === x) ||
      p.type === "ArrayExpression" ||
      p.type === "ConditionalExpression" ||
      p.type === "LogicalExpression" ||
      p.type === "ReturnStatement" ||
      (p.type === "AssignmentExpression" && p.right === x)
    )
  }
  const hasT = (node) => {
    let yes = false
    tw(node, (x) => {
      if (x.type === "CallExpression" && x.callee.type === "Identifier" && (x.callee.name === "t" || x.callee.name === "tStatic")) yes = true
    })
    return yes
  }
  const refs = (node, names) => {
    const hit = new Set()
    tw(node, (x) => {
      if (x.type === "Identifier" && names.has(x.name)) hit.add(x.name)
    })
    return hit
  }
  const hasKeyLiteral = (node) => {
    let yes = false
    tw(node, (x) => {
      if (x.type === "StringLiteral" && dict.has(x.value) && isKeyValue(x)) yes = true
    })
    return yes
  }
  const NON_TEXT = "key|value|id|variant|length|count|enabled|disabled|features|permissions|hex|channelType|badge|tone|icon|to|sample|w|h"

  /** 分析一个文件：谁持有 key、谁返回 key、导出了哪些 */
  const analyze = (abs) => {
    let src, ast
    try {
      src = readFileSync(abs, "utf8")
      ast = parse(src, { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: true })
    } catch {
      return null
    }
    const decls = []
    const exports = new Set()
    tw(ast, (n) => {
      if (n.type === "VariableDeclarator" && n.init) decls.push([n.id, n.init])
      if (n.type === "ExportNamedDeclaration" && n.declaration) {
        const d = n.declaration
        if (d.type === "VariableDeclaration") d.declarations.forEach((x) => x.id.type === "Identifier" && exports.add(x.id.name))
        else if (d.type === "FunctionDeclaration" && d.id) exports.add(d.id.name)
      }
    })
    const holders = new Set()
    for (let round = 0; round < 6; round++) {
      let changed = false
      for (const [id, init] of decls) {
        if (id.type !== "Identifier" || holders.has(id.name)) continue
        if (hasKeyLiteral(init) || refs(init, holders).size) {
          holders.add(id.name)
          changed = true
        }
      }
      if (!changed) break
    }
    const producers = new Set()
    tw(ast, (n) => {
      let name = null
      let body = null
      if (n.type === "FunctionDeclaration" && n.id) {
        name = n.id.name
        body = n.body
      } else if (
        n.type === "VariableDeclarator" &&
        n.id.type === "Identifier" &&
        n.init &&
        (n.init.type === "ArrowFunctionExpression" || n.init.type === "FunctionExpression")
      ) {
        name = n.id.name
        body = n.init.body
      }
      if (!name || !body) return
      let ret = false
      tw(body, (x) => {
        if (x.type !== "ReturnStatement" || !x.argument) return
        if (hasKeyLiteral(x.argument) || refs(x.argument, holders).size) ret = true
      })
      if (ret) producers.add(name)
    })
    return { abs, src, ast, holders, producers, exports }
  }

  const analyzed = files.map(analyze).filter(Boolean)
  // 跨文件：从别的文件 import 进来的「持有 key 的变量 / 返回 key 的函数」也算
  const exported = new Set()
  for (const a of analyzed) {
    for (const n of [...a.holders, ...a.producers]) if (a.exports.has(n)) exported.add(n)
  }

  const rawKeyHits = []
  for (const a of analyzed) {
    const names = new Set([...a.holders, ...a.producers, ...exported])
    if (!names.size) continue
    const sites = []
    tw(a.ast, (n) => {
      if (n.type === "JSXExpressionContainer") sites.push(n.expression)
      else if (n.type === "JSXAttribute" && n.value && n.value.type === "JSXExpressionContainer") sites.push(n.value.expression)
      else if (n.type === "TemplateLiteral") sites.push(n)
      else if (
        n.type === "CallExpression" &&
        n.callee.type === "MemberExpression" &&
        n.callee.object.name === "toast" &&
        ["success", "error", "warning", "info"].includes(n.callee.property.name)
      )
        sites.push(n)
      else if (n.type === "CallExpression" && ["confirm", "prompt", "alert"].includes(n.callee.name)) sites.push(n)
    })
    for (const expr of sites) {
      if (!expr || expr.type === "JSXEmptyExpression") continue
      const hit = refs(expr, names)
      if (!hit.size || hasT(expr)) continue
      const text = a.src.slice(expr.start, expr.end)
      if (/^\s*[A-Za-z_$][\w$]*\s*(===|!==|==|!=)/.test(text)) continue
      const lowered = [...hit].map((nm) =>
        text.replace(new RegExp("\\b" + nm + "\\s*\\??\\.\\s*(" + NON_TEXT + ")\\b", "g"), "")
      )
      if (lowered.every((t) => !new RegExp("\\b(?:" + [...hit].join("|") + ")\\b").test(t))) continue
      rawKeyHits.push(`  ${relative(ROOT, a.abs).replace(/\\/g, "/")}:${expr.loc.start.line}  [${[...hit].join(",")}]  ${text.replace(/\s+/g, " ").slice(0, 90)}`)
    }
  }
  const uniqHits = [...new Set(rawKeyHits)]
  if (uniqHits.length) {
    console.log("")
    console.log(`⚠️ 有 ${uniqHits.length} 处可能在界面上直接显示了词条 key（漏套 t()）：`)
    for (const s2 of uniqHits.slice(0, 30)) console.log(s2)
    if (uniqHits.length > 25) console.log(`    …还有 ${uniqHits.length - 25} 处`)
    console.log("    → 用 t(...) 包起来；若是 .variant/.icon 这类非文案属性可忽略")
  }
}

if (hits.length) process.exit(1)

