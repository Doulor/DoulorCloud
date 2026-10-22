-- 0173: 聊天室 ↔ TG 群互通（骨架）
--
-- 站长 2026-10-23 决定：**未绑定站内账号的群成员也可以发言**（方案 B），
-- 以「TG:@用户名」的访客身份进站内。这条路最省事，但必须配套护栏：
--   · 访客是**影子账号**（role='guest'，不可登录、不可私信、不出现在用户列表/搜索里）
--   · 按 telegram_id 限流（10 条/分钟，业务层用 guardRateLimit）
--   · 每条消息记 tg_message_id，用于防回声 + 站内删帖时同步删群消息
--
-- 幂等性说明：ALTER TABLE ADD COLUMN 在 SQLite 里没有 IF NOT EXISTS，
-- 重复执行会报 duplicate column —— 迁移只跑一次（wrangler d1 migrations 有记录）。

-- 1) 聊天消息：来源与 TG 侧标识
ALTER TABLE chat_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'site';
ALTER TABLE chat_messages ADD COLUMN tg_message_id TEXT;
ALTER TABLE chat_messages ADD COLUMN tg_username TEXT;
ALTER TABLE chat_messages ADD COLUMN tg_chat_id TEXT;

-- 按 TG 消息去重 / 反查（防回声、删帖同步）
CREATE INDEX IF NOT EXISTS idx_chat_messages_tg
  ON chat_messages(tg_chat_id, tg_message_id);

-- 2) TG 群登记：复用现有频道表，用 kind 区分「播报频道」和「互通群」
ALTER TABLE tg_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel';
CREATE INDEX IF NOT EXISTS idx_tg_channels_kind ON tg_channels(kind);

-- 3) 影子账号标记（users.role 是 TEXT，'guest' 无需改表结构；
--    这里只加一个来源标记，便于清理/统计，不与登录体系混用）
ALTER TABLE users ADD COLUMN tg_shadow_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg_shadow
  ON users(tg_shadow_id) WHERE tg_shadow_id IS NOT NULL;
