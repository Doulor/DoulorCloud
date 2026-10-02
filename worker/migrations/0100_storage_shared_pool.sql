-- 网盘存储模型重构（2026-10-02 站长要求）：
--   从「每个用户保留一份固定配额（专属空间）」改成「桶 = 共享池」。
--
--   · 新增 capacity_bytes：桶的**真实容量**（默认 Cloudflare R2 免费额度 10 GB）。
--     桶满 = 所有人都不能再传；桶没满 = 用户可以一直传到自己的个人限额为止。
--   · 原有 quota_per_user 语义改为「每人最大上传限额」（软上限，不再当作「保留空间」）。
--     开通网盘但不存任何文件 ⇒ used_bytes = 0，不占任何名义位置。
ALTER TABLE r2_buckets ADD COLUMN capacity_bytes INTEGER NOT NULL DEFAULT 10737418240;
