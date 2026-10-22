-- 0170: TG 机器人（DoulorCloud Bot）
--
-- 权限设计见 worker/src/handlers/telegram.ts 顶部注释，这里只落存储结构：
--   · tg_bot_config  单行配置。Bot Token **加密存储**（AES-GCM，密钥取 env.SESSION_SECRET，
--                    复用 crypto.ts 的 encryptSecret/decryptSecret），页面只能读到脱敏值。
--   · tg_bindings    站内用户 ↔ Telegram 账号。telegram_id 作主键，user_id 唯一
--                    （一个站内账号只能绑一个 TG，防止一人多绑绕过限流/审计）。
--   · tg_bind_tokens 一次性绑定码：站内生成 → bot 里 /bind 输入。
--                    只存码本身（6 位数字，10 分钟过期、单次使用），不存明文密码。
--   · tg_push_log    所有推送与机器人操作审计：谁、什么类型、成功没、错误信息。
--                    同时用于**命令限流**（同一 telegram_id 60 秒内 >10 条命令即丢弃）。

CREATE TABLE IF NOT EXISTS tg_bot_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  /** AES-GCM 密文（v1:<iv>:<ct>），空表示未配置 */
  token_enc TEXT,
  bot_username TEXT,
  /** 由服务端生成，Telegram 回调时比对 X-Telegram-Bot-Api-Secret-Token */
  webhook_secret TEXT,
  /** 命令开关：{"me":true,"frp":true,"status":true} */
  commands_json TEXT NOT NULL DEFAULT '{}',
  /** 推送开关：{"login":true,"frpExpiry":true,"nodeDown":true,"daily":true} */
  pushes_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT
);
INSERT OR IGNORE INTO tg_bot_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS tg_bindings (
  telegram_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tg_username TEXT,
  bound_at INTEGER NOT NULL,
  /** 用户自己关掉的通知类型：["login","frpExpiry",...] */
  muted_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_bindings_user ON tg_bindings(user_id);

CREATE TABLE IF NOT EXISTS tg_bind_tokens (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tg_bind_tokens_user ON tg_bind_tokens(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS tg_push_log (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  /** 接收方（telegram_id）；管理员广播为 'admins' */
  target TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tg_push_log_time ON tg_push_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_push_log_target ON tg_push_log(target, created_at DESC);
