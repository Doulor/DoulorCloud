-- 0108_shop_codes_daily.sql
-- 积分商城两项（用户反馈 2026-10-03）：
--   1. a977d1cf「商城上架增加自动发货」——提供「卡密/Key」交付方式：
--      管理员批量粘贴卡密（一行一个），用户下单时原子取出一条未使用的交付。
--   2. 6e002b5e「限量每日不补一点么」——提供「每日限量」：商品可设每天最多卖出多少，
--      按自然日计数，隔天自动恢复（不需要定时任务，读取时按当天日期取）。

-- 卡密池
CREATE TABLE IF NOT EXISTS point_product_codes (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  code        TEXT NOT NULL,
  -- 被谁用掉（NULL = 未使用）
  used_by     TEXT,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ppc_product_unused
  ON point_product_codes (product_id, used_at);

-- 每日销量计数：按 (商品, 自然日) 累计，隔天自然归零
CREATE TABLE IF NOT EXISTS point_product_daily_sales (
  product_id  TEXT NOT NULL,
  date        TEXT NOT NULL,
  sold        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, date)
);

-- 商品的每日限量（NULL = 不限）
ALTER TABLE point_products ADD COLUMN daily_limit INTEGER;
