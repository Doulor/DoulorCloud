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
 */
const ALLOW = new Map([
  // ---- 已确认的真缺陷：功能写好了但没接线（2026-10-13 复核）----
  //
  // ⚠️ 这里原先写的理由是「当前由另一 AI 占用，待其合并后再清」。
  //    现在没有人在改这些文件了，所以那些理由已失效 —— 下面改成了**事实本身**：
  //    它们就是还没接线的缺陷。别再拿「有人在改」当延后处理的借口。
  [
    "src/handlers/analytics.ts::purgeExpiredAnalytics",
    "真实缺陷（审计 H13）：analytics_events 清理函数从未被调用，表无界增长。" +
      "修法明确 —— 挂到 maintenance.ts 的定时任务上；未做只是因为还没排期。",
  ],
  [
    "src/link-preview.ts::purgeExpiredPreviews",
    "同上（H13）：link_previews 的过期清理从未被调用。同样要挂到 maintenance.ts。",
  ],
  [
    "src/handlers/community.ts::linkPreview",
    "真实缺陷（审计 F4）：handler 已实现但 index.ts 没有对应路由，功能完全不可用。" +
      "已同时记录在 check-api-paths.mjs 的 KNOWN_GAPS。",
  ],
  [
    "src/handlers/admin.ts::deleteInvite",
    "管理端「删除邀请码」的 handler 存在，但没有任何路由/界面调用它 ——" +
      "**管理员实际上无法撤销已发出的邀请码**。补一条路由 + 一个按钮即可，属于待排期。",
  ],
  // ---- 未接线的功能（缺的不是代码，是产品决策）----
  [
    "src/donation-provision.ts::CHANNEL_TEST_HINT",
    "疑似死常量（同文件内有等价的内联实现）。无人在改这个文件了，可直接删 ——" +
      "留在这是为了让「已复核过、确认无害」这件事有记录。",
  ],
  [
    "src/newapi-client.ts::requestEmailCode",
    "**NewAPI 自助注册那条链没做完**：requestEmailCode / registerUser /" +
      " generateAccessToken / extractVerificationCode 四个函数都写好了，但全仓无调用点 ——" +
      "也就是说「补 email 完成自助注册」这条路目前走不通。" +
      "（原先的理由是「该文件紧邻另一 AI 的捐献流程，删了怕冲突」；" +
      " 现在没人在改它，理由换成事实：**这条链就是没接线**。）",
  ],
  [
    "src/newapi-client.ts::registerUser",
    "同上：NewAPI 自助注册的调用链尚未接线。",
  ],
  [
    "src/newapi-client.ts::generateAccessToken",
    "同上。",
  ],
  [
    "src/newapi-client.ts::extractVerificationCode",
    "同上。",
  ],
  [
    "src/newapi-client.ts::CHANNEL_STATUS_MANUALLY_DISABLED",
    "同上。",
  ],
  [
    "src/settings.ts::formatBytes",
    "worker 侧确实没有消费者（前端另有一份实现）。可删；留着仅为记录已复核。",
  ],
  // ---- 有意的对外/预留接口 ----
  [
    "src/permissions.ts::userPermissions",
    "权限解析的对外工具函数，当前无调用点；测试与后续模块都可能用到。",
  ],
  [
    "src/handlers/wb2api.ts::wb2apiBaseUrl",
    "反代网关基址解析函数，当前无调用点（同文件内有内联实现）。" +
      "疑似重复实现，待确认后清理。",
  ],
  [
    "src/handlers/profile.ts::CANVAS_EFFECTS",
    "名片特效的「画布类」子集常量，当前无调用点。" +
      "疑似与 EFFECTS 重复，需确认前端是否依赖它，暂保留。",
  ],
  // ---- 2026-10-13 复核后新登记（内网穿透改造那一轮清掉了另外 6 项）----
  [
    "src/handlers/lab-search.ts::SEARCH_MAX_PER_TURN",
    "**这是一个没被实施的保护**，不是单纯的死常量：" +
      "注释写着「一次对话里最多能搜几次（防模型打转把额度刷光）」，" +
      "但 `webSearch` 上没有任何计数/限流（整条路由连 guardRateLimit 都没挂）。" +
      "之所以没有直接接上：服务端拿不到「一次对话」的边界（请求里没有会话 id），" +
      "要限流就得先定窗口与超限行为（例如「每用户 60 秒 8 次、超了回 429」），" +
      "那是产品决策，不该由改代码的人顺手定。**已如实记在这里，别当它已经生效。**",
  ],
  // 注：原先还登记过一个 `src/newapi-client.ts::adminSetUserGroup`，
  // 2026-10-13 按站长要求连同函数本体一起删了 —— 那套「绑定后转进 0 倍率免费组」
  // 的方案已作废（仓库里从来没有过「免费组」这个设置项）。
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
