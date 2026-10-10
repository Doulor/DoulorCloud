// 管理员改派网盘桶（`PUT /api/admin/r2/assign`）的「目标桶已满」判据。
//
// 2026-10-10 实测：`assignUserBucket` 的守卫写成
//   `if ((cnt?.c ?? 0) >= bucket.max_users && account.used_bytes === 0)`
// —— 多出来的 `&& account.used_bytes === 0` 把判据**反过来**：桶满时
// **真正要搬文件进去的账号被放行、不占空间的空账号被拒**。
//
// 为什么确定这是写反而不是有意：三处独立旁证都指向「纯人数判据」——
//   ① 同文件 `assignAllUnassigned`（批量迁入）写的是 `(current + count) > bucket.max_users`，纯人数；
//   ② 文案「目标桶已满（N/M 人）」与桶列表「已分配 N 人 · 每人 X」都是人数口径；
//   ③ `src/i18n/api-messages.ts` 的英文译文是 "The target bucket is full ({v0}/{v1} users)"。
//
// 可达性：管理端改派下拉**只列 `usedBytes > 0` 的用户**（`src/pages/admin.tsx:6053`）
// ⇒ UI 上能点的人恰好全是会被放行的 ⇒ 判据在真实操作路径上 100% 失效。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

const now = new Date().toISOString()

/** 造一个启用中的「用户网盘桶」 */
async function makeBucket(id: string, maxUsers: number) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO r2_buckets
       (id, name, account_id, endpoint, bucket_name, access_key_id_enc, secret_key_enc,
        analytics_token_enc, max_users, quota_per_user, enabled, sort_order, kind, created_at, updated_at)
     VALUES (?, ?, NULL, 'https://example.r2.cloudflarestorage.com', ?, 'enc', 'enc',
        NULL, ?, 1073741824, 1, 0, 'user', ?, ?)`
  )
    .bind(id, id, id, maxUsers, now, now)
    .run()
}

/** 造一个网盘账号；`bucketId` 为 null 表示「未分配」 */
async function makeStorage(
  userId: string,
  prefix: string,
  bucketId: string | null,
  used: number
) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO storage_accounts
       (user_id, prefix, quota_bytes, used_bytes, file_count, enabled,
        consent_version, consented_at, bucket_id, created_at, updated_at)
     VALUES (?, ?, 1073741824, ?, 0, 1, 1, ?, ?, ?, ?)`
  )
    .bind(userId, prefix, used, now, bucketId, now, now)
    .run()
}

function assign(admin: TestUser, username: string, bucketId: string) {
  return fetchSelf(
    authRequest(admin, "/api/admin/r2/assign", {
      method: "PUT",
      body: JSON.stringify({ username, bucketId }),
    })
  )
}

async function bucketOf(userId: string): Promise<string | null> {
  const r = await env.DB.prepare(
    "SELECT bucket_id FROM storage_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ bucket_id: string | null }>()
  return r?.bucket_id ?? null
}

describe("PUT /api/admin/r2/assign —— 目标桶人数上限", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM storage_accounts").run()
    await env.DB.prepare("DELETE FROM r2_buckets").run()
  })

  it("桶已满：迁入一个**有数据**的账号必须被拦（这正是 UI 上唯一能点的那种）", async () => {
    const root = await makeUser({ role: "root" })
    await makeBucket("bfull", 1)

    const occupant = await makeUser()
    await makeStorage(occupant.id, "occ1", "bfull", 0) // 占住唯一名额

    const mover = await makeUser()
    await makeStorage(mover.id, "mv1", null, 5 * 1024 * 1024) // 有 5 MiB 数据

    const res = await assign(root, mover.username, "bfull")
    const payload = (await res.json().catch(() => ({}))) as { code?: string }
    expect(res.status, JSON.stringify(payload)).toBe(409)
    expect(payload.code).toBe("BUCKET_FULL")
    // 被拒后不能留下副作用：归属没变
    expect(await bucketOf(mover.id)).toBeNull()
  })

  it("桶已满：迁入一个**空**账号同样被拦（判据只看人数）", async () => {
    const root = await makeUser({ role: "root" })
    await makeBucket("bfull2", 1)

    const occupant = await makeUser()
    await makeStorage(occupant.id, "occ2", "bfull2", 0)

    const mover = await makeUser()
    await makeStorage(mover.id, "mv2", null, 0) // 空账号

    const res = await assign(root, mover.username, "bfull2")
    expect(res.status).toBe(409)
    expect(await bucketOf(mover.id)).toBeNull()
  })

  it("桶未满：迁入有数据的账号必须放行（不能误伤）", async () => {
    const root = await makeUser({ role: "root" })
    await makeBucket("broom", 3)

    const mover = await makeUser()
    await makeStorage(mover.id, "mv3", null, 1024)

    const res = await assign(root, mover.username, "broom")
    expect(res.status).toBe(200)
    expect(await bucketOf(mover.id)).toBe("broom")
  })

  it("桶恰好差一个人满：迁入必须放行（边界是 >= 不是 >）", async () => {
    const root = await makeUser({ role: "root" })
    await makeBucket("bedge", 2)

    const occupant = await makeUser()
    await makeStorage(occupant.id, "occ4", "bedge", 0) // 1/2 人

    const mover = await makeUser()
    await makeStorage(mover.id, "mv4", null, 2048)

    const res = await assign(root, mover.username, "bedge")
    expect(res.status).toBe(200)
    expect(await bucketOf(mover.id)).toBe("bedge")
  })

  it("人数只数**目标桶**：别的桶人再多也不影响", async () => {
    const root = await makeUser({ role: "root" })
    await makeBucket("btarget", 2)
    await makeBucket("bother", 10)

    // 另一个桶塞满 10 人（远超目标桶上限 2）
    for (let i = 0; i < 10; i++) {
      const u = await makeUser()
      await makeStorage(u.id, `oth${i}`, "bother", 1024)
    }
    // 目标桶只有 1 人
    const occupant = await makeUser()
    await makeStorage(occupant.id, "tgt1", "btarget", 1024)

    const mover = await makeUser()
    await makeStorage(mover.id, "mv5", null, 1024)

    const res = await assign(root, mover.username, "btarget")
    expect(res.status, "别的桶的人数不该被算进来").toBe(200)
    expect(await bucketOf(mover.id)).toBe("btarget")
  })
})
