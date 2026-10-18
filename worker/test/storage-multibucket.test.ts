// 网盘「跨桶」核心逻辑（2026-10-12 站长要求）。
//
// ## 背景
//
// 改前：一个账号的所有文件都写在他开通时分到的那**一个**桶（`storage_accounts.bucket_id`），
// 桶满只能报错拒传。
//
// 改后：**文件级跨桶** —— 主桶装不下时，新文件自动落到下一个还有空间的桶
// （"A 桶满了剩下的去 B 桶存"）；两个桶都没满就不需要新建第三个。
//
// ## 这里锁什么
//
// 只测纯 DB 逻辑的两个函数（选桶 / 候选桶顺序），不涉及 R2 出站 ——
// 跨桶正确性的**根基**就是这两个函数给出的桶对不对，剩下的读/删/列只是"把
// candidateBucketIds 给的桶挨个试一遍"。
//
// 具体锁四条：
//   1. 主桶装得下 ⇒ 就用主桶（别乱搬家，读的时候一次命中）；
//   2. 主桶装不下 ⇒ 落到**下一个还有空间的桶**（这就是"A 满了用 B"）；
//   3. 所有桶都装不下 ⇒ 仍返回剩余最多的那个（交给容量守卫报「桶已满」，
//      保持与改前一致的错误语义，而不是静默写到默认桶去）；
//   4. 候选桶顺序：主桶第一，其余按 sort_order。
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { encryptSecret } from "../src/crypto"
import { invalidatePlatformBucketCache, pickBucketForWrite, candidateBucketIds } from "../src/r2"
import { makeUser } from "./helpers"

const MB = 1024 * 1024

/** 造一个桶（只需 id / 容量 / 排序；凭据随便塞个合法密文，选桶逻辑本身不碰它） */
async function makeBucket(id: string, capacityBytes: number, sortOrder: number) {
  const secret = env.SESSION_SECRET!
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT OR REPLACE INTO r2_buckets
       (id, name, account_id, endpoint, bucket_name, access_key_id_enc, secret_key_enc,
        quota_per_user, capacity_bytes, enabled, sort_order, kind, created_at, updated_at)
     VALUES (?, ?, NULL, 'https://x.r2.cloudflarestorage.com', 'network', ?, ?, ?, ?, 1, ?, 'user', ?, ?)`
  )
    .bind(
      id,
      id,
      await encryptSecret("test-key-id", secret),
      await encryptSecret("test-secret", secret),
      MB,
      capacityBytes,
      sortOrder,
      now,
      now
    )
    .run()
}

/** 造一个账号，记到某个桶上并占掉 usedBytes（user_id 有外键 ⇒ 用 makeUser 建真用户） */
async function makeAccount(bucketId: string, usedBytes: number): Promise<void> {
  const user = await makeUser()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO storage_accounts
       (user_id, prefix, quota_bytes, used_bytes, file_count, enabled, bucket_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`
  )
    .bind(user.id, user.username, 10 * MB, usedBytes, bucketId, now, now)
    .run()
}

/** 每个用例都从「空桶表」开始：这些用例验证的是「在给定桶集合下选谁」，
 *  上一个用例建的桶残留下来会把候选集弄脏（第一次跑就是这么挂的）。 */
async function resetBuckets() {
  await env.DB.prepare("DELETE FROM storage_accounts").run()
  await env.DB.prepare("DELETE FROM r2_buckets WHERE kind = 'user'").run()
  invalidatePlatformBucketCache()
}

beforeAll(resetBuckets)
beforeEach(resetBuckets)

describe("网盘跨桶：选桶与候选顺序", () => {
  it("主桶装得下 ⇒ 就用主桶", async () => {
    await makeBucket("b_big", 1000 * MB, 0)
    await makeAccount("b_big", 10 * MB)

    expect(await pickBucketForWrite(env, 5 * MB, "b_big")).toBe("b_big")
  })

  it("主桶装不下 ⇒ 落到下一个还有空间的桶（A 满了用 B）", async () => {
    await makeBucket("b_full", 50 * MB, 0)
    await makeBucket("b_roomy", 1000 * MB, 1)
    // 主桶容量 50MB、已用 49MB ⇒ 只剩 1MB，装不下 5MB
    await makeAccount("b_full", 49 * MB)

    expect(await pickBucketForWrite(env, 5 * MB, "b_full")).toBe("b_roomy")
  })

  it("剩余相同则优先主桶（让同一账号的文件尽量聚在一起）", async () => {
    await makeBucket("b_a", 1000 * MB, 0)
    await makeBucket("b_b", 1000 * MB, 1)
    await makeAccount("b_a", 0)

    expect(await pickBucketForWrite(env, 1 * MB, "b_a")).toBe("b_a")
  })

  it("所有桶都装不下 ⇒ 仍返回剩余最多的（交给容量守卫报「桶已满」，不静默换桶）", async () => {
    await makeBucket("b_x", 10 * MB, 0)
    await makeBucket("b_y", 20 * MB, 1)
    await makeAccount("b_x", 10 * MB) // x 已满
    await makeAccount("b_y", 1 * MB) // y 还剩 19MB

    // 要写 100MB，谁都装不下 ⇒ 返回剩余最多的 b_y，而不是 null 或主桶
    expect(await pickBucketForWrite(env, 100 * MB, "b_x")).toBe("b_y")
  })

  it("候选桶：主桶排第一，其余按 sort_order", async () => {
    await makeBucket("b_1", 1000 * MB, 0)
    await makeBucket("b_2", 1000 * MB, 1)
    await makeBucket("b_3", 1000 * MB, 2)

    expect(await candidateBucketIds(env, "b_3")).toEqual(["b_3", "b_1", "b_2"])
    // 主桶不在列表里（被删了）⇒ 仍按 sort_order 正常返回
    expect(await candidateBucketIds(env, "b_gone")).toEqual(["b_1", "b_2", "b_3"])
    // 没有主桶（老账号）⇒ 同样按 sort_order
    expect(await candidateBucketIds(env, null)).toEqual(["b_1", "b_2", "b_3"])
  })

  it("没配任何用户桶 ⇒ 返回 null（调用方回落 env 默认桶）", async () => {
    expect(await pickBucketForWrite(env, 1, null)).toBeNull()
    expect(await candidateBucketIds(env, null)).toEqual([])
  })
})
