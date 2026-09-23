-- 成就系统：访问统计 + 名片访客量
--
-- user_stats：按用户的累计统计，用于成就进度计算。
--   visit_count   登录/访问控制台的累计次数（节流：同一会话 1 小时内只计一次）
--   last_visit_at 上次计入的时间，用于节流判断
--
-- profiles.view_count：名片被访问的累计次数（公开页每次渲染 +1）。
--   名片已有 created_at（开通时间），注册时间取自 users.created_at。

CREATE TABLE IF NOT EXISTS user_stats (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  visit_count   INTEGER NOT NULL DEFAULT 0,
  last_visit_at TEXT
);

ALTER TABLE profiles ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
