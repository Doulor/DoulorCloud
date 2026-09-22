-- Doulor Cloud D1 迁移：网盘默认分享链接前缀
-- 用户可指定「复制直链时默认使用哪个前缀」，为空则用默认的 /dl/<用户名>/。
ALTER TABLE storage_accounts ADD COLUMN default_prefix_id TEXT;
