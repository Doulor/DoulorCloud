-- Doulor Cloud D1 迁移：节点在线状态（管理员手动维护）
--
-- 为什么不做自动探测：实测确认两条路都不通 ——
--   1. Worker 裸 IP 出网被 Cloudflare 拦截（1ms 返回 403 1003，请求未离开边缘）
--   2. 走域名（firef.qzz.io）时，节点在阿里云大陆机房，返回
--      "Non-compliance ICP Filing" 未备案拦截（浏览器访问同样被拦）
--   3. Cloudflare connect() socket API 需付费计划
-- 因此由管理员在面板上手动标记状态（或自行更新），本站只负责展示。
ALTER TABLE frp_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE frp_nodes ADD COLUMN status_note TEXT;
ALTER TABLE frp_nodes ADD COLUMN status_updated_at TEXT;
