-- 0024_community.sql
-- 社区广场：帖子 / 两层嵌套评论 / 点赞 / 通知
--
-- 冗余计数字段（like_count/comment_count/share_count）：避免列表查询
-- COUNT(*) 扫 post_likes——D1 免费额度按行读计费（500 万行/天），这是最吃紧的资源。
-- 两层嵌套：回复的 parent_id 始终指向「根评论」，深度恒为 2，渲染时一次分组即可。

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 一期恒为 'general'；将来分区时填入分区标识
  channel       TEXT NOT NULL DEFAULT 'general',
  body          TEXT NOT NULL,
  -- 图片对象键数组（JSON），形如 ["community/<postId>/1.webp", ...]
  images        TEXT,
  like_count    INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  share_count   INTEGER NOT NULL DEFAULT 0,
  -- 软删：评论或管理操作可能引用它，物理删会留下断链
  deleted_at    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user    ON posts(user_id);

CREATE TABLE IF NOT EXISTS post_comments (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 根评论为 NULL；回复指向根评论 id（因此深度恒为 2）
  parent_id   TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
  -- 回复某条回复时记录被回复者，用于展示「回复 @某人」
  reply_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  like_count  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_post   ON post_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON post_comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_user   ON post_comments(user_id);

CREATE TABLE IF NOT EXISTS post_likes (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,   -- 'post' | 'comment'
  target_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_target ON post_likes(target_type, target_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,   -- 'post_comment' | 'comment_reply'
  actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  post_id    TEXT REFERENCES posts(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, read, created_at DESC);
