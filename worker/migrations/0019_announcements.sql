-- 网站公告 / 动态
--
-- 用于概览页的「网站动态」卡片：管理员发布公告（新增渠道、新模型、新节点、
-- 维护通知等），登录用户在概览页看到最近几条，pinned 优先。
--
-- category 值：general / frp / ai / proxy / storage / profile
--   仅作展示分类标签用，不做权限过滤。
--
-- 不预建记录；管理员通过 POST /api/admin/announcements 创建。

CREATE TABLE IF NOT EXISTS announcements (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general',
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);
