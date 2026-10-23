-- 0179: TG 机器人会话状态（2026-10-24）
--
-- 多层级公告面板的「新建公告」是多步流程（标题 → 正文 → 预览确认），
-- 需要把中间状态存到服务端（Worker 无状态，不能靠内存）。
-- 一次只保留一条（每个 chat 一行），完成/取消即删；读的时候带 30 分钟过期判断。
CREATE TABLE IF NOT EXISTS tg_bot_states (
  chat_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT,
  updated_at TEXT NOT NULL
);
