-- 每日签到
--
-- ⚠️ 线上 `d1_migrations` 是空的，**不要跑 `wrangler d1 migrations apply`**，
-- 逐条手工执行（多语句用 --file 会报 D1_RESET_DO）：
--   npx wrangler d1 execute doulor-mail --remote --command "<每条 SQL>"

CREATE TABLE IF NOT EXISTS daily_checkins (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 签到日期。**按站点时区（UTC+8）的日历日**，不是 UTC 日期 ——
  -- 否则中国用户晚上 8 点之后签到会被算成「第二天」，跨零点就乱了。
  checkin_date TEXT NOT NULL,
  -- 本次实际发放的积分合计（基础 + 里程碑）
  points       INTEGER NOT NULL,
  -- 基础奖励部分
  base_points  INTEGER NOT NULL,
  -- 里程碑奖励部分（没命中为 0）
  bonus_points INTEGER NOT NULL,
  -- 这次签到后的连续天数，便于直接展示与排查
  streak       INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  -- 主键即「一人一天一条」，天然防止重复签到（并发下也只会成功一条）
  PRIMARY KEY (user_id, checkin_date)
);

-- 算「连续多少天」要按日期倒序取最近一条，走这个索引
CREATE INDEX IF NOT EXISTS idx_daily_checkins_user
  ON daily_checkins(user_id, checkin_date DESC);
