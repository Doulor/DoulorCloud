-- 0125_profile_design.sql
--
-- 个人名片「设计系统」（2026-10-07 站长放权大规模重构）：
--   把排版/间距/形状/材质/配色从「11 套写死的主题 CSS」解放成用户可逐项调节
--   的参数。所有参数存一份扁平 JSON 到本列，不再为每个开关加独立列。
--
-- 语义：
--   '{}' = 完全跟随主题（默认）⇒ 与改动前逐像素一致，存量名片不需要回填。
--   未知键 / 非法值在 sanitizeDesign 里被丢弃，回退到主题值。
--
-- ⚠️ 修复附带雷：`handlers/profile.ts` 的 enableProfile INSERT 已引用本列，
--    但线上库没有 ⇒ 新建名片会 500。本迁移补齐该列，一并修复。
-- ⚠️ 线上 D1 由站长手动执行（本项目从不跑 migrations apply）。

ALTER TABLE profiles ADD COLUMN design TEXT NOT NULL DEFAULT '{}';
