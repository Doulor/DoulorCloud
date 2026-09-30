-- 0078_user_shop.sql
-- 用户商城：让普通用户也能上架自己的商品，别人用积分兑换，积分归卖家。
--
-- 1) point_products 增加归属与审核
--    · owner_id / owner_name —— NULL = 官方商品（站长上架）；非 NULL = 用户商品。
--      owner_name 是上架时的用户名快照，卖家改名后老商品仍显示当时的名字。
--    · review_status —— 用户商品必须审核通过才会出现在用户端；
--      'pending' = 待审核 / 'approved' = 已通过 / 'rejected' = 已拒绝。
--      **官方商品恒为 'approved'**，不受审核流程影响。
--    · review_note / reviewed_at —— 审核意见与时间（拒绝时把理由写给用户看）。
--
-- 2) point_orders 增加卖家与结算时间
--    · seller_id / seller_name —— 下单时的卖家快照；NULL = 官方商品订单。
--    · settled_at —— 积分真正结算给卖家的时间。
--
-- 为什么用户商品走**担保**而不是「下单即给钱」：
--   用户商品只能人工交付，如果下单就把积分给卖家，卖家收了分不发货，
--   买家只能找站长手动退 —— 而积分可能已经被卖家兑换成中转站余额，退不回来。
--   担保流程下积分在下单时只是「从买家账上扣掉、暂存在平台」，
--   卖家交付 + 买家确认收货后才结算；中途出问题直接取消订单、原路退回，
--   卖家从未拿到过这笔积分，不需要从他账上倒扣。
--   因此订单状态多一个 'settled'（已结算）。官方商品订单不受影响，
--   delivered 仍是终态。
--
-- ⚠️ 用户商品只允许 'manual' 交付方式：自动发权限 / 订阅 / 额度是平台能力，
--    不能让用户自己创建这种商品（否则谁都能给自己或别人开权限）。
--
-- ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，只能跑一次。
--    线上必须**逐条**手工执行 —— D1 的一条命令里塞多条语句会静默不执行。

ALTER TABLE point_products ADD COLUMN owner_id TEXT;

ALTER TABLE point_products ADD COLUMN owner_name TEXT;

ALTER TABLE point_products ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';

ALTER TABLE point_products ADD COLUMN review_note TEXT;

ALTER TABLE point_products ADD COLUMN reviewed_at TEXT;

ALTER TABLE point_orders ADD COLUMN seller_id TEXT;

ALTER TABLE point_orders ADD COLUMN seller_name TEXT;

ALTER TABLE point_orders ADD COLUMN settled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_point_products_owner
  ON point_products (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_point_products_review
  ON point_products (review_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_point_orders_seller
  ON point_orders (seller_id, created_at DESC);
