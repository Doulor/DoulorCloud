-- 0110_admin_notices.sql
-- 管理端「通知」：站长给单个/多个用户发通知，可要求强制已读，
-- 并可选择「确认收到前禁用某些模块权限（如 AI 中转站，同步禁用 NewAPI 账户）」。
-- 用户确认收到后，自动还原权限 + 重新启用 NewAPI。

CREATE TABLE IF NOT EXISTS admin_notices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  -- 是否要求强制已读（关不掉的弹窗）；0 = 仅站内提醒
  require_ack  INTEGER NOT NULL DEFAULT 1,
  -- 确认前要禁用的模块（JSON 数组，如 ["ai"]）；NULL = 不禁用任何权限
  restrict_features TEXT,
  -- 禁用前该用户 permissions 列的原始快照（可能是 NULL=全开）；确认后精确还原
  restore_permissions TEXT,
  -- 本通知是否把该用户的 NewAPI 账户禁用了（确认后要 enable 回来）
  newapi_disabled INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  read_at      TEXT,   -- 用户确认收到的时间；NULL = 未确认
  revoked_at   TEXT    -- 管理员撤回时间；非空 = 已撤回（自动还原）
);

CREATE INDEX IF NOT EXISTS idx_admin_notices_user ON admin_notices(user_id, read_at);
