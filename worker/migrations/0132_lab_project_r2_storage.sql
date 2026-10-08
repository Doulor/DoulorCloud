-- 0132_lab_project_r2_storage.sql
-- 网页实验室：作品文件内容从 D1 迁到 R2。
--
-- 背景：D1 免费版单个数据库上限 500MB，而作品文件（HTML/CSS/JS）直接塞在
-- lab_projects.files 里会很快吃掉这个额度。改存 R2（平台桶），D1 只留
-- 「文件清单」（路径 → 大小），既省空间也避免整表被撑大（行越大扫描越慢）。
--
-- storage 列的含义：
--   'd1' → files 是 {"path": "<文件内容>"}          历史数据，读取时兼容
--   'r2' → files 是 {"path": {"size": N}}           内容在 R2：
--          lab/<user_id>/<project_id>/<path>
--
-- 历史行默认 'd1'，读取路径不变；重新保存一次即自动迁到 R2（惰性迁移）。

ALTER TABLE lab_projects ADD COLUMN storage TEXT NOT NULL DEFAULT 'd1';
