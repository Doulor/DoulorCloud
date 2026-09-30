-- 0059_password_reset.sql
-- 找回密码：用户忘记密码时，通过已验证/注册邮箱自助重置。
--
-- 流程：
--   1) POST /api/auth/password/forgot  { email }
--       生成一次性 token，发邮件（含重置链接），DB 只存 sha256(token)。
--   2) 用户点链接 → 前端 /reset-password?token=xxx → 输入新密码
--   3) POST /api/auth/password/reset  { token, password }
--       校验 token（存在 + 未过期 + 未使用）→ 重置密码 → 标记已用 → 撤销全部会话。
--
-- 安全要点：
--   · token 只在 DB 存哈希（sha256），DB 泄露后无法直接拿明文 token 重置他人密码。
--   · token 一次性、15 分钟过期。
--   · forgot 接口对「邮箱是否存在」不做区分（防账号枚举）。
--   · 重置成功后撤销该用户全部会话，强制重新登录。

CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,               -- sha256(token 明文)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, used, expires_at);
