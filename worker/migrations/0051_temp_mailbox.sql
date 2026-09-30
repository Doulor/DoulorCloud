-- 临时邮箱（2026-09-25）
--
-- 设计取舍：临时邮箱**复用 mailboxes 表**，只加一个 is_temp 标记，
-- 而不是另建一张 temp_mailboxes 表。
--
-- 理由：入站邮件分发（worker/src/email-delivery.ts）定位收件箱的唯一依据是
--   SELECT * FROM mailboxes WHERE address = ? COLLATE NOCASE
-- 复用这张表意味着临时邮箱的「收信 / 网页读信 / 标记已读 / 删除」全部零改动即可工作；
-- 若另建表，则入站分发、收件箱列表、消息接口都要各写一套分支，
-- 任何一处漏改都会表现为「临时邮箱收不到信」这种极难排查的静默故障。
--
-- 额度语义：普通邮箱上限 MAX_MAILBOXES_PER_USER = 3，临时邮箱**独立计数**，
-- 不占用这 3 个名额。因此所有「按 user_id 数邮箱」的查询都必须显式带上 is_temp 条件，
-- 否则临时邮箱会把普通邮箱的额度挤掉。
--
-- ⚠️ 线上 D1 的 d1_migrations 表是空的，不要跑 `d1 migrations apply`
-- （它会从头重放全部迁移并在已存在的表上失败）。线上加列请手工执行本文件的语句。

ALTER TABLE mailboxes ADD COLUMN is_temp INTEGER NOT NULL DEFAULT 0;

-- 列表与额度统计都按 (user_id, is_temp) 取数，避免全表扫
CREATE INDEX IF NOT EXISTS idx_mailboxes_user_temp ON mailboxes(user_id, is_temp);
