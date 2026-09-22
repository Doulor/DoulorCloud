-- Doulor Mail D1 迁移：子域名模型 + 用户角色
-- 在 0002 之上执行（保持幂等）。

-- users.role：admin | user
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 子域名表（每用户最多 5 个）
CREATE TABLE IF NOT EXISTS subdomains (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                          -- e.g. blog
  fqdn        TEXT NOT NULL UNIQUE,                   -- blog.test.doulor.cn
  status      TEXT NOT NULL DEFAULT 'active',         -- active | pending | error
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subdomains_user ON subdomains(user_id);

-- DNS 记录挂到 subdomain（旧数据若无匹配子域名则挂 NULL）
ALTER TABLE dns_records ADD COLUMN subdomain_id TEXT REFERENCES subdomains(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dns_subdomain ON dns_records(subdomain_id);

-- 为每个用户把现有域名的默认子域（空名字段或 '@'）建出来，并把旧 DNS 记录归入
INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
SELECT
  lower(hex(randomblob(16))),
  d.user_id,
  '@',
  d.name,
  'active',
  datetime('now')
FROM domains d;

UPDATE dns_records SET subdomain_id = (
  SELECT s.id FROM subdomains s
  WHERE s.user_id = (SELECT d.user_id FROM domains d WHERE d.id = dns_records.domain_id)
  LIMIT 1
)
WHERE subdomain_id IS NULL;