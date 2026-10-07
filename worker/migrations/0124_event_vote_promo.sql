-- 0124 活动：新增「投票」参与条件 + 「是否在消息中心活动推广中显示」开关
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0124_event_vote_promo.sql -y
--
-- 1) promo_hidden
--    1 = 不在消息中心「活动推广」里显示，只能通过 /activity/<id> 链接参与。
--    不加 NOT NULL 是刻意的：D1 的 ALTER TABLE ADD COLUMN 加 NOT NULL + DEFAULT 在
--    老行上依赖默认值回填，这里用可空列 + 代码侧 `?? 0` 更稳（老行为 NULL = 显示）。
--
-- 2) event_votes
--    投票记录。唯一索引 (event_id, user_id) 就是「一人一票」的并发锁 ——
--    与 event_claims 的 (event_id, user_id) 同一套思路：不依赖前端、不读后写，
--    并发重复投票在唯一约束处被拦下（投完就锁，不支持改票）。
--
--    选项本身（标题 / 说明 / 图片）存在 events.condition_params 里（JSON），
--    与抽奖配置（0087）同一套做法 —— 选项是「活动配置」而不是「用户数据」，
--    单独建表只会让创建/编辑活动变成多表事务，得不偿失。
--
--    没有外键指向 condition_params 里的选项 id，所以「选项被删掉」的旧票会变成
--    孤儿行。这是可接受的：删选项本来就是改配置，计数时按现存选项过滤即可
--    （见 event-rewards.ts 的 pickWinningOptions 与 events.ts 的计票）。

ALTER TABLE events ADD COLUMN promo_hidden INTEGER;

CREATE TABLE IF NOT EXISTS event_votes (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  option_id  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 一人一票（并发锁）
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_votes_unique ON event_votes(event_id, user_id);

-- 计票（开奖时按 option_id 分组）
CREATE INDEX IF NOT EXISTS idx_event_votes_option ON event_votes(event_id, option_id);

-- 管理端领取名单要显示「投给了哪个选项」
CREATE INDEX IF NOT EXISTS idx_event_votes_user ON event_votes(user_id, event_id);
