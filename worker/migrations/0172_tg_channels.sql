-- 0172: TG 频道推送
--
-- 站长 2026-10-22 把机器人拉进了频道，要求「自动推送到频道」。
-- 之前所有推送都是 1:1 私聊（按 tg_bindings 的 telegram_id），频道没有任何支持。
--
-- 一频道一行：events_json 控制哪些事件往这个频道发（默认公告 + 新作品，社区新帖默认关，
-- 免得频道被刷屏；站长可以自己开）。

CREATE TABLE IF NOT EXISTS tg_channels (
  chat_id     TEXT PRIMARY KEY,              -- -100xxxxxxxxxx 或 @username
  title       TEXT NOT NULL DEFAULT '',
  username    TEXT,                          -- 公开频道的 @name（没有则 NULL）
  events_json TEXT NOT NULL DEFAULT '{}',    -- { "announcement": true, "gallery": true, "post": false }
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  created_by  TEXT,                          -- 'auto:my_chat_member' 或管理员 user id
  last_ok_at  INTEGER,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tg_channels_enabled ON tg_channels(enabled);
