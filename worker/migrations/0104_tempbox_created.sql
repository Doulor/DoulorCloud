-- 成就「分享即达」按「累计创建数」计算（2026-10-03 反馈 bug #1）。
--
-- 原因：tempbox_batches 里的批次过期会被惰性清理（purgeExpiredBatch）和定时任务
-- （maintenance）物理 DELETE，若成就按行数 COUNT，会随过期减少；又因为同时最多只能
-- 保留 TEMPBOX_MAX_LIVE_BATCHES 个未过期批次，行数永远到不了第三档「创建 20 个」。
-- 所以把「累计创建数」单独落到 user_stats，创建时 +1、永不清减。

ALTER TABLE user_stats ADD COLUMN tempbox_created INTEGER NOT NULL DEFAULT 0;

-- 回填存量：把当前仍存活的批次计入累计。已过期且已被清理的历史批次无法恢复，
-- 但至少从此刻起，计数不再随过期减少。
UPDATE user_stats SET tempbox_created = (
  SELECT COUNT(*) FROM tempbox_batches WHERE creator_user_id = user_stats.user_id
);
