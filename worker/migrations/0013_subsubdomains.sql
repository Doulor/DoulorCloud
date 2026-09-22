-- 子子域名（任意层级）
--
-- 需求：一级子域名（ruben.doulor.cn）之下还能再建 5 个，
-- 如 profile.ruben.doulor.cn，且其 DNS 等待遇与一级完全一致。
--
-- 设计：给 subdomains 增加 parent_id 自引用。fqdn 仍存完整域名，
-- 因此 DNS 记录、名片/网盘绑定等既有逻辑无需改动（它们只认 fqdn）。
--
-- 配额：一级（parent_id IS NULL）最多 5 个（含 '@' 主域名）；
--      每个一级之下再各自最多 5 个。校验在应用层完成（见 subdomains.ts）。

ALTER TABLE subdomains ADD COLUMN parent_id TEXT REFERENCES subdomains(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_subdomains_parent ON subdomains(parent_id);