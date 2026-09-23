/**
 * R2 跨账户迁移脚本（一次性）
 *
 * 用途：把 1 号桶 network（adoulor）里的平台数据（profiles/ 与 temporary/）
 * 迁移到 Doulor Cloud 账户的 cloud 桶。
 *
 * 安全顺序：**先复制 → 校验大小 → 再删源**。任何一步失败即中止。
 *
 * 用法：
 *   node scripts/migrate-r2.mjs <TOKEN> <模式>
 *     模式: copy   只复制（不删源）—— 推荐先跑这个
 *           verify 校验目标桶
 *           purge  删除源（仅在 copy + verify 都通过后手动执行）
 *
 * 认证：用 Cloudflare API Token（需 R2 读写权限），通过 REST API 操作对象，
 *       不依赖 S3 凭据。
 */

const TOKEN = process.argv[2]
const MODE = process.argv[3] ?? "copy"

if (!TOKEN) {
  console.error("用法: node scripts/migrate-r2.mjs <TOKEN> [copy|verify|purge]")
  process.exit(1)
}

const SRC = { account: "b46dc87b9e13fa47cb7f782ef54519ce", bucket: "network", label: "adoulor/network" }
const DST = { account: "87ea616823fc78cf31193959df936803", bucket: "cloud", label: "DoulorCloud/cloud" }

/** 要迁移的前缀 */
const PREFIXES = ["profiles/", "temporary/"]

const api = (account, path) =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${path}`

const auth = { Authorization: `Bearer ${TOKEN}` }

async function listAll(acc, bucket, prefix) {
  const out = []
  let cursor = null
  for (let i = 0; i < 50; i++) {
    const url =
      api(acc.account, `${bucket}/objects?per_page=200&prefix=${encodeURIComponent(prefix)}`) +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
    const res = await fetch(url, { headers: auth })
    const data = await res.json()
    if (!data.success) throw new Error(`列对象失败: ${JSON.stringify(data.errors)}`)
    out.push(...(data.result ?? []))
    cursor = data.result_info?.cursor
    if (!cursor || !(data.result ?? []).length) break
  }
  return out
}

async function getObject(acc, bucket, key) {
  const res = await fetch(api(acc.account, `${bucket}/objects/${encodeURIComponent(key)}`), {
    headers: auth,
  })
  if (!res.ok) throw new Error(`读取 ${key} 失败: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return { buf, contentType: res.headers.get("content-type") ?? "application/octet-stream" }
}

async function putObject(acc, bucket, key, buf, contentType) {
  const res = await fetch(api(acc.account, `${bucket}/objects/${encodeURIComponent(key)}`), {
    method: "PUT",
    headers: { ...auth, "Content-Type": contentType },
    body: buf,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.success) {
    throw new Error(`写入 ${key} 失败: HTTP ${res.status} ${JSON.stringify(data.errors ?? {})}`)
  }
}

async function deleteObject(acc, bucket, key) {
  const res = await fetch(api(acc.account, `${bucket}/objects/${encodeURIComponent(key)}`), {
    method: "DELETE",
    headers: auth,
  })
  if (!res.ok) throw new Error(`删除 ${key} 失败: HTTP ${res.status}`)
}

async function headObject(acc, bucket, key) {
  // R2 REST API 没有 HEAD，用 GET 只读头
  const res = await fetch(api(acc.account, `${bucket}/objects/${encodeURIComponent(key)}`), {
    headers: auth,
  })
  if (res.status === 404) return null
  if (!res.ok) return null
  // 不读 body，直接取消
  await res.body?.cancel().catch(() => {})
  return { size: Number(res.headers.get("content-length") ?? 0) }
}

function fmt(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

async function main() {
  console.log("=".repeat(64))
  console.log(`R2 迁移: ${SRC.label} → ${DST.label}   模式: ${MODE}`)
  console.log("=".repeat(64))

  // 先收集源对象清单
  const all = []
  for (const p of PREFIXES) {
    const objs = await listAll(SRC, SRC.bucket, p)
    all.push(...objs)
    console.log(`  扫描 ${p}  → ${objs.length} 个对象`)
  }
  // 目录占位对象（以 / 结尾、0 字节）也一并搬，保持目录结构
  console.log(`\n合计 ${all.length} 个对象，${fmt(all.reduce((s, o) => s + o.size, 0))}\n`)

  if (MODE === "copy") {
    // 先取目标桶已有对象（用列表 size 判断是否已复制过，幂等可重跑）
    const dstObjs = []
    for (const p of PREFIXES) {
      dstObjs.push(...(await listAll(DST, DST.bucket, p)))
    }
    const dstMap = new Map(dstObjs.map((o) => [o.key, o.size]))

    let copied = 0
    let skipped = 0
    for (const o of all) {
      if (dstMap.get(o.key) === o.size) {
        skipped++
        continue
      }
      const { buf, contentType } = await getObject(SRC, SRC.bucket, o.key)
      await putObject(DST, DST.bucket, o.key, buf, contentType)
      copied++
      if (copied % 5 === 0 || copied === all.length) {
        console.log(`  已复制 ${copied}/${all.length} ...`)
      }
    }
    console.log(`\n✅ 复制完成：新增 ${copied}，跳过 ${skipped}（已存在且大小一致）`)
    console.log(`   下一步：node scripts/migrate-r2.mjs <TOKEN> verify`)
    return
  }

  if (MODE === "verify") {
    // 用「列表 API 的 size」比对，而不是 HEAD ——
    // CF 的 R2 REST API 返回 chunked 编码，content-length 头为 null，
    // 依赖它会把非空对象误判成 0 字节。
    const dstObjs = []
    for (const p of PREFIXES) {
      dstObjs.push(...(await listAll(DST, DST.bucket, p)))
    }
    const dstMap = new Map(dstObjs.map((o) => [o.key, o.size]))

    let okCount = 0
    const problems = []
    for (const o of all) {
      const size = dstMap.get(o.key)
      if (size === undefined) {
        problems.push(`${o.key}: 目标不存在`)
      } else if (size !== o.size) {
        problems.push(`${o.key}: 大小不符（源 ${o.size} vs 目标 ${size}）`)
      } else {
        okCount++
      }
    }
    console.log(`目标桶共 ${dstObjs.length} 个对象`)
    console.log(`校验结果：${okCount}/${all.length} 一致`)
    if (problems.length) {
      console.log("\n❌ 存在问题：")
      for (const p of problems.slice(0, 20)) console.log("   " + p)
      process.exit(1)
    }
    console.log("\n✅ 全部一致。确认无误后执行：")
    console.log(`   node scripts/migrate-r2.mjs <TOKEN> purge`)
    return
  }

  if (MODE === "purge") {
    // 安全护栏：必须先把目标校验通过（同样用列表 size）
    console.log("先做一次校验...")
    const dstObjs = []
    for (const p of PREFIXES) {
      dstObjs.push(...(await listAll(DST, DST.bucket, p)))
    }
    const dstMap = new Map(dstObjs.map((o) => [o.key, o.size]))
    for (const o of all) {
      if (dstMap.get(o.key) !== o.size) {
        console.error(`❌ 校验未通过（${o.key}），拒绝删除源对象。请先 copy + verify。`)
        process.exit(1)
      }
    }
    console.log("校验通过，开始删除源对象...\n")
    let deleted = 0
    for (const o of all) {
      await deleteObject(SRC, SRC.bucket, o.key)
      deleted++
    }
    console.log(`\n✅ 已从源桶删除 ${deleted} 个对象`)
    return
  }

  console.error(`未知模式: ${MODE}`)
  process.exit(1)
}

main().catch((e) => {
  console.error("\n❌ 迁移失败:", e.message)
  process.exit(1)
})