-- ⚠️ 编号说明：本文件原名 0024_r2_bucket_kind.sql，因 0023_r2_buckets.sql
-- 改名（撞号）而顺延为 0026。内容已应用到线上。
-- 桶用途区分：平台数据桶 vs 用户网盘桶
--
-- 背景：网站自身的数据（名片头像/背景/音乐、临时分享箱）与用户网盘文件
-- 应该分开存放：
--   - 平台数据桶（kind='platform'）：只在 Doulor Cloud 账户，存 profiles/ 与 temporary/
--   - 用户网盘桶（kind='user'）：adoulor / bdoulor 等，存 <用户名>/ 前缀，参与多桶分配
--
-- 这样用户网盘的「每桶 8 人 × 1 GiB」配额不会被平台数据挤占，
-- 平台数据的容量也独立核算。
--
-- 默认 'user' 保持向后兼容：已存在的 r2_buckets 行（若有）语义不变。

ALTER TABLE r2_buckets ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';