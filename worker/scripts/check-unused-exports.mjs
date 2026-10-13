/**
 * 一致性护栏：检查「导出了但全仓没有任何地方引用」的死代码。
 *
 * 为什么需要（2026-09-25 审计 H13 发现）：
 *   有两处清理函数写好了、也在注释里被说成「供定时运维调用」，但**从来没被调用**：
 *   - `handlers/analytics.ts` 的 `purgeExpiredAnalytics()` —— 于是 analytics_events
 *     这张「每次浏览写一行」的表实际上无界增长；
 *   - 同类问题还有 tempbox 的过期批次清理。
 *   这类「实现了但没接线」的代码，tsc 不会报（因为是 export，视为对外接口），
 *   review 也容易滑过去，最后表现为「线上数据一直涨」。
 *
 * 判据：一个 export 只要满足以下任一条就算「被引用」：
 *   1. 别的文件具名 import 了它；
 *   2. 别的文件通过命名空间调用（`import * as x from "./handlers/y"` 后 `x.name`）；
 *   3. `index.ts` 的导出（它是 Worker 入口，视为对外契约）；
 *   4. 类型/接口（编译期擦除，无法可靠统计，跳过）。
 *
 * 用法：
 *   node scripts/check-unused-exports.mjs            # 检查（有**新增**死代码即退出 1）
 *   node scripts/check-unused-exports.mjs --list     # 打印统计明细
 *
 * 退出码：0 = 通过（或只剩 ALLOW 清单里的已知项）；1 = 出现新的未引用导出。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const WORKER = resolve(here, "..")
const SRC = join(WORKER, "src")
const TEST = join(WORKER, "test")

const LIST = process.argv.includes("--list")

/** 先删行注释、再删块注释（保持行号） */
function stripComments(text) {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
}

function collectFiles(dir, exts) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

const srcFiles = collectFiles(SRC, [".ts"])
const testFiles = collectFiles(TEST, [".ts"])
const allFiles = [...srcFiles, ...testFiles]

/** file -> { text, lines } */
const fileText = new Map()
for (const f of allFiles) fileText.set(f, stripComments(readFileSync(f, "utf8")))

/** 收集每个源文件的导出名（跳过类型/接口） */
const exportsByFile = new Map()
for (const f of srcFiles) {
  const text = fileText.get(f)
  const names = []
  // export function / async function / const / let / class
  for (const m of text.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    names.push({ name: m[1], index: m.index })
  }
  exportsByFile.set(f, names)
}

/** 命名空间别名：alias -> 目标文件绝对路径 */
const nsAlias = new Map()
for (const f of allFiles) {
  const text = fileText.get(f)
  const dir = dirname(f)
  for (const m of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+"([^"]+)"/g)) {
    if (!m[2].startsWith(".")) continue
    const target = resolve(dir, m[2])
    for (const cand of [`${target}.ts`, join(target, "index.ts")]) {
      if (existsSync(cand)) {
        nsAlias.set(m[1], cand)
        break
      }
    }
  }
}

/** 具名 import：name -> 引用它的文件集合 */
const namedImportUsers = new Map()
for (const f of allFiles) {
  const text = fileText.get(f)
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"[^"]+"/g)) {
    for (const part of m[1].split(",")) {
      const raw = part.trim()
      if (!raw) continue
      const name = raw.split(/\s+as\s+/)[0].trim()
      if (!name) continue
      if (!namedImportUsers.has(name)) namedImportUsers.set(name, new Set())
      namedImportUsers.get(name).add(f)
    }
  }
}

/** 命名空间属性调用：alias.name -> 引用文件集合 */
const nsPropertyUsers = new Map()
for (const [alias, target] of nsAlias) {
  const re = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g")
  for (const f of allFiles) {
    const text = fileText.get(f)
    for (const m of text.matchAll(re)) {
      const key = `${target}::${m[1]}`
      if (!nsPropertyUsers.has(key)) nsPropertyUsers.set(key, new Set())
      nsPropertyUsers.get(key).add(f)
    }
  }
}

const ENTRY = join(SRC, "index.ts")

/**
 * 已确认的「有意保留 / 暂时无法处理」清单。
 *
 * 与 check-api-paths.mjs 的 KNOWN_GAPS 同理：写进代码里可被搜索到，
 * 每条都必须说明**为什么现在不动它**。新增死代码不在本清单里 → CI 红。
 *
 * ================== 2026-10-13：本清单已清空 ==================
 *
 * 它此前挂着 15 条 key，其中 9 条真的出现在未引用列表里。那 9 条不是
 * 「没法处理」，而是「还没排期」—— 现在逐条解决完了，记录如下（可搜索）：
 *
 *   A · 过期清理没挂定时任务（真缺陷：表无界增长）
 *     src/handlers/analytics.ts::purgeExpiredAnalytics
 *     src/link-preview.ts::purgeExpiredPreviews
 *     → 已挂进 maintenance.ts 的每小时运维（cron `17 * * * *`），见该文件 4c 段。
 *       不挂每分钟那条 tick：清过期数据不怕晚一小时，而 DELETE 是写操作。
 *
 *   B · handler 有了但没有路由
 *     src/handlers/community.ts::linkPreview
 *     → 路由已补上（index.ts 的 `GET /community/link-preview`，默认站内链接查库、
 *       外站抓 OG），check-api-paths.mjs 的 KNOWN_GAPS 也随之清空。
 *     src/handlers/admin.ts::deleteInvite
 *     → 复核结论：**不缺路由**。`DELETE /api/admin/invites/:id` 一直挂着
 *       adminDeleteInviteWithRefund（严格超集：额度退还 + 审计日志），
 *       deleteInvite 是它的旧版、连审计都没有 → 直接删掉，不留两个同路径实现。
 *
 *   C · NewAPI 自助注册链（4 个函数全无调用点）
 *     src/newapi-client.ts::requestEmailCode / registerUser /
 *       generateAccessToken / extractVerificationCode
 *     → 判断为**已废弃**并删除：建号已改走 OIDC（用户在中转站点「用 Doulor Cloud
 *       登录」建号，回来 bindAccount 复用本站密码），取令牌由 login() 直接返回
 *       （rc.40 起不再需要 session→token 两步）；且全仓没有读收件箱的代码，
 *       这条链本来就跑不通。删除理由写在 newapi-client.ts 对应位置。
 *
 *   D · 写了但没实施的保护
 *     src/handlers/lab-search.ts::SEARCH_MAX_PER_TURN
 *     → 真的接上限流了：webSearch 上挂按用户的 guardRateLimit
 *       （8 次 / 60 秒，窗口取舍写在同文件的 SEARCH_WINDOW_SECONDS 注释里）。
 *
 *   E · 确认后删除的死代码
 *     src/donation-provision.ts::CHANNEL_TEST_HINT（连同 CHANNEL_TEST_HINT_MS）
 *       —— 全仓无渲染者（前端渠道测试界面没有这个字段），已删。
 *     src/handlers/profile.ts::CANVAS_EFFECTS
 *       —— 前端 src/pages/profile.tsx 另有一份**实际生效**的同名常量，删 worker 这份。
 *     src/handlers/wb2api.ts::wb2apiBaseUrl
 *       —— 同文件 adminGetConfig 已直接返回 baseUrl（内联实现），删掉第二个出口。
 *
 * ⚠️ 本次复核还发现清单里躺着 **3 条根本没死的「误登记」**（它们从未出现在
 *    脚本输出里，纯靠人工维护导致脱节），一并清掉：
 *      · src/settings.ts::formatBytes —— handlers/storage.ts 一直在用；
 *      · src/permissions.ts::userPermissions —— handlers/email.ts、
 *        handlers/subdomains.ts 一直在用；
 *      · src/newapi-client.ts::CHANNEL_STATUS_MANUALLY_DISABLED ——
 *        handlers/admin-channels.ts 一直在用。
 *
 * 教训：本清单只按 key 匹配，**不会校验条目是否仍然有效**。往这里加条目之前，
 * 先跑一次 `node scripts/check-unused-exports.mjs` 确认它真的在输出里，
 * 并写清「为什么现在不动它」以及「谁在什么条件下能处理」。
 */
const ALLOW = new Map([
  // 目前为空。要加条目，请先在上面的注释块里补一段理由。
])

const dead = []
let checked = 0

for (const [file, names] of exportsByFile) {
  // Worker 入口的导出视为对外契约
  if (file === ENTRY) continue
  const selfText = fileText.get(file)
  for (const { name, index } of names) {
    checked++
    const line = selfText.slice(0, index).split("\n").length

    const named = namedImportUsers.get(name)
    if (named && named.size > 0) continue

    const viaNs = nsPropertyUsers.get(`${file}::${name}`)
    if (viaNs && viaNs.size > 0) continue

    // 同文件内自用：名字在声明之外还出现过（如 profile.ts 的 THEMES 只在本文件里用）。
    // 只出现一次说明连本文件都没用 —— 那才是真的「写了没接线」。
    const occurrences = selfText.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0
    if (occurrences > 1) continue

    const key = `${relative(WORKER, file).split("\\").join("/")}::${name}`
    dead.push({ file: relative(WORKER, file), line, name, key, allowed: ALLOW.has(key) })
  }
}

if (LIST) {
  console.log(`\n扫描 ${srcFiles.length} 个源文件 / ${testFiles.length} 个测试文件`)
  console.log(`导出（非类型）共 ${checked} 个，命名空间别名 ${nsAlias.size} 个\n`)
}

if (dead.length === 0) {
  console.log(`✓ 未引用导出检查通过（${checked} 个导出全部有引用）`)
  process.exit(0)
}

const fresh = dead.filter((d) => !d.allowed)
const known = dead.filter((d) => d.allowed)

if (known.length > 0) {
  console.log(`ℹ ${known.length} 个已在 ALLOW 清单里的未引用导出：\n`)
  for (const d of known) {
    console.log(`  · ${d.file}:${d.line}  ${d.name}`)
    console.log(`      ${ALLOW.get(d.key)}`)
  }
  console.log("")
}

if (fresh.length > 0) {
  console.error(`✗ 发现 ${fresh.length} 个**新增**的「导出但全仓无引用」符号：\n`)
  for (const d of fresh) console.error(`  · ${d.file}:${d.line}  ${d.name}`)
  console.error(
    `\n  说明：这些符号在 src 与 test 里都没有被 import、也没有通过命名空间调用。` +
      `\n  典型成因是「功能写好了但没接线」（例如清理函数没挂到定时任务上）。` +
      `\n  处理方式：接上调用点，或删掉它。若确实要保留，请加入本脚本的 ALLOW 清单并写明原因。\n`
  )
  process.exit(1)
}

console.log(`✓ 未引用导出检查通过（${checked} 个导出；${known.length} 个在 ALLOW 清单内）`)
process.exit(0)
