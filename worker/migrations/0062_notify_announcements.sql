-- 0062_notify_announcements.sql
-- 通知偏好拆分：原 notify_enabled 只管「个人相关通知」（捐献回复/反馈回复/社区回复等），
-- 新增 notify_announcements 管「站点统一公告」的邮件通知。
--
-- 为什么拆：以前发信依赖 CF destination（只能发已验证邮箱），所以通知都绑在 email_verified 上。
-- 现在有 Posthorn/Brevo 能发任意邮箱，通知不再需要验证 —— 改为由用户的两个偏好开关决定：
--   · notify_announcements（默认 1）= 是否接收站点公告推送
--   · notify_enabled（默认 1）= 是否接收个人相关通知

ALTER TABLE users ADD COLUMN notify_announcements INTEGER NOT NULL DEFAULT 1;
