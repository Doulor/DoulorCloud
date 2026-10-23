-- 0174: QQ 机器人 ↔ 站内聊天室（2026-10-24）
--
-- 平台限制（官方文档）：普通 QQ 群只推 `GROUP_AT_MESSAGE_CREATE`（用户 @机器人 时），
-- 没有"读取全部群消息"的权限 —— 所以这里做不到 TG 那种全量互通，只在文档里注明。
--
-- 本迁移只加结构，不改变任何现有行为。

-- 机器人配置（单行，与 tg_bot_config 同风格；secret 用 AES-GCM 加密存）
CREATE TABLE IF NOT EXISTS qq_bot_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL DEFAULT 0,
  app_id      TEXT,
  /** AES-GCM 密文（v1:<iv>:<ct>），空表示未配置 */
  secret_enc  TEXT,
  created_at  INTEGER,
  updated_at  INTEGER
);

-- 已接入的 QQ 群（消息事件里只有 group_openid，没有群号，只能按它登记）
CREATE TABLE IF NOT EXISTS qq_channels (
  group_openid TEXT PRIMARY KEY,
  title        TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_ok_at   INTEGER,
  last_error   TEXT
);

-- 影子账号：QQ 侧用 member_openid 标识，同一个人在不同群里 openid 不同（平台规则）
ALTER TABLE users ADD COLUMN qq_shadow_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_qq_shadow
  ON users(qq_shadow_id) WHERE qq_shadow_id IS NOT NULL;

-- 聊天消息的 QQ 侧标识（用于去重与追溯）
ALTER TABLE chat_messages ADD COLUMN qq_message_id TEXT;
ALTER TABLE chat_messages ADD COLUMN qq_group_openid TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_messages_qq
  ON chat_messages(qq_group_openid, qq_message_id);
