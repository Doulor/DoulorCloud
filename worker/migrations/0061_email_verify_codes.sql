-- 0061_email_verify_codes.sql
-- 真实邮箱验证：从「Cloudflare destination 验证」改为「自研 6 位验证码」。
--
-- 为什么改：
--   1. CF destination 每账户上限 200，注册即建 destination 会堆积僵尸（已踩坑），
--      验证靠「用户点 CF 邮件里的确认链接」也导致大量 pending 浪费配额。
--   2. 现在有自建 Posthorn / 第三方 Brevo 发信通道，可以直接把验证码发到任意邮箱，
--      不再需要 CF 的 destination 验证信。
--   3. destination 验证是「账户级」的（账户里某邮箱 verified 就谁都算已验证），
--      有身份伪造隐患；验证码归属到具体 user_id，彻底消除这个洞。
--
-- 流程：POST /api/settings/email/verify 生成 6 位码 + sendMail 发出 →
--        POST .../verify {action:"confirm", code} 回填校验 → 通过置 email_verified=1。
--
-- 安全：验证码只存 sha256、10 分钟过期、同一用户重新发起即覆盖旧码、最多 5 次尝试。

CREATE TABLE IF NOT EXISTS email_verify_codes (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,               -- sha256(6 位验证码明文)
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
