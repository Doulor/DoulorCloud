-- 0138_qoder2api.sql
-- 捐献通道：Qoder2API-Hub 反代账号（登录即解锁 AI 权限）。
--
-- 本迁移**替代**原 cli2api 通道（见 0058_cli2api.sql）。老表 cli2api_* **保留不删**
-- （弃用保留，便于回溯历史捐献记录），只是代码不再读写它们。
--
-- 上游网关：https://github.com/shuishuipingan/qoder2api-hub
--   1) POST /panel/login {password}                 → {token}       面板会话（TTL 7 天）
--   2) POST /accounts/login/start {platform,realm}  → {state, authUrl}
--   3) GET  /accounts/login/poll?state=             → {status, account?}
--        status ∈ pending | ok | expired | unknown | error
--   4) GET  /accounts                               → {accounts, usable}
--   5) POST /accounts/delete {uid}                  → {deleted}
--
-- 与原 cli2api 的三个关键差异（决定了表结构不同）：
--   a) **账号不是本站预建的** —— 上游在设备授权成功那一刻才把账号入池。
--      因此不存在「未登录成功的空账号」要清理（原来那套 discardSessionAccount 不需要了），
--      会话表里记的也不再是账号 id，而是**上游 state**。
--   b) `/accounts/*` 是**面板路由**，必须带 `X-Panel-Token`（由面板密码换来的内存会话）；
--      API Key 只能打 /v1 数据面 ⇒ 本站存的是**面板密码**（等价于该实例管理员凭据）。
--   c) 上游 state 有效期 **10 分钟**（LOGIN_TTL_SECONDS = 600），比 cli2api 的 15 分钟短。

-- ---------------------------------------------------------------------------
-- 1) 绑定关系：谁捐献了哪个 Qoder 账号
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qoder2api_bindings (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 上游账号 uid（由 /accounts/login/poll 成功时返回）
  account_id            TEXT NOT NULL,
  -- 绑定时的区域：cn（国内版 qoder.com.cn）/ intl（国际版 qoder.com）
  realm                 TEXT NOT NULL,
  nickname              TEXT,
  -- active | removed（移除只做墓碑，不删行，便于判断「曾经捐过」）
  status                TEXT NOT NULL DEFAULT 'active',
  -- 本次绑定是否真的把 ai 从「无」变成「有」，用于移除时判断该不该收回权限
  granted_ai_permission INTEGER NOT NULL DEFAULT 0,
  -- 勾选免责声明时的来源 IP（留痕：证明用户被告知账号会进共享池）
  acknowledged_ip       TEXT,
  created_at            TEXT NOT NULL,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- 同一个上游账号只能被绑一次（重复登录走幂等，跨用户抢注则拒绝）
CREATE UNIQUE INDEX IF NOT EXISTS idx_qoder2api_bindings_account ON qoder2api_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_qoder2api_bindings_user ON qoder2api_bindings(user_id, status);

-- ---------------------------------------------------------------------------
-- 2) 登录会话：本站自己的 session_id 下发前端
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qoder2api_login_sessions (
  id              TEXT PRIMARY KEY,   -- sha256(下发给前端的 session_id 明文)
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 上游 state（qd-xxxx）。🔴 **绝不下发前端** —— 拿到它就能抢先 poll 把账号据为己有。
  upstream_state  TEXT NOT NULL,
  realm           TEXT NOT NULL,
  -- 授权链接：拿到后缓存，重复 poll 不必再打上游
  auth_url        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  message         TEXT,
  acknowledged_ip TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qoder2api_sessions_expires ON qoder2api_login_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- 3) 面板密码（等价于上游管理员凭据）
-- ---------------------------------------------------------------------------
-- AES-GCM（密钥由 SESSION_SECRET 派生）。无行时回落 env.QODER2API_PANEL_PASSWORD。
-- ⚠️ 面板会话能改上游一切设置、能删号池里所有账号 —— 泄露即整个号池失守，
-- 因此本站加密落库、只在管理面板显示尾号，明文永不下发前端。
CREATE TABLE IF NOT EXISTS qoder2api_credentials (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  enc_panel_password TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
