-- 0133_lab_project_bucket.sql
-- 网页实验室：记录作品文件实际落在**哪个 R2 桶**。
--
-- 为什么必须记下来：作品文件优先存进「用户自己的网盘桶」（storage_accounts.bucket_id），
-- 没开通网盘的用户才回退到平台桶。用户以后换桶 / 网盘账号被重新分配时，
-- 如果读取端每次都按「当前该用户的桶」去猜，老作品就会凭空消失。
-- 存下当时的桶 id，读写删都认它，才是稳的。
--
-- NULL = 该作品还没落过 R2（storage='d1' 的历史行，或 R2 未配置时的回退行）。

ALTER TABLE lab_projects ADD COLUMN bucket_id TEXT;
