-- 0031_messages_read_index.sql
-- 给「未读数统计」补一个覆盖索引。
--
-- 背景：未读统计的查询形如
--   SELECT COUNT(*) AS total, COALESCE(SUM(read = 0), 0) AS unread
--     FROM messages WHERE mailbox_id = ?
-- 以及
--   SELECT COUNT(*) FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id
--    WHERE mb.user_id = ? AND m.read = 0
-- 两者都按 (mailbox_id, read) 过滤。原先只有 idx_messages_mailbox(mailbox_id, received_at)，
-- read 列不在索引里，只能靠回表逐行判断，邮件量上去后扫描成本明显。
--
-- 参照 notifications 表的做法（0024_community.sql 里已建 idx_notifications_user(user_id, read, ...)）。
--
-- 该统计在 /api/me（每次页面加载）、邮箱列表、未读计数多处调用，属于热点路径。

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_read ON messages(mailbox_id, read);
