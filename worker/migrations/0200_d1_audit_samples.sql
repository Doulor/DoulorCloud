-- 0200_d1_audit_samples.sql
-- D1 行读审计样本（2026-11-17，诊断用，默认关闭）
--
-- 背景：线上日均 D1 行读 1.57 亿，但 Cloudflare 的 GraphQL 只给到「按库/按天」，
-- 没有 query 级维度。这里由 Worker 内部按请求采样（1%），把「路由 + 查询数 +
-- 行读/行写 + 最贵一条 SQL」落下来，用于定位额度消耗的大头。
--
-- 保留期 7 天（maintenance.ts 清理）。采样开关见 settings.ts 的 d1_audit_enabled。
CREATE TABLE IF NOT EXISTS d1_audit_samples (
  id            TEXT PRIMARY KEY,
  /** 请求路径（如 /api/leaderboard；cron 不采样） */
  route         TEXT NOT NULL,
  method        TEXT NOT NULL,
  /** 该请求内的 D1 调用次数（含拿不到 meta 的 .first()） */
  queries       INTEGER NOT NULL DEFAULT 0,
  rows_read     INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  /** 该请求里行读最多的那条 SQL（规范化后截断 300 字符） */
  slow_sql      TEXT,
  slow_rows     INTEGER NOT NULL DEFAULT 0,
  /** SQL 指纹（FNV-1a），用于把同一条 SQL 聚起来 */
  sql_tag       TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_d1_audit_created ON d1_audit_samples(created_at);
CREATE INDEX IF NOT EXISTS idx_d1_audit_route ON d1_audit_samples(route, created_at);
CREATE INDEX IF NOT EXISTS idx_d1_audit_tag ON d1_audit_samples(sql_tag, created_at);
