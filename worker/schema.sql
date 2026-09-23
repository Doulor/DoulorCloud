-- Doulor Mail D1 Schema
-- 所有时间戳使用 ISO 8601 字符串，id 使用 UUID（Worker 端生成）。

PRAGMA foreign_keys = ON;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  namespace   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status      TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 会话表（token 存哈希，原 token 仅通过 HttpOnly Cookie 返回）
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 邀请码表
CREATE TABLE IF NOT EXISTS invite_codes (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,
  created_at  TEXT NOT NULL
);

-- 域名表（当前每个用户一个命名空间域名）
CREATE TABLE IF NOT EXISTS domains (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL UNIQUE,                -- e.g. ruben.doulor.cn
  zone_id     TEXT,                                -- Cloudflare zone id
  status      TEXT NOT NULL DEFAULT 'active',      -- active | pending | suspended
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domains_user ON domains(user_id);

-- DNS 记录表
CREATE TABLE IF NOT EXISTS dns_records (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  cf_id       TEXT,                                -- Cloudflare DNS record id
  name        TEXT NOT NULL,                       -- e.g. blog（相对前缀）
  fqdn        TEXT NOT NULL,                       -- blog.ruben.doulor.cn
  type        TEXT NOT NULL,                       -- A | AAAA | CNAME | TXT | MX
  content     TEXT NOT NULL,
  ttl         INTEGER NOT NULL DEFAULT 1,
  proxied     INTEGER NOT NULL DEFAULT 0,
  priority    INTEGER,                             -- 仅 MX
  status      TEXT NOT NULL DEFAULT 'pending',     -- active | pending | error
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dns_domain ON dns_records(domain_id);
CREATE INDEX IF NOT EXISTS idx_dns_fqdn ON dns_records(fqdn);

-- 邮箱表（每用户最多 3 个收件箱）
CREATE TABLE IF NOT EXISTS mailboxes (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address          TEXT NOT NULL UNIQUE,              -- ruben@doulor.cn
  forwarding_to    TEXT,                              -- JSON 数组：真实邮箱转发目标（可空=不转发）
  last_forwarded_at TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_user ON mailboxes(user_id);

-- 邮件消息表（D1 网页收件箱）
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  from_address TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  text_body    TEXT NOT NULL DEFAULT '',
  read         INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id, received_at DESC);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- ============================================================
-- 以下为 0005 迁移新增：R2 直链网盘 + AI 中转站（NewAPI）
-- ============================================================

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
CREATE TABLE IF NOT EXISTS storage_prefixes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subdomain_id  TEXT NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  fqdn          TEXT NOT NULL UNIQUE,            -- blog.doulor.cn
  r2_prefix     TEXT NOT NULL,                   -- blog
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

-- AI 中转站：管理员凭据（可在管理面板在线更新，优先于 Worker Secret）
-- NewAPI 的「系统访问令牌」随时可能被后台轮换，一旦失效则所有管理员级调用
-- （建号 / 查账号 / 设额度 / 健康检查）全部 401，只能重跑 wrangler secret put。
-- 单行表（id 恒为 1）；令牌用 SESSION_SECRET 派生的 AES-GCM 加密存储，明文不落库。
-- 本表无行时回落到 env.NEWAPI_ADMIN_TOKEN / NEWAPI_ADMIN_USER_ID（故不影响既有部署）。
CREATE TABLE IF NOT EXISTS newapi_admin_credentials (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  enc_token     TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
