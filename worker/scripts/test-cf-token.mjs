/**
 * Cloudflare API Token 自测脚本
 *
 * 用法：
 *   node scripts/test-cf-token.mjs <TOKEN>
 *
 * 会依次检查：
 *   1. token 是否有效（verify）
 *   2. 能否看到三个账户（R2 权限覆盖范围）
 *   3. 能否读 R2 桶列表
 *   4. 能否读 R2 操作数（Analytics 权限）
 *
 * 只读，不做任何修改。不写入任何文件。
 */

const TOKEN = process.argv[2]
if (!TOKEN) {
  console.error("用法: node scripts/test-cf-token.mjs <TOKEN>")
  process.exit(1)
}

const ACCOUNTS = {
  "Doulor 主账户": "83fdea7d910cbc683e6d53fa6baf45ab",
  "adoulor (1号桶 network)": "b46dc87b9e13fa47cb7f782ef54519ce",
  "bdoulor (2号桶 network2)": "d20b3b86a1982bea469b4555240516aa",
}

const BUCKETS = {
  "Doulor 主账户": null,
  "adoulor (1号桶 network)": "network",
  "bdoulor (2号桶 network2)": "network2",
}

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  let body
  try {
    body = await res.json()
  } catch {
    body = { raw: await res.text().catch(() => "") }
  }
  return { status: res.status, body }
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`
const bad = (s) => `\x1b[31m${s}\x1b[0m`
const warn = (s) => `\x1b[33m${s}\x1b[0m`

async function main() {
  console.log("=".repeat(60))
  console.log("Cloudflare API Token 自测")
  console.log("=".repeat(60))

  // 1. verify
  console.log("\n[1] 验证 token 本身")
  const v = await cf("/user/tokens/verify")
  if (v.status === 200 && v.body.success) {
    console.log(ok("  ✅ token 有效"))
    console.log(`     状态: ${v.body.result?.status ?? "?"}`)
    if (v.body.result?.expires_on) {
      console.log(`     过期: ${v.body.result.expires_on}`)
    }
  } else {
    console.log(bad(`  ❌ token 无效 (HTTP ${v.status})`))
    console.log(`     ${JSON.stringify(v.body.errors ?? v.body).slice(0, 200)}`)
    console.log("\n  → token 无效的话下面都不用测了。")
    console.log("    请在 Cloudflare 后台重新复制一次值，或 Roll 生成新值。")
    return
  }

  // 2-4. 逐账户测
  for (const [name, accountId] of Object.entries(ACCOUNTS)) {
    console.log(`\n[账户] ${name}`)
    console.log(`       ${accountId}`)

    // R2 桶列表
    const r2 = await cf(`/accounts/${accountId}/r2/buckets`)
    if (r2.status === 200 && r2.body.success) {
      const names = (r2.body.result?.buckets ?? []).map((b) => b.name)
      console.log(ok(`  ✅ R2 访问正常`) + `  桶: ${names.join(", ") || "(空)"}`)
    } else {
      console.log(bad(`  ❌ R2 访问失败 (HTTP ${r2.status})`))
      console.log(`     ${JSON.stringify(r2.body.errors ?? r2.body).slice(0, 150)}`)
      continue
    }

    // Analytics（操作数）
    const bucket = BUCKETS[name]
    if (!bucket) {
      console.log(warn(`  ⚠️  跳过 Analytics（该账户无桶）`))
      continue
    }
    const since = new Date()
    since.setUTCDate(1)
    const dateGeq = since.toISOString().slice(0, 10)

    const gql = await cf("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `query($tag:String!,$b:String!,$d:String!){
          viewer { accounts(filter:{accountTag:$tag}) {
            r2OperationsAdaptiveGroups(limit:5, filter:{date_geq:$d, bucketName:$b}) {
              dimensions { actionType }
              sum { requests }
            }
          } }
        }`,
        variables: { tag: accountId, b: bucket, d: dateGeq },
      }),
    })

    if (gql.body?.errors?.length) {
      const msg = gql.body.errors[0].message
      if (/authz|not authorized/i.test(msg)) {
        console.log(bad(`  ❌ Analytics 无权限`) + `  ${msg}`)
        console.log(`     → 需要加权限: Account → Account Analytics → Read`)
      } else {
        console.log(warn(`  ⚠️  Analytics 查询报错`) + `  ${msg}`)
      }
    } else {
      const groups =
        gql.body?.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? []
      const total = groups.reduce((s, g) => s + (g.sum?.requests ?? 0), 0)
      console.log(ok(`  ✅ Analytics 正常`) + `  本月操作数样本: ${total}`)
      if (groups.length) {
        for (const g of groups.slice(0, 3)) {
          console.log(`       ${g.dimensions?.actionType ?? "?"}: ${g.sum?.requests ?? 0}`)
        }
      }
    }
  }

  console.log("\n" + "=".repeat(60))
  console.log("完成。若三项都 ✅，可把该 token 填进管理面板各桶的")
  console.log("「Analytics 令牌」字段（S3 密钥仍需另外用 R2 API Token）。")
  console.log("=".repeat(60))
}

main().catch((e) => {
  console.error("脚本错误:", e.message)
  process.exit(1)
})