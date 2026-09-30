-- 0060_achievement_rewards.sql
-- 成就奖励：用户成就点每满 N 点（默认 10），发放一份 NewAPI「成就奖励」订阅。
--
-- 为什么需要一张表：
--   成就点是**实时计算**的（每次请求按当前数据算，见 handlers/achievements.ts），
--   本身不落库。若不记录「已发放到第几档」，每次看成就页都会重复发订阅。
--   本表按 user_id 记录已发放的份数（tier），每满 N 点补发差额。
--
-- 触发时机：GET /api/achievements（用户查看成就页）时检查并补发。

CREATE TABLE IF NOT EXISTS achievement_rewards (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 已发放的份数（第 1 份 = 满 10 点，第 2 份 = 满 20 点，以此类推）
  granted_tiers INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
