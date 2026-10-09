-- 0137_lab_likes_cover.sql
-- 造物集：作品点赞（每人一赞）+ 作品封面（上传图片，替代单一的 emoji）。
--
-- 1) 点赞明细表
--    用 (project_id, user_id) 做**复合主键**，让「一个用户对一个作品只能有一票」
--    由数据库保证，而不是靠应用层先查再写（并发下那种写法必然出错）。
--    `lab_projects.likes` 继续当计数字段，但它只是这份明细的缓存 ——
--    写路径统一用「先改明细、再按明细重算计数」，绝不让两者各自漂移。
CREATE TABLE IF NOT EXISTS lab_project_likes (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

-- 按用户查「我赞过哪些作品」用（大厅列表要标出已赞的）
CREATE INDEX IF NOT EXISTS idx_lab_project_likes_user ON lab_project_likes (user_id);

-- 2) 作品封面
--    R2 对象 key（存在平台桶），NULL = 没上传，前端回退到 emoji 图标。
--    只存 key 不存完整 URL：桶可能换，URL 由读取端现拼（跟 lab_projects.bucket_id 一个道理）。
ALTER TABLE lab_projects ADD COLUMN cover_key TEXT;

-- 3) 审核相关索引：管理端要看「待审核」队列
CREATE INDEX IF NOT EXISTS idx_lab_projects_review ON lab_projects (visibility, updated_at DESC);
