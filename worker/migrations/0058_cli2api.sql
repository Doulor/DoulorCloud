-- 0058_cli2api.sql
-- 捐献模块接入 CLI2API 网关（https://github.com/caigee-cmd/cli2api）：
-- 用户登录自己的 Qoder / WorkBuddy / Trae 上游账号 → 账号进入 cli2api 共享池
-- → 自动解锁本站「AI 中转站」权限。
--
-- 与 0034_wb2api.sql 的关系：**并行的第二条同类通道**，不是替换。
-- 两者接口形态不同（cli2api 走 `/api/accounts` + `/api/accounts/{id}/login/*`，
-- 且必须先建账号、等 worker 起来，才能触发登录），硬抽象成同一套 client 会让
-- 两边都难改，故独立建表 / 独立 client / 独立 handler，前端并列展示。
--
-- 实测（2026-09-26，对着线上实例逐条验证）确认的远程登录链路：
--   1) POST   /api/accounts                    {provider, region, name, enabled:true} → acc_xxx
--   2) POST   /api/accounts/{id}/login/device   → {"authUrl":"https://qoder.cn/device/selectAccounts?..."}
--   3) GET    /api/accounts/{id}/login/status   → {"login":{"status":"pending|done|failed"}}
--   4) DELETE /api/accounts/{id}                → 解绑
--
-- ⚠️ 两个实测定下来的关键事实：
--   a) authUrl 指向 qoder.cn 自己的登录页，`oauth_callback` 也指回 qoder.cn 的 device 页，
--      授权结果按 `machine_id` 关联回 cli2api 的 worker —— **不需要回调本站、也不需要用户粘贴**。
--      所以这条路对远程用户天然可用（`login/callback` 那条粘贴兜底用不上）。
--   b) cli2api 是「先建账号 → 账号 enabled 且 worker 起来 → 才能 login/device」，
--      否则返回 `account_not_running`（实测）。这也是为什么会话表要记 account_id：
--      会话过期/失败时得把那个空账号删掉。

-- ---------------------------------------------------------------------------
-- 1) 绑定关系：谁贡献了哪个 cli2api 账号
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cli2api_bindings (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- cli2api 侧账号 id（acc_xxxxxxxxxxxx）；解绑调 DELETE /api/accounts/{id}
  account_id            TEXT NOT NULL,
  -- 绑定时使用的上游与区域（qoder/global、qoder/cn、workbuddy/cn…）
  provider              TEXT NOT NULL,
  region                TEXT NOT NULL,
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

-- 同一个 cli2api 账号只能被绑一次（重复登录走幂等，跨用户抢注则拒绝）
CREATE UNIQUE INDEX IF NOT EXISTS idx_cli2api_bindings_account ON cli2api_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_cli2api_bindings_user ON cli2api_bindings(user_id, status);

-- ---------------------------------------------------------------------------
-- 2) 登录会话：本站自己的 session_id 下发前端
-- ---------------------------------------------------------------------------
-- 与 wb2api 同理多一层：不让前端直接持有上游标识，越权 poll 就能抢账号。
-- 额外存 account_id —— 会话过期/失败时要把它从 cli2api 删掉，避免池子里堆空账号。
CREATE TABLE IF NOT EXISTS cli2api_login_sessions (
  id              TEXT PRIMARY KEY,   -- sha256(session_id 明文)
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  region          TEXT NOT NULL,
  -- 授权链接：拿到后缓存，重复 poll 不必再打上游
  auth_url        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  message         TEXT,
  acknowledged_ip TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cli2api_sessions_expires ON cli2api_login_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- 3) 控制台密钥（console key）
-- ---------------------------------------------------------------------------
-- ⚠️ 注意这不是「客户端 key」：cli2api 的 `/api/*` 全部要求 console key，
-- 它等于该实例的管理员权限 —— 泄露 = 整个账号池被拿走。
-- 照抄 0032/0034 的模式：单行表 + AES-GCM（SESSION_SECRET 派生密钥）加密，
-- 无行时回落 env.CLI2API_CONSOLE_KEY，迁移不影响尚未配置的部署。
CREATE TABLE IF NOT EXISTS cli2api_credentials (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  enc_console_key TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
