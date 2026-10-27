-- 羊毛记录（QQ 机器人自助登记，2026-10-26）
--
-- 指令侧：/羊毛 加 <内容> · /羊毛 列表 · /羊毛 完成 <编号> · /羊毛 汇总
-- 谁都能用 → 靠 user_key 限流，靠 status 自动过期。

CREATE TABLE IF NOT EXISTS wool_items (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,           -- 群内自增展示编号（#1 #2 …），从 1 开始
  title       TEXT NOT NULL,
  source      TEXT,                       -- 来源：群友昵称 / 平台 / 链接
  link        TEXT,                       -- 可选链接
  value       TEXT,                       -- 价值描述（额度/时长）
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'open',-- open | done | dead
  expires_at  INTEGER,                    -- 秒级时间戳；到点自动算过期
  scope       TEXT NOT NULL DEFAULT 'group', -- group | private
  scope_id    TEXT,                       -- group_openid / user_openid
  created_by  TEXT,                       -- 操作者 openid
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wool_scope ON wool_items(scope, scope_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_wool_created ON wool_items(created_at DESC);

-- 机器人侧限流（滑窗），跟站点其它 ratelimit 表互不影响
CREATE TABLE IF NOT EXISTS wool_quota (
  user_key   TEXT PRIMARY KEY,
  window_at  INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0
);
