-- 0068_user_messages_and_events.sql
-- 消息箱：把 notifications 从「社区互动专用」升级为全站统一消息表
-- （系统 / 网站动态 / 社交 / 活动 四类），并新增活动系统（events / event_claims）。
--
-- 为什么不新建 user_messages 表：notifications 已有的
--   idx_notifications_user(user_id, read, created_at DESC)
-- 以及 unread-count / mark-read 接口、前端角标都能直接复用；新建表会让
-- 未读数需要 UNION、已读接口分裂成两套。新增列全部可空或带 DEFAULT，
-- 老行不受影响。
--
-- category 默认 'social'：现有 post_comment / comment_reply / feedback_reply
-- 三类正好都属于「社交」，无需 UPDATE 回填。

ALTER TABLE notifications ADD COLUMN category TEXT NOT NULL DEFAULT 'social';
ALTER TABLE notifications ADD COLUMN title    TEXT;
ALTER TABLE notifications ADD COLUMN body     TEXT;
ALTER TABLE notifications ADD COLUMN link     TEXT;   -- 点击跳转的站内路径
ALTER TABLE notifications ADD COLUMN payload  TEXT;   -- JSON：活动卡片 / 捐献结果等附加数据
ALTER TABLE notifications ADD COLUMN dedup_key TEXT;  -- 幂等键，NULL 表示不去重

CREATE INDEX IF NOT EXISTS idx_notifications_user_cat
  ON notifications(user_id, category, created_at DESC);

-- 幂等去重：点赞「从无到有」只留一条、公告/活动重复广播不翻倍、捐献结果重试不重复。
-- 用部分索引把 dedup_key IS NULL 的老行排除在外。
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(user_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- ---- 活动 ----
-- 管理员在管理面板发布，用户在消息中心「活动推广」看到并领取。
-- reward_type / condition_type 是注册表里的字符串键，具体行为在
-- worker/src/event-rewards.ts 里注册（加新活动类型只需加一项 handler）。
CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft',  -- draft | active | ended | archived
  starts_at        TEXT,                           -- 可空 = 立即开始
  ends_at          TEXT,                           -- 可空 = 不过期
  reward_label     TEXT,                           -- 展示给用户的奖励文案
  reward_type      TEXT NOT NULL DEFAULT 'none',
  reward_params    TEXT,                           -- JSON
  condition_type   TEXT NOT NULL DEFAULT 'always',
  condition_params TEXT,                           -- JSON
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, starts_at, ends_at);

-- ---- 活动领取记录 ----
-- 唯一索引 (event_id, user_id) 就是并发锁：领取接口用 INSERT OR IGNORE，
-- 靠 changes===0 判断「已领过」，不依赖前端、也不读后写。
CREATE TABLE IF NOT EXISTS event_claims (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  reward_type   TEXT NOT NULL,
  reward_status TEXT NOT NULL DEFAULT 'pending',  -- pending | granted | manual | failed
  reward_detail TEXT,                             -- 发放结果说明 / 管理员备注
  claimed_at    TEXT NOT NULL,
  granted_at    TEXT,
  granted_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_claims_unique ON event_claims(event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_event_claims_user ON event_claims(user_id, claimed_at DESC);

-- 回填：把已存在的公告物化成消息，让「网站动态」tab 上线即有内容。
-- 站是邀请制、用户量小，一次交叉连接即可；若活跃用户超过约 2000 人，
-- 这段应改为按 id 分段循环（见 HANDOFF 的迁移说明）。
INSERT OR IGNORE INTO notifications
  (id, user_id, category, type, title, body, link, dedup_key, read, created_at)
SELECT lower(hex(randomblob(16))), u.id, 'site', 'announcement',
       a.title, a.body, '/dashboard/messages', 'ann:' || a.id, 0, a.created_at
  FROM users u, announcements a
 WHERE u.status = 'active';
