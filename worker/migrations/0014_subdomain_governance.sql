-- 子域名治理：可配置保留名 + 可配置配额
--
-- 背景（用户需求）：
--   1. 一级子域名是根域直系（xxx.doulor.cn），位数必须 ≥3；
--      二级（yyy.xxx.doulor.cn）不限位数。
--   2. 管理员可维护一份「保留子域名」名单（如 blog / dev / www），
--      即使位数合规也不允许用户创建 —— 用于给平台自己或特定用途留位。
--   3. 每个用户可创建的一级子域名数量可配：全局默认 + 用户级覆盖。

-- 保留子域名（管理员可增删）
CREATE TABLE IF NOT EXISTS reserved_subdomains (
  name        TEXT PRIMARY KEY COLLATE NOCASE,   -- 如 blog（不含 .doulor.cn）
  note        TEXT,                              -- 备注：为什么保留
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reserved_subdomains_name ON reserved_subdomains(name);

-- 默认保留一批常见名称（用户提到的 blog/dev/www 等）
INSERT OR IGNORE INTO reserved_subdomains (name, note, created_at) VALUES
  ('www',    '站点主入口',   datetime('now')),
  ('blog',   '博客',         datetime('now')),
  ('dev',    '开发环境',     datetime('now')),
  ('test',   '测试用途',     datetime('now')),
  ('staging','预发布环境',   datetime('now')),
  ('api',    '接口服务',     datetime('now')),
  ('cdn',    '静态资源',     datetime('now')),
  ('img',    '图床',         datetime('now')),
  ('static', '静态资源',     datetime('now')),
  ('assets', '静态资源',     datetime('now')),
  ('files',  '文件服务',     datetime('now')),
  ('mail',   '邮件服务',     datetime('now')),
  ('smtp',   '邮件服务',     datetime('now')),
  ('ns',     '域名解析',     datetime('now')),
  ('admin',  '管理后台',     datetime('now')),
  ('panel',  '控制面板',     datetime('now')),
  ('status', '状态页',       datetime('now')),
  ('docs',   '文档',         datetime('now')),
  ('git',    '代码仓库',     datetime('now')),
  ('m',      '移动端',       datetime('now'));

-- 用户级配额覆盖（NULL = 用全局默认）
ALTER TABLE users ADD COLUMN max_subdomains INTEGER;