-- 0169_perf_indexes.sql
-- 2026-10-22：给两个「按条件数行」的热点补复合索引，配合同一批的 SQL 重写。
--
-- 背景（D1 Insights 实测，7 天窗口）：
--   · group-map 的 don 子查询被 SQLite 规划成 `SEARCH d USING INDEX idx_donations_status`，
--     每个账号都重扫一遍全部 approved 捐献 → 528 × ~700 ≈ 37 万行/次；这个接口被
--     group-sync 每 20~30 秒调一次，7 天共读 74.7 亿行，占全库 **90%**。
--   · 积分商城商品列表的 sold_count 子查询同样选中 `idx_point_orders_status`，
--     72 个商品各扫一遍全部订单 → 2.7 万行/次，7 天 5.97 亿行。
--
-- 两条 SQL 已改成「先按 user_id / product_id 聚合，再 LEFT JOIN」
-- （见 worker/src/handlers/group-sync.ts、worker/src/points-shop.ts）。
-- 这里再补覆盖索引，给 getProduct、成就统计等其它「按 user_id / product_id 数行」
-- 的路径兜底，避免以后新增查询再退化成全表扫描。
--
-- 两张都是小表（donations 971 行、point_orders 429 行），建索引代价可忽略。
CREATE INDEX IF NOT EXISTS idx_donations_user_status_type
  ON donations (user_id, status, type);

CREATE INDEX IF NOT EXISTS idx_point_orders_product_status
  ON point_orders (product_id, status);
