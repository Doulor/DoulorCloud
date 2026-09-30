-- 0049_rate_limits_window_index.sql
-- 给 rate_limits.window_start 建索引。
--
-- 背景（2026-09-25 审计 M15）：maintenance.ts 每小时执行一次
--   DELETE FROM rate_limits WHERE window_start < ?
-- 而 0028_rate_limits.sql 当初的注释写的是「bucket 直接做主键，无需额外索引」。
-- 那句话只考虑了**限流本身**的访问模式（`WHERE bucket = ?`，走主键，确实不需要），
-- 漏掉了**定时清理**的访问模式：按 window_start 范围删。
--
-- 没有这个索引，每小时那次 DELETE 是全表扫描。表本身设计得很小
-- （每个限流键一行，键数上界 ≈ 独立 IP 数 + 被尝试的账号数），
-- 但即使只有 5 万行，一小时 5 万次行读 = 一天 120 万次，
-- 对 D1 免费档的「每天 500 万行读」是实打实的一块。
--
-- 这个索引只有 window_start 一列，写入放大可以忽略（限流键只在窗口滚动时
-- 原地更新一行），换掉每小时的整表扫描是划算的。
--
-- ⚠️ 顺带更正 0028 里那句注释：不是「无需额外索引」，
--    而是「限流查询不需要，但定时清理需要」。原注释留在原文件里不动
--    （迁移文件是不可变的历史记录），以这里为准。

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON rate_limits(window_start);
