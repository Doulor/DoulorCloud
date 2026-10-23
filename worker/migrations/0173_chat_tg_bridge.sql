-- 0173: 聊天室 ↔ TG 群互通（2026-10-24）
--
-- 合并版：一次性加齐所有需要的列与索引，保证**全新库**上可执行（测试用 miniflare 会跑全部迁移）。
-- 线上库此前已用等价语句手动补齐过（tg_* / kind / tg_shadow_id），不需要重复执行本文件。
ALTER TABLE chat_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'site';
ALTER TABLE chat_messages ADD COLUMN tg_message_id TEXT;
ALTER TABLE chat_messages ADD COLUMN tg_username TEXT;
ALTER TABLE chat_messages ADD COLUMN tg_chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_messages_tg ON chat_messages(tg_chat_id, tg_message_id);

ALTER TABLE tg_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel';
CREATE INDEX IF NOT EXISTS idx_tg_channels_kind ON tg_channels(kind);

ALTER TABLE users ADD COLUMN tg_shadow_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg_shadow ON users(tg_shadow_id) WHERE tg_shadow_id IS NOT NULL;