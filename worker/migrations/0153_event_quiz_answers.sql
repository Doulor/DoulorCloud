-- 集合投票（问卷）：每个用户每题的答案。
--
-- 背景：现有 event_votes 是「一人一票」（唯一索引 (event_id,user_id)），
-- 而问卷一个人要答 N 题，一票存不下 —— 所以单独一张表。
--
-- ⚠️ attempt 是**第几次作答**，一起进主键：
--   retake=once 时只会写 attempt=1；retake=best/unlimited 时每次交卷 attempt+1，
--   结算取「最高分」那次。把它放进主键而不是覆盖旧行，是为了**留痕**：
--   站长能看出谁重考了几次、分数怎么变的（覆盖掉就查不到了）。
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0153_event_quiz_answers.sql
--
-- 选项与正确答案存在 events.condition_params（JSON）里，与投票/抽奖同一套做法：
-- 那是「活动配置」不是「用户数据」，单独建表只会让创建/编辑活动变成多表事务。
-- 所以这里没有外键指向选项 id，配置改了之后旧答案可能变成孤儿 —— 与 event_votes 一致，
-- 计数时按现存题目过滤即可（见 event-rewards.ts 的 quizScorePercent）。

CREATE TABLE IF NOT EXISTS event_quiz_answers (
  event_id    TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT    NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  question_id TEXT    NOT NULL,
  option_id   TEXT    NOT NULL,
  attempt     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (event_id, user_id, question_id, attempt)
);

-- 计票/统计用：按活动 + 题目聚合
CREATE INDEX IF NOT EXISTS idx_event_quiz_answers_event
  ON event_quiz_answers(event_id, question_id);

-- 「这个人交过卷吗 / 交了几次」用
CREATE INDEX IF NOT EXISTS idx_event_quiz_answers_user
  ON event_quiz_answers(event_id, user_id);
