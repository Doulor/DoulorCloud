-- 0098：表情包「快捷保存」记录来源，用于去重（避免重复保存同一个别人的表情包）
ALTER TABLE user_stickers ADD COLUMN source_id TEXT;
