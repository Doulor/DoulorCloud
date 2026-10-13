-- 0152_lab_project_slug.sql
-- 「造物集」作品的可分享链接支持**自定义页面名**：tyu.me/p/<slug>
--
-- 背景：slug 机制本来就有（`slugify()` 从作品名自动生成），但有两个限制让它不能当链接用：
--   1. **只在「同一用户内」唯一** —— 而 `/p/<slug>` 这种 URL 里没有用户信息，
--      两个用户都叫 `starwar` 就会撞车；
--   2. **每次保存都会被重新生成** —— 用户手改过的名字会被覆盖掉。
-- 所以这里做两件事：给「已公开作品」的 slug 建**全局唯一索引**，并加一个「用户手改过」的锁标记。
--
-- ⚠️ 建唯一索引前必须先把**存量冲突**消掉（同 slug 的两个公开作品），
--    否则索引建不上（这是典型的「迁移在生产库上跑一半失败」）。规则：后发布的加 id 前缀。

-- 1) 锁标记：1 = 用户手改过，保存作品时不再自动重算 slug
ALTER TABLE lab_projects ADD COLUMN slug_locked INTEGER NOT NULL DEFAULT 0;

-- 2) 存量去重：同一 slug 有多个**公开**作品时，保留最早发布的，其余改成 <slug>-<id前6位>
UPDATE lab_projects
   SET slug = slug || '-' || substr(id, 1, 6)
 WHERE visibility = 'public'
   AND slug <> ''
   AND id NOT IN (
     SELECT keep_id FROM (
       SELECT MIN(id) AS keep_id, slug AS s
         FROM lab_projects
        WHERE visibility = 'public' AND slug <> ''
        GROUP BY slug
     ) t WHERE t.s = lab_projects.slug
   );

-- 3) 公开作品的 slug 全局唯一（部分索引：未公开/空 slug 不参与）
CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_projects_public_slug
  ON lab_projects(slug) WHERE visibility = 'public' AND slug <> '';
