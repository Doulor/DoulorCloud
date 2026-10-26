-- 小浣熊（Raccoon）账号捐献：一次性捐献码 + 入池记录
--
-- 为什么需要「码」：捐献者的书签脚本跑在 xiaohuanxiong.com 的上下文里，
-- 跨站带本站登录 cookie 会被 SameSite=Lax 拦掉，所以用一次性短效码做身份绑定。

CREATE TABLE IF NOT EXISTS raccoon_donate_codes (
  code        TEXT PRIMARY KEY,           -- 32 位十六进制随机串
  user_id     TEXT NOT NULL,              -- 归属用户（本站账号）
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,           -- 10 分钟有效
  used_at     INTEGER                     -- 用过即置位（一次性）
);

CREATE INDEX IF NOT EXISTS idx_raccoon_codes_user ON raccoon_donate_codes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS raccoon_donations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  account_id       TEXT,                  -- Agent2API 侧的账号 id
  account_name     TEXT,
  token_expires_at INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raccoon_donations_user ON raccoon_donations(user_id, created_at DESC);
