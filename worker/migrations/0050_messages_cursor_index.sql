-- 0050_messages_cursor_index.sql
-- 把 messages 的列表索引从「单键」升级成「复合键」，以配合 M16 的游标分页。
--
-- 背景（2026-09-25 审计 M16）：`GET /api/mailbox/:id/messages` 原先写死
-- `ORDER BY received_at DESC LIMIT 100`，没有游标 —— 收件箱超过 100 封后
-- 旧邮件在界面上永久不可达。
--
-- 修好分页之后，排序键变成 `ORDER BY received_at DESC, id DESC`：
-- 只按 received_at 翻页是**错的**，因为邮件是批量到达的（同一次投递/导入的
-- 时间戳完全相同），同一时间戳上的多封邮件会被整批跳过。
--
-- 而 0002 建的 `idx_messages_mailbox(mailbox_id, received_at DESC)` 只覆盖了
-- 排序键的前缀。SQLite 要求 ORDER BY 是索引列的前缀才能免排序，缺了 `id`
-- 这一列它就会退化成「先按 WHERE 取全部行 → 再建临时 B-tree 排序」——
-- 每翻一页都按**整个收件箱**的规模排序一次，比现在的固定 100 行还慢。
--
-- 所以这里直接**替换**掉旧索引（而不是再建一个）：新索引以旧索引为前缀，
-- 是完全的替代品，留着两个只会让写入放大且让 planner 多一个无用的候选。
--
-- ⚠️ 与 schema.sql 的关系：schema.sql 里仍然写着旧的 `idx_messages_mailbox`
--    （它是从旧 dump 生成的，本身就有 H11 记录的漂移）。
--   这里**不动** schema.sql —— 测试是先建 schema.sql 再跑全部迁移，
--    最终状态由本迁移决定，与生产一致。等 H11 重建 schema.sql 时一并收敛。
--
-- 代价：messages 表很小（生产 14 行 / 4 个邮箱），重建索引可忽略。

DROP INDEX IF EXISTS idx_messages_mailbox;

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_cursor
  ON messages(mailbox_id, received_at DESC, id DESC);
