-- Doulor Cloud D1 迁移：临时分享箱纯文本互传
-- 在 0016 之上执行。
--
-- 纯文本互传不占用 R2：文字直接存 D1 的 tempbox_batches.text_content，
-- 接收码仍走同一套过期机制。文件互传照旧存 R2。

ALTER TABLE tempbox_batches ADD COLUMN text_content TEXT;