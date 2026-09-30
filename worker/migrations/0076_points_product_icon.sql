-- 0076_points_product_icon.sql
-- 给积分商城的商品加一个「图标」字段。
--
-- 背景：原先商品只能填 imageUrl（外链图片），站长上架时得先自己找图、找地方放。
-- 现在允许直接从一个内置图标库里选一个图标当封面，商品卡片上图标会占很大一块。
--
-- 取值是 lucide 图标名（slug，如 'gift' / 'credit-card' / 'share-2'），
-- 前端 src/lib/shop-icons.ts 里映射成组件；**未命中就回退成一个通用礼盒图标**，
-- 不会崩、也不会空着。所以这里不需要外键或枚举约束。
--
-- 与 image_url 的关系：**image_url 优先**（站长填了真实图片就用图片），
-- 没填 image_url 才用 icon；两个都没填则用默认图标。
--
-- ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，这条**只能跑一次**，
--    重复执行会报 duplicate column name（无害，忽略即可）。

ALTER TABLE point_products ADD COLUMN icon TEXT;
