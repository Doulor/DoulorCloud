-- 0033_oauth_provider.sql
-- Doulor Cloud 作为「身份提供方」（IdP）：自有站点（NewAPI 等）通过本平台登录。
--
-- ⚠️ 方向说明：是**别的站点来接我们**，不是我们接别人。
-- 首个消费者是 NewAPI，但用户明确表示「以后其他网站也都要用 Doulor Cloud 登录」，
-- 所以这里按「多客户端」设计，不是为单一站点定做。
--
-- 对接依据（已核对 new-api 源码 oauth/oidc.go）：
--   1. 授权码流程：本平台签发 code → 对方拿 code 换 access_token → 用 token 调 /userinfo
--   2. 对方读取 userinfo 的字段：sub / email / name / preferred_username / picture
--   3. **对方不验证 id_token 签名**，只检查 access_token 非空
--      ⇒ 一期不需要 RSA 密钥与 JWKS；access_token 用不透明随机串即可
--
-- 安全约定（与库内既有做法保持一致）：
--   - client_secret / code / access_token 一律**只存哈希**，明文不落库
--     （参照 sessions.token_hash 的既有设计）
--   - redirect_uri 必须**精确匹配**，绝不做前缀/通配匹配
--     （模糊匹配 = 开放重定向 = 令牌被第三方窃取，这是 OAuth 最经典的漏洞）

-- 接入的第三方应用（每个站点一条）
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                 TEXT PRIMARY KEY,
  client_id          TEXT NOT NULL UNIQUE,
  -- 只存哈希；明文仅在「创建」与「重置密钥」时返回一次，之后无法再取回
  client_secret_hash TEXT NOT NULL,
  name               TEXT NOT NULL,          -- 同意页上展示给用户看的应用名
  redirect_uris      TEXT NOT NULL,          -- JSON 字符串数组，精确匹配
  scopes             TEXT NOT NULL DEFAULT 'openid profile email',
  owner_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  disabled           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- 授权码：短命、一次性、绑定 client 与 redirect_uri
CREATE TABLE IF NOT EXISTS oauth_codes (
  id                     TEXT PRIMARY KEY,
  code_hash              TEXT NOT NULL UNIQUE,
  client_id              TEXT NOT NULL,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 签发时用的 redirect_uri。兑换时若不一致则拒绝（防止把码换到攻击者的地址）
  redirect_uri           TEXT NOT NULL,
  scopes                 TEXT NOT NULL,
  -- PKCE：NewAPI 不发这两个参数，所以允许为空；接别的站点时可用
  code_challenge         TEXT,
  code_challenge_method  TEXT,
  expires_at             TEXT NOT NULL,      -- 建议 60 秒
  used                   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL
);

-- 访问令牌：同样只存哈希
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

-- 授权记忆：用户点过「允许」之后，同一应用再登录就不再弹同意页
-- （否则每次进 NewAPI 都要点一次，体验很差，用户会绕过而不是认真读）
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
