-- Doulor Mail D1 迁移：mailboxes 增加 rule_id（Email Routing 规则）
ALTER TABLE mailboxes ADD COLUMN rule_id TEXT;