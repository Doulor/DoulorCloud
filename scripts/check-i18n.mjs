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
  process.exit(1)
} else {
  console.log("结果：没有遗漏，中文文案已全部走 i18n。")
}
