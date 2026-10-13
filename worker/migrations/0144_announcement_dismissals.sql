-- 公告「不再显示 / 已读」的用户级持久记录（2026-10-10）。
--
-- 背景：公告弹窗的「不再显示」原来只写浏览器 localStorage
-- （`doulor:ann-seen:<id>`）。这条记录有三个现实缺口：
--   1. 换设备 / 清浏览器数据 / 卸载重装 App（WebToApp 的 WebView 存储随应用走）
--      ——记录一没，弹窗就回来，用户感受是「点了不再显示，过阵子又弹」；
--   2. 同一个账号在另一台机器上从未点过 —— 换个设备照弹；
--   3. 站长在后台看到的「已读」口径不可对账（服务端根本没有这个事实）。
--
-- 这张表把「某用户对某公告点过不再显示 / 已读」这件事落在服务端，
-- 与本仓库既有的「用户级事实落库」原则一致（同 users 的各类偏好与占位记录）。
-- localStorage 仍然保留：它是**首屏即时生效**的快读缓存，避免弹窗闪一下再收回；
-- 服务端这份是**真相源**，两端任缺其一以服务端为准（见 dashboard.tsx 的
-- AnnouncementPopup：`dismissed || localStorage` 才算已读）。
--
-- 粒度：(user_id, announcement_id) 复合主键 —— 记录是「谁对哪条」，天然幂等，
-- 重复点不再显示只是一次无副作用的 upsert。
--
-- 为什么不加外键 / 不做级联：公告被删除后，这份记录留着无害（id 不会复用），
-- 而 D1 上外键约束会拖慢写入。用户注销时由用户清理流程按 user_id 一并删。
--
-- ⚠️ 本迁移是**纯建表**（IF NOT EXISTS），可安全重跑。
-- ⚠️ 线上部署顺序：**先跑迁移，再部署后端**。反了的话 dismiss 接口会报
--    `no such table: announcement_dismissals`，前端把失败吞掉（弹窗照常关掉、
--    只是这一条没落服务端），表现为「这次点了，下次还弹」—— 正是本表要修的现象。

CREATE TABLE IF NOT EXISTS announcement_dismissals (
  user_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, announcement_id)
);

-- 列表接口按 user_id 一次性捞「我屏蔽过哪些」，走这个索引
CREATE INDEX IF NOT EXISTS idx_announcement_dismissals_user
  ON announcement_dismissals (user_id);
