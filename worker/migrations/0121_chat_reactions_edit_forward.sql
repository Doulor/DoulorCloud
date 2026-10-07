-- 0121_chat_reactions_edit_forward.sql
-- 聊天室与私信的三项互动升级（2026-10-05 需求，延续 Telegram 借鉴路线）：
--   1. 表情回应（Reactions，Telegram 标志性互动）——
--      一条消息 × 一个人 × 一个表情 只算一次（PK 四元组天然幂等，
--      「点一下加上、再点一下取消」不需要先查后删的竞态处理）。
--      kind 区分消息所在表：'chat' = chat_messages，'dm' = direct_messages
--      （两表的 id 都是 v4 UUID，必须带 kind 才不会张冠李戴）。
--   2. 编辑消息（Telegram 同款）——edited_at 为空 = 未编辑过；
--      编辑只改正文与这个时间戳，created_at 不动（排序与游标全靠它）。
--   3. 消息转发 —— forward_from 记**来源作者的 user_id**（不是 username，
--      用户名不可改但 user_id 永远稳），下发时现查用户名，显示「转发自 xxx」。

CREATE TABLE IF NOT EXISTS message_reactions (
  kind       TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_msg
  ON message_reactions(kind, message_id);

ALTER TABLE chat_messages ADD COLUMN edited_at TEXT;
ALTER TABLE chat_messages ADD COLUMN forward_from TEXT;
ALTER TABLE direct_messages ADD COLUMN edited_at TEXT;
ALTER TABLE direct_messages ADD COLUMN forward_from TEXT;
