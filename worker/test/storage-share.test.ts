// 网盘「目录」相关的两个易错点。
//
// 1) 列表接口返回的文件路径口径。
//    2026-10-09 站长实爆：把文件放进子目录后，复制出来的直链是
//    `https://r2.tyu.me/新建 文本文档.txt` —— **丢了子目录**，点开跑去根目录找（或串到根目录的同名文件）。
//    根因：`listLevel` 给的 `files[].path` 是「相对当前目录」的短名，
//    而下游把它当「相对账号根目录」用（拼直链 `https://<fqdn>/<path>`、拼 R2 key `<prefix>/<path>`）。
//    同一个坑还会让「删除 / 批量删除」打到 `<prefix>/<文件名>` 这个不存在的对象上 —— 看起来删成功了，其实没有。
//    这里把口径锁死：**无论在根目录还是子目录，path 一律是相对账号根目录的完整路径**。
//
// 2) 公开分享页的品牌元素。
//    页头要用站点 Logo 的云图标；页脚「Doulor Cloud · 直链网盘」要能点回站点首页，并带上开源仓库入口。
//    这些是站长 2026-10-09 明确要的，别在下一次改版里弄丢。
//
// 环境说明：网盘真实的读写走 S3 兼容 REST（`r2.ts::r2Fetch`），测试环境没有桶绑定，
// 所以这里手工造一个「启用中的用户桶」+ 用 `globalThis.fetch` 打桩返回 ListObjectsV2 的 XML
// （仓库既有的出站打桩方式，见 donation-ai.test.ts / audit-batch6.test.ts）。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { encryptSecret } from "../src/crypto"
import { invalidatePlatformBucketCache } from "../src/r2"
import { makeUser, authRequest, fetchSelf } from "./helpers"

const BUCKET_ID = "tb_share_test"
const ACCOUNT_ID = "a".repeat(32)
const S3_ORIGIN = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`

/** 本次要「出现在桶里」的对象（每个用例自己设） */
let fakeObjects: { key: string; size: number }[] = []
let originalFetch: typeof globalThis.fetch

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** 伪造一个 ListObjectsV2 响应（只保留 listObjects 真正会解析的那几个标签） */
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

beforeAll(async () => {
  const secret = env.SESSION_SECRET!
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO r2_buckets
       (id, name, account_id, endpoint, bucket_name, access_key_id_enc, secret_key_enc,
        analytics_token_enc, max_users, quota_per_user, enabled, sort_order, kind, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'network', ?, ?, NULL, 16, ?, 1, 0, 'user', ?, ?)`
  )
    .bind(
      BUCKET_ID,
      BUCKET_ID,
      S3_ORIGIN,
      await encryptSecret("test-access-key-id", secret),
      await encryptSecret("test-secret-access-key", secret),
      1024 * 1024 * 1024,
      now,
      now
    )
    .run()
  invalidatePlatformBucketCache()

  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(S3_ORIGIN)) {
      const prefix = new URL(url).searchParams.get("prefix") ?? ""
      return new Response(listObjectsXml(prefix), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      })
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

/** prefix 是 UNIQUE 且各用例共用同一个测试库，所以每次取一个新前缀 */
let prefixSeq = 0

/** 建一个网盘账号（挂在上面那个桶上），返回本次用的 prefix */
async function seedAccount(userId: string): Promise<string> {
  const prefix = `t_sh${++prefixSeq}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO storage_accounts
       (user_id, prefix, quota_bytes, used_bytes, file_count, enabled,
        consent_version, consented_at, bucket_id, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 1, 1, ?, ?, ?, ?)`
  )
    .bind(userId, prefix, 1024 * 1024 * 1024, now, BUCKET_ID, now, now)
    .run()
  return prefix
}

describe("GET /api/storage/objects —— 路径一律相对账号根目录", () => {
  it("根目录下：path 就是文件名", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u.id)
    fakeObjects = [{ key: `${prefix}/a.txt`, size: 3 }]

    const res = await fetchSelf(authRequest(u, "/api/storage/objects"))
    expect(res.status).toBe(200)
    const body = await res.json<{ objects: { path: string; key: string }[] }>()
    expect(body.objects).toHaveLength(1)
    expect(body.objects[0].path).toBe("a.txt")
    expect(body.objects[0].key).toBe(`${prefix}/a.txt`)
  })

  it("子目录里：path / key 都必须带上目录名（直链才指得对）", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u.id)
    fakeObjects = [
      // 子目录里的文件
      { key: `${prefix}/归档/新建 文本文档.txt`, size: 12 },
      // 子目录自己的占位对象（不该被当成文件列出来）
      { key: `${prefix}/归档/`, size: 0 },
      // 更深一层：归到「归档」这个子目录名下即可
      { key: `${prefix}/归档/2025/x.txt`, size: 1 },
      // 根目录里的同名文件（最容易张冠李戴的那个）
      { key: `${prefix}/新建 文本文档.txt`, size: 99 },
    ]

    const res = await fetchSelf(authRequest(u, "/api/storage/objects?path=归档"))
    expect(res.status).toBe(200)
    const body = await res.json<{
      path: string
      folders: { name: string; path: string }[]
      objects: { path: string; key: string; size: number }[]
    }>()

    expect(body.path).toBe("归档")
    expect(body.folders).toEqual([{ name: "2025", path: "归档/2025" }])

    expect(body.objects).toHaveLength(1)
    // 🔴 关键断言：丢了目录名就会退化成 "新建 文本文档.txt"
    expect(body.objects[0].path).toBe("归档/新建 文本文档.txt")
    expect(body.objects[0].key).toBe(`${prefix}/归档/新建 文本文档.txt`)
    // 且绝不能串到根目录那个同名文件上
    expect(body.objects[0].size).toBe(12)
  })

  it("非法目录名（.. 穿越）被拒", async () => {
    const u = await makeUser()
    await seedAccount(u.id)
    const res = await fetchSelf(authRequest(u, "/api/storage/objects?path=../x"))
    expect(res.status).toBe(400)
  })
})

describe("GET /s/<token> —— 公开分享页", () => {
  async function makeShare(userId: string, token: string, path: string): Promise<void> {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO storage_shares (id, user_id, token, path, title, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`
    )
      .bind(`sh_${token}`, userId, token, path, now, now)
      .run()
  }

  it("页头有站点云图标，页脚能点回站点首页 + 有仓库入口", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u.id)
    await makeShare(u.id, "tokbrand00000000000001", "")
    fakeObjects = [{ key: `${prefix}/a.txt`, size: 3 }]

    const res = await fetchSelf(new Request("https://cloud.doulor.cn/s/tokbrand00000000000001"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("no-store")
    const html = await res.text()

    // 页头：站点 Logo 徽标里的云图标（lucide cloud）
    expect(html).toContain('class="brand"')
    expect(html).toContain('d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"')
    // 页脚：站点首页 + GitHub 仓库
    expect(html).toContain('href="https://cloud.doulor.cn"')
    expect(html).toContain("Doulor Cloud · 直链网盘")
    expect(html).toContain('href="https://github.com/Doulor/DoulorCloud"')
    expect(html).toContain('class="gh"')
    // 对外页面不该被搜索引擎收录
    expect(html).toContain("noindex")
  })

  it("子目录页：文件下载链接带完整相对路径", async () => {
    const u = await makeUser()
    const prefix = await seedAccount(u.id)
    await makeShare(u.id, "toksub0000000000000001", "发布")
    fakeObjects = [{ key: `${prefix}/发布/子目录/说明.txt`, size: 3 }]

    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/s/toksub0000000000000001?p=子目录")
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(
      `/s/toksub0000000000000001/f/${encodeURIComponent("子目录")}/${encodeURIComponent("说明.txt")}`
    )
  })

  it("分享不存在 → 404 且回 HTML 而不是 JSON", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/s/nope0000000000000000"))
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("text/html")
  })
})
