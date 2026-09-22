-- 捐献功能：用户通过贡献资源（模型渠道/内网穿透/代理订阅）来解锁功能权限
--
-- 参考 frp_applications 的申请-审核流程：
--   1. 用户在「捐献」页面提交资源
--   2. 管理员收到邮件通知，在管理面板审核
--   3. 批准后自动解锁用户对应功能的权限（写入 users.permissions）
--   4. 申请人收到结果邮件

CREATE TABLE IF NOT EXISTS donations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 捐献类型：ai | frp | proxy
  type        TEXT NOT NULL,
  -- 资源详情（JSON，按类型存不同结构）：
  --   ai:      {baseUrl, apiKey, models:["gpt-4o","claude-3.5-sonnet"]}
  --   frp:     {configYml, channels:[{name, status, localAddr}]}
  --   proxy:   {subUrls:["https://...","..."]}
  payload     TEXT NOT NULL,
  -- 结果通知邮箱
  notify_email TEXT NOT NULL,
  -- 备注
  remark      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  review_note TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_donations_user ON donations(user_id);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_type ON donations(type);

-- 管理员通知邮箱（复用 frp_admin_notify_email 的模式，但独立配置）
-- 已有 frp_admin_notify_email，这里不再新建：捐献通知也发到同一个邮箱