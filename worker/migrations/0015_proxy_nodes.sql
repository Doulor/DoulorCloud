-- Doulor Cloud D1 迁移：代理节点（proxy）
-- 在 0014 之上执行（保持幂等）。
--
-- 设计要点（2026-09-22 按用户要求简化）：
--   * 邀请码只控制「代理节点」功能权限（users.permissions.proxy）。
--     有 proxy 权限的用户，启用本功能后就能看到全部已启用的订阅源，
--     **不做**按用户单独授权订阅源。
--   * `proxy_subscriptions`：管理员维护的「订阅源」。每个源对应一条代理订阅
--     （vless/vmess/trojan/ss 等），其节点列表、剩余流量、到期日由 Worker
--     运行时 `fetch` 订阅 URL 并解析（详见 worker/src/handlers/proxy.ts）。
--     `enabled` 为 0 时对所有用户隐藏（管理员可临时停用某个订阅源）。
--   * `proxy_activation`：用户是否已启用本功能（与 frp_accounts /
--     storage_accounts / newapi_accounts 一致：启用后才显示功能界面）。
--     `consent_version` 记录用户同意的「使用协议」版本，须与前端内嵌版本一致。

CREATE TABLE IF NOT EXISTS proxy_subscriptions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,               -- 显示名，如「香港中继」「美国节点组」
  region        TEXT,                        -- 地区说明，如「香港」
  url           TEXT NOT NULL,               -- 订阅链接（http/https）
  protocol      TEXT NOT NULL DEFAULT 'mixed', -- 协议说明：vless / vmess / trojan / ss / mixed
  status        TEXT NOT NULL DEFAULT 'unknown', -- online | offline | maintenance | unknown
  status_note   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,  -- 0=对用户隐藏（管理员停用）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,                        -- 备注（显示在节点详情里）
  last_synced_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_activation (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled         INTEGER NOT NULL DEFAULT 1,
  consent_version INTEGER NOT NULL DEFAULT 0, -- 同意的协议版本（0=未同意，仅 proxy.enable 时写入）
  consented_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 默认设置项：代理节点功能总开关
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('proxy_enabled', '1', datetime('now'));