-- 0099_point_orders_after_sale.sql
-- 积分商城：售后（退款）流程。
--
-- 背景（2026-10-02 站长要求）：
--   原流程是「下单 → 卖家交付 → 买家确认收货 → 结算」，退款入口只有管理员的「取消订单」。
--   于是买家在「卖家已交付但我没收到货」时无路可走，确认收货之后更是彻底没有退款入口。
--   现在按主流电商的售后模型补上：
--     买家申请退款 → 卖家处理（同意即退 / 拒绝）→ 买家可申请平台介入 → 管理员判定。
--
-- 订单状态刻意**不新增枚举值**：退款成立后订单仍是 `cancelled`（积分已原路退回买家，
-- 与管理员取消的语义完全一致），「这次退款是谁触发的、走到过哪一步」由售后的 5 个字段表达。
-- 好处是现有所有按 status 过滤的查询（到期收回、库存归还、限购计数）一行都不用改。
--
-- after_sale_status 取值：
--   NULL        没有售后在进行（也用作「撤销后归零」）
--   'requested' 买家已申请，等卖家处理
--   'rejected'  卖家拒绝，买家可申请平台介入
--   'platform'  待平台（管理员）判定 —— 也用于官方商品订单（没有卖家）
--   'closed'    平台判定「不予退款」，售后终结
--   'refunded'  已退款（订单同时变成 cancelled）
--
-- ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，每条只能跑一次。
-- ⚠️ 线上必须**逐条**手工执行 —— D1 一条命令里塞多条语句会静默不执行：
--     npx wrangler d1 execute doulor-mail --remote --command "ALTER TABLE ..."

ALTER TABLE point_orders ADD COLUMN after_sale_status TEXT;

ALTER TABLE point_orders ADD COLUMN after_sale_reason TEXT;

ALTER TABLE point_orders ADD COLUMN after_sale_note TEXT;

ALTER TABLE point_orders ADD COLUMN after_sale_requested_at TEXT;

ALTER TABLE point_orders ADD COLUMN after_sale_resolved_at TEXT;

-- 管理面板要按「待客服处理」捞单，加个索引（顺手也覆盖「待卖家处理」的查询）
CREATE INDEX IF NOT EXISTS idx_point_orders_after_sale
  ON point_orders (after_sale_status, after_sale_requested_at DESC);
