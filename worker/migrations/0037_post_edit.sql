-- 0037_post_edit.sql
-- 帖子编辑：作者可编辑自己的帖子，并保留每次编辑的历史（含时间），
-- 用于详情页展示「编辑于 xx」，以及（将来）查看历史版本。

-- 1. posts 加 updated_at：最近一次编辑时间；未编辑过则为 NULL，
--    前端据此决定显示「发布于 xx」还是「编辑于 xx」。
ALTER TABLE posts ADD COLUMN updated_at TEXT;

-- 2. 编辑历史表：每次编辑存一行 body 快照。
--    body 是快照（编辑前的正文），供将来「查看历史版本」用；
--    当前版本永远在 posts.body。
CREATE TABLE IF NOT EXISTS post_edits (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  editor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_before TEXT NOT NULL,       -- 编辑前的正文快照
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_edits_post ON post_edits(post_id, created_at DESC);
