-- 0146_lab_project_pinned.sql
-- 造物集：**管理端置顶**（2026-10-10 站长要求）。
--
-- 置顶的作品无论用户选哪种排序，都排在最前面 —— 所以排序 SQL 里第一顺位是它。
--
-- ⚠️ 用「时间戳」而不是布尔：
--   · NULL = 没置顶；非空 = 置顶时间。
--   · 好处是置顶的作品之间**按置顶时间倒序**（后置顶的在最前），
--     而且将来想加「置顶到期」只多一个条件，不用改表。
--
-- ⚠️ SQLite 的 `ALTER TABLE ADD COLUMN` 不能加 NOT NULL 且无默认值的列；
--    这里可空、无默认 ✅ 安全。旧行自动是 NULL（= 未置顶）✅

ALTER TABLE lab_projects ADD COLUMN pinned_at TEXT;
