-- 0096 账号监管：封禁申诉 + 风险账户
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0096_moderation.sql

-- ---- 封禁申诉 ----
-- 被封禁的用户**登不进来**（login 里 status !== 'active' 直接 403），
-- 所以提交申诉的接口必须是公开的、不需要会话；user_id 只能「尽量关联」
-- （按用户名查，查不到就是 NULL —— 用户可能已经改名，或账号被删）。
CREATE TABLE IF NOT EXISTS account_appeals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                              -- 可空：按用户名尽力关联
  username    TEXT NOT NULL,                     -- 用户填写的账号名
  contact     TEXT,                              -- 联系方式（邮箱 / QQ），便于回复
  content     TEXT NOT NULL,                     -- 申诉正文
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected
  review_note TEXT,                              -- 管理员处理备注
  reviewed_by TEXT,
  ip          TEXT,                              -- 提交时的来源 IP（防刷/取证）
  created_at  TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_appeals_status ON account_appeals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeals_user ON account_appeals(user_id);

-- ---- 风险账户 ----
-- 由定时任务扫描中转站日志后写入（单账号每分钟请求数超阈值等）。
-- 与管理端「监管」栏目一一对应；后续新增风险规则时往 reasons(JSON) 里加即可，
-- 不需要改表结构。
CREATE TABLE IF NOT EXISTS risk_accounts (
  user_id       TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  risk_level    TEXT NOT NULL DEFAULT 'low',   -- low | medium | high
  score         INTEGER NOT NULL DEFAULT 0,    -- 综合分，用于排序
  reasons       TEXT,                          -- JSON 数组：命中的规则与实测数值
  peak_per_min  INTEGER NOT NULL DEFAULT 0,    -- 观测到的每分钟最大请求数
  requests_7d   INTEGER NOT NULL DEFAULT 0,    -- 近 7 天请求量
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | watching | banned | cleared
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_risk_score ON risk_accounts(score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_status ON risk_accounts(status);
