-- 0063_forwarding_verifications.sql
-- 邮箱转发目标：从「必须是系统内已验证用户邮箱」改为「任意邮箱 + 验证码验证」。
--
-- 背景：转发以前用 Cloudflare 的 message.forward()，它只能转发到「账户内已验证的
-- destination」，所以转发目标被限制成「某个 email_verified=1 的用户邮箱」——
-- 用户只能转发到自己的（或别人已验证的）账号邮箱，不能随便绑一个朋友的邮箱。
--
-- 现在转发改用多通道发信（sendMail，可发任意邮箱），转发目标改为独立的验证码验证：
--   1. 用户在邮箱设置里输入任意目标邮箱 → 发验证码到该邮箱
--   2. 回填验证码 → 验证通过，目标邮箱记入 forwarding_verifications
--   3. 该邮箱即可被绑定为转发目标（同一用户下次再绑同邮箱无需重复验证）

-- 已验证的转发目标（按用户维度，验证一次可复用）
CREATE TABLE IF NOT EXISTS forwarding_verifications (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_email TEXT NOT NULL,
  verified_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, target_email)
);

-- 转发目标的验证码（发起验证时写入，确认后删除；同一邮箱重新发起即覆盖）
CREATE TABLE IF NOT EXISTS forward_verify_codes (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_email TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, target_email)
);
