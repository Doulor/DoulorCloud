-- 一次性运维脚本：回退「在线投资」对所有人积分的影响（站长 2026-10-11 要求）。
--
-- 目标：把每个人**因为炒币亏掉/赚到的**积分还回去，其它任何积分变动（商城、捐献、
--       活动、发分……）一律不动。也就是说：只回退 reason 属于本游戏的流水。
--
-- 为什么这样做是"精确回到炒币前"：
--   `point_transactions` 记录了**每一次**积分变动，游戏的变动只用了三个 reason：
--     game_open    （开仓：扣保证金进托管 + 扣开仓手续费进池子）
--     game_settle  （平仓/追缴：退还保证金 + 盈亏 ± 手续费）
--     game_pool    （站长划拨垫本/抽回）
--   于是每个用户的 `net = Σ 这三种 delta` 就是"游戏一共让他的积分变了多少"。
--   给他补 -net，余额就回到了没玩过这个游戏的状态 —— 不需要任何猜测。
--
-- 钱从哪来：池子余额 + 在仓保证金（托管）。回退后：
--   · 在仓仓位标记为 rolled_back（托管清零；它们的保证金已经算在 net 里被补回去了）；
--   · 池子扣掉 (补出去的钱 − 释放的托管)。**不把池子清零**，因为池子里有 200 分是
--     历史平仓段的残差（与玩家扣款对不上，见 HANDOFF §24.22）—— 那 200 留在池子里，
--     全站总分才一分不差（守恒）。
--
-- 幂等：脚本一开始 CREATE TABLE game_rollback_v1_plan，重复执行会因为表已存在而中止；
--       补偿流水的 dedup_key 也有唯一约束兜底。

-- ============ 0) 先停掉新开仓（避免一边回退一边有人下单）============
UPDATE app_settings
   SET value = '0', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE key = 'game_enabled';

-- ============ 1) 备份（回滚用）============
CREATE TABLE game_rollback_v1_balances AS
  SELECT user_id, balance, updated_at FROM user_points;

CREATE TABLE game_rollback_v1_positions AS
  SELECT * FROM game_positions;

CREATE TABLE game_rollback_v1_plan AS
  SELECT user_id, SUM(delta) AS net
    FROM point_transactions
   WHERE reason IN ('game_open', 'game_settle', 'game_pool')
   GROUP BY user_id
  HAVING SUM(delta) <> 0;

-- ============ 2) 补偿流水（用户看到的账单里会有这一行）============
INSERT INTO point_transactions (id, user_id, delta, balance, reason, detail, dedup_key, created_at)
SELECT lower(hex(randomblob(16))),
       p.user_id,
       -p.net,
       u.balance - p.net,
       'game_rollback',
       '回退「在线投资」盈亏与手续费（其他积分变动不受影响）',
       'game:rollback:v1:' || p.user_id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM game_rollback_v1_plan p
  JOIN user_points u ON u.user_id = p.user_id;

-- ============ 3) 余额回退 ============
UPDATE user_points
   SET balance = balance - (SELECT net FROM game_rollback_v1_plan WHERE user_id = user_points.user_id),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE user_id IN (SELECT user_id FROM game_rollback_v1_plan);

-- ============ 4) 在仓仓位作废（托管清零）============
UPDATE game_positions
   SET status = 'rolled_back',
       closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       note = '回退：按站长要求撤销本轮投资'
 WHERE status = 'open';

-- ============ 5) 池子扣减（留下历史残差，保证全站总分不变）============
--   扣减额 = 补给玩家的总额 − 释放出来的托管
UPDATE game_market
   SET pool_balance = MAX(
         0,
         pool_balance - (
           (SELECT COALESCE(SUM(-net), 0) FROM game_rollback_v1_plan)
           - (SELECT COALESCE(SUM(margin), 0) FROM game_rollback_v1_positions WHERE status = 'open')
         )
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 1;

-- 池子流水同步记一笔（池子的账必须自平：Σdelta = pool_balance）
INSERT INTO game_pool_ledger (id, kind, delta, balance_after, user_id, position_id, note, created_at)
SELECT lower(hex(randomblob(16))),
       'adjust',
       -( (SELECT COALESCE(SUM(-net), 0) FROM game_rollback_v1_plan)
          - (SELECT COALESCE(SUM(margin), 0) FROM game_rollback_v1_positions WHERE status = 'open') ),
       (SELECT pool_balance FROM game_market WHERE id = 1),
       NULL, NULL,
       '回退玩家投资盈亏',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
