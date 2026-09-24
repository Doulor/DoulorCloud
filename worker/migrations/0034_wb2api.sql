-- 0034_wb2api.sql
-- 捐献模块接入 WorkBuddy 反代网关（workbuddy2api-panel）：用户登录自己的
-- WorkBuddy 国际版账号 → 账号进入网关共享池 → 自动解锁本站「AI 中转站」权限。
--
-- 背景：本站 `ai` 权限此前只能靠管理员审核 `donations` 走一遍人工流程才能解锁。
-- 而反代网关自带 OAuth 设备授权接口（`POST /panel/api/login/start` 拿授权链接、
-- `GET /panel/api/login/poll?state=` 轮询登录结果），登录成功时网关自己完成
-- 凭证落盘 + 热加载进池 + 注册激活 + 领 trial —— 本站只需发起与轮询。
--
-- 因此这条通道**免管理员审核**，不能塞进 donations 的「提交 → pending → 审核」语义，
-- 单独建表。三张表分别管：绑定关系、登录会话（隐藏网关 state）、网关 api_key。

-- ---------------------------------------------------------------------------
-- 1) 绑定关系：谁捐了哪个 WorkBuddy 账号
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wb2api_bindings (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 网关侧 WorkBuddy 账号 uid（UUID 形态，用于调 accounts/{uid}/remove）
  uid                   TEXT NOT NULL,
  nickname              TEXT,
  realm                 TEXT NOT NULL DEFAULT 'global',
  -- active | removed（移除只做墓碑，不删行：重复登录时能判断「曾经捐过」）
  status                TEXT NOT NULL DEFAULT 'active',
  -- 本次绑定是否真的把 ai 从「无」变成「有」。用于移除时判断该不该收回权限：
  -- 绑定当时用户已有 ai（邀请码 / 其他捐献）时记 0，移除就不该动他的权限。
  granted_ai_permission INTEGER NOT NULL DEFAULT 0,
  -- 免责声明勾选时的来源 IP（留痕用，证明用户被告知账号会进共享池）
  acknowledged_ip       TEXT,
  created_at            TEXT NOT NULL,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- 同一个 WorkBuddy 账号只能被绑一次：重复登录自己的账号走幂等分支，
-- 不同用户抢同一个账号则拒绝（避免同一账号被两人「认领」）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb2api_bindings_uid ON wb2api_bindings(uid);
CREATE INDEX IF NOT EXISTS idx_wb2api_bindings_user ON wb2api_bindings(user_id, status);

-- ---------------------------------------------------------------------------
-- 2) 登录会话：本站自己的 session，网关 state 只存服务端
-- ---------------------------------------------------------------------------
-- 为什么要多一层：网关的 state 就是「换取 token 的凭据」，若直接下发给前端，
-- 另一个用户拿到它就能抢先 poll 把账号据为己有。故本站生成自己的 session_id
-- 下发前端，网关 state 存在服务端并与 user_id 绑定。
--
-- 另一层作用是**缓存终态**：网关 poll 成功后立即从内存删除 state，重复 poll
-- 只会拿到 404。这里落库 done/failed 终态，重复轮询直接回快照、不再打上游。
CREATE TABLE IF NOT EXISTS wb2api_login_sessions (
  -- sha256(session_id 明文)：明文只在响应里出现一次，落库的是摘要
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_state TEXT NOT NULL,
  realm          TEXT NOT NULL DEFAULT 'global',
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  -- done 时的结果快照（uid / nickname / credits / credits_total）
  result_json    TEXT,
  message        TEXT,                             -- failed 时的原因
  -- 勾选免责声明时的来源 IP：绑定成功时随绑定行一起落库留痕
  acknowledged_ip TEXT,
  created_at     TEXT NOT NULL,
  -- 与网关 state 的 15 分钟有效期对齐
  expires_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wb2api_sessions_expires ON wb2api_login_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- 3) 网关 api_key（面板可在线更新，加密落库）
-- ---------------------------------------------------------------------------
-- 照抄 0032_newapi_admin_credentials 的模式：单行表 + AES-GCM（SESSION_SECRET
-- 派生密钥）加密。本表**没有行**时回落到 env.WB2API_API_KEY，因此迁移不影响
-- 尚未配置的部署；管理员在面板粘贴一次即覆盖 env，且可随时改回。
CREATE TABLE IF NOT EXISTS wb2api_credentials (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enc_api_key TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
