-- 聊天增量轮询的索引（2026-10-28）。
--
-- 背景：/api/chat/messages 在 sinceEdit 分支（前端每 5 秒轮询带一次）执行的是
--   WHERE m.created_at > ? OR (m.created_at = ? AND m.id > ?)
--      OR m.edited_at > ?
--      OR m.id IN (SELECT message_id FROM message_reactions WHERE kind='chat' AND created_at > ?)
--
-- SQLite 的 OR-优化要求**每个分支**都能走索引；而 `edited_at` 和
-- `message_reactions(kind, created_at)` 一直没索引，于是整条语句退化成全表扫：
-- 实测单次读 11,452 行、单日 17,927 次 ≈ 2.05 亿行，占全库行读的 63%
-- （见 2026-10-28 的 D1 按语句统计）。
--
-- 这两条索引配合 chat.ts 里改成 UNION 的写法，让两个分支各自走范围扫描。
CREATE INDEX IF NOT EXISTS idx_chat_messages_edited ON chat_messages(edited_at);
CREATE INDEX IF NOT EXISTS idx_message_reactions_created ON message_reactions(kind, created_at);
