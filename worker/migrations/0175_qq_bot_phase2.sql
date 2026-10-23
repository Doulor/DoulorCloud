-- 0175: QQ 机器人二期（2026-10-24）
--
-- · qq_bindings：QQ 私聊里 `/bind <码>` 之后的绑定关系（与 tg_bindings 平行，
--   openid 按用户维度，不用群里的 member_openid）
-- · qq_c2c_state：用户在机器人资料卡上开关"主动消息"的状态（C2C_MSG_RECEIVE/REJECT）

CREATE TABLE IF NOT EXISTS qq_bindings (
  qq_openid TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  bound_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qq_bindings_user ON qq_bindings(user_id);

CREATE TABLE IF NOT EXISTS qq_c2c_state (
  qq_openid   TEXT PRIMARY KEY,
  allow_push  INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);
