// 网盘配额（存量用户）两个入口的契约。
//
// 背景：`storage_accounts.quota_bytes` 是**开通那一刻写死的快照**，
// 改 `r2_buckets.quota_per_user` 只影响之后新开通的人。所以存量用户必须靠：
//   · PUT  /api/admin/storage/quota/:username  —— 单个改（成员详情里用）
//   · POST /api/admin/storage/sync-quota       —— 批量刷成「所属桶的每人配额」
//
// 这里锁定三件事，避免以后被「顺手」改坏：
//   1. 只有管理员能调（普通用户 403）；
//   2. 真的写到 storage_accounts.quota_bytes，且超额会被标出来；
//   3. 批量同步会**跳过 admin/root**（他们开通时写的是「不限量」哨兵值，不该被刷小）。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/** 造一条 storage_accounts（prefix 是 UNIQUE，各用例要用不同的） */
async function makeStorage(
  userId: string,
  prefix: string,
  quotaBytes: number,
  opts: { used?: number; bucketId?: string | null } = {}
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO storage_accounts
       (user_id, prefix, quota_bytes, used_bytes, file_count, enabled,
        consent_version, consented_at, bucket_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, 1, ?, ?, ?, ?)`
  )
    .bind(userId, prefix, quotaBytes, opts.used ?? 0, now, opts.bucketId ?? null, now, now)
    .run()
}

/** 造一个用户网盘桶 */
async function makeBucket(id: string, quotaPerUser: number, kind = "user"): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO r2_buckets
       (id, name, account_id, endpoint, bucket_name, access_key_id_enc, secret_key_enc,
        analytics_token_enc, max_users, quota_per_user, enabled, sort_order, kind, created_at, updated_at)
     VALUES (?, ?, NULL, 'https://example.r2.cloudflarestorage.com', ?, 'enc', 'enc',
        NULL, 16, ?, 1, 0, ?, ?, ?)`
  )
    .bind(id, id, id, quotaPerUser, kind, now, now)
    .run()
}

async function quotaOf(userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT quota_bytes FROM storage_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ quota_bytes: number }>()
  return row?.quota_bytes ?? null
}

/** 全局默认配额（没有设置行时回落 SETTING_DEFAULTS 的 1 GiB） */
async function globalDefaultQuota(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'storage_quota_bytes'"
  ).first<{ value: string }>()
  return row ? Number(row.value) : GiB
}

function putQuota(admin: { cookie: string }, username: string, quotaBytes: number) {
  return fetchSelf(
    authRequest(admin, `/api/admin/storage/quota/${username}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotaBytes }),
    })
  )
}

describe("PUT /api/admin/storage/quota/:username —— 改单个用户的网盘配额", () => {
  it("写入 quota_bytes，并在超额时给出提示标记", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await makeStorage(u.id, `t_sq_${u.username}`, GiB, { used: 600 * MiB })

    const res = await putQuota(admin, u.username, 512 * MiB)
    expect(res.status).toBe(200)
    const body = await res.json<{ quotaBytes: number; usedBytes: number; overQuota: boolean }>()
    expect(body.quotaBytes).toBe(512 * MiB)
    expect(body.usedBytes).toBe(600 * MiB)
    expect(body.overQuota).toBe(true) // 已用 600 MB > 新配额 512 MB

    expect(await quotaOf(u.id)).toBe(512 * MiB)
  })

  it("配额大于已用量时不标超额", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await makeStorage(u.id, `t_sq_${u.username}`, GiB, { used: 10 * MiB })

    const res = await putQuota(admin, u.username, 2 * GiB)
    const body = await res.json<{ overQuota: boolean }>()
    expect(res.status).toBe(200)
    expect(body.overQuota).toBe(false)
    expect(await quotaOf(u.id)).toBe(2 * GiB)
  })

  it("未开通网盘 → 404", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const res = await putQuota(admin, u.username, GiB)
    expect(res.status).toBe(404)
  })

  it("非管理员 → 403", async () => {
    const u = await makeUser()
    const other = await makeUser()
    await makeStorage(u.id, `t_sq_${u.username}`, GiB)

    const res = await putQuota(other, u.username, GiB)
    expect(res.status).toBe(403)
    expect(await quotaOf(u.id)).toBe(GiB) // 没被改
  })

  it("非法配额（负数 / 非数字）→ 400", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await makeStorage(u.id, `t_sq_${u.username}`, GiB)

    for (const bad of [-1, "abc", {}]) {
      const res = await fetchSelf(
        authRequest(admin, `/api/admin/storage/quota/${u.username}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quotaBytes: bad }),
        })
      )
      expect(res.status).toBe(400)
    }
    expect(await quotaOf(u.id)).toBe(GiB)
  })
})

describe("POST /api/admin/storage/sync-quota —— 存量用户刷成所属桶配额", () => {
  it("有桶归属的用桶配额；没桶的回落全局默认；管理员被跳过", async () => {
    await makeBucket("t_sync_a", 512 * MiB)
    const fallback = await globalDefaultQuota()

    const admin = await makeUser({ role: "admin" })
    const inBucket = await makeUser()
    const noBucket = await makeUser()

    await makeStorage(inBucket.id, `t_sy_${inBucket.username}`, GiB, { bucketId: "t_sync_a" })
    // 故意给个不等于全局默认的值，验证它确实被刷成了全局默认
    await makeStorage(noBucket.id, `t_sy_${noBucket.username}`, 12345 * MiB, { bucketId: null })
    // 管理员：不该被刷
    await makeStorage(admin.id, `t_sy_${admin.username}`, GiB, { bucketId: "t_sync_a" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/storage/sync-quota", { method: "POST" })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ updated: number; skippedAdmins: number }>()
    expect(body.updated).toBeGreaterThanOrEqual(2)
    expect(body.skippedAdmins).toBeGreaterThanOrEqual(1)

    expect(await quotaOf(inBucket.id)).toBe(512 * MiB) // 桶配额
    expect(await quotaOf(noBucket.id)).toBe(fallback) // 回落全局默认
    expect(await quotaOf(admin.id)).toBe(GiB) // 管理员原样
  })

  it("重复执行是幂等的（配额已一致就不再改）", async () => {
    await makeBucket("t_sync_b", 256 * MiB)
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await makeStorage(u.id, `t_sy2_${u.username}`, GiB, { bucketId: "t_sync_b" })

    const first = await (
      await fetchSelf(authRequest(admin, "/api/admin/storage/sync-quota", { method: "POST" }))
    ).json<{ updated: number }>()
    expect(first.updated).toBeGreaterThanOrEqual(1)
    expect(await quotaOf(u.id)).toBe(256 * MiB)

    const second = await (
      await fetchSelf(authRequest(admin, "/api/admin/storage/sync-quota", { method: "POST" }))
    ).json<{ updated: number }>()
    expect(second.updated).toBe(0) // 已一致，无事可做
  })

  it("非管理员 → 403", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/admin/storage/sync-quota", { method: "POST" }))
    expect(res.status).toBe(403)
  })
})
