-- 一次性运维脚本（不是迁移，放在这里只是为了避免引号转义踩坑）。
--
-- 目的：把「在线投资」的行情归位到「初始是一条直线」。
--
-- 背景：噪声默认值从 4 bps 改成了 0（站长 2026-10-11 要求：没人交易时应当是
-- 一条直线，而不是看着像随机生成的历史）。但线上已经用旧的默认值跑出了
-- 一个多小时的噪声历史 —— 那一段留在图上就是「前面还是随机线、后面才是直线」，
-- 很难看也容易误会。所以在没有持仓、没有成交的时刻清掉它。
--
-- ⚠️⚠️ **绝不动 pool_balance**。
--     站长已经划拨了 1000 积分进做市池，那是真实积分（从他的账户扣过来的）。
--     删掉 game_market 行或把它重置成 0 = 把这 1000 积分凭空弄丢，
--     并且直接破坏守恒等式。本脚本只改「价格 / 锚 / 种子 / K 线 / 日内高低」，
--     与 worker/src/game-market.ts 的 resetMarket() 完全一致 ——
--     唯一的区别就是**不碰 pool_balance**。
--
-- 前置条件（已在执行前核对）：game_positions = 0、game_trades = 0。
-- 有持仓时不能这么干（等于把所有人瞬间重新定价）。

-- 1) 清掉噪声历史
DELETE FROM game_candles;

-- 2) 行情归位：价格回初始价、换新种子、tick_seq 清零、K 线窗口重开。
--    seed 用 randomblob 现生成一个 —— 反正噪声是 0，它只影响未来的可复现性。
UPDATE game_market
   SET price           = 100,
       anchor          = 100,
       tick_seq        = 0,
       last_tick_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       seed            = hex(randomblob(8)),
       candle_open_at  = strftime('%Y-%m-%dT%H:%M:00.000Z', 'now'),
       candle_open     = 100,
       candle_high     = 100,
       candle_low      = 100,
       candle_close    = 100,
       candle_volume   = 0,
       candle_trades   = 0,
       day_open_at     = strftime('%Y-%m-%dT%H:%M:00.000Z', 'now'),
       day_open        = 100,
       day_high        = 100,
       day_low         = 100,
       updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 1;
