-- 0116_temp_mailbox_refresh_daily.sql
-- 临时邮箱「每天最多刷新次数」的每日计数器。
--
-- 背景（2026-10-04 站长要求）：
--   临时邮箱（收件邮箱，非「临时分享箱」）可随时刷新换地址，旧地址立即作废。
--   之前只有「每小时 60 次」的滑动窗口限流，没有按天的总量闸 —— 有人拿它刷一堆
--   一次性地址去注册第三方账号（当注册机邮箱）。加一个每日上限，默认 20，后台可配。
--
-- 计数键 = (user_id, date)，date 是站点时区（UTC+8）的 YYYY-MM-DD，
-- 与签到 daily_checkins 的 checkin_date、API 限额 api_usage_account 的 date 同口径。
-- 用 RETURNING 原子累加（线上 D1 实测支持），「本次计入之后的计数」直接判断是否超限。

CREATE TABLE IF NOT EXISTS temp_mailbox_refresh_daily (
  user_id TEXT NOT NULL,
  date    TEXT NOT NULL,               -- 站点时区 YYYY-MM-DD
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
