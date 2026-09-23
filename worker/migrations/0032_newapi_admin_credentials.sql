-- 0032_newapi_admin_credentials.sql
-- NewAPI 管理员凭据可在线更新（管理面板「中转站」标签）。
--
-- 背景：此前管理员凭据只存在于 Worker Secret（NEWAPI_ADMIN_TOKEN /
-- NEWAPI_ADMIN_USER_ID），而 NewAPI 的**系统访问令牌是可被随时轮换的** ——
-- 在 NewAPI 后台每点一次「生成/重新生成」都会覆盖旧值（rc.15 的
-- GenerateAccessToken 直接覆盖 users.access_token，且前端打开令牌弹窗时会
-- 自动调用一次），一旦轮换，本站所有管理员级调用（建号、查账号、设额度、
-- 健康检查）立刻 401，只能重跑 wrangler secret put 才能恢复。
--
-- 本表让管理员直接在网页上粘贴新令牌即完成更新：优先于 env 生效。
--
-- 单行表（id 恒为 1）：凭据是全局的，不需要多行。
-- 令牌用 SESSION_SECRET 派生的 AES-GCM 加密后存库（同 newapi_accounts.enc_token、
-- r2_buckets 的桶凭据），明文绝不落库、也不回传给前端。
--
-- 回落语义：本表**没有行**时，继续用 env.NEWAPI_ADMIN_TOKEN / NEWAPI_ADMIN_USER_ID，
-- 因此迁移不影响线上既有部署；写入行后 env 值被覆盖，可随时在面板改回。

CREATE TABLE IF NOT EXISTS newapi_admin_credentials (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  enc_token     TEXT NOT NULL,          -- AES-GCM 加密的管理员 access token
  admin_user_id TEXT NOT NULL,          -- 令牌所属用户 id（New-Api-User 头），默认 1
  updated_at    TEXT NOT NULL
);
