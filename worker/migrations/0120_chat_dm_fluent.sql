-- 0120_chat_dm_fluent.sql
-- 聊天室与私信的「Telegram 式流畅性」升级（借鉴 Telegram Android 源码逻辑）。
--
-- 1. client_id（借鉴 Telegram 的 random_id 幂等发送，SendMessagesHelper）：
--    前端乐观发送先本地出气泡、后端确认后原位替换；超时重试 / 双击提交时，
--    同一个 (发信人, client_id) 只会落一行 —— `(user_id, client_id)` 唯一索引兜底，
--    冲突时后端查回原行返回（幂等）。旧数据 client_id 全为 NULL，
--    SQLite 的唯一索引不把 NULL 互判相等，不会撞。
--
-- 2. typing_at / dm_typing（借鉴 ChatActivityEnterView 的 5 秒 typing 节流）：
--    「正在输入」是短命状态，只写一个时间戳，由**已有的消息轮询响应**顺带下发，
--    不为它新增任何轮询请求；超过 10 秒没续报（2 个节流窗口）即过期。
--
-- 3. 私信补引用与撤回（语义与聊天室 chat_messages 对齐）：
--    direct_messages.reply_to = 被引用消息 id；recalled_at = 撤回时间，
--    撤回即清空正文（与 chat.ts 的「不只盖遮罩、内容真的删掉」一致）。

-- —— 聊天室：幂等键 + 输入中时间戳 ——
ALTER TABLE chat_messages ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client
  ON chat_messages(user_id, client_id);

ALTER TABLE chat_presence ADD COLUMN typing_at TEXT;

-- —— 私信：幂等键 + 引用 + 撤回 ——
ALTER TABLE direct_messages ADD COLUMN client_id TEXT;
ALTER TABLE direct_messages ADD COLUMN reply_to TEXT;
ALTER TABLE direct_messages ADD COLUMN recalled_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_messages_client
  ON direct_messages(from_user_id, client_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_reply ON direct_messages(reply_to);

-- —— 私信「正在输入」——
-- 一人同时只会给一个会话打字（PK = user_id），够用且省行；
-- (peer_id, typing_at) 索引给「对端正在输入我吗」的窗口查询用。
CREATE TABLE IF NOT EXISTS dm_typing (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  peer_id   TEXT NOT NULL,
  typing_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_typing_peer ON dm_typing(peer_id, typing_at);
