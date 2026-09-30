-- 0064_feedback_messages.sql
-- 用户反馈从「单次工单」升级为「对话式」：管理员回复后，用户可以继续追加回复，
-- 形成多轮来回（而不是只能提交一次、干等管理员一句话）。
--
-- 原模型：feedback 表里 body（用户第一条）+ admin_reply（管理员回复），
-- 用户无法追加回复。新增 feedback_messages 存每一轮对话，按时间顺序展示。

CREATE TABLE IF NOT EXISTS feedback_messages (
  id          TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  sender_id   TEXT NOT NULL,               -- 发送者 user id（用户或管理员）
  is_admin    INTEGER NOT NULL DEFAULT 0,  -- 1 = 管理员，0 = 用户
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_messages_fid ON feedback_messages(feedback_id, created_at);
