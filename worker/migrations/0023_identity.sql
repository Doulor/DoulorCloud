-- 0023_identity.sql
-- 账户级身份：中文昵称 + 头像（与 profile 模块解耦）

ALTER TABLE users ADD COLUMN nickname TEXT;
ALTER TABLE users ADD COLUMN avatar_key TEXT;

-- 昵称全站唯一（大小写不敏感）；未设置（NULL）不参与唯一性
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_unique
  ON users(nickname COLLATE NOCASE) WHERE nickname IS NOT NULL;
