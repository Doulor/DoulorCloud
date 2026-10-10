-- 0144_lab_project_domains.sql
-- AI 实验室：**把作品绑到自己的域名上**（2026-10-10 站长要求）。
--
-- 机制**完全照抄直链网盘那一套**（`storage_prefixes.fqdn` + `createWorkerRoute`）：
--   1. 建 DNS 记录（AAAA 100:: + **开代理**）—— doulor.cn 没有泛解析，
--      只加 Worker Route 不建解析的话域名根本到不了 Cloudflare；
--   2. 给这个 fqdn 加一条 Worker Route（`<fqdn>/*`）指到本站 Worker；
--   3. Worker 里 `hostedDirectLink()` 按 Host 分流：命中本表就吐作品内容。
--
-- ⚠️ fqdn 全局唯一：一个域名只能绑一个作品，否则「谁的」说不清。
--    绑定时会先查重，撞了就报错而不是静默覆盖。

CREATE TABLE IF NOT EXISTS lab_project_domains (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES lab_projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  fqdn       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lab_project_domains_user ON lab_project_domains (user_id);
CREATE INDEX IF NOT EXISTS idx_lab_project_domains_project ON lab_project_domains (project_id);
