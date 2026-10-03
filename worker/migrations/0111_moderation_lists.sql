-- 监管：白名单 / 自动条件 / 黑名单（2026-10-03 站长要求）
--
-- 白名单：名单内用户**不会被封禁**。两种来源：
--   · manual —— 管理员手动添加；
--   · auto   —— 某个自动条件命中（如「成就点 > 20」），conditions 表里那条 enabled=0 时自动退出。
-- ⚠️ username 建唯一索引：一个人只有一条记录，手动优先（手动加过就不再写 auto 行）。
--
-- 黑名单：主要针对 IP。auto 来源 = 有账号被封禁时，它的注册 IP 自动进来。
-- ⚠️ 线上 d1_migrations 表为空，迁移**不会自动跑**，这份文件只是留档，
--    实际建表用逐条 `wrangler d1 execute --remote --command "..."` 手工执行。

CREATE TABLE IF NOT EXISTS moderation_whitelist (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',   -- manual | auto
  condition_id TEXT,                       -- auto 时：来源条件 id
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_wl_username ON moderation_whitelist(username);
CREATE INDEX IF NOT EXISTS idx_mod_wl_condition ON moderation_whitelist(condition_id);

CREATE TABLE IF NOT EXISTS moderation_conditions (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,                    -- achievement_points（目前仅这一种）
  op TEXT NOT NULL,                        -- gt | gte | lt | lte
  value INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_blacklist (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',   -- manual | auto（auto = 封禁账号的 IP）
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_bl_ip ON moderation_blacklist(ip);
