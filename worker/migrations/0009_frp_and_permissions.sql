-- Doulor Cloud D1 迁移：按功能维度的权限控制 + frp 内网穿透申请
-- 在 0008 之上执行（保持幂等）。

-- ============================================================
-- 1. 功能权限
-- ============================================================
-- invite_codes.permissions：该邀请码注册出来的账号默认拥有哪些功能权限
-- users.permissions：用户实际权限（管理员可在成员详情里单独修改）
-- 值都是 JSON，形如 {"r2":true,"ai":true,"frp":false}
-- NULL 表示「未指定」——注册时按邀请码的 permissions 落库；
-- 老数据为 NULL 时按「全部允许」处理，避免升级后老用户功能突然失效。

ALTER TABLE invite_codes ADD COLUMN permissions TEXT;
ALTER TABLE users ADD COLUMN permissions TEXT;

-- ============================================================
-- 2. frp 节点（管理面板可维护）
-- ============================================================
CREATE TABLE IF NOT EXISTS frp_nodes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,              -- 显示名，如「北京」「香港」
  region        TEXT,                       -- 地区说明
  server_addr   TEXT NOT NULL,              -- serverAddr（frpc 配置里填的域名/IP）
  server_port   INTEGER NOT NULL DEFAULT 7000,
  auth_token    TEXT NOT NULL DEFAULT '',   -- frps 的 auth.token
  token_prefix  TEXT NOT NULL DEFAULT '',   -- metadatas.token 前缀，实际 token = 前缀+序号
  port_min      INTEGER NOT NULL DEFAULT 20000,
  port_max      INTEGER NOT NULL DEFAULT 50000,
  max_ports     INTEGER NOT NULL DEFAULT 5, -- 每个用户最多可申请的端口数
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 端口占用表：同一个节点内端口不可重复分配给不同用户
CREATE TABLE IF NOT EXISTS frp_ports (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES frp_nodes(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT,                      -- 来源申请（可空，管理员手工分配时为空）
  remote_port   INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_frp_ports_node_port
  ON frp_ports(node_id, remote_port);
CREATE INDEX IF NOT EXISTS idx_frp_ports_user ON frp_ports(user_id);

-- ============================================================
-- 3. frp 申请（人工审核）
-- ============================================================
CREATE TABLE IF NOT EXISTS frp_applications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES frp_nodes(id) ON DELETE CASCADE,
  -- frp 账号凭据（管理员批准后在 frps-panel 里创建）
  frp_user      TEXT NOT NULL,
  frp_password  TEXT NOT NULL,
  -- 申请使用的端口（JSON 数组），批准时写入 frp_ports
  ports         TEXT NOT NULL,
  -- 隧道定义（JSON 数组）：[{name,type,localIP,localPort,remotePort}]
  tunnels       TEXT NOT NULL,
  -- 结果通知邮箱（doulor.cn 邮箱 或 已验证的真实邮箱）
  notify_email  TEXT NOT NULL,
  -- 申请理由 / 备注
  remark        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  review_note   TEXT,                              -- 管理员审批意见
  reviewed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_frp_apps_status ON frp_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_frp_apps_user ON frp_applications(user_id, created_at DESC);

-- ============================================================
-- 4. 默认设置项
-- ============================================================
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('frp_enabled', '1', datetime('now')),
  ('frp_core_url', 'https://r2data.doulor.cn/Firef%20Frp.zip', datetime('now')),
  ('frp_admin_notify_email', '', datetime('now'));