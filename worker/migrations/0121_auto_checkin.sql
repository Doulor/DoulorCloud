-- 0121_auto_checkin.sql
--
-- 自动签到（2026-10-05 站长要求）：
--   用户在签到弹窗里打开「自动签到」后，每天进站会自动签一次，
--   右下角弹窗提示获得的积分（含里程碑额外奖励）。
--
-- 开关挂在 users 上（与 checkin_makeup_cards 同类）。
-- ⚠️ 线上 D1 由站长手动执行（本项目从不跑 migrations apply）。

ALTER TABLE users ADD COLUMN auto_checkin INTEGER NOT NULL DEFAULT 0;
