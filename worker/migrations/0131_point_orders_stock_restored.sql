-- 积分商城：库存归还的订单级幂等键（2026-10-08）
--
-- 背景：归还库存有两条路径会碰到同一张单 —— 退款（points-shop.ts 的
-- refundOrderCore）与到期 cron（expireRentalOrders）。旧实现用调用方快照的
-- expire_handled_at 判断「还过没有」，而 cron 会在两次 await 之间把标记写掉，
-- 退款那侧的快照仍是 NULL ⇒ 两边各还一次，**一件商品的库存凭空 +1**
-- （探针实测稳定复现：stock 1 → 2）。
--
-- 修法：新增 stock_restored（0/1）作为订单级原子占位，抢到占位的那一方才真的
-- 把库存 +1。判据从「调用方读到的快照」换成「库里的原子占位」——与 PR #30
-- （确认收货 × 售后退款）同一条原则。
--
-- 为什么是 0/1 而不是时间戳：历史订单里没有「库存是什么时候还的」这个事实，
-- 只有「还过 / 没还过」。占位只需要这个布尔量，不伪造时间。
--
-- 执行方式（线上不跑 migrations apply）：**先跑迁移，再部署后端**。
-- 反了的话 restoreStockForOrder 会报 `no such column: stock_restored`：
--   · cron 侧：记进 errors 并跳过该单，下一小时重试（可自愈）；
--   · **退款侧不可自愈** —— 此刻钱已退（第 2 步）、订单已是 cancelled，第 3 步抛错后
--     既不在 cron 扫描范围（status IN ('delivered','settled')），也无法重试
--     （refundOrderCore 开头的 status==='cancelled' 守卫直接 409）⇒ 这份库存永久不还。
--     所以「先迁移」是硬前置，不是建议。
-- 刻意不加 try/catch 兜底 —— 那只会把「没跑迁移」这个真实部署错误藏起来。
--
-- ⚠️ **部署完成后请再跑一次下面两条回填 UPDATE**（只跑 UPDATE，不要重跑 ALTER）。
--    原因：迁移与部署之间有个窗口 —— 新列已就位、线上仍是旧代码，旧 cron 在这期间
--    还了库存却不会写 stock_restored。这段窗口内被 cron 处理过的单，回填时还是 0，
--    之后被退款就会**再还一次**。部署后补跑一次即可覆盖（按值幂等，见下）。
--
--   cd worker && npx wrangler d1 execute doulor-mail --remote --config wrangler.toml \
--     --command="UPDATE point_orders SET stock_restored = 1 WHERE expire_handled_at IS NOT NULL; \
--                UPDATE point_orders SET stock_restored = 1 WHERE status = 'cancelled';"
--
-- ⚠️ `--config wrangler.toml` 不能省：仓库用 toml，wrangler 默认找 jsonc，
--    省了会报 `Couldn't find a D1 DB with the name or binding 'doulor-mail' in your
--    wrangler.jsonc file.`（2026-10-08 在 wrangler 4.136.3 上实测复现）。
--
-- ⚠️ 本迁移**只允许跑一次**：ALTER 非幂等，重跑报 `duplicate column name`。
--    两条回填 UPDATE 重跑**结果不变**（值本来就对），但 `changes()` 会报告**全部
--    匹配行**而不是 0 —— SQLite 的 changes() 计的是被语句处理的行数，不是「值真的
--    变了」的行数（实测重跑一条回填报 n=1）。别拿 changes 判断是否需要重跑。
--
-- ⚠️ 不要写进 worker/schema.sql：ALTER 非幂等，写进基线会让「schema.sql +
--    迁移链」的测试环境重复加列而报错（见 schema.sql:415 的既有约定）。
--
-- 回填判据（覆盖「历史上库存已经被还过」的全部情形，逐类核对过）：
--   · expire_handled_at IS NOT NULL —— 到期 cron 处理过的，库存已归还；
--   · status = 'cancelled'         —— 退款 / 售后退款 / 下单后自动交付失败补偿，
--     库存已归还。status='cancelled' 的写入点共 4 条语句（自动交付失败补偿、
--     claimRefundSlot 抢占、售后收尾、取消收尾），语义来源 3 处，无一例外。
-- 不回填就会重演本缺陷：老单在退款时占位是 0 ⇒ 又还一次。
--
-- 回填**覆盖不到**的只有「历史故障残留」（旧代码在还库存时抛错 ⇒ 本来就已丢失），
-- 那类不可回溯，不是本缺陷。

ALTER TABLE point_orders ADD COLUMN stock_restored INTEGER NOT NULL DEFAULT 0;

UPDATE point_orders SET stock_restored = 1 WHERE expire_handled_at IS NOT NULL;

UPDATE point_orders SET stock_restored = 1 WHERE status = 'cancelled';
