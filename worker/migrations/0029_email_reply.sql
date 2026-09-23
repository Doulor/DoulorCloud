-- 0029_email_reply.sql
-- 网页端「回信」功能：保存原邮件的 RFC Message-ID。
--
-- 背景：入站邮件此前只存了 from/subject/正文，把 MIME 里的 `Message-ID` 丢掉了。
-- 而回信时要设置 `In-Reply-To` / `References` 才能让对方邮件客户端把两封信
-- 归到同一会话（否则在对方邮箱里是两封互不相干的信）。
--
-- 可空：迁移之前的存量邮件没有这个值，回信时留空即可（只是不串会话，不影响发送）。

ALTER TABLE messages ADD COLUMN rfc_message_id TEXT;
