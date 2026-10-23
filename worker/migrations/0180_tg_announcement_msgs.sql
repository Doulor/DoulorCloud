-- 0180: 记录公告在 TG 频道里的消息 id（2026-10-24）
--
-- 站长要求：网页/机器人删掉公告后，频道里那条也要自动删掉。
-- 频道消息只有拿到 message_id 才能 deleteMessage，所以发布时把它记下来。
CREATE TABLE IF NOT EXISTS tg_announcement_msgs (
  announcement_id TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  message_id      INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (announcement_id, chat_id)
);
