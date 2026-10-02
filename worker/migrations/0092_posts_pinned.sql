-- 社区帖子置顶（2026-10-01 站长要求）
--
-- 用途：管理员/站长把重要帖子（公告、活动、规则）钉在社区广场最前面。
-- 列表排序改为 `pinned DESC, created_at DESC`，置顶内部仍按时间倒序。
--
-- 只存「钉没钉」这一个布尔，不存置顶时间/置顶人：
-- 需要审计时走 audit 表（接口会写一条），不必在业务表里冗余。

ALTER TABLE posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
