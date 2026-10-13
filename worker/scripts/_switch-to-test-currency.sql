-- 切到「测试币」模式 + 给测试币池垫本 + 开闸（一次性运维，站长已确认）
--
-- 为什么测试币池要垫本：滑点 = 冲击系数 × 名义额 ÷ 池子余额。
-- 池子空 ⇒ 一笔小单就被自己推飞（这也是站长「怎么炒都是亏」的结构性原因之一）。
-- 测试币是游戏内货币，垫本不涉及任何真实积分。
INSERT INTO app_settings (key, value, updated_at)
VALUES ('game_currency', 'test', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- 手续费 10 → 5 bps（来回 0.2% → 0.1%）：这是当初把玩家整体拖亏的最大摩擦项
INSERT INTO app_settings (key, value, updated_at)
VALUES ('game_fee_open_bps', '5', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO app_settings (key, value, updated_at)
VALUES ('game_fee_close_bps', '5', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- 开闸
INSERT INTO app_settings (key, value, updated_at)
VALUES ('game_enabled', '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- 记下切换时刻：排行榜只统计它之后的成交（两种货币的 1 分不是一回事）
UPDATE game_market
   SET currency_since = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       pool_test_balance = pool_test_balance + 100000,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 1;

-- 池子流水同步记一笔（池子的账必须自平：Σ(delta WHERE currency='test') = pool_test_balance）
INSERT INTO game_pool_ledger (id, delta, balance_after, kind, user_id, ref, note, created_at, currency)
VALUES (
  lower(hex(randomblob(16))),
  100000,
  (SELECT pool_test_balance FROM game_market WHERE id = 1),
  'seed_deposit',
  NULL,
  'test-seed',
  '测试币池初始垫本（游戏内货币，不涉及真实积分）',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'test'
);
