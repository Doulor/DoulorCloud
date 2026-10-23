-- 0178: 聊天室免打扰（2026-10-24）
--
-- 站长要求免打扰跨设备生效。原来只存 localStorage（换设备就丢），
-- 现在落一个 users 字段：开启后 /api/attention 里的 chat 计数直接返回 0。
ALTER TABLE users ADD COLUMN chat_dnd INTEGER NOT NULL DEFAULT 0;
