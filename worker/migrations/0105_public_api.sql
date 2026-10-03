-- 公开 API（用户可通过 API Key 调用站点功能）
--
-- ⚠️ 线上 `d1_migrations` 是空的，**不要跑 `wrangler d1 migrations apply`**，
-- 逐条手工执行（多语句用 --file 会报 D1_RESET_DO）：
--   npx wrangler d1 execute doulor-mail --remote --command "<每条 SQL>"

-- 1) 每用户一个 API Key。明文只在生成/重置时返回一次，库里只存 sha256。
--    key_prefix 存前 8 位，让用户在设置页能认出「自己现在用的哪把」。
CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- 2) 每个功能的 API 配置，一行一个功能。
--    · enabled      —— 该功能的 API 是否开放（管理面板开关）
--    · tier_limits  —— **账号**维度每日限额，JSON 数组，索引 = 成就点层级（0,1,2…）
--    · ip_limit     —— **IP** 维度每日限额（固定值，IP 没有成就点所以不分层；0 = 不限）
CREATE TABLE IF NOT EXISTS api_config (
  feature     TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  tier_limits TEXT NOT NULL DEFAULT '[]',
  ip_limit    INTEGER NOT NULL DEFAULT 0
);

-- 3) 账号维度调用计数（按站点时区日期，每天清）。
--    主键即「一人一天一功能」，原子 upsert 累加，天然防并发。
CREATE TABLE IF NOT EXISTS api_usage_account (
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  date    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, feature, date)
);

-- 4) IP 维度调用计数（按站点时区日期，每天清）。
CREATE TABLE IF NOT EXISTS api_usage_ip (
  ip      TEXT NOT NULL,
  feature TEXT NOT NULL,
  date    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, feature, date)
);

-- 5) 种子：三个功能的默认配置。默认**全部关闭**，站长在管理面板手动开。
--    默认层级限额（账号维度）：层级 0（0-9 成就点）起每层递进，11 层封顶（100+ 点）。
--    IP 默认每日 100 次。
INSERT INTO api_config (feature, enabled, tier_limits, ip_limit) VALUES
  ('dns',          0, '[10,20,30,40,50,60,80,100,120,150,200]', 100),
  ('mailbox',      0, '[20,40,60,80,100,120,150,180,220,260,300]', 200),
  ('temp_mailbox', 0, '[3,5,8,10,15,20,25,30,40,50,60]', 50)
ON CONFLICT(feature) DO NOTHING;
