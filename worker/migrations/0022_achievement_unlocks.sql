-- 成就解锁时间记录
--
-- 成就是「纯计算」的（每次按当前数据实时算出进度），但解锁时间需要持久化：
-- 第一次达成某成就某等级时写入一行，之后不再更新（保留最早解锁时间）。
--
-- 若资源被删除导致等级回落，这里的历史记录保留（不删），
-- 详情弹窗里展示「历史最高等级」与首次解锁时间。
-- 当前等级以实时计算为准。

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL,
  level          INTEGER NOT NULL,        -- 达成时的等级
  unlocked_at    TEXT NOT NULL,           -- 首次达成该等级的时间
  PRIMARY KEY (user_id, achievement_id, level)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
