-- 0041_chat.sql
-- 公共聊天室：一期只做一个默认公共聊天室（不分房间）。
--
-- 消息实时性：SSE 推送为主，轮询兜底。Worker 无状态，无法直接数「活跃连接」，
-- 故「在线」用心跳定义：用户停留在聊天室时每 30 秒报一次心跳，
-- 最近 2 分钟内有心跳的算「在线」。

CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);

-- 在线心跳：只存「谁最近活跃过」，不存连接数（Worker 无状态）
CREATE TABLE IF NOT EXISTS chat_presence (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_presence_seen ON chat_presence(last_seen_at);
