-- 注销/删除用户留痕 + 注销验证码。
--
-- 背景：原先自助注销与管理员删号都是直接 `DELETE FROM users` —— 账号「人间蒸发」，
-- 管理端事后既看不到「谁注销了」，也无法判断某个用户名是否曾被占用。
-- 本次改为：删除前先往 deleted_users 写一条**最小证据**（不保留密码/内容等敏感数据），
-- 供管理端用户列表以「已注销用户」展示与追溯。
--
-- 注意：users 行仍按原逻辑硬删（用户名/邮箱因此可被重新注册），本表只作历史留痕，
-- 不参与任何鉴权/查询主链路 —— 这样对既有逻辑零影响、零风险。
CREATE TABLE IF NOT EXISTS deleted_users (
  id          TEXT PRIMARY KEY,   -- 原 users.id（便于与 audit_logs 对照）
  uid         INTEGER,            -- 原展示编号（users.uid，老数据可能为 NULL）
  username    TEXT NOT NULL,
  email       TEXT NOT NULL,
  namespace   TEXT,
  role        TEXT,
  reason      TEXT NOT NULL,      -- 'self' 自助注销 | 'admin' 管理员删除
  deleted_by  TEXT,               -- 操作者 user id（自助=本人；管理员删=管理员 id）
  created_at  TEXT,               -- 原注册时间
  deleted_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleted_users_username ON deleted_users(username);
CREATE INDEX IF NOT EXISTS idx_deleted_users_deleted_at ON deleted_users(deleted_at);

-- 注销验证码：注销是高危不可逆操作，除密码外再要求一次「邮箱验证码」证明本人。
-- 与 email_verify_codes 分表，避免同一 user_id 在两套流程间互相覆盖。
CREATE TABLE IF NOT EXISTS account_delete_codes (
  user_id     TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
