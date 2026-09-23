/**
 * 一致性护栏：检查「引用的实现是否真的存在」。
 *
 * 为什么需要（2026-09-23 审计发现）：
 *   本分支曾出现过一类**编译期就该发现、却一路混到最后**的问题 ——
 *   `index.ts` 导入了不存在的 `./handlers/r2-admin`、调用了从未定义的
 *   `storageHandlers.proxyUpload` / `tempboxHandlers.proxyTempboxUpload`，
 *   三个 handler 从 `../r2` 引入了 `isStorageConfigured` / `getPlatformBucketId`
 *   而 `r2.ts` 并未导出。多 AI 并行开发 + 无 CI 的情况下，这类"调用方在、实现不在"
 *   的错误会反复发生（起因是选择性 `git add` 只提交了消费方）。
 *
 * 本脚本纯静态分析（不依赖 tsc / node_modules），检查三件事：
 *   1. `worker/src/index.ts` 里 `import * as XHandlers from "./handlers/x"` 的模块文件是否存在；
 *   2. `XHandlers.fn(...)` 调用是否都能在该模块的导出里找到；
 *   3. `worker/src/**` 里所有相对路径 import 的具名导出是否存在
 *      （能直接抓出「r2.ts 没导出 isStorageConfigured」这类问题）。
 *
 * 用法：
 *   node scripts/check-handlers.mjs          # 只检查
 *   node scripts/check-handlers.mjs --list   # 额外打印扫描到的模块与导出数量
 *
 * 退出码：0 = 通过；1 = 发现问题（供 CI 使用）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, "..", "src")
const ENTRY = join(SRC, "index.ts")

const problems = []

/**
 * 剥离注释后再做模式匹配。
 * 必须做这一步：本项目习惯在注释里写「正确写法示例」，例如 quotas.ts 的
 * import { parseBasicFeatures } from "../quotas" —— 不剥注释就会把它当成真 import，
 * 报出「模块不存在」的误报（开发时真实踩到过）。
 *
 * ⚠️ 顺序很关键：**必须先删行注释、再删块注释**。
 *   reserved-names.ts 的行注释里写着「<fqdn> 加 斜杠星号 路由」（形如路径通配符），
 *   其中的块注释起始标记若被优先识别，就会一路吞到下一个结束标记，
 *   把整个 RESERVED_NAMES 数组连同下面的函数一起抹掉，产生成片的假「缺导出」
 *   （开发时真实踩到过）。先删行注释即可把这类尾巴一并带走。
 *
 * 已知局限：字符串字面量或正则里出现块注释标记时仍可能误判。
 * 本项目源码里没有这种情况；若将来出现，请把本函数换成按 token 扫描。
 */
function stripComments(text) {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

/** 递归收集 src/**\/*.ts */
function collectFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectFiles(full))
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

/** 该文件导出的名字集合（含 interface / type / `export { ... }` 重导出） */
function readExports(file) {
  const text = stripComments(readFileSync(file, "utf8"))
  const names = new Set()

  // export [async] function|const|let|class|interface|type|enum NAME
  const declRe =
    /export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g
  for (const m of text.matchAll(declRe)) names.add(m[1])

  // export { a, b as c } / export { a } from "./x"
  const groupRe = /export\s+(?:type\s+)?\{([^}]*)\}/g
  for (const m of text.matchAll(groupRe)) {
    for (const raw of m[1].split(",")) {
      const seg = raw.trim()
      if (!seg) continue
      // `b as c` → 对外暴露的名字是 c
      const parts = seg.split(/\s+as\s+/)
      names.add((parts[1] ?? parts[0]).replace(/^type\s+/, "").trim())
    }
  }
  return names
}

/** `import { a, b as c } from "..."` 引用的导出（返回 [{from, names}]） */
function readNamedImports(file) {
  const text = stripComments(readFileSync(file, "utf8"))
  const out = []
  const re = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g
  for (const m of text.matchAll(re)) {
    const spec = m[2]
    if (!spec.startsWith(".")) continue // 跳过裸模块（postal-mime 等）
    const names = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim())
      .filter(Boolean)
    out.push({ from: spec, names })
  }
  return out
}

/** 相对说明符 → 本地绝对路径（补 .ts / /index.ts） */
function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const candidates = [`${base}.ts`, join(base, "index.ts")]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

const files = collectFiles(SRC)
const exportsCache = new Map()
const exportsOf = (file) => {
  if (!exportsCache.has(file)) exportsCache.set(file, readExports(file))
  return exportsCache.get(file)
}

// ---- 检查 1 & 2：index.ts 的 handler 命名空间 ----
const entryText = stripComments(readFileSync(ENTRY, "utf8"))
const namespaces = new Map()
const nsRe = /import\s+\*\s+as\s+(\w+)\s+from\s+["']\.\/([\w\-/]+)["']/g
for (const m of entryText.matchAll(nsRe)) {
  const [, alias, spec] = m
  const target = resolveSpecifier(ENTRY, `./${spec}`)
  if (!target) {
    problems.push(`[缺模块] index.ts 导入 "./${spec}"（${alias}），但文件不存在`)
    continue
  }
  namespaces.set(alias, target)
}

for (const [alias, file] of namespaces) {
  const eks = exportsOf(file)
  const callRe = new RegExp(`\\b${alias}\\.(\\w+)\\s*\\(`, "g")
  const reported = new Set()
  for (const m of entryText.matchAll(callRe)) {
    const fn = m[1]
    if (reported.has(fn)) continue
    if (!eks.has(fn)) {
      reported.add(fn)
      problems.push(
        `[缺导出] index.ts 调用了 ${alias}.${fn}()，但 ${short(file)} 未导出 ${fn}`
      )
    }
  }
}

// ---- 检查 3：全量具名 import ↔ 导出 ----
for (const file of files) {
  for (const { from, names } of readNamedImports(file)) {
    const target = resolveSpecifier(file, from)
    if (!target) {
      problems.push(`[缺模块] ${short(file)} 导入 "${from}"，但解析不到该文件`)
      continue
    }
    const eks = exportsOf(target)
    for (const name of names) {
      if (!eks.has(name)) {
        problems.push(
          `[缺导出] ${short(file)} 引入 { ${name} } from "${from}"，但 ${short(target)} 未导出该名字`
        )
      }
    }
  }
}

function short(p) {
  return p.replace(resolve(here, "..", "..") + "\\", "").replace(/\\/g, "/")
}

// ---- 输出 ----
if (process.argv.includes("--list")) {
  console.log(`扫描 ${files.length} 个源文件，识别 ${namespaces.size} 个 handler 命名空间：`)
  for (const [alias, file] of namespaces) {
    console.log(`  ${alias.padEnd(22)} -> ${short(file)}（${exportsOf(file).size} 个导出）`)
  }
  console.log("")
}

if (problems.length === 0) {
  console.log(`✅ 一致性检查通过：${files.length} 个源文件，未发现缺失的模块或导出。`)
  process.exit(0)
}

console.error(`❌ 一致性检查失败：发现 ${problems.length} 处「引用了不存在的实现」\n`)
for (const p of problems) console.error(`  - ${p}`)
console.error(
  `\n提示：这类问题通常是「另一个 AI 的未提交在制品」被选择性 git add 造成的 ——\n` +
    `      消费方进了仓库、实现方没进。请确认实现方是否遗漏提交，再决定补实现还是回滚消费方。\n` +
    `      （参见 HANDOFF §15 协作注意、docs/审计报告-Doulor-Cloud-2026-09-23.md P0-1）`
)
process.exit(1)
