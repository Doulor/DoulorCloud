-- 0045_proxy_donation_link.sql
-- 把「因某笔捐献而导入节点池」的订阅源和那张捐献单关联起来。
--
-- 为什么需要：代理节点捐献通过后，订阅链接会被写进 proxy_subscriptions 供所有人使用。
-- 撤销这笔捐献时，光收回用户自己的 proxy 权限是不够的 —— 他捐的链接还留在节点池里
-- 被大家用着。有了这一列，撤销就能精确删掉「这笔捐献导入的那些」，而不误伤
-- 管理员手工添加的订阅源。

ALTER TABLE proxy_subscriptions ADD COLUMN source_donation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_proxy_subs_source_donation
  ON proxy_subscriptions(source_donation_id);
