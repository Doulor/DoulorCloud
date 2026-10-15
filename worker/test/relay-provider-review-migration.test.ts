/**
 * 迁移 `0162_relay_provider_review.sql` 的**存量数据**处理（2026-10-16 审核制）。
 *
 * 为什么单独一个文件、而且要动表结构：
 *   这次迁移里最容易出事的不是新代码，而是**已经在库里的行**。SQLite 的
 *   `ADD COLUMN ... NOT NULL DEFAULT 'pending'` 会把默认值也写到存量行上 ——
 *   线上现有 3 条会在一瞬间从「已生效」变成「待审核」，对登记人就是
 *   「我登记过的站突然不见了」，站长还得手工点三次审批。迁移里那句
 *   `UPDATE relay_providers SET review_status = 'approved'` 就是防这个回归的。
 *
 * 验证方式（真的是**执行迁移文件里的语句**，不是照着抄一遍）：
 *   语句直接取自 `env.TEST_MIGRATIONS`（vitest 配置用 readD1Migrations 读的
 *   就是 migrations/ 目录），所以这里跑的就是站长手工执行的那份 SQL。
 *   为了造出「迁移之前」的库，先把 0162 新增的列与索引从测试库里拆掉
 *   （DROP → 表回到 0131 的形状），再插 3 条存量行，然后跑迁移。
 *
 * ⚠️ 本文件会临时改 relay_providers 的形状，所以**只放这一个用例**，
 *   且必须跑在独立文件里（vitest-pool-workers 每个测试文件一份隔离存储）。
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"

/** 0162 给 relay_providers 加的四列（顺序无关，DROP 时要全拆掉） */
const REVIEW_COLUMNS = ["review_status", "review_note", "reviewed_at", "reviewed_by"]

describe("迁移 0162：中转站审核制", () => {
  it("存量数据全部变成 approved（且新登记的默认值仍是 pending）", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) =>
      m.name.includes("relay_provider_review")
    )
    expect(
      migration,
      "找不到 0162 迁移 —— 文件名变了？本用例按名字前缀去找它"
    ).toBeTruthy()

    // ---- 1) 把表还原成「迁移之前」（0131）的样子 ----
    await env.DB.prepare("DROP INDEX IF EXISTS idx_relay_providers_review").run()
    for (const col of REVIEW_COLUMNS) {
      await env.DB.prepare(`ALTER TABLE relay_providers DROP COLUMN ${col}`).run()
    }

    // ---- 2) 造 3 条存量行（与线上那 3 条同形：那时候还没有审核列）----
    const now = new Date().toISOString()
    for (let i = 1; i <= 3; i++) {
      await env.DB.prepare(
        `INSERT INTO relay_providers
           (id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, created_at, updated_at)
         VALUES (?, ?, 'newapi', ?, 'legacy-enc', 'legacy-owner', 1, 100, ?, ?)`
      )
        .bind(`rp_legacy_${i}`, `存量站 ${i}`, `https://legacy${i}.example.com`, now, now)
        .run()
    }

    // ---- 3) 执行迁移文件里的每一条语句（与站长手工执行的是同一份文本）----
    for (const statement of migration!.queries) {
      await env.DB.prepare(statement).run()
    }

    // ---- 4) 存量行必须是 approved，且不编造审核时间 ----
    const legacy = await env.DB.prepare(
      `SELECT review_status, reviewed_at FROM relay_providers
        WHERE id LIKE 'rp_legacy_%' ORDER BY id`
    ).all<{ review_status: string; reviewed_at: string | null }>()
    expect(legacy.results).toHaveLength(3)
    for (const row of legacy.results) {
      expect(row.review_status).toBe("approved")
      // 审核制之前登记的没有审核记录；编一个假时间会让管理端显示误导信息
      expect(row.reviewed_at).toBeNull()
    }

    // ---- 5) 迁移之后的新行默认仍是 pending（fail-closed 的默认值没被写坏）----
    await env.DB.prepare(
      `INSERT INTO relay_providers
         (id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, created_at, updated_at)
       VALUES ('rp_after_migration', '迁移后的新站', 'newapi', 'https://after.example.com', 'enc',
               'owner', 1, 100, ?, ?)`
    )
      .bind(now, now)
      .run()
    const fresh = await env.DB.prepare(
      "SELECT review_status FROM relay_providers WHERE id = 'rp_after_migration'"
    ).first<{ review_status: string }>()
    expect(fresh?.review_status).toBe("pending")

    // ---- 6) 索引也建起来了（管理端按审核态筛、用户侧按审核态过滤都要它）----
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'relay_providers'"
    ).all<{ name: string }>()
    expect(indexes.results.map((r) => r.name)).toContain("idx_relay_providers_review")
  })
})
