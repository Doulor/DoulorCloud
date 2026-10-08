-- 公开 API：管理员 Key 标记 + 子域名功能接入
--
-- 背景（2026-10-07 站长要求）：
--   1) 公开 API 要补「子域名 / 邮箱」的创建与删除类接口；
--   2) 另给一把**管理员权限的 Key** —— 它不受 API 速率、子域名速率、
--      子域名数量、邮箱数量这些限制。
--
-- ⚠️ `user_api_keys` 是「每用户一把 Key」的模型（user_id 唯一），
-- 所以这里不加第二张表，而是在同一行上打 `is_admin` 标记：
-- 管理员重新生成 Key 时可选「管理员 Key」，普通用户没有这个选项。
--
-- ⚠️ 线上 D1 **不要跑 migrations apply** —— 本文件与线上手工执行的语句一致，
-- 仅作版本留档。

-- 1) Key 的管理员标记
ALTER TABLE user_api_keys ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- 2) 子域名功能行（与 dns/mailbox 同档限额：按成就点分层 + IP 上限）
INSERT INTO api_config (feature, enabled, tier_limits, ip_limit)
VALUES (
  'subdomain',
  1,
  '[10,50,150,500,1000,2000,5000,10000,10000,10000,10000]',
  1000
)
ON CONFLICT DO NOTHING;
