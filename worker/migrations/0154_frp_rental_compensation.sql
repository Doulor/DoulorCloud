-- 内网穿透改为「租用模式」：对原有 frp 权限持有者的一次性补偿（2026-10-13）
--
-- 背景：站长决定把内网穿透从「人工申请 + 手工panel建号」改为「积分租用」，
-- 并**彻底移除 `frp` 功能权限键**（租用不再需要任何预先授权）。
-- 原有 137 名持有该权限的用户因此失去既有资格，每人补偿 50 积分。
--
-- ⚠️ 人数是 **137**，不是 319。用 `permissions LIKE '%frp%true%'` 会误判：
--    形如 {"r2":false,"ai":true,"frp":false,"proxy":true} 的字符串里，
--    `"frp"` 之后还有 `"proxy":true`，宽松匹配会把它算成「有 frp 权限」。
--    所以这里一律用 json_extract 精确判定。
--
-- 幂等性：靠 point_transactions.dedup_key 的唯一索引。
--    重复执行时第 2 步一行都插不进去，第 3 步的重算也就没有任何影响。
--    前提是「余额 == 流水之和」——执行前已核对全站 726 个余额行，0 个不一致。

-- 1) 先补齐余额行（有 11 人此前从未获得过积分，没有 user_points 行）
INSERT OR IGNORE INTO user_points (user_id, balance, updated_at)
SELECT u.id, 0, '2026-10-13T00:00:00.000Z'
  FROM users u
 WHERE json_extract(u.permissions, '$.frp') = 1;

-- 2) 记流水（dedup_key 保证每人只记一次）
INSERT OR IGNORE INTO point_transactions
  (id, user_id, delta, balance, reason, detail, dedup_key, created_by, created_at)
SELECT lower(hex(randomblob(16))),
       u.id,
       50,
       COALESCE((SELECT balance FROM user_points p WHERE p.user_id = u.id), 0) + 50,
       'admin',
       '内网穿透改为租用模式的一次性补偿（50 积分）',
       'frp_migrate_50_20261013',
       NULL,
       '2026-10-13T00:00:00.000Z'
  FROM users u
 WHERE json_extract(u.permissions, '$.frp') = 1;

-- 3) 重算这些人的余额。
--    为什么不直接 `balance = balance + 50`：那样重复执行会重复加。
--    重算基于账本、天然幂等；账本一致性已在执行前核对过。
UPDATE user_points
   SET balance = (
         SELECT COALESCE(SUM(t.delta), 0)
           FROM point_transactions t
          WHERE t.user_id = user_points.user_id
       ),
       updated_at = '2026-10-13T00:00:00.000Z'
 WHERE user_id IN (
         SELECT user_id FROM point_transactions
          WHERE dedup_key = 'frp_migrate_50_20261013'
       );
