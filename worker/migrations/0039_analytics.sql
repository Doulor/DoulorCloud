-- 0039_analytics.sql
-- 网站访问统计：PV / UV / 页面路径 / 来源 / 时间趋势。
--
-- 只统计「页面浏览」，不统计 API 调用。
-- 前端用 sendBeacon 在路由切换时上报一条事件，后端落库，管理面板聚合查询。
--
-- 字段说明：
--   visitor_id  —— 前端 localStorage 存的随机 UUID，用于计算 UV（独立访客）
--   path        —— 页面路径（如 /dashboard/storage），不含查询串
--   referrer    —— 来源（来源站点域名，或 'direct' 直接访问）
--   ua          —— 简化后的 User-Agent（只存设备/浏览器类别，不存完整 UA，省空间）
--   created_at  —— 事件时间
--
-- 数据量评估：个人/小团队站点，日 PV 假设 < 10 万，D1 行读按需聚合即可，
-- 不必预聚合。表只保留最近 N 天（由定时运维清理），避免无限增长。

CREATE TABLE IF NOT EXISTS analytics_events (
  id          TEXT PRIMARY KEY,
  visitor_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  referrer    TEXT NOT NULL DEFAULT 'direct',
  ua          TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_path ON analytics_events(path);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor ON analytics_events(visitor_id);
