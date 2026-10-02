-- 0101_appeal_note_read.sql
-- 申诉回复的「已读」追踪（2026-10-02 站长要求）。
--
-- 背景：
--   管理员处理封禁申诉后会写回复（review_note），但被封禁/已解封的用户往往「没看见」——
--   要么封禁中登录页不够醒目，要么解封后根本没再回来看。
--   现在要求：回复**强制弹窗**展示，用户必须勾选确认才能关闭；
--   对「已解封但还没看到回复」的用户，登录时**补发**弹窗。
--
--   补发的判定依据就是本列：note_read_at 为 NULL = 这条回复用户还没确认看过。
--   管理员每次（重新）写回复时它保持 NULL，用户确认后才落时间戳。
--
-- ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，只能跑一次。
-- ⚠️ 线上必须**逐条**手工执行：
--     npx wrangler d1 execute doulor-mail --remote --command "ALTER TABLE account_appeals ADD COLUMN note_read_at TEXT"

ALTER TABLE account_appeals ADD COLUMN note_read_at TEXT;
