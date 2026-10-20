-- 0168_gallery_comments_align_community.sql
--
-- 把造物集评论**对齐社区广场**（2026-10-21 站长要求：「和社区完全一致」）。
--
-- 0167 建表时只做了「能评论」的最小集，这次补齐社区那套能力的存储：
--   · `edit_count` / `updated_at` —— 评论可以改，但次数有上限
--     （上限值复用设置项 `community_comment_edit_limit`，两个场景一个口径）
--
-- 评论点赞**不新建表**：`post_likes` 本来就是多态设计
-- （`target_type` 已经支持 'post' | 'comment'），加一个 'gallery_comment'
-- 就是纯数据层面的事，不需要 schema 变更。少一张表少一处要维护的一致性。
--
-- ⚠️ SQLite 的 ADD COLUMN 不支持 `IF NOT EXISTS`，所以这两条在重复执行时会报
--    duplicate column。迁移只跑一次，这是标准做法；手工重跑请忽略该错误。

ALTER TABLE gallery_comments ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;

-- 最近一次修改时间；从未改过为 NULL（前端据此决定要不要显示「已编辑」）
ALTER TABLE gallery_comments ADD COLUMN updated_at TEXT;

-- 点赞查询要按 (target_type, target_id) 走索引 —— post_likes 上已有的
-- idx_likes_target 正好覆盖 'gallery_comment'，无需另建。
