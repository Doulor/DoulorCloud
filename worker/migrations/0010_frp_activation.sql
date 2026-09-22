-- Doulor Cloud D1 迁移：内网穿透的「用户手动启用」状态
-- 与网盘（开通后建目录）、中转站（开通后建账号）一致：
-- 用户需先手动启用，才显示节点列表与申请入口。

CREATE TABLE IF NOT EXISTS frp_accounts (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
