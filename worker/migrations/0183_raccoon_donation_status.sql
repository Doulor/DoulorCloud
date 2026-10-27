-- 小浣熊捐献账号健康状态（2026-10-27）
--
-- 站长要求：号池里某个捐献账号被封 → 该账号带来的每日额度自动收回，
-- 并在站内提醒捐献者「重新登录 / 重新捐献后额度自动恢复」。
--
-- 判定来源：hk2 入池网关的 GET /_donate/status（它拿着面板凭据去问 Agent2API
-- 每个账号的 available）。Worker 定时拉一次，把结果落到这张表的 status 上；
-- group-sync 算额度时只认 status='active'，于是封号下一轮就自动不给额度。

ALTER TABLE raccoon_donations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE raccoon_donations ADD COLUMN last_checked_at INTEGER;
ALTER TABLE raccoon_donations ADD COLUMN invalid_at INTEGER;
ALTER TABLE raccoon_donations ADD COLUMN invalid_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_raccoon_donations_status ON raccoon_donations(status, user_id);
