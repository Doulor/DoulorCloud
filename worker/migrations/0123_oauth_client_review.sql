-- 0123_oauth_client_review.sql
-- OAuth 应用「用户自助创建 + 站长审核」所需的状态列（2026-10-06）。
--
-- 背景：此前 OAuth 应用只能由管理员在后台添加。放开给用户自建后，**主要风险是
-- 钓鱼** —— 应用名可以随便填，而用户看到的同意页只有「某某应用想访问你的账号」，
-- 没有任何办法判断这是谁做的网站。因此配套：审核状态 + 同意页展示回调域名 +
-- 应用名敏感词拦截。
--
-- ⚠️ 默认 'approved' 很关键：既有客户端（全部是管理员建的）必须继续可用，
--    不能因为加列就集体变成「待审核」。
--
-- ⚠️ 线上 D1 **不要**跑 migrations apply（见项目约定）。部署时手动执行下面这几条
--    ALTER（先确认结构、必要时先备份）。

ALTER TABLE oauth_clients ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE oauth_clients ADD COLUMN review_note TEXT;
ALTER TABLE oauth_clients ADD COLUMN reviewed_at TEXT;
ALTER TABLE oauth_clients ADD COLUMN reviewed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_oauth_clients_review ON oauth_clients(review_status);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_owner ON oauth_clients(owner_user_id);
