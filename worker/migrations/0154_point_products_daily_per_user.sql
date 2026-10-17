-- 商品新增「每日每人限购」：同一个用户每个自然日最多买几件（NULL / 0 = 不限）。
--
-- 与现有三个维度的区别：
--   stock                —— 总库存
--   per_user_limit       —— 累计每人限购（一辈子最多几件）
--   daily_limit          —— 每日**全站**限量（今天总共最多卖几件）
--   daily_per_user_limit —— 每日**每人**限购（你个人今天最多买几件）← 本次新增
--
-- 日期口径与 daily_limit 完全一致（站点时区日，见 points-shop.ts 的
-- siteDayString + siteOffsetHours）；不一致会出现"商品说还有货、用户却被拦"。
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0154_point_products_daily_per_user.sql

ALTER TABLE point_products ADD COLUMN daily_per_user_limit INTEGER;
