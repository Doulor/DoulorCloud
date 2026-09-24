-- 0038_announcement_popup.sql
-- 公告弹窗：管理员创建公告时可配置「是否弹窗提醒」及弹窗行为。
--
-- popup_mode 取值：
--   'none'  —— 不弹窗（默认，仅显示在概览页「网站动态」卡片）
--   'once'  —— 每个用户只弹一次（关闭后不再弹，本地记忆）
--   'every' —— 每次进入都弹，但允许用户点「不再显示」永久屏蔽
--
-- 「关闭/不再显示」的记忆存在浏览器 localStorage，不落库（无需后端记录
-- 每个用户看没看过，避免为弹窗单独建一张大表）。

ALTER TABLE announcements ADD COLUMN popup_mode TEXT NOT NULL DEFAULT 'none';
