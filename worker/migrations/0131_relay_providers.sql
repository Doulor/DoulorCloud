-- 0131_relay_providers.sql
--
-- 「中转站」登记表（2026-10-12 站长需求）：
--   本站的 AI 中转站页原先只服务**一台** NewAPI（站长自己的）。现在允许朋友把
--   他们的 NewAPI / Sub2API 登记进来，用户在 AI 页能顺便看到自己在那边的余额与订阅。
--
-- 语义（与站长定的三条口径一致）：
--   · **朋友自己填令牌** —— owner_user_id 是登记人，本表由他自助维护；
--   · **额度只读** —— 我们只读上游的余额与订阅，不代发额度、不建 Key、不改余额；
--   · **一个用户可以登记/绑定多台** —— 本表与用户是一对多。
--
-- token_enc 是**管理员令牌的密文**（与 newapi_admin_credentials 同一套 crypto 加密）。
-- 它等价于朋友站的管理权，所以：只加密存、只在服务端用于该站的读接口、支持随时删除。
--
-- ⚠️ 线上 D1 由站长手动执行（本项目从不跑 migrations apply）：
--   npx wrangler d1 execute doulor-mail --remote --config wrangler.toml \
--     --file=./migrations/0131_relay_providers.sql

CREATE TABLE IF NOT EXISTS relay_providers (
  id TEXT PRIMARY KEY,
  /** 显示名（如「小李的 NewAPI」）——用户在选择/查看时看到的就是它 */
  name TEXT NOT NULL,
  /** 站点类型：newapi | sub2api（决定用哪套适配器读余额与订阅） */
  kind TEXT NOT NULL,
  /** 站点根地址，统一去掉尾部斜杠（如 https://api.example.com） */
  base_url TEXT NOT NULL,
  /** 管理员令牌**密文** */
  token_enc TEXT NOT NULL,
  /** 登记人（朋友）——只有他能改/删 */
  owner_user_id TEXT NOT NULL,
  /** 站长可以一键停用（0 = 不再对任何人展示） */
  enabled INTEGER NOT NULL DEFAULT 1,
  /** 展示排序（小的在前；站长自己的站排在代码里固定最前） */
  sort INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_providers_owner ON relay_providers(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_relay_providers_enabled ON relay_providers(enabled, sort);
