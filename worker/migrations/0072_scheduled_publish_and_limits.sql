-- 定时发布（公告 + 活动）与活动限量总份数
--
-- 背景：管理员希望「先写好、到点自动发」。之前公告是发布即公开、活动只有
-- 开始/结束时间，没有「到点才出现并广播」的概念。
--
-- ⚠️ 线上 d1_migrations 是空的，迁移**靠手工执行**（永远别跑 `migrations apply`），
--    本文件只是留档。上线前记得把下面 SQL 单独在线上 D1 跑一遍。

-- 1) 公告：草稿 / 定时发布 / 已发布 三态 + 发布时间
--    status 语义：
--      draft     草稿，用户端不可见
--      scheduled 定时，到 publish_at 才转为 published（由 cron 处理）
--      published 已发布，用户端可见
--    旧数据一律回落 published（ADD COLUMN 的 DEFAULT 会填给已有行），行为不变。
--    notify_email：把「是否群发邮件」从请求参数变成持久化字段 ——
--    定时发布时创建请求早就返回了，cron 到点必须凭它决定发不发邮件。
ALTER TABLE announcements ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE announcements ADD COLUMN publish_at TEXT;
ALTER TABLE announcements ADD COLUMN published_at TEXT;
ALTER TABLE announcements ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 0;

-- 2) 活动：定时发布列 + 限量总份数
--    max_claims NULL = 不限量；有值时先到先得，领满即拒绝。
ALTER TABLE events ADD COLUMN publish_at TEXT;
ALTER TABLE events ADD COLUMN published_at TEXT;
ALTER TABLE events ADD COLUMN max_claims INTEGER;
