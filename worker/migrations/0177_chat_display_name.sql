-- 0177: 聊天消息显示名（2026-10-24）
--
-- 群桥接进来的消息，发送者是共享的「群友」账号；为了区分是谁说的，
-- 在消息级别记一个显示名（QQ/TG 都没昵称时用 openid 短标识）。
ALTER TABLE chat_messages ADD COLUMN display_name TEXT;
