-- 0163_comment_edit_delete.sql
-- 社区评论「可编辑 / 可删除留痕」（2026-10-17 站长要求）。
--
-- 1. edit_count：这条评论被成功修改过几次。前端在评论右上角显示「已修改 N 次」，
--    后端按站点设置 community_comment_edit_limit（默认 2）拒绝超额修改。
--    为什么单独存计数而不是每次 COUNT(comment_edits)：评论编辑不保留历史正文
--    （站长只要求次数），一个整数就够，读列表时也不用多一次 JOIN。
-- 2. updated_at：最近一次修改时间；未修改过为 NULL，前端可据此显示「编辑于」。
--
-- 删除沿用既有的 deleted_at 软删列，但**同时清空 body**（内容要消掉），
-- 列表接口把这类行作为「该评论已删除」占位返回，保证回复树不断链。
ALTER TABLE post_comments ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE post_comments ADD COLUMN updated_at TEXT;
