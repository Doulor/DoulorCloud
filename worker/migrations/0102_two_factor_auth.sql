-- 二次认证（2FA）
--
-- 背景：管理员 / 站长的账号一旦口令泄露，等于整个后台易主。所以要求他们登录时
-- 除口令外**必须**再过一道验证（邮箱码 / TOTP / 恢复码）；普通用户在设置里可选。
--
-- ⚠️ 线上 `d1_migrations` 是空的，**不要跑 `wrangler d1 migrations apply`**，
-- 手工逐条执行（多语句用 --file 会报 D1_RESET_DO）：
--   npx wrangler d1 execute doulor-mail --remote --command "<每条 SQL>"

-- 1) 每个用户的 2FA 设置。没有行 = 什么都没配。
CREATE TABLE IF NOT EXISTS user_2fa (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- TOTP 密钥，存的是 AES-GCM 密文（v1:<iv>:<ct>，见 crypto.ts::encryptSecret），
  -- 密钥用 env.SESSION_SECRET。**绝不明文落库** —— 拿到库就等于拿到所有人的动态口令。
  totp_secret    TEXT,
  -- 扫码后必须再输一次动态码才算数，避免「扫了但没配对成功」被当成已开启
  totp_confirmed INTEGER NOT NULL DEFAULT 0,
  -- 邮箱验证码方式是否启用（收件地址取 users.email）
  email_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- 2) 恢复码（一次性）。手机丢了 / 认证器删了时的唯一自救手段。
--    只存 sha256，不存明文；用过就标 used_at，不能复用。
CREATE TABLE IF NOT EXISTS user_2fa_recovery (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);

-- 3) 登录挑战：**口令已通过、但二次验证还没过**的中间态。
--    关键：这个阶段绝不能建 session —— 否则 2FA 形同虚设。
CREATE TABLE IF NOT EXISTS login_challenges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 本挑战允许的验证方式，JSON 数组，如 ["email","totp","recovery"]
  methods    TEXT NOT NULL,
  -- 验证尝试次数；超过上限直接作废（防在线爆破动态码）
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- 发起挑战时的来源 IP，仅用于排查（审计用）
  ip         TEXT
);

-- 过期挑战会被定期清理，按 expires_at 找
CREATE INDEX IF NOT EXISTS idx_login_challenges_expires
  ON login_challenges(expires_at);

-- 4) 邮箱验证码。**与 `email_verify_codes` 分开**：那张表是「验证邮箱归属」，
--    这张是「登录时证明是本人」，语义不同、生命周期也不同（跟着挑战走，用完即删）。
CREATE TABLE IF NOT EXISTS login_email_codes (
  challenge_id TEXT PRIMARY KEY REFERENCES login_challenges(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
