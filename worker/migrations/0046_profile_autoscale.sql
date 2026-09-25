-- Doulor Cloud D1 迁移：名片自动缩放
-- 在 0045 之上执行（保持幂等）。
--
-- 背景：模块开得多时名片内容会超出视口，而旧的 CSS（body height:100% +
-- justify-content:center）会把溢出量平均分到上下两侧，上侧那部分滚不到，
-- 表现为「头像和昵称永久看不见」。渲染层的裁切问题已在 profile-page.ts 里
-- 改成 height:auto + safe center 修掉；本迁移提供配套的「自动缩放」，
-- 让内容真的能一屏放下。
--
-- 三列的分工：
--   scale_mode   'off'  = 不缩放，固定用 scale_manual 的比例
--                'auto' = 内容超出视口时按比例缩小到刚好放下（下限 scale_min）
--   scale_min    自动缩放的下限（百分比）。内容再多也不会小于这个比例，
--                避免文字小到不可读。
--   scale_manual 基准缩放比例（百分比）。两种模式下都是「起点」：
--                auto 只会在此基础上继续缩小，不会放大（用户要求「超出才缩」）。
--
-- 默认 auto + 100 + 下限 50：存量名片里内容超出的那些会立刻恢复正常显示，
-- 内容不超出的名片算出来就是 100%，观感完全不变。

ALTER TABLE profiles ADD COLUMN scale_mode   TEXT    NOT NULL DEFAULT 'auto';
ALTER TABLE profiles ADD COLUMN scale_min    INTEGER NOT NULL DEFAULT 50;
ALTER TABLE profiles ADD COLUMN scale_manual INTEGER NOT NULL DEFAULT 100;
