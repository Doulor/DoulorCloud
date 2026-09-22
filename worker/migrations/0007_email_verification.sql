-- Doulor Cloud D1 迁移：真实邮箱验证 + 用户名/邮箱可改
-- 在 0006 之上执行（保持幂等）。

-- users.email 语义调整：
--   它仍然是「注册邮箱」，但**不再等同于已验证的转发目标**。
--   只有用户在「设置」里走完验证流程（Cloudflare 向其发送验证邮件并点击确认）
--   之后，该地址才能被选作邮箱转发目标、并接收站内通知。
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1;
-- 记录最近一次验证请求时间，用于节流（避免反复触发 Cloudflare 验证邮件）
ALTER TABLE users ADD COLUMN email_verify_requested_at TEXT;

-- 用户名修改记录（用于审计与排查"网盘目录丢了"之类的困惑）
CREATE TABLE IF NOT EXISTS username_changes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_username TEXT NOT NULL,
  new_username TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_changes_user ON username_changes(user_id, created_at DESC);