-- 0036_link_previews.sql
-- 链接预览缓存：社区 markdown 里的外站链接会被解析成「富链接卡片」，
-- 需要抓取目标 URL 的 OG 标签。同一链接多人引用时不能反复抓，
-- 所以把解析结果缓存起来，过期后重新抓。
--
-- 为什么存 D1 而不是 KV：项目已有 D1，加一张小表即可，不引入新绑定；
-- 链接数量有限（帖子里的外链不会海量），行数可控。
--
-- 缓存键用 URL 本身（去尾斜杠、去 hash 后）；同一 URL 只抓一次，
-- 过期（fetched_at + TTL）后重新抓取以反映目标站点内容更新。

CREATE TABLE IF NOT EXISTS link_previews (
  url          TEXT PRIMARY KEY,          -- 规范化后的 URL（去尾斜杠 / 去 hash）
  title        TEXT NOT NULL,
  description  TEXT,                      -- 可能为空（目标站没写 og:description）
  image        TEXT,                      -- og:image 绝对 URL，可能为空
  site_name    TEXT,                      -- og:site_name，可能为空
  fetched_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_previews_fetched ON link_previews(fetched_at);
