-- 0151_game_test_currency.sql
-- 「在线投资」双货币：积分 / 测试币（站长 2026-10-11 要求）。
--
-- 站长原话：「添加一个测试货币，就是用测试币炒，然后在管理面板可选积分还是独立的货币」。
--
-- 设计要点（**钱必须彻底分账**，混用等于把真钱和游戏币放一个账上）：
--   1. 测试币有自己的余额表 `game_test_balances`，与 `user_points` 完全隔离 ——
--      测试币的任何加减都不会碰用户积分；
--   2. 测试币有自己的池子 `game_market.pool_test_balance` ——
--      真积分池 `pool_balance` 与它互不影响；
--   3. 货币模式由设置 `game_currency` 决定（points / test），管理面板可切换。
--
-- 池子流水表用 `ref` 列区分货币（'test' = 测试币，其它/空 = 积分），于是对账式变成：
--   · Σ(delta WHERE ref IS NULL OR ref <> 'test') = pool_balance
--   · Σ(delta WHERE ref = 'test')               = pool_test_balance
-- 之所以复用一张流水表：两者结构完全一样，分开建表只会让对账代码翻倍。
CREATE TABLE IF NOT EXISTS game_test_balances (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL DEFAULT 0,
  -- 首次领取测试币的时间（NULL = 还没领过）。用来做「只能领一次」。
  granted_at TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE game_market ADD COLUMN pool_test_balance INTEGER NOT NULL DEFAULT 0;

-- 货币切换的时间点：排行榜/统计只统计**切换之后**的成交，
-- 否则真积分时代的盈亏会和测试币时代的混在一张榜上（数字没法比）。
ALTER TABLE game_market ADD COLUMN currency_since TEXT;

-- 池子流水加货币标记：两种货币各自的流水必须能分别对账
--   Σ(delta WHERE currency='points') = pool_balance
--   Σ(delta WHERE currency='test')   = pool_test_balance
ALTER TABLE game_pool_ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'points';
