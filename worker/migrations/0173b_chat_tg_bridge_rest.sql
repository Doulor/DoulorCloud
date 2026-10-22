ALTER TABLE chat_messages ADD COLUMN tg_message_id TEXT;
ALTER TABLE chat_messages ADD COLUMN tg_username TEXT;
ALTER TABLE chat_messages ADD COLUMN tg_chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_messages_tg ON chat_messages(tg_chat_id, tg_message_id);
ALTER TABLE tg_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel';
CREATE INDEX IF NOT EXISTS idx_tg_channels_kind ON tg_channels(kind);
ALTER TABLE users ADD COLUMN tg_shadow_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg_shadow ON users(tg_shadow_id) WHERE tg_shadow_id IS NOT NULL;