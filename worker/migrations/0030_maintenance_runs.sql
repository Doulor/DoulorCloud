-- 0030_maintenance_runs.sql
-- 定时运维任务的运行记录（见 worker/src/maintenance.ts）。
--
-- 用途有二：
--   1. 排查"cron 到底还在不在跑" —— 没有记录表时，定时任务静默失效是发现不了的；
--   2. 对比两次运行的大表行数，观察增长趋势（D1 免费额度按**行读**计费，
--      真正会打满额度的是 messages / audit_logs / notifications 这些大表）。
--
-- 规模：主任务每次运行写 1 行，并自动裁剪只保留最近 100 行（见 MAINTAIN_RUN_KEEP），
--       不会变成一张新的"只增不减"的表。

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id        TEXT PRIMARY KEY,
  ran_at    TEXT NOT NULL,
  deep      INTEGER NOT NULL DEFAULT 0,
  -- 本次统计结果的 JSON（各表行数、清理条数等）
  stats     TEXT,
  -- 告警文本数组的 JSON；NULL = 本次无告警
  warnings  TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_ran_at ON maintenance_runs(ran_at DESC);
