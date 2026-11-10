// 网盘「复制 / 剪切 → 粘贴」（2026-10-30 站长要求）。
//
// ## 背景
// 改前网盘只能「上传到某个目录」和「删除」，根目录下已经传好的文件**挪不动**——
// 想归类只能重新上传一份。典型的诉求是「根目录的文件剪切到某个子目录」「复制一份到
// 别的目录做备份」。
//
// ## 实现口径（这里逐条锁住）
//   1. 复制是**服务端**做的（R2 CopyObject）：文件不经过浏览器也不走 Worker 带宽；
//   2. 「剪切」= 复制成功后删源，因此**不粘贴就什么都不变**（前端可后悔）；
//   3. 目标目录有同名文件时**自动加 ` (1)` 后缀**，绝不覆盖；
//   4. 剪切到自己所在的目录 ⇒ 无事可做（不能凭空多出一个 ` (1)` 副本）；
//   5. 剪贴板里的 key 在粘贴前被删了 ⇒ 记进 `missing`，不让整批失败；
//   6. 复制会真占配额（同一份内容存两遍）⇒ 超配额直接 400，一个都不动；
//      移动前后总量不变 ⇒ 不校验配额。
//
// 环境说明：与 storage-share.test.ts 同一套打法 —— 手工造「启用中的用户桶」，
// 用 `globalThis.fetch` 打桩把 S3 的 HEAD / PUT(copy) / DELETE 模拟出来。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { encryptSecret } from "../src/crypto"
import { invalidatePlatformBucketCache } from "../src/r2"
import { withCopySuffix } from "../src/handlers/storage"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const BUCKET_ID = "tb_copy_test"
const ACCOUNT_ID = "b".repeat(32)
const S3_ORIGIN = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`

/** 假桶里的对象（每个用例自己设） */
let fakeObjects: { key: string; size: number; contentType: string }[] = []
let originalFetch: typeof globalThis.fetch

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function listObjectsXml(prefix: string): string {
  const contents = fakeObjects
    .filter((o) => o.key.startsWith(prefix))
    .map(
      (o) =>
        `<Contents><Key>${xmlEscape(o.key)}</Key><Size>${o.size}</Size>` +
        `<LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag></Contents>`
    )
    .join("")
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
    `<Name>network</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
    `<KeyCount>${fakeObjects.length}</KeyCount><MaxKeys>1000</MaxKeys>` +
    `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
  )
}

/** `https://<acct>.r2.cloudflarestorage.com/network/<key>` → `<key>` */
function keyFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/network\//, ""))
}

beforeAll(async () => {
  const secret = env.SESSION_SECRET!
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO r2_buckets
       (id, name, account_id, endpoint, bucket_name, access_key_id_enc, secret_key_enc,
        analytics_token_enc, quota_per_user, capacity_bytes, enabled, sort_order, kind, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'network', ?, ?, NULL, ?, ?, 1, 0, 'user', ?, ?)`
  )
    .bind(
      BUCKET_ID,
      BUCKET_ID,
      S3_ORIGIN,
      await encryptSecret("test-access-key-id", secret),
      await encryptSecret("test-secret-access-key", secret),
      1024 * 1024 * 1024,
      10 * 1024 * 1024 * 1024,
      now,
      now
    )
    .run()
  invalidatePlatformBucketCache()

  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(S3_ORIGIN)) return originalFetch(input as RequestInfo, init)

    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase()
    const u = new URL(url)
    const headers = new Headers((init?.headers ?? {}) as HeadersInit)

    // 列目录（listObjects）
    if (method === "GET" && u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? ""
      return new Response(listObjectsXml(prefix), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      })
    }

    const key = keyFromUrl(url)

    if (method === "HEAD") {
      const hit = fakeObjects.find((o) => o.key === key)
      if (!hit) return new Response(null, { status: 404 })
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(hit.size), "content-type": hit.contentType },
      })
    }

    if (method === "PUT") {
      const copySource = headers.get("x-amz-copy-source")
      if (copySource) {
        const srcKey = decodeURIComponent(copySource.replace(/^\/network\//, ""))
        const hit = fakeObjects.find((o) => o.key === srcKey)
        if (!hit) return new Response("<Error/>", { status: 404 })
        fakeObjects.push({ ...hit, key })
        return new Response("<CopyObjectResult/>", { status: 200 })
      }
      const size = Number(headers.get("content-length") ?? 0)
      fakeObjects.push({
        key,
        size,
        contentType: headers.get("content-type") ?? "application/octet-stream",
      })
      return new Response(null, { status: 200 })
    }

    if (method === "DELETE") {
      fakeObjects = fakeObjects.filter((o) => o.key !== key)
      return new Response(null, { status: 204 })
    }

    return originalFetch(input as RequestInfo, init)
  }) as typeof globalThis.fetch
})

afterAll(() => {
  if (originalFetch) globalThis.fetch = originalFetch
})

beforeEach(() => {
  fakeObjects = []
})

let prefixSeq = 0

/** 建网盘账号 + 一批 storage_objects 记账行；quota 可按需给 */
async function seedAccount(
  user: TestUser,
  files: { path: string; size: number }[] = [],
  quotaBytes = 1024 * 1024
): Promise<string> {
  const prefix = `t_cp${++prefixSeq}`
  const now = new Date().toISOString()
  const used = files.reduce((s, f) => s + f.size, 0)
  await env.DB.prepare(
    `INSERT INTO storage_accounts
       (user_id, prefix, quota_bytes, used_bytes, file_count, enabled,
        consent_version, consented_at, bucket_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`
  )
    .bind(user.id, prefix, quotaBytes, used, files.length, now, BUCKET_ID, now, now)
    .run()

  for (const f of files) {
    fakeObjects.push({
      key: `${prefix}/${f.path}`,
      size: f.size,
      contentType: "text/plain",
    })
    await env.DB.prepare(
      `INSERT INTO storage_objects (id, user_id, r2_key, filename, size, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, 'text/plain', ?)`
    )
      .bind(
        `obj_${prefix}_${f.path}`,
        user.id,
        `${prefix}/${f.path}`,
        f.path.slice(f.path.lastIndexOf("/") + 1),
        f.size,
        now
      )
      .run()
  }
  return prefix
}

function copyRequest(
  user: TestUser,
  body: Record<string, unknown>
): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/storage/objects/copy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

interface CopyBody {
  mode: "copy" | "move"
  count: number
  items: { from: string; to: string }[]
  failed: { path: string; message: string }[]
  missing: string[]
}

async function accountOf(userId: string) {
  return env.DB.prepare(
    "SELECT used_bytes, file_count FROM storage_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ used_bytes: number; file_count: number }>()
}

describe("withCopySuffix —— 重名加序号", () => {
  it("有扩展名：序号加在主名后面", () => {
    expect(withCopySuffix("报告.pdf", 1)).toBe("报告 (1).pdf")
    expect(withCopySuffix("a.tar.gz", 2)).toBe("a.tar (2).gz") // 只认最后一段扩展名
  })

  it("没有扩展名：序号整段缀在末尾", () => {
    expect(withCopySuffix("README", 1)).toBe("README (1)")
    // 点开头且没有主名（.gitignore）不能变成 " (1).gitignore"
    expect(withCopySuffix(".gitignore", 1)).toBe(".gitignore (1)")
  })

  it("n <= 0 原样返回", () => {
    expect(withCopySuffix("a.txt", 0)).toBe("a.txt")
    expect(withCopySuffix("a.txt", -3)).toBe("a.txt")
  })
})

describe("POST /api/storage/objects/copy —— 复制 / 剪切", () => {
  it("复制到子目录：目标多个副本，源仍在，用量按新增字节涨", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u, [{ path: "a.txt", size: 10 }])

    const res = await copyRequest(u, {
      keys: [`${prefix}/a.txt`],
      destFolder: "归档",
      mode: "copy",
    })
    expect(res.status).toBe(200)
    const body = await res.json<CopyBody>()
    expect(body.mode).toBe("copy")
    expect(body.count).toBe(1)
    expect(body.items).toEqual([{ from: "a.txt", to: "归档/a.txt" }])

    // R2 侧：源还在，目标多了一份
    expect(fakeObjects.map((o) => o.key).sort()).toEqual(
      [`${prefix}/a.txt`, `${prefix}/归档/a.txt`].sort()
    )
    // 记账：行数 +1，用量 +10
    const acc = await accountOf(u.id)
    expect(acc?.used_bytes).toBe(20)
    expect(acc?.file_count).toBe(2)
  })

  it("目标目录有同名文件 ⇒ 自动加 ` (1)` 后缀，不覆盖", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u, [
      { path: "a.txt", size: 10 },
      { path: "归档/a.txt", size: 999 },
    ])

    const res = await copyRequest(u, {
      keys: [`${prefix}/a.txt`],
      destFolder: "归档",
      mode: "copy",
    })
    const body = await res.json<CopyBody>()
    expect(body.items[0].to).toBe("归档/a (1).txt")
    // 原来那份 999 字节的没被动过
    expect(fakeObjects.find((o) => o.key === `${prefix}/归档/a.txt`)?.size).toBe(999)
    expect(fakeObjects.find((o) => o.key === `${prefix}/归档/a (1).txt`)?.size).toBe(10)
  })

  it("复制到同一个目录 ⇒ 变成 ` (1)` 副本（不是静默覆盖）", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u, [{ path: "a.txt", size: 10 }])

    const res = await copyRequest(u, {
      keys: [`${prefix}/a.txt`],
      destFolder: "",
      mode: "copy",
    })
    const body = await res.json<CopyBody>()
    expect(body.items).toEqual([{ from: "a.txt", to: "a (1).txt" }])
  })

  it("剪切：源消失、目标出现、用量不变", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u, [{ path: "a.txt", size: 10 }])

    const res = await copyRequest(u, {
      keys: [`${prefix}/a.txt`],
      destFolder: "归档",
      mode: "move",
    })
    expect(res.status).toBe(200)
    const body = await res.json<CopyBody>()
    expect(body.mode).toBe("move")
    expect(body.count).toBe(1)

    expect(fakeObjects.map((o) => o.key)).toEqual([`${prefix}/归档/a.txt`])
    const acc = await accountOf(u.id)
    expect(acc?.used_bytes).toBe(10) // 总量不变
    expect(acc?.file_count).toBe(1)
  })

  it("剪切到自己所在的目录 ⇒ 什么都不做（不能凭空多一个副本）", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u, [{ path: "归档/a.txt", size: 10 }])

    const res = await copyRequest(u, {
      keys: [`${prefix}/归档/a.txt`],
      destFolder: "归档",
      mode: "move",
    })
    const body = await res.json<CopyBody>()
    expect(body.count).toBe(0)
    expect(fakeObjects.map((o) => o.key)).toEqual([`${prefix}/归档/a.txt`])
  })

  it("剪贴板里的文件已经不在 ⇒ 记进 missing，其余照常处理", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u, [{ path: "a.txt", size: 10 }])

    const res = await copyRequest(u, {
      keys: [`${prefix}/a.txt`, `${prefix}/gone.txt`],
      destFolder: "归档",
      mode: "copy",
    })
    expect(res.status).toBe(200)
    const body = await res.json<CopyBody>()
    expect(body.count).toBe(1)
    expect(body.missing).toEqual(["gone.txt"])
  })

  it("复制超配额 ⇒ 400 QUOTA_EXCEEDED，一个都不动", async () => {
    const u = await makeUser()
    // 配额 15 字节，已用 10；再复制 10 字节就不够了
    const prefix = await seedAccount(u, [{ path: "a.txt", size: 10 }], 15)

    const res = await copyRequest(u, {
      keys: [`${prefix}/a.txt`],
      destFolder: "归档",
      mode: "copy",
    })
    expect(res.status).toBe(400)
    expect(fakeObjects.map((o) => o.key)).toEqual([`${prefix}/a.txt`])
  })

  it("剪切不校验配额（总量不变，满额也能整理目录）", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u, [{ path: "a.txt", size: 10 }], 10)

    const res = await copyRequest(u, {
      keys: [`${prefix}/a.txt`],
      destFolder: "归档",
      mode: "move",
    })
    expect(res.status).toBe(200)
  })
})

describe("POST /api/storage/objects/copy —— 入参护栏", () => {
  it("没选文件 ⇒ 400", async () => {
    const u = await makeUser()
    await seedAccount(u)
    const res = await copyRequest(u, { keys: [], destFolder: "归档" })
    expect(res.status).toBe(400)
  })

  it("超过 200 个 ⇒ 400", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u)
    const keys = Array.from({ length: 201 }, (_v, i) => `${prefix}/f${i}.txt`)
    const res = await copyRequest(u, { keys, destFolder: "归档" })
    expect(res.status).toBe(400)
  })

  it("别人的 key ⇒ 403", async () => {
    const u = await makeUser()
    await seedAccount(u)
    const res = await copyRequest(u, { keys: ["someoneelse/a.txt"], mode: "copy" })
    expect(res.status).toBe(403)
  })

  it("目录占位对象不能复制 / 移动 ⇒ 400", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u)
    const res = await copyRequest(u, { keys: [`${prefix}/归档/`], mode: "copy" })
    expect(res.status).toBe(400)
  })

  it("未登录 ⇒ 401", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/storage/objects/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["x/a.txt"] }),
      })
    )
    expect(res.status).toBe(401)
  })
})
