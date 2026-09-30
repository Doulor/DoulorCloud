import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeEach } from "vitest"

// Apply baseline schema.sql first (contains users, sessions, etc. that
// migrations 0002+ depend on but don't re-create). The statements were
// pre-split in vitest.config.ts using wrangler's unstable_splitSqlQuery.
for (const stmt of env.TEST_SCHEMA_STATEMENTS) {
  await env.DB.prepare(stmt).run()
}

// migration 0002 references email_aliases (a table that existed in the
// original pre-migration baseline but was dropped by 0002 itself and is
// absent from the current schema.sql). Create an empty placeholder so the
// migration's UPDATE/DROP don't error.
await env.DB.prepare(
  "CREATE TABLE IF NOT EXISTS email_aliases (id TEXT, user_id TEXT, forwarding_to TEXT, created_at TEXT)"
).run()

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

/**
 * 每个用例前清空全局设置（2026-09-25 审计 M24）。
 *
 * 为什么必须在这里做：
 *   `app_settings` 是**全局**状态，而同一个测试文件里的所有用例共享同一个 D1。
 *   于是「某个用例把社区关掉」会污染后面的用例 —— 表现为随机红，且失败信息
 *   指向一个看起来毫不相干的断言（本次修复中就真实踩到过：
 *   `audit-2026-09-25.test.ts` 的「关闭社区」用例把后面的发帖用例全打成了 403）。
 *   此前每个文件各自用 `beforeEach` 手工清理自己涉及的键
 *   （如 `open-features.test.ts:12-16`），漏一个就复发。
 *
 * 为什么是「清空」而不是「写回默认值」：
 *   `getSetting()` 在行不存在时会回落到 `SETTING_DEFAULTS`，
 *   所以删行 = 恢复出厂默认，不需要在这里维护第二份默认值副本
 *   （两份默认值一定会漂移）。
 *
 * 为什么安全：setup file 里注册的 hook 先于测试文件自身的 hook 执行，
 *   所以各文件自己 `beforeEach` 里设的开关不会被这里覆盖；
 *   全仓测试也没有任何 `beforeAll` 或模块级 `setSetting`
 *   （这两者才会被本 hook 误伤）。
 *
 * 局限：本 hook 只处理全局设置这一类污染源。其它表（users / posts / …）
 *   的隔离靠各用例自己按 id 限定查询范围 —— 那是另一件事，不在这里兜。
 */
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM app_settings").run()
})
