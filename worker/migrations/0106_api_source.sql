-- 公开 API「是否计入成就」的数据标记
--
-- 站长需求：API 调用产生的业务数据（DNS / 邮箱）默认**不计入**成就计数
-- （防止脚本刷成就点）。实现：给这两张表加 source 列，网页操作写 'web'、
-- API 调用写 'api'，成就计数按开关决定是否排除 'api'。
--
-- ⚠️ 线上 `d1_migrations` 是空的，逐条手工执行：
--   npx wrangler d1 execute doulor-mail --remote --command "<每条 SQL>"

-- DEFAULT 'web'：存量数据全部视为「网页创建」，向后兼容（不会突然丢成就）。
ALTER TABLE dns_records ADD COLUMN source TEXT NOT NULL DEFAULT 'web';
ALTER TABLE mailboxes ADD COLUMN source TEXT NOT NULL DEFAULT 'web';
