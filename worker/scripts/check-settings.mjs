/**
 * 一致性护栏：检查「设置项是否真的在服务端生效」。
 *
 * 为什么需要（2026-09-25 审计 L7 / F2 发现）：
 *   `community_enabled` 这个设置项曾经**服务端没有任何地方读它** ——
 *   管理员在后台关掉「社区广场」后，所有读接口照常返回帖子与评论，
 *   这个开关实际上只是「前端把入口隐藏起来」。同类问题还有
 *   `tempbox_enabled`（比较的是 `=== true`，而 app_settings 里所有值都是
 *   字符串 "1"，于是判断恒为 false，导致「关闭」状态下功能反而一直可用）。
 *
 *   这类 bug 的特点是：**编译通过、测试通过、界面看起来也正常**，
 *   只有真的去调 API 才会发现开关是假的。人工 review 极难发现，
 *   因此用一个纯静态检查把它变成 CI 上的红灯。
 *
 * 检查内容：
 *   1. `settings.ts` 里 `SETTING_DEFAULTS` 声明的每个键，
 *      必须在 `worker/src/**` 的**非 settings.ts 文件**里被读取一次
 *      （`getSetting(...)` / `getSettingBool(...)` / `getSettings()` 后取属性）；
 *   2. `app_settings` 的值一律是字符串，因此禁止出现
 *      `getSetting(...) === true` / `=== false` 这类恒假的比较；
 *   3. 声明为「开关」语义（默认值 "0"/"1"）的键，若在 admin 界面里可见，
 *      至少要有一次布尔读取。
 *
 * 已知局限（有意保守，宁可漏报不误报）：
 *   - 只做文本匹配，不做类型/数据流分析；
 *   - 读取点可以出现在注释里 —— 已剥离注释后再匹配。
 *
 * 用法：
 *   node scripts/check-settings.mjs            # 只检查
 *   node scripts/check-settings.mjs --list     # 打印每个键的读取点
 *
 * 退出码：0 = 通过；1 = 发现问题（供 CI 使用）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, "..", "src")
const SETTINGS_FILE = join(SRC, "settings.ts")
const LIST = process.argv.includes("--list")

const problems = []
const warnings = []

/**
 * 与 check-handlers.mjs 同口径：先删行注释，再删块注释。
 *
 * 与那边不同的是：这里**必须保持行号不变**，否则报出的 `文件:行号` 全是错的
 * （多行块注释被整段删掉会连带吃掉换行，后面所有行号都往前串）。
 * 所以块注释按「保留原有换行数」的方式替换。
 */
function stripComments(text) {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
}

function collectFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectFiles(full))
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

if (!existsSync(SETTINGS_FILE)) {
  console.error(`✗ 找不到 ${relative(process.cwd(), SETTINGS_FILE)}`)
  process.exit(1)
}

// ---- 1. 解析 SETTING_DEFAULTS 的键与默认值 ----
const settingsSrc = stripComments(readFileSync(SETTINGS_FILE, "utf8"))
const blockMatch = /SETTING_DEFAULTS\s*=\s*\{([\s\S]*?)\n\}/.exec(settingsSrc)
if (!blockMatch) {
  console.error("✗ 无法从 settings.ts 解析 SETTING_DEFAULTS（结构变了？请更新本脚本）")
  process.exit(1)
}

/** @type {{ key: string, value: string }[]} */
const keys = []
for (const line of blockMatch[1].split("\n")) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false)\s*,?/.exec(line)
  if (!m) continue
  keys.push({ key: m[1], value: m[2].replace(/^["']|["']$/g, "") })
}

if (keys.length === 0) {
  console.error("✗ SETTING_DEFAULTS 解析出 0 个键（正则失效？）")
  process.exit(1)
}

// ---- 2. 收集所有非 settings.ts 的源码（含 handlers） ----
const consumers = collectFiles(SRC).filter((f) => f !== SETTINGS_FILE)

/** @type {Map<string, string[]>} key -> ["handlers/x.ts:42", ...] */
const readSites = new Map()
for (const { key } of keys) readSites.set(key, [])

for (const file of consumers) {
  const src = stripComments(readFileSync(file, "utf8"))
  const lines = src.split("\n")
  for (const { key } of keys) {
    lines.forEach((line, i) => {
      // 两种读取形态都要认：
      //   1. 按字符串字面量读取：getSetting(env, "key") / getSettingBool(env, "key")
      //   2. 走 getSettings() 聚合对象后的属性访问：settings.proxy_enabled === "1"
      //      （只认字面量会把大量真实读取误报成「从未读取」）
      const byLiteral = line.includes(`"${key}"`) || line.includes(`'${key}'`)
      const byProperty = new RegExp(`\\.${key}\\b`).test(line)
      if (byLiteral || byProperty) {
        readSites.get(key).push(`${relative(SRC, file)}:${i + 1}`)
      }
    })
  }
}

// ---- 3. 检查每个键至少有一个读取点 ----
for (const { key, value } of keys) {
  const sites = readSites.get(key)
  if (LIST) {
    console.log(`  ${key.padEnd(34)} 默认=${String(value).padEnd(6)} 读取点=${sites.length}${sites.length ? "  " + sites.slice(0, 3).join(", ") : ""}`)
  }
  if (sites.length === 0) {
    problems.push(
      `设置项 "${key}" 在 SETTING_DEFAULTS 里声明了，但 worker/src 中没有任何地方读取它` +
        `\n     → 这个开关是**假的**：管理面板能改、数据库里有值，但服务端从不生效。` +
        `\n     → 要么在用到它的 handler 里真正读一次（getSetting/getSettingBool），要么从 SETTING_DEFAULTS 里删掉。`
    )
  }
}

// ---- 4. 禁止对字符串设置值做布尔比较（恒假） ----
for (const file of consumers) {
  const src = stripComments(readFileSync(file, "utf8"))
  const lines = src.split("\n")
  lines.forEach((line, i) => {
    // getSetting(...) === true / !== false 之类
    const bad = /getSetting(?:Bool)?\s*\([^)]*\)\s*(?:===|!==|==|!=)\s*(?:true|false)/.exec(line)
    if (bad) {
      problems.push(
        `${relative(SRC, file)}:${i + 1} 对设置值做了布尔比较：${line.trim()}` +
          `\n     → app_settings 里**所有值都是字符串**（"1"/"0"），` +
          `\n       与 true/false 比较恒不成立，判断会永远走同一个分支。` +
          `\n       请改用 getSettingBool(env, key) 或与 "1" 比较。`
      )
    }
  })
}

// ---- 输出 ----
if (LIST) console.log("")

if (problems.length === 0) {
  console.log(`✓ 设置项生效性检查通过（${keys.length} 个键，全部有服务端读取点）`)
  process.exit(0)
}

console.error(`✗ 设置项生效性检查失败：${problems.length} 个问题\n`)
for (const p of problems) console.error(`  · ${p}\n`)
if (warnings.length) for (const w of warnings) console.error(`  ⚠ ${w}`)
process.exit(1)
