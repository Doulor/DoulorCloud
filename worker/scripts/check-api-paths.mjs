/**
 * 一致性护栏：检查「前端调用的 API 路径在 Worker 路由表里是否存在」。
 *
 * 为什么需要（2026-09-25 审计 F4 发现）：
 *   社区链接预览的后端实现 `linkPreview()` 早就写好了，前端也在调
 *   `/api/community/link-preview`，但 `index.ts` 的路由表里**没有这条路由** ——
 *   结果请求被 SPA 兜底成 index.html（200 + HTML），前端 `res.json()` 解析失败，
 *   表现为「链接卡片永远出不来」，且没有任何报错线索。这类「跨端路径对不上」
 *   的问题编译期发现不了、单元测试也覆盖不到（测试直接调 handler，绕过路由表）。
 *
 * 本脚本纯静态分析（不依赖 tsc / node_modules），做两件事：
 *   1. 从 `worker/src/index.ts` 抽出全部路由路径
 *      （`path: "..."` 与 `match: ... => routePath.match(/^\/...$/)` 两种形态）；
 *   2. 从 `src/**` 抽出 `request(...)` / `fetch(...)` 调用里的路径字面量，
 *      归一化成 `/api/...` 后逐个比对；找不到对应路由的即为问题。
 *
 * 用法：
 *   node scripts/check-api-paths.mjs            # 只检查
 *   node scripts/check-api-paths.mjs --list     # 打印抽到的路由与调用
 *
 * 退出码：0 = 通过；1 = 发现问题（供 CI 使用）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const WORKER_SRC = resolve(here, "..", "src")
const REPO = resolve(here, "..", "..")
const WEB_SRC = join(REPO, "src")
const ENTRY = join(WORKER_SRC, "index.ts")

const LIST = process.argv.includes("--list")
const problems = []
const warnings = []

/**
 * 已知且**已确认**的跨端缺口（allowlist）。
 *
 * 为什么要有它：这两个缺口都要改 `worker/src/index.ts` 的路由表，而该文件
 * 在本次修复期间由另一个 AI 占用（正在做「商汤 Key 捐献 + 捐献模型重试」）。
 * 写进 allowlist 而不是直接忽略，是为了让缺口**留在代码里可被搜索到**：
 * 一旦对方合并完成、路由补上，本脚本会立刻报「allowlist 里的条目已不再缺失」，
 * 提醒把它删掉。
 *
 * ⚠️ 新增条目必须写清楚「为什么现在不能修」和「谁来修」。
 */
const KNOWN_GAPS = [
  // 2026-09-25：原先这里有两条，都已在另一个 AI 释放 index.ts 后修掉：
  //   1. /api/community/link-preview —— 补了路由（index.ts），链接卡片从此真的会出卡片；
  //   2. /api/community/comments/   —— 前端那个 deleteComment 是没人引用的死方法，
  //      后端也从来没有对应 handler，已直接从 api.ts 删除（而不是顺手加一个
  //      新的写接口上线）。
  // 留这个空数组是因为脚本的「缺口已修复就报错」逻辑依赖它存在。
]

/** 先删行注释、再删块注释（保持行号） */
function stripComments(text) {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
}

/**
 * 粗略的括号配平：只数 `(` 和 `)`，并跳过引号内的字符。
 * 目的是判断「这次调用在这一行写完了没有」，不需要真正的词法分析。
 * 模板字符串里嵌套的 `${...}`（例如 `encodeURIComponent(x)`）括号本身是配平的，
 * 所以即便引号识别不完美，结论仍然正确。
 */
function parenDepth(line) {
  let depth = 0
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if (ch === "(") depth++
    else if (ch === ")") depth--
  }
  return depth
}

function collectFiles(dir, exts) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

// ---- 1. 抽 Worker 路由 ----
if (!existsSync(ENTRY)) {
  console.error(`✗ 找不到 ${relative(process.cwd(), ENTRY)}`)
  process.exit(1)
}
const entrySrc = stripComments(readFileSync(ENTRY, "utf8"))

/** 路由路径统一成 `/api/...` 形式（index.ts 里 path 是相对 /api 的） */
function toApiPath(p) {
  if (!p.startsWith("/")) p = `/${p}`
  return p.startsWith("/api") ? p : `/api${p}`
}

const workerRoutes = new Set()
for (const m of entrySrc.matchAll(/\bpath:\s*"([^"]+)"/g)) {
  workerRoutes.add(toApiPath(m[1]))
}
// match: (routePath) => routePath.match(/^\/oauth\/grants\/([^/]+)$/)
//
// ⚠️ 这里的捕获组不能用「排除 / 和 \」的字符类：正则体里必然出现 `\/`（转义斜杠），
// 而参数段的写法 `([^/]+)` 里那个 `/` **前面没有反斜杠**，用排除 `/` 的字符类
// 会在第一个参数段就匹配失败，整条路由被静默漏掉（开发时真实踩到过：
// tempbox 的 5 条带参路由全部没被抽出来，于是误报成「前端调了不存在的接口」）。
// 改为非贪婪地吃到正则字面量的收尾 `/)`。
for (const m of entrySrc.matchAll(/routePath\.match\(\s*\/(.+?)\/\s*\)/g)) {
  let p = m[1].replace(/\\\//g, "/").replace(/^\^/, "").replace(/\$$/, "")
  p = p.replace(/\([^)]*\)/g, "*") // 参数段 → *
  if (p.startsWith("/")) workerRoutes.add(toApiPath(p))
}

/** 路由的静态前缀（截到第一个参数段），用于前缀匹配 */
function routePrefix(p) {
  const cut = p.indexOf("*")
  return (cut >= 0 ? p.slice(0, cut) : p).replace(/\/+$/, "")
}

// ---- 2. 抽前端调用路径 ----
const webFiles = existsSync(WEB_SRC) ? collectFiles(WEB_SRC, [".ts", ".tsx"]) : []
/** @type {{ path: string, site: string }[]} */
const calls = []

for (const file of webFiles) {
  const src = stripComments(readFileSync(file, "utf8"))
  const lines = src.split("\n")
  lines.forEach((line, i) => {
    // 只认「在请求调用里」的字面量，避免把 react-router 的 "/dashboard" 当成 API 路径
    if (!/\b(request|requestRaw|fetch|sendBeacon)\s*[<(]/.test(line)) return

    // ⚠️ 路径字面量经常在**下一行**：
    //     request<{ messages: MailMessage[]; nextCursor: string | null }>(
    //       `/mailbox/${mailboxId}/messages${...}`
    //     ),
    // 原先只看触发行，这类调用会**静默消失**在比对之外 —— 实测踩到过：
    // 把 api.ts 的 listMessages 改成上面这种多行写法后，调用点计数从 143 掉到 142，
    // 而检查依旧「通过」。所以这里把**括号尚未闭合**的续行也纳入。
    //
    // 用括号配平（而不是无脑多看几行）是为了避免误报：单行写完的调用
    // 括号已闭合，不会把下一条语句的字符串当成自己的路径。
    let text = line
    let depth = parenDepth(line)
    for (let j = i + 1; depth > 0 && j < lines.length && j <= i + 6; j++) {
      text += "\n" + lines[j]
      depth += parenDepth(lines[j])
    }

    for (const m of text.matchAll(/["'`](\/[^"'`\s]*)["'`]/g)) {
      let raw = m[1]
      // 去掉 ${...} 之后的部分与查询串，得到静态前缀
      raw = raw.split("${")[0].split("?")[0].split("#")[0]
      if (!raw || raw === "/") continue
      calls.push({ path: toApiPath(raw), site: `${relative(REPO, file)}:${i + 1}` })
    }
  })
}

// ---- 3. 比对 ----
const prefixes = [...workerRoutes].map(routePrefix)
const allowHit = new Set()
const seen = new Set()
for (const { path, site } of calls) {
  const key = `${path}@${site}`
  if (seen.has(key)) continue
  seen.add(key)

  const match = prefixes.some(
    (p) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`)
  )
  if (match) continue

  const gap = KNOWN_GAPS.find((g) => path === g.path)
  if (gap) {
    allowHit.add(gap.path)
    warnings.push(`${site} 调用了 ${path}（**已知缺口，见脚本 KNOWN_GAPS**）：${gap.reason}`)
    continue
  }

  // 静态前缀只有一段（如 /api/x）时噪声较大，降级为 warning
  const segments = path.split("/").filter(Boolean)
  if (segments.length <= 2) {
    warnings.push(`${site} 调用了 ${path}，但路由表里没有明显匹配项（前缀过短，可能是动态拼接，请人工确认）`)
  } else {
    problems.push(
      `${site} 调用了 ${path}，但 worker/src/index.ts 的路由表里没有这条路由` +
        `\n     → 该请求会落到静态 Worker，被 SPA 兜底成 index.html（200 + HTML），` +
        `\n       前端解析 JSON 失败，表现为「功能静默失效」。请补路由或改调用路径。`
    )
  }
}

// allowlist 里的条目若已不再缺失，说明缺口被修好了 —— 提醒删掉这一条
for (const gap of KNOWN_GAPS) {
  if (!allowHit.has(gap.path)) {
    warnings.push(
      `KNOWN_GAPS 里的 "${gap.path}" 现在已经能匹配到路由了 —— ` +
        `缺口已修复，请从 check-api-paths.mjs 的 KNOWN_GAPS 里删除这一条。`
    )
  }
}

if (LIST) {
  console.log(`\n抽到 Worker 路由 ${workerRoutes.size} 条：`)
  for (const p of [...workerRoutes].sort()) console.log(`  ${p}`)
  console.log(`\n抽到前端调用 ${calls.length} 处\n`)
}

if (problems.length === 0 && warnings.length === 0) {
  console.log(`✓ 跨端 API 路径检查通过（${workerRoutes.size} 条路由 / ${calls.length} 处调用）`)
  process.exit(0)
}

if (problems.length > 0) {
  console.error(`✗ 跨端 API 路径检查失败：${problems.length} 个问题\n`)
  for (const p of problems) console.error(`  · ${p}\n`)
}
if (warnings.length > 0) {
  console.error(`⚠ ${warnings.length} 条需人工确认：`)
  for (const w of warnings) console.error(`  · ${w}`)
}
process.exit(problems.length > 0 ? 1 : 0)
