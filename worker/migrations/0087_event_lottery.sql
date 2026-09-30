-- 0087 活动抽奖：新增「参与类型 = 抽奖」所需的开奖时间列
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0087_event_lottery.sql
--
-- 设计：抽奖不需要新表 —— 配置全部塞进现有的
--   events.condition_params = { winners, pool, mode }   （中奖人数 / 奖池积分 / 平均或随机）
--   events.max_claims                                   （参与人数上限，留空不限）
-- 只有「是否已开过奖」需要一个新列：drawn_at 非空 = 已开奖（同时是开奖幂等锁）。

ALTER TABLE events ADD COLUMN drawn_at TEXT;
