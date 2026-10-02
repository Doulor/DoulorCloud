-- 一对一私信（2026-10-01）
--
-- 场景：
--   ① 积分商城交易双方要能互相联系（下单后商量交付、催确认收货）；
--   ② 个人空间 / 聊天室里想私聊某人。
--
-- 为什么不用现成的 notifications：那张表是**单向通知**（收件人 + 触发者），
-- 没有「对话」概念，拿它做私聊会把系统消息语义和对话混在一起。
-- 也不复用 chat_messages：那是**一个公共房间**，没有「对端」。
--
-- 已读怎么记：私聊是一对一，**一条消息只需要一个「收件人读了吗」** ——
-- 所以 read_at 一列就够（收件人读的时间；自己发的不需要标记）。
-- 这样未读数 = `to_user_id = 我 AND read_at IS NULL`，不需要额外的位点表。

CREATE TABLE IF NOT EXISTS direct_messages (
  id           TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- 收件人读这条消息的时间；NULL = 未读
  read_at      TEXT
);

-- 会话里按时间正序翻页（双方方向都要走）
CREATE INDEX IF NOT EXISTS idx_dm_from_to ON direct_messages(from_user_id, to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_to_from ON direct_messages(to_user_id, from_user_id, created_at);
-- 未读数 / 会话列表：找我收到的未读
CREATE INDEX IF NOT EXISTS idx_dm_unread ON direct_messages(to_user_id, read_at, created_at);
