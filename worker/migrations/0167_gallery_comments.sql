-- 0167_gallery_comments.sql
--
-- 造物集评论区（2026-10-21 站长要求）。
--
-- 为什么**不复用** `post_comments`：
--   那张表的 post_id 有外键指向 `posts(id)`，而造物集作品在 `lab_projects` 里 ——
--   是两套完全不同的实体（一个是长文帖子，一个是可运行的网页作品）。
--   硬塞进去要么去掉外键（脏数据风险），要么给 posts 造假行（更糟）。
--   所以另开一张结构对齐的表，语义清晰、互不干扰。
--
-- 结构**刻意与 post_comments 保持一致**（parent_id / reply_to_user_id / like_count /
-- deleted_at），这样后端可以直接复用 `community-logic.ts` 里的 `groupComments()`、
-- `canPostAgain()` 等纯函数，前端也能沿用社区那套渲染逻辑。
--
-- 与社区的差异：
--   · 不维护 `comment_count` 冗余列 —— 造物集详情的浏览/点赞已经够多了，
--     评论数在列表接口里顺手 `COUNT(*)` 就够，不值得为它多一个要同步更新的字段。
--   · 不触发站内通知 —— 造物集是展示为主的场景，先不引入通知噪音（要加再说）。
--
-- ⚠️ project_id 的外键**不加** `ON DELETE CASCADE` 也能删干净，但加了更省心：
--    作品被删除时评论跟着走，不留孤儿行。

CREATE TABLE IF NOT EXISTS gallery_comments (
  id               TEXT PRIMARY KEY,
  -- 指向 lab_projects.id（作品）。用 slug 不行 —— slug 可改，评论会跟丢。
  project_id       TEXT NOT NULL REFERENCES lab_projects(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 根评论为 NULL；回复指向父评论 id（深度不限，前端递归渲染）
  parent_id        TEXT REFERENCES gallery_comments(id) ON DELETE CASCADE,
  -- 回复某条回复时记录被回复者，用于展示「回复 @某人」
  reply_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body             TEXT NOT NULL,
  like_count       INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL
);

-- 列表查询：按作品取、按时间正序（建树依赖时间序）
CREATE INDEX IF NOT EXISTS idx_gallery_comments_project
  ON gallery_comments(project_id, created_at);

-- 防刷屏：查「该用户在造物集的最后一条评论时间」
CREATE INDEX IF NOT EXISTS idx_gallery_comments_user
  ON gallery_comments(user_id, created_at);
