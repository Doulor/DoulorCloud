-- AutoClaw（国内版）捐献通道（2026-10-27）
--
-- 与小浣熊完全同一套模型：一次性捐献码 + 书签取登录态 → claim → 入池网关 → Agent2API。
-- 表结构照抄 raccoon_donate_codes / raccoon_donations（含 0183 加的健康状态列），
-- 这样健康巡检、额度计算等逻辑可以原样复用。

CREATE TABLE IF NOT EXISTS autoclaw_donate_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_autoclaw_codes_user ON autoclaw_donate_codes(user_id, created_at);

CREATE TABLE IF NOT EXISTS autoclaw_donations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT,
  account_name TEXT,
  token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_checked_at INTEGER,
  invalid_at INTEGER,
  invalid_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_autoclaw_donations_user ON autoclaw_donations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_autoclaw_donations_status ON autoclaw_donations(status, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_autoclaw_donations_account ON autoclaw_donations(account_id);
