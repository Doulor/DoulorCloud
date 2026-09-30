-- 0079_rental_products.sql
-- 商品「计费方式」：买断（一次性）之外，支持**租用 / 定期**（有效 N 天，到期失效）。
--
-- 1) point_products 增加计费方式
--    · billing_mode —— 'one_time'（买断，默认）| 'rental'（租用）
--    · rental_days  —— 租期天数；billing_mode='rental' 时必填（1 ~ 3650）
--      买断商品该列为 NULL。
--
-- 2) point_orders 增加租期与到期处理
--    · billing_mode      —— 下单时的计费方式快照（'one_time' | 'rental'）。订单是**快照**，
--      商品事后被改成买断 / 被删掉都不该影响历史订单的展示，所以这里存一份。
--    · rental_days       —— 下单时的租期天数快照；买断订单为 NULL。
--    · expires_at        —— 租用订单的到期时间；买断订单恒为 NULL。
--      **在「交付生效」时才写入**（不是下单时）：
--        官方自动交付 → 下单交付成功那一刻
--        官方人工交付 → 管理员点「标记已发放」那一刻
--        用户商品     → 买家确认收货 / 管理员结算那一刻（担保结算即交付完成）
--      这样「卖家拖了 5 天才发货」不会白白吃掉买家的租期。
--    · renewed_from      —— 续费来源订单 id（本单是从哪一单顺延来的），仅用于追溯
--    · expire_handled_at —— 到期处理（收回权益 / 归还库存）的时间，**幂等标记**：
--      cron 每小时扫一次，只处理 expire_handled_at IS NULL 的行，重复跑不会重复收回。
--    · granted_feature   —— 本单**实际授予**的模块权限名（仅 delivery='feature' 时非空）。
--      到期收回时必须知道「这单给的是哪个权限」，而且**不能 JOIN point_products**
--      （商品可能已被删）。有了它，到期判断可以完全自包含。
--
-- 3) 到期收回规则（见 points-shop.ts 的 expireRentalOrders）
--    · delivery='feature'      → 收回权限，但**仅当用户没有别的未到期租用也在给同一个权限**时
--      （避免「续费单还在、旧单到期就把权限收掉」）。
--    · delivery='subscription' → 不主动动上游（订阅本身的有效期由 NewAPI 套餐决定），只记账。
--    · delivery='manual'       → 官方人工商品与**所有用户商品**：平台无法强制回收实物 / 服务，
--      只记账 + 在管理端提示，由买卖双方自行处理。
--    · delivery='quota' / 'invite_quota' → **不允许租用**（见 sanitizeProductInput）：
--      额度和邀请码额度是**一次性消耗品**，发出去就收不回来，「租用」没有意义。
--
-- 4) 租用商品的库存语义与买断不同：
--    · 买断：stock = 一共能卖几件，卖完为止。
--    · 租用：stock = **同时最多能租出几份**；下单占用 1 份，**到期或取消时归还 1 份**。
--      因此「租出去还会回来」，这与买断的「消耗掉就没了」是两回事。
--
-- ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，只能跑一次。
--    线上必须**逐条**手工执行 —— D1 的一条命令里塞多条语句会静默不执行。

ALTER TABLE point_products ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'one_time';

ALTER TABLE point_products ADD COLUMN rental_days INTEGER;

ALTER TABLE point_orders ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'one_time';

ALTER TABLE point_orders ADD COLUMN rental_days INTEGER;

ALTER TABLE point_orders ADD COLUMN expires_at TEXT;

ALTER TABLE point_orders ADD COLUMN renewed_from TEXT;

ALTER TABLE point_orders ADD COLUMN expire_handled_at TEXT;

ALTER TABLE point_orders ADD COLUMN granted_feature TEXT;

CREATE INDEX IF NOT EXISTS idx_point_orders_expiry
  ON point_orders (expires_at, status);
