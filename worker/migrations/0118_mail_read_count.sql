-- 成就「阅信有道」按「累计已读」计算（2026-10-04 反馈 06c6eeed）。
--
-- 原因：原实现按 messages 表里 read=1 的**当前行数**算，用户删掉已读邮件后
-- 进度会回落，用户不理解「我读过的信怎么少了」。改成把「累计已读封数」
-- 单独落到 user_stats，标记已读时 +1、删邮件永不清减。
--
-- 幂等：CREATE 用 ALTER TABLE ADD COLUMN（重复执行会报错，但本文件只跑一次）。

ALTER TABLE user_stats ADD COLUMN mail_read_count INTEGER NOT NULL DEFAULT 0;

-- 回填存量：把当前仍存在的已读邮件计入累计。已被删除的历史已读邮件无法恢复，
-- 但至少从此刻起，计数不再随删除减少。
UPDATE user_stats SET mail_read_count = (
  SELECT COUNT(*)
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
   WHERE mb.user_id = user_stats.user_id AND m.read = 1
);
