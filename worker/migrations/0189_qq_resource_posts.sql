-- QQ 群发起的资源共享帖（2026-10-27）
--
-- posts.user_id 只能落到"本群访客账号"，区分不出是群里哪个人发的。
-- 想支持「只能删自己发的」，就得把 (group_openid, member_openid) 记下来。

CREATE TABLE IF NOT EXISTS qq_resource_posts (
  post_id      TEXT PRIMARY KEY,
  group_openid TEXT NOT NULL,
  member_openid TEXT,
  created_at   INTEGER NOT NULL
);
