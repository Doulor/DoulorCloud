-- 节点级指纹表（2026-10-03 站长要求：导入时拒绝相同节点）。
--
-- 之前节点池只按「订阅 URL」去重，同一份节点资源换个订阅 URL 就能重复导入。
-- 这里落一张「协议+服务器+端口」指纹表，导入订阅源时据此判断「这些节点是否已经在池里」，
-- 全部重复就拒绝导入。删除订阅源时对称清理。

CREATE TABLE IF NOT EXISTS proxy_node_fingerprints (
  fingerprint     TEXT PRIMARY KEY,   -- 形如 vless:1.2.3.4:443
  subscription_id TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxy_node_fp_sub ON proxy_node_fingerprints(subscription_id);
