-- Doulor Mail D1 迁移：邮箱别名 → 收件箱模型
-- 在旧 schema 之上执行（保持幂等）。

-- 邮箱表（每用户一个收件箱）
CREATE TABLE IF NOT EXISTS mailboxes (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address          TEXT NOT NULL UNIQUE,              -- ruben@doulor.cn
  forwarding_to    TEXT,                              -- JSON 数组：真实邮箱转发目标（可空=不转发）
  last_forwarded_at TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_user ON mailboxes(user_id);

-- 邮件消息表（D1 网页收件箱）
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  from_address TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  text_body    TEXT NOT NULL DEFAULT '',
  read         INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id, received_at DESC);

-- 为每个已有用户创建默认收件箱（新用户由注册流程自动创建）
INSERT OR IGNORE INTO mailboxes (id, user_id, address, forwarding_to, created_at)
SELECT
  lower(hex(randomblob(16))),
  u.id,
  u.username || '@doulor.cn',
  json_array(u.email),
  datetime('now')
FROM users u;

-- 旧 email_aliases 数据并入收件箱（保留每个用户第一个转发地址）
UPDATE mailboxes SET forwarding_to = (
  SELECT ea.forwarding_to
  FROM email_aliases ea
  WHERE ea.user_id = mailboxes.user_id
  ORDER BY ea.created_at ASC
  LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM email_aliases ea WHERE ea.user_id = mailboxes.user_id);

DROP TABLE IF EXISTS email_aliases;