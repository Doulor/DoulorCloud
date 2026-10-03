-- 0107_chat_recall_quote.sql
-- 公共聊天室：支持「撤回自己的消息」与「引用别人的消息」。
--
-- 背景（用户反馈 2026-10-03）：聊天室已有气泡，希望加右键菜单 —— 撤回自己的、
-- 复制别人的、引用别人的。原 chat_messages 只有 id/user_id/body/created_at 四列，
-- 既没有撤回标记，也没有引用字段，所以这里各加一列：
--   * recalled_at：撤回时间（NULL = 未撤回）。撤回后正文不再下发，前端显示「已撤回」。
--   * reply_to：被引用消息的 id（NULL = 非引用）。渲染时反查被引消息的作者与摘要。
--
-- 两列都可空，向后兼容；老消息 recalled_at/reply_to 均为 NULL，行为不变。

ALTER TABLE chat_messages ADD COLUMN recalled_at TEXT;
ALTER TABLE chat_messages ADD COLUMN reply_to TEXT;
