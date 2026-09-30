-- 0051_feedback.sql
-- 用户反馈：让用户把「问题 / 建议 / 捐献咨询 / 其他」直接投到站内，
-- 管理员在管理面板回复，用户在反馈页看到回复。
--
-- 为什么另开一张表而不是复用社区帖子 / 公告：
--   * 反馈**只有作者与管理员能看**，是一条私有工单；社区帖子是公开的，
--     用帖子实现要么泄露隐私、要么得给 posts 加一整套可见性规则；
--   * 反馈有**状态机**（待处理 → 处理中 → 已处理 / 已关闭）与**官方回复**，
--     这两个概念在 posts 里都不存在，硬塞进去会污染社区那套「点赞/评论/转发」。
--
-- 与通知（notifications）的关系：
--   管理员回复时顺带写一条 notifications 记录（type='feedback_reply'），
--   用户在哪都能看到角标。但通知是「提示」，本表才是「工单本体」——
--   通知被清空/已读不影响这里的历史。
--
-- user_read：作者是否已读过管理员的回复。
--   不复用 notifications.read：两者语义不同（通知是逐条提示，这里是
--   「这条工单的回复我还没看」），而且作者可能从通知进来、也可能直接进反馈页。
--   只有 status 变成 replied 之后它才有意义。

CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- bug | feature | donation | other（见 handlers/feedback.ts 的 FEEDBACK_CATEGORIES）
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- pending（待处理）| processing（处理中）| resolved（已处理）| closed（已关闭）
  status      TEXT NOT NULL DEFAULT 'pending',
  -- 管理员回复正文；NULL = 还没回复过
  admin_reply TEXT,
  replied_at  TEXT,
  replied_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- 作者是否已读回复（1 = 已读）；无回复时无意义，恒为 0
  user_read   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 用户视角：我的反馈按时间倒序（GET /api/feedback）
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at DESC);

-- 管理端视角：按状态筛选 + 时间倒序（GET /api/admin/feedback?status=pending）
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);
