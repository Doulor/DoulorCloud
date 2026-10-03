-- 0109_post_categories.sql
-- 社区广场帖子分类（用户反馈 2026-10-03）：闲聊 / 求助 / 资源共享，默认闲聊。
-- 加一列 category，默认 'chat'（老帖子自动归入闲聊，不破坏历史数据）。

ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT 'chat';
