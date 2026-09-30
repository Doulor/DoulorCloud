-- Doulor Mail D1 迁移：R2 直链网盘 + AI 中转站（NewAPI）
-- 在 0004 之上执行（保持幂等）。

-- 全局可配置项（管理面板可改，避免硬编码）
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('storage_quota_bytes', '1073741824', datetime('now')),  -- 默认 1 GiB
  ('storage_enabled',     '1',          datetime('now')),  -- 网盘功能总开关
  ('storage_max_file_bytes', '104857600', datetime('now')),-- 单文件上限 100 MiB
  ('newapi_enabled',      '1',          datetime('now')),  -- AI 中转站总开关
  ('newapi_trial_quota',  '500000',     datetime('now')),  -- 500000 quota = $1
  ('newapi_group',        'default',    datetime('now')),
  ('newapi_unlimited_quota', '0',       datetime('now'));  -- 1 = 新账号不限额度

-- 网盘账户（每个用户一条，prefix 即 R2 中的顶层目录名）
CREATE TABLE IF NOT EXISTS storage_accounts (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL UNIQUE,             -- R2 key 前缀 = 用户名
  quota_bytes  INTEGER NOT NULL,                 -- 开通时的配额快照
  used_bytes   INTEGER NOT NULL DEFAULT 0,       -- 记账用量（可由重算接口校正）
  file_count   INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 自定义直链前缀：某个二级域名 → R2 目录前缀
-- 例：blog.doulor.cn → blog，则 https://blog.doulor.cn/a.png 命中 network/blog/a.png
CREATE TABLE IF NOT EXISTS storage_prefixes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subdomain_id  TEXT NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  fqdn          TEXT NOT NULL UNIQUE,            -- blog.doulor.cn
  r2_prefix     TEXT NOT NULL,                   -- blog（通常等于 subdomain.name）
  hostname_id   TEXT,                            -- 预留：Cloudflare custom hostname id
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storage_prefixes_user ON storage_prefixes(user_id);
CREATE INDEX IF NOT EXISTS idx_storage_prefixes_fqdn ON storage_prefixes(fqdn);

-- 文件元数据（配额/列表以 R2 为准，此表用于快速展示与审计）
CREATE TABLE IF NOT EXISTS storage_objects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  content_type TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storage_objects_user ON storage_objects(user_id, created_at DESC);

-- AI 中转站：NewAPI 账号绑定
-- 只存加密后的 access token，绝不存用户明文密码
CREATE TABLE IF NOT EXISTS newapi_accounts (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  newapi_user_id  INTEGER NOT NULL,
  username        TEXT NOT NULL,                 -- NewAPI 侧用户名
  email           TEXT NOT NULL,                 -- <username>@doulor.cn
  enc_token       TEXT NOT NULL,                 -- AES-GCM 加密的 access token
  enc_password    TEXT,                          -- AES-GCM 加密的明文密码（token 失效时自动重登续期用；可空）
  group_name      TEXT,
  quota           INTEGER NOT NULL DEFAULT 0,
  used_quota      INTEGER NOT NULL DEFAULT 0,
  request_count   INTEGER NOT NULL DEFAULT 0,
  synced_at       TEXT,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_newapi_accounts_uid ON newapi_accounts(newapi_user_id);

-- AI 中转站：用户创建的 API Key（完整 key 只在创建时展示一次，不落库）
CREATE TABLE IF NOT EXISTS newapi_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  key_prefix  TEXT NOT NULL,                     -- NewAPI 返回的掩码，如 rUWC**********Vi7l
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_newapi_keys_user ON newapi_keys(user_id, created_at DESC);