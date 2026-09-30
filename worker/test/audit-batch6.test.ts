/**
 * 回归测试：第六批修复（2026-09-25 审计 H4 / H13 / L25）。
 *
 * H4  —— 定时清理过期分享箱用了错误的桶，且 R2 删除失败后仍然删 D1 行
 *        → R2 对象永久泄漏（不可读、不可清）。
 * H13 —— `purgeExpiredAnalytics` / `purgeExpiredPreviews` 写好了但从未被调用
 *        → 两张最贵的表无界增长且无告警。
 * L25 —— 删除 `permissions = NULL` 的历史邀请码会一次退还全部 4 个模块额度。
 *
 * ⚠️ 关于 H4 的「桶选对了没」怎么测：
 *   本测试环境没有配 R2 凭据，所以删除**必然失败** —— 这正好是 H4 里
 *   数据丢失那一半的天然注入点。而「用了哪个桶」本来无法从外部观察，
 *   直到读了 `r2.ts` 的 `resolveBucket`：
 *
 *     if (!bucketId) return envConfig(env)     // 传空 → env 默认桶
 *     ...找不到行 → 404「桶 X 不存在」
 *     ...行在但没凭据 → 503「桶 <row.name> 未配置凭据…」   ← 错误信息带桶名！
 *
 *   所以我们插一个 **没有凭据** 的 platform 桶，然后断言错误信息里
 *   出现了**这个桶的名字** —— 出现了就说明 maintenance 确实把
 *   `getPlatformBucketId(env)` 的结果传下去了；旧代码传 undefined 时
 *   只会走到 `envConfig`，报「网盘存储未配置（缺少 R2 S3 凭据）」，不含桶名。
 *
 *   注意不能用 `vi.mock` 拦 `deletePrefix`：本仓库用的是
 *   `@cloudflare/vitest-plugin`（测试跑在 workerd 里），`vi.mock` 拦不住
 *   worker 源码的模块导入（实测拦不到，调用照旧打到真实实现）。
 *   仓库既有的出站打桩方式都是 `globalThis.fetch = stub`。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"
import { runMaintenance } from "../src/maintenance"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** 故意不起眼的名字：只在「桶选对了」时才会出现在错误信息里 */
const PLATFORM_BUCKET_NAME = "H4平台桶"

beforeAll(async () => {
  const now = new Date().toISOString()
  // ⚠️ 必须显式写 kind='platform'：`kind` 是 0026 迁移加上的，
  // 默认值是 'user'，而 `getPlatformBucketId` 查的是 `kind = 'platform'`。
  // 漏了它就会静默退回 env 默认桶，测试变成假绿。
  await env.DB.prepare(
    `INSERT INTO r2_buckets
       (id, name, account_id, endpoint, bucket_name,
        access_key_id_enc, secret_key_enc, kind, enabled, sort_order, created_at, updated_at)
     VALUES ('h4test', ?, NULL, 'https://h4test.r2.cloudflarestorage.com', 'h4test-bucket',
        '', '', 'platform', 1, 0, ?, ?)`
  )
    .bind(PLATFORM_BUCKET_NAME, now, now)
    .run()
})

async function seedTempbox(code: string, expired: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tempbox_batches (id, code, creator_user_id, expire_at, file_count, total_bytes, created_at)
     VALUES (?, ?, NULL, ?, 0, 0, ?)`
  )
    .bind(
      uuid(),
      code,
      new Date(Date.now() + (expired ? -HOUR : HOUR)).toISOString(),
      new Date().toISOString()
    )
    .run()
}

async function tempboxCodes(): Promise<string[]> {
  const r = await env.DB.prepare("SELECT code FROM tempbox_batches ORDER BY code").all<{
    code: string
  }>()
  return (r.results ?? []).map((x) => x.code)
}

describe("过期分享箱清理（H4）", () => {
  it("R2 删除失败 → 保留 D1 行等下轮重试（旧代码会连行一起删，对象永久泄漏）", async () => {
    await seedTempbox("H4EXPIRED", true)
    await seedTempbox("H4LIVE", false)

    const report = await runMaintenance(env, { dryRun: false })

    const codes = await tempboxCodes()
    // 核心：R2 没删成功，D1 行就**必须**留着。
    // 否则那批对象既不会被惰性清理（没有接收码可触发），也不会被定时清理
    // （D1 里已经没有那一行了）→ 永远不可读、不可清。
    expect(codes).toContain("H4EXPIRED")
    // 未过期的不能被动
    expect(codes).toContain("H4LIVE")

    const err = report.errors.find((e) => e.includes("H4EXPIRED"))
    expect(err).toBeTruthy()
  })

  it("用的是 platform 桶，不是 env 默认桶（旧代码只传 3 个参数）", async () => {
    await seedTempbox("H4BUCKET", true)

    const report = await runMaintenance(env, { dryRun: false })

    const err = report.errors.find((e) => e.includes("H4BUCKET"))
    expect(err).toBeTruthy()
    // 错误信息里出现 platform 桶的名字 ⇒ resolveBucket 拿到了真实 bucketId。
    // 旧代码 `deletePrefix(env, prefix)` 传 undefined ⇒ 走 envConfig ⇒
    // 只会报「网盘存储未配置（缺少 R2 S3 凭据）」，绝不会出现桶名。
    expect(err!).toContain(PLATFORM_BUCKET_NAME)
  })

  it("dry-run 只统计不删行", async () => {
    await seedTempbox("H4DRYRUN", true)
    const report = await runMaintenance(env, { dryRun: true })
    expect(report.tempbox.batches).toBeGreaterThanOrEqual(1)
    expect(await tempboxCodes()).toContain("H4DRYRUN")
  })
})

describe("过期统计事件 / 链接预览缓存清理（H13）", () => {
  async function seedAnalytics(path: string, ageDays: number): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO analytics_events (id, visitor_id, path, referrer, ua, created_at)
       VALUES (?, ?, ?, 'direct', NULL, ?)`
    )
      .bind(uuid(), `v_${path}`, path, new Date(Date.now() - ageDays * DAY).toISOString())
      .run()
  }

  async function seedPreview(url: string, ageDays: number): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO link_previews (url, title, description, image, site_name, fetched_at)
       VALUES (?, ?, NULL, NULL, NULL, ?)`
    )
      .bind(url, `t_${url}`, new Date(Date.now() - ageDays * DAY).toISOString())
      .run()
  }

  it("超过保留期的行会被删掉，未超期的保留（这两个函数原先从未被调用）", async () => {
    await seedAnalytics("/h13-old", 100) // > 90 天
    await seedAnalytics("/h13-new", 1)
    await seedPreview("https://h13-old.example.com/", 10) // > 7 天
    await seedPreview("https://h13-new.example.com/", 1)

    const report = await runMaintenance(env, { dryRun: false })

    expect(report.expiredPurged.analyticsEvents).toBeGreaterThanOrEqual(1)
    expect(report.expiredPurged.linkPreviews).toBeGreaterThanOrEqual(1)

    const a = await env.DB.prepare("SELECT path FROM analytics_events").all<{ path: string }>()
    const paths = (a.results ?? []).map((r) => r.path)
    expect(paths).not.toContain("/h13-old")
    expect(paths).toContain("/h13-new")

    const p = await env.DB.prepare("SELECT url FROM link_previews").all<{ url: string }>()
    const urls = (p.results ?? []).map((r) => r.url)
    expect(urls).not.toContain("https://h13-old.example.com/")
    expect(urls).toContain("https://h13-new.example.com/")
  })

  it("dry-run 只统计不删除", async () => {
    await seedAnalytics("/h13-dryrun", 100)

    const report = await runMaintenance(env, { dryRun: true })
    expect(report.expiredPurged.analyticsEvents).toBeGreaterThanOrEqual(1)

    const a = await env.DB.prepare("SELECT path FROM analytics_events").all<{ path: string }>()
    expect((a.results ?? []).map((r) => r.path)).toContain("/h13-dryrun")
  })
})

describe("代理捐献不能刷额度（H2）", () => {
  // 手工批准代理捐献时，`importProxySubscriptions` 会对订阅链接做一次
  // 「识别协议/地区」的请求（见 donations.ts 的 detectSubscriptionProfile）。
  // 测试里必须把它打桩掉 —— 否则会真的走外网，而本机挂着代理环境变量时
  // 这种失败会以 **uncaught exception** 的形式冒出来（不 fail 测试，但很脏）。
  // 用仓库既有的 `globalThis.fetch = stub` 方式（见 donation-ai.test.ts）。
  // 注意 `fetchSelf` 走的是 `SELF.fetch`，不受这里影响。
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("network disabled in tests")
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /**
   * `createDonation` 要求「已验证的真实邮箱」——`@doulor.cn` 的站内地址会被
   * 400 NO_NOTIFY_EMAIL 挡掉（makeUser 造的用户默认就是站内地址）。
   */
  async function giveRealEmail(userId: string): Promise<void> {
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
      .bind(`real_${userId.slice(0, 8)}@example.com`, userId)
      .run()
  }

  function submitProxy(user: TestUser, url: string): Promise<Response> {
    return fetchSelf(
      authRequest(user, "/api/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "proxy", payload: { subUrls: [url] } }),
      })
    )
  }

  function approve(admin: TestUser, id: string): Promise<Response> {
    return fetchSelf(
      authRequest(admin, "/api/admin/donations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "approve" }),
      })
    )
  }

  async function bonus(userId: string): Promise<number> {
    const r = await env.DB.prepare(
      "SELECT invite_quota_bonus FROM users WHERE id = ?"
    )
      .bind(userId)
      .first<{ invite_quota_bonus: number }>()
    return r?.invite_quota_bonus ?? 0
  }

  it("同一订阅链接批准后再提交仍被拒（原先 proxy 分支完全没有去重）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await giveRealEmail(user.id)
    // 关掉自动审核，让单据停在 pending，避免依赖出站校验
    await setSetting("auto_review_features", "")

    const url = "https://sub.example.com/a?token=1"
    const first = await submitProxy(user, url)
    expect(first.status).toBe(201)
    const id1 = (await first.json<{ id: string }>()).id
    expect((await approve(admin, id1)).status).toBe(200)

    // ⚠️ 必须**批准之后**再提交，这样才测到真正的刷额度循环：
    // 第一笔已 approved，「同类型不能有 pending」那道闸门此时不生效，
    // 只剩资源级去重能拦住它。修复前这里会返回 201（又一轮奖励）。
    const again = await submitProxy(user, url)
    expect(again.status).toBe(409)
    expect((await again.json<{ code: string }>()).code).toBe("DUPLICATE_UPSTREAM")
  })

  it("换个 URL 但该模块已解锁时不再发第二份额度（否则邀请权可无限刷）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await giveRealEmail(user.id)
    await setSetting("auto_review_features", "")

    // 第一笔：全新模块 → 正常发额度
    const d1 = await submitProxy(user, "https://sub.example.com/one?x=1")
    expect(d1.status).toBe(201)
    const id1 = (await d1.json<{ id: string }>()).id
    expect((await approve(admin, id1)).status).toBe(200)
    const afterFirst = await bonus(user.id)
    expect(afterFirst).toBeGreaterThan(0)

    // 第二笔：换个 URL（URL 级去重拦不住，加个查询参数就是「新链接」），
    // 但 proxy 模块已经解锁过 → 按 H2 的修复不能再发第二份。
    const d2 = await submitProxy(user, "https://sub.example.com/two?x=2")
    expect(d2.status).toBe(201)
    const id2 = (await d2.json<{ id: string }>()).id
    expect((await approve(admin, id2)).status).toBe(200)

    // 关键断言：额度**没有**再涨。修复前这里会翻倍，循环提交即可无限刷邀请权。
    expect(await bonus(user.id)).toBe(afterFirst)
  })
})

describe("删除 permissions=NULL 的历史邀请码（L25）", () => {
  it("退还邀请码额度，但**一个模块额度都不退**（NULL 不等于「全开」）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()

    // 用户：1 个邀请码额度已占用，四个模块额度各已占用 1
    const used = { r2: 1, ai: 1, frp: 1, proxy: 1 }
    await env.DB.prepare(
      `UPDATE users
          SET invite_quota_used = 1,
              feature_quota = ?,
              feature_quota_used = ?
        WHERE id = ?`
    )
      .bind(JSON.stringify(used), JSON.stringify(used), user.id)
      .run()

    // 历史遗留行：permissions 为 NULL
    const codeId = uuid()
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, expires_at, created_at, permissions)
       VALUES (?, ?, ?, 1, 0, NULL, ?, NULL)`
    )
      .bind(codeId, "LEGACYNULL01", user.id, new Date().toISOString())
      .run()

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/invites/${codeId}`, { method: "DELETE" })
    )
    expect(res.status).toBe(204)

    const row = await env.DB.prepare(
      "SELECT invite_quota_used, feature_quota_used FROM users WHERE id = ?"
    )
      .bind(user.id)
      .first<{ invite_quota_used: number; feature_quota_used: string }>()

    // 那个码确实占了一个邀请码额度 → 退 1
    expect(row!.invite_quota_used).toBe(0)
    // 但模块额度必须原封不动：原先 parsePermissions(null) = 全开，会一次退掉 4 个
    expect(JSON.parse(row!.feature_quota_used)).toEqual(used)
  })
})
