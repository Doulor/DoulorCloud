-- 0117_event_github_username_global.sql
-- GitHub star 活动：把「用户名占用」从「按活动唯一」升级为「全局唯一」。
--
-- 背景（2026-10-04 站长要求）：
--   0090 的 event_github_claims 主键是 (event_id, github_username) —— 同一个 GitHub
--   用户名在**不同活动**里可以各占一次。而 star 名单是公开的，谁都能抄别人的名字，
--   于是「一个名字」理论上能跨多个 github_star 活动反复冒领。
--   站长要求：**单个 GitHub 用户名只能提交一次**（全局一次性）。
--
-- 做法：不动表结构（避免重建表的风险），只加一个 **全局唯一索引** ——
--   一旦某个 github_username 被写过一行，任何活动、任何账号都无法再占用它。
--   现有 133 行即「已领取」集合，全部保留，不加锁、不清洗。
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0117_event_github_username_global.sql

-- 1) 防御性去重：万一历史数据里同名跨活动重复，先只保留最早的一条
--    （否则下一步的 UNIQUE 索引会建失败）。线上实测 133 行、133 个唯一名，不会删到东西。
DELETE FROM event_github_claims
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM event_github_claims GROUP BY github_username
 );

-- 2) 全局唯一索引：github_username 从此全站一次性
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_github_username_global
  ON event_github_claims(github_username);
