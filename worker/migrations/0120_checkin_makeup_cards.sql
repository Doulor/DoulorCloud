-- 0120_checkin_makeup_cards.sql
--
-- 补签卡（2026-10-05 站长要求）：
--   商城新增一种交付方式 `checkin_makeup`，购买后给用户累计补签卡数量；
--   签到页可消耗一张补签一次「昨天」的漏签（只补连续天数，不发积分）。
--
-- 余额挂在 users 上（与 invite_quota_bonus 同类：一次性消耗品、可叠加多张）。
-- ⚠️ 线上 D1 由站长手动执行（本项目从不跑 migrations apply）。

ALTER TABLE users ADD COLUMN checkin_makeup_cards INTEGER NOT NULL DEFAULT 0;
