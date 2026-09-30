-- 「有趣的网页分享」：工具箱里一个精选外链列表，由管理面板手动维护。
--
-- 为什么单开一张表而不是塞进 app_settings 的 JSON：
--   列表要支持逐条增删改、排序、上下架，用行存更自然；
--   而且两个管理员同时编辑时，整块 JSON 覆盖会互相吃掉对方的改动。
--
-- enabled = 0 表示下架：普通用户在工具箱里看不到，管理员列表里仍然可见。
CREATE TABLE IF NOT EXISTS fun_links (
  id          TEXT PRIMARY KEY,            -- uuid
  title       TEXT NOT NULL,               -- 网站名
  url         TEXT NOT NULL,               -- 链接（只允许 http / https）
  description TEXT NOT NULL DEFAULT '',    -- 一句话说明
  sort_order  INTEGER NOT NULL DEFAULT 0,  -- 小的排前面
  enabled     INTEGER NOT NULL DEFAULT 1,  -- 0 = 下架
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fun_links_order ON fun_links (enabled, sort_order, created_at);
