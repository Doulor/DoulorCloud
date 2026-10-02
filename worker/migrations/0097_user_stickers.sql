-- 用户自定义表情包（社区/私信编辑器里快捷发送）。
--
-- 设计要点：
--   · 图片本体存 R2（key = `stickers/<userId>/<uuid>.<ext>`），这里只记元信息；
--   · 取图走 `/s/<id>`，id 是 uuid ⇒ **内容不可变** ⇒ 可以放心用
--     `Cache-Control: immutable` + CDN 边缘缓存（见 handlers/stickers.ts）；
--   · 删除是「先删行、再删对象」：行没了用户立刻看不到，
--     万一 R2 删失败也只是残留一个孤儿对象，不影响用户；
--   · bytes 存下来是为了给用户看占用、也方便日后做总量配额，
--     不必每次去 R2 查 HEAD。
CREATE TABLE IF NOT EXISTS user_stickers (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- 列表按人查、按上传时间正序（先传的在前，符合「我的表情包栏」直觉）
CREATE INDEX IF NOT EXISTS idx_user_stickers_user ON user_stickers(user_id, created_at);
