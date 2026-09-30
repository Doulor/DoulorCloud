-- 0075_points_shop.sql
-- 积分商城：商品（point_products）与订单（point_orders）。
--
-- 背景：积分原先只能「按比例兑换成中转站余额」，入口在积分页单独一块。
-- 现在把兑换也当成商城里的一个商品位，并新增可由管理员自由上架的商品。
--
-- 交付方式 delivery：
--   'quota'  —— 下单后自动充入 AI 中转站余额（金额取 quota_yuan，元）
--   'manual' —— 只生成一张「待发放」订单，由管理员在后台手动处理
--
-- 积分在**下单时立刻扣除**：自动充值失败会退回积分并把订单置 cancelled；
-- manual 商品则一直挂着 pending 直到管理员点「标记已发放」。
--
-- 库存 stock：NULL = 不限量；有限量时靠条件 UPDATE（stock > 0）原子扣减防超卖。
-- 限购 per_user_limit：NULL / 0 = 不限；统计口径是「非 cancelled 的订单数」。

CREATE TABLE IF NOT EXISTS point_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  /** 售价（积分，正整数） */
  price INTEGER NOT NULL,
  /** 剩余库存；NULL = 不限量 */
  stock INTEGER,
  /** 每人限购件数；NULL / 0 = 不限 */
  per_user_limit INTEGER,
  /** 'quota' = 自动充入中转站余额；'manual' = 人工发放 */
  delivery TEXT NOT NULL DEFAULT 'manual',
  /** delivery='quota' 时每件充入多少元 */
  quota_yuan REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS point_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  /** 下单时的用户名快照（用户被删后订单仍可读，不需要 JOIN users） */
  username TEXT NOT NULL,
  product_id TEXT,
  /** 下单时的商品名与单价快照（商品改价/删除都不影响历史订单） */
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  delivery TEXT NOT NULL,
  quota_yuan REAL,
  /** 'pending' = 待发放；'delivered' = 已发放；'cancelled' = 已取消（自动充值失败，积分已退） */
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  /** 自动充值的订单为 NULL；人工发放的记录管理员 id */
  delivered_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_point_orders_user
  ON point_orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_point_orders_status
  ON point_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_point_products_sort
  ON point_products (sort DESC, created_at DESC);
