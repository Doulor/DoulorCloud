/**
 * 路由自检脚本：检查 doulor-mail-api 在 Cloudflare 上的路由触发器是否齐全。
 *
 * 为什么需要：worker/wrangler.toml 不声明 [[routes]]（否则 deploy 会覆盖、删掉
 * 动态绑定的自定义域名 Route，导致 522/523）。这意味着路由靠 CF 线上状态维护，
 * 误删后不会自愈。本脚本对照清单查漏，可选 --fix 自动补建缺失路由。
 *
 * 清单来源：
 *   1. 8 条固定路由（API / 直链 / 名片页 / 名片资源，doulor.cn + cloud.doulor.cn）
 *   2. 动态路由：D1 里 profiles.fqdn + storage_prefixes.fqdn（用户绑定的自定义域名）
 *
 * 用法：
 *   node scripts/check-routes.mjs          # 只检查，打印缺失/多余
 *   node scripts/check-routes.mjs --fix    # 检查并自动补建缺失路由
 *
 * 认证：读 wrangler OAuth token（~/.wrangler/config/default.toml 的 oauth_token）
 *   作 Bearer 调 CF API；需先 wrangler login。环境变量可覆盖默认值：
 *   CLOUDFLARE_ACCOUNT_ID / CF_ZONE_ID / WORKER_NAME / ROOT_DOMAIN
 */
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "83fdea7d910cbc683e6d53fa6baf45ab"
const ZONE_ID = process.env.CF_ZONE_ID || "141ef5bed7ae38f4ffa094809bf0998"
const WORKER_NAME = process.env.WORKER_NAME || "doulor-mail-api"
const ROOT_DOMAIN = process.env.ROOT_DOMAIN || "doulor.cn"
const FIX = process.argv.includes("--fix")

/** 从 wrangler 配置读 OAuth token */
function readOauthToken() {
  const candidates = [
    join(homedir(), ".wrangler", "config", "default.toml"),
    // Windows 上 wrangler 实际路径（XDG_CONFIG_HOME 或 AppData/Roaming/xdg.config）
    process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, ".wrangler", "config", "default.toml")
      : "",
    join(process.env.APPDATA || "", "xdg.config", ".wrangler", "config", "default.toml"),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const txt = readFileSync(p, "utf8")
      const m = txt.match(/oauth_token\s*=\s*"([^"]+)"/)
      if (m) return m[1]
    } catch {
      // 继续找下一个候选路径
    }
  }
  throw new Error("找不到 wrangler OAuth token，请先 `npx wrangler login`")
}

const TOKEN = readOauthToken()

async function cf(path, init) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  const data = await res.json()
  if (!data.success) {
    throw new Error(`CF API ${path} 失败: ${JSON.stringify(data.errors)}`)
  }
  return data.result
}

/** 用 wrangler 查 D1，返回字符串数组的并集 */
function queryD1Fqdns() {
  const sql = `SELECT fqdn FROM profiles WHERE fqdn IS NOT NULL
               UNION ALL
               SELECT fqdn FROM storage_prefixes WHERE fqdn IS NOT NULL`
  const cmd = `npx wrangler d1 execute doulor-mail --remote --command="${sql.replace(/\n/g, " ")}" --json`
  const out = execSync(cmd, { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
  const parsed = JSON.parse(out)
  // 输出是数组（每个 statement 一块），取所有 results 的 fqdn
  const blocks = Array.isArray(parsed) ? parsed : [parsed]
  const fqdns = new Set()
  for (const b of blocks) {
    for (const r of b.results ?? []) {
      if (r.fqdn) fqdns.add(String(r.fqdn).toLowerCase())
    }
  }
  return [...fqdns]
}

/** 固定路由清单 */
function fixedRoutes() {
  const hosts = [`cloud.${ROOT_DOMAIN}`, ROOT_DOMAIN]
  const paths = ["/api/*", "/dl/*", "/profile/*", "/p/*"]
  // /u/*（账户头像）与 /c/*（社区帖子图片）仅在 cloud 子域，走 API Worker
  const cloudOnlyPaths = ["/u/*", "/c/*"]
  return [
    ...hosts.flatMap((h) => paths.map((p) => `${h}${p}`)),
    ...cloudOnlyPaths.map((p) => `cloud.${ROOT_DOMAIN}${p}`),
  ]
}

async function main() {
  console.log(`检查 ${WORKER_NAME} 的路由触发器...\n`)

  const [existing, dynamic] = await Promise.all([
    cf(`/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/routes`),
    Promise.resolve(queryD1Fqdns()),
  ])

  const existingSet = new Set(
    existing.map((r) => String(r.pattern).toLowerCase().replace(/\/$/, ""))
  )
  const expected = [
    ...fixedRoutes(),
    ...dynamic.map((f) => `${f}/*`),
  ].map((p) => p.toLowerCase())
  const expectedSet = new Set(expected)

  const missing = expected.filter((p) => !existingSet.has(p))
  const extra = [...existingSet].filter((p) => !expectedSet.has(p))

  console.log(`现有 ${existing.length} 条路由，期望 ${expected.length} 条\n`)
  console.log("现有路由:")
  for (const p of [...existingSet].sort()) console.log(`  ✓ ${p}`)
  console.log("")

  if (missing.length === 0 && extra.length === 0) {
    console.log("✅ 路由齐全，无缺失无多余。")
    return
  }

  if (missing.length > 0) {
    console.log(`❌ 缺失 ${missing.length} 条路由:`)
    for (const p of missing) console.log(`  - ${p}`)
    if (FIX) {
      console.log("\n开始补建缺失路由...")
      for (const pattern of missing) {
        try {
          await cf(`/zones/${ZONE_ID}/workers/routes`, {
            method: "POST",
            body: JSON.stringify({ pattern, script: WORKER_NAME }),
          })
          console.log(`  ✓ 已补建: ${pattern}`)
        } catch (err) {
          console.error(`  ✗ 补建失败 ${pattern}: ${err.message}`)
          console.error(`    （若为 OAuth 权限不足，请改用 CF_WORKERS_TOKEN 或在 dashboard 手动建）`)
        }
      }
    } else {
      console.log("\n（加 --fix 自动补建）")
    }
  }

  if (extra.length > 0) {
    console.log(`\n⚠️  多出 ${extra.length} 条（清单里没有，可能是已解绑但未清理，或清单未更新）:`)
    for (const p of extra) console.log(`  + ${p}`)
    console.log("（多余路由不会自动删除，需手动在 dashboard 确认后清理）")
  }
}

main().catch((err) => {
  console.error("自检失败:", err.message)
  process.exit(1)
})
