-- 0115_email_change_codes.sql
-- 修改真实邮箱：从「Cloudflare destination 账户级验证」改为「用户专属验证码」。
--
-- 为什么改（2026-10-04 审计）：
--   changeRealEmail 原先调用 cfEnsureDestination + destinationStatus，采信
--   Cloudflare Email Routing 的 `verified`。那是**账户级**状态 —— 它只说明
--   「本账户里这个地址验证过」，不说明「当前这个用户能收这个地址的邮件」。
--   于是账户里历史遗留（或别人验证过）的已验证地址会被当成「已验证」，
--   把用户的 email_verified 置 1 —— 而该用户从未能读取那个邮箱。
--   这与 0061 修掉的「验证真实邮箱」是同一个洞，只是发生在「改邮箱」路径上。
--
-- 现在改为：把 6 位验证码发到**目标邮箱**，用户回填校验通过后才落库。
--   验证归属到具体 user_id，彻底去掉对账户级状态的依赖。
--
-- 安全：验证码只存 sha256、10 分钟过期、同一用户重新发起即覆盖旧码、最多 5 次尝试；
--       并绑定待更换的 email，避免「对 A 取码、拿 B 来换」。
-- 单表按 user_id 主键：一个用户同一时刻只可能有一次待确认的改邮箱请求。
-- 与 email_verify_codes（当前邮箱验证）、account_delete_codes（注销）分表，互不覆盖。

CREATE TABLE IF NOT EXISTS email_change_codes (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,               -- 待确认的新邮箱（小写）
  code_hash  TEXT NOT NULL,               -- sha256(6 位验证码明文)
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
