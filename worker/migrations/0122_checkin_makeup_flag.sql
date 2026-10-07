-- 0122_checkin_makeup_flag.sql
--
-- 签到日历（2026-10-05 站长要求）：
--   每日签到加日历视图，补签的日期要着重标出来、漏签日期可点选补签。
--   补签记录需要能区别于正常签到，故加一列标记。
--
-- ⚠️ 线上 D1 由站长手动执行（本项目从不跑 migrations apply）。

ALTER TABLE daily_checkins ADD COLUMN is_makeup INTEGER NOT NULL DEFAULT 0;
