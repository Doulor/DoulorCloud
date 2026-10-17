-- 活动领取记录支持「一个人多笔奖励」（满分额外奖励）。
--
-- 背景：event_claims 原来是「一人一条」（唯一索引 (event_id,user_id)）。
-- 但问卷的档位允许**同一门槛配多档**（例如 ≥100% 同时给"额度 3000"和"积分 500"），
-- 满分时要两份一起发 ⇒ 一人一条装不下。
--
-- 改法：加 seq（第几笔），唯一索引变成 (event_id,user_id,seq)。
-- ⚠️ 旧的流程（领取活动、投票、抽奖）一律写 seq=0，唯一性行为与以前**完全一致**，
--    所以这次改动对它们没有任何影响。
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0155_event_claims_seq.sql

ALTER TABLE event_claims ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_event_claims_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_claims_unique
  ON event_claims(event_id, user_id, seq);
