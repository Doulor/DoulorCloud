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
  type        TEXT NOT NULL,                       -- A | AAAA | CNAME | TXT | MX | SRV
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
-- 未读数统计按 (mailbox_id, read) 过滤，单独建索引避免回表（见 0031 迁移）
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_read ON messages(mailbox_id, read);

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
  -- 加密的明文密码：缓存 token 失效时用它自动重登续期（可空）
  -- ⚠️ 2026-09-30 补齐：本文件是**基线**建表语句，先于 migrations 执行，
  --    而 migrations/0005 用的是 `CREATE TABLE IF NOT EXISTS` ⇒ 这里少一列，
  --    测试库里就永远没这一列（线上是有的），表现为
  --    「table newapi_accounts has no column named enc_password」。
  --    以后改这里的表结构，务必同步改 migrations/0005_storage_ai.sql。
  enc_password    TEXT,
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

-- ============ WorkBuddy 反代网关捐献（登录即解锁 AI 权限）============
-- 用户登录自己的 WorkBuddy 国际版账号 → 账号进入网关共享池 → 自动解锁 ai 权限。
-- 免管理员审核，故不走 donations 的「提交 → pending → 审核」流程，单独建表。
-- 详见 worker/migrations/0034_wb2api.sql 的说明；此处供全新安装使用。

-- 绑定关系：谁捐了哪个 WorkBuddy 账号
CREATE TABLE IF NOT EXISTS wb2api_bindings (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid                   TEXT NOT NULL,
  nickname              TEXT,
  realm                 TEXT NOT NULL DEFAULT 'global',
  status                TEXT NOT NULL DEFAULT 'active',   -- active | removed
  granted_ai_permission INTEGER NOT NULL DEFAULT 0,
  acknowledged_ip       TEXT,
  created_at            TEXT NOT NULL,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL
);
-- 同一 WorkBuddy 账号只能被绑一次（重复登录走幂等，跨用户抢注则拒绝）
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb2api_bindings_uid ON wb2api_bindings(uid);
CREATE INDEX IF NOT EXISTS idx_wb2api_bindings_user ON wb2api_bindings(user_id, status);

-- 登录会话：本站自己的 session_id 下发前端，网关 state 只存服务端；
-- 同时缓存 done/failed 终态（网关 poll 成功后 state 即失效，重复 poll 只会 404）。
CREATE TABLE IF NOT EXISTS wb2api_login_sessions (
  id             TEXT PRIMARY KEY,   -- sha256(session_id 明文)
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_state TEXT NOT NULL,
  realm          TEXT NOT NULL DEFAULT 'global',
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  result_json    TEXT,
  message        TEXT,
  acknowledged_ip TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wb2api_sessions_expires ON wb2api_login_sessions(expires_at);

-- 网关 api_key（面板可在线更新；单行表，无行时回落 env.WB2API_API_KEY）
CREATE TABLE IF NOT EXISTS wb2api_credentials (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enc_api_key TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ============ CLI2API 反代绑定通道（⚠️ 已弃用，仅保留历史数据）============
-- 2026-10-09 起本站改用 Qoder2API-Hub（见下方 qoder2api_* 段），本通道代码已删除。
-- 这三张表**刻意保留不删**：老的捐献记录还在里面，删了就查不到「谁曾经捐过」。
-- 详见 worker/migrations/0058_cli2api.sql。

-- 绑定关系：谁贡献了哪个 cli2api 账号
CREATE TABLE IF NOT EXISTS cli2api_bindings (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id            TEXT NOT NULL,
  provider              TEXT NOT NULL,
  region                TEXT NOT NULL,
  nickname              TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  granted_ai_permission INTEGER NOT NULL DEFAULT 0,
  acknowledged_ip       TEXT,
  created_at            TEXT NOT NULL,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cli2api_bindings_account ON cli2api_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_cli2api_bindings_user ON cli2api_bindings(user_id, status);

-- 登录会话：account_id 也要记，会话过期/失败时得把那个空账号删掉
CREATE TABLE IF NOT EXISTS cli2api_login_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  region          TEXT NOT NULL,
  auth_url        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  message         TEXT,
  acknowledged_ip TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cli2api_sessions_expires ON cli2api_login_sessions(expires_at);

-- console key（= 该实例的管理员密钥，不是客户端 key），加密落库
CREATE TABLE IF NOT EXISTS cli2api_credentials (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  enc_console_key TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ============ Qoder2API-Hub 反代绑定通道（当前在用，替代上面的 cli2api）============
-- 用户登录自己的 Qoder 账号 → 账号进入 qoder2api-hub 共享池 → 自动解锁「AI 中转站」权限。
-- 免管理员审核，单独建表。详见 worker/migrations/0138_qoder2api.sql。

-- 绑定关系：谁捐献了哪个 Qoder 账号
CREATE TABLE IF NOT EXISTS qoder2api_bindings (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id            TEXT NOT NULL,
  realm                 TEXT NOT NULL,   -- cn（qoder.com.cn）/ intl（qoder.com）
  nickname              TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  granted_ai_permission INTEGER NOT NULL DEFAULT 0,
  acknowledged_ip       TEXT,
  created_at            TEXT NOT NULL,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_qoder2api_bindings_account ON qoder2api_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_qoder2api_bindings_user ON qoder2api_bindings(user_id, status);

-- 登录会话：存**上游 state**（绝不下发前端），不存账号 id（账号由上游在授权成功时才入池）
CREATE TABLE IF NOT EXISTS qoder2api_login_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_state  TEXT NOT NULL,
  realm           TEXT NOT NULL,
  auth_url        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  message         TEXT,
  acknowledged_ip TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qoder2api_sessions_expires ON qoder2api_login_sessions(expires_at);

-- 面板密码（= 该实例的管理员凭据，不是客户端 key），加密落库
CREATE TABLE IF NOT EXISTS qoder2api_credentials (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  enc_panel_password TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- ============ OAuth 2.0 授权服务器（Doulor Cloud 作为身份提供方）============
-- 让自有站点（NewAPI 等）通过 Doulor Cloud 账号登录。
-- ⚠️ 方向：别的站点来接我们，不是我们接别人。
-- 详见 worker/migrations/0033_oauth_provider.sql 的说明与
-- docs/新功能-对外开放OAuth登录(身份提供方).md。
-- 与迁移文件保持一致；此处供全新安装使用。

CREATE TABLE IF NOT EXISTS oauth_clients (
  id                 TEXT PRIMARY KEY,
  client_id          TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  name               TEXT NOT NULL,
  redirect_uris      TEXT NOT NULL,
  scopes             TEXT NOT NULL DEFAULT 'openid profile email',
  owner_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  disabled           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  id                     TEXT PRIMARY KEY,
  code_hash              TEXT NOT NULL UNIQUE,
  client_id              TEXT NOT NULL,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri           TEXT NOT NULL,
  scopes                 TEXT NOT NULL,
  code_challenge         TEXT,
  code_challenge_method  TEXT,
  expires_at             TEXT NOT NULL,
  used                   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id, client_id);

-- ---- 0047: AI 捐献失败模型的重试记录 ----
-- 见 migrations/0047_donation_model_retries.sql 的说明。
CREATE TABLE IF NOT EXISTS donation_model_retries (
  donation_id   TEXT NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  channel_id    INTEGER NOT NULL,
  status        TEXT NOT NULL,
  reason        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_tried_at TEXT NOT NULL,
  next_retry_at TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (donation_id, model)
);

CREATE INDEX IF NOT EXISTS idx_dmr_due ON donation_model_retries(status, next_retry_at);

-- ---- 0051: 用户反馈（私有工单 + 管理员回复）----
-- 见 migrations/0051_feedback.sql 的说明。
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,                      -- bug | feature | donation | other
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',    -- pending | processing | resolved | closed
  admin_reply TEXT,
  replied_at  TEXT,
  replied_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_read   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);

-- ---- 0068: 消息箱 + 活动系统 ----
-- 见 migrations/0068_user_messages_and_events.sql 的说明。
--
-- ⚠️ notifications 表**不在此处重建**：它由 0024_community.sql 建表，
-- 0068 用 ALTER TABLE 加列（category/title/body/link/payload/dedup_key）。
-- ALTER 不幂等，写进基线会让「schema.sql + 迁移链」的测试环境重复加列而报错，
-- 所以基线只保留**新增的表**（CREATE TABLE IF NOT EXISTS 幂等）。

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft',  -- draft | active | ended | archived
  starts_at        TEXT,
  ends_at          TEXT,
  reward_label     TEXT,
  reward_type      TEXT NOT NULL DEFAULT 'none',
  reward_params    TEXT,
  condition_type   TEXT NOT NULL DEFAULT 'always',
  condition_params TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS event_claims (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  reward_type   TEXT NOT NULL,
  reward_status TEXT NOT NULL DEFAULT 'pending',  -- pending | granted | manual | failed
  reward_detail TEXT,
  claimed_at    TEXT NOT NULL,
  granted_at    TEXT,
  granted_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_claims_unique ON event_claims(event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_event_claims_user ON event_claims(user_id, claimed_at DESC);

-- ---- 0071: 公告邮件群发队列 ----
-- 见 migrations/0071_announcement_mail_queue.sql 的说明。
-- announcements 的 mail_status/mail_total/... 五列由该迁移 ALTER 加上，不在此重复
-- （ALTER 不幂等，写进基线会让「schema.sql + 迁移链」的测试环境重复加列而报错）。
CREATE TABLE IF NOT EXISTS announcement_mail_queue (
  id            TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_amq_pending ON announcement_mail_queue(announcement_id, status);
CREATE INDEX IF NOT EXISTS idx_amq_status ON announcement_mail_queue(status, created_at);
