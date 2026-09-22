-- 转发失败原因（供界面如实展示，避免「已转发」假象）
ALTER TABLE mailboxes ADD COLUMN last_forward_error TEXT;