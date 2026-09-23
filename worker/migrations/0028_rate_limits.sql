-- 0028_rate_limits.sql
-- 轻量限流计数表（见 worker/src/ratelimit.ts）。
--
-- 背景：审计发现登录/注册等敏感接口此前**完全没有限流**，可被无成本在线爆破。
-- 本表用固定窗口计数实现限流，不引入 KV / Durable Objects 等新绑定。
--
-- 规模：每个限流键只有一行（窗口滚动时原地覆盖 count），
--       键数上界 ≈ 独立 IP 数 + 被尝试的账号数，量级很小。
--
-- 说明：bucket 直接做主键，无需额外索引。
--       时间戳按项目惯例统一存 ISO 8601 字符串。

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
