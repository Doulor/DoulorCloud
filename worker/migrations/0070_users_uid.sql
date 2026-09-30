-- 0070_users_uid.sql
-- 用户 UID：按注册顺序从 1 开始编号，展示时前端补零成 001。
--
-- 为什么另开一列而不是复用 id：id 是随机 uuid，没有顺序含义，也没法给人看。
-- UID 是给用户看的「第几号会员」，要出现在个人空间与名片上。
--
-- 存 **INTEGER** 而不是 '001' 这种字符串：排序/取最大值都是数值语义，
-- 补零只是展示层的事（前端 padStart(3,'0')），存字符串会让 MAX() 变成字典序
-- （'999' > '1000'），第 1000 个用户之后就乱了。

ALTER TABLE users ADD COLUMN uid INTEGER;

-- 回填：按 (created_at, id) 排序依次编号。
-- 用 id 做 tiebreaker，保证同一秒注册的用户也拿到不同号（只要求唯一确定，不要求 id 有序）。
UPDATE users
   SET uid = (
     SELECT COUNT(*)
       FROM users u2
      WHERE u2.created_at < users.created_at
         OR (u2.created_at = users.created_at AND u2.id <= users.id)
   );

-- 唯一索引：既方便按 UID 查人，也兜住并发注册时号段不重复
-- （SQLite 里多个 NULL 互不相等，所以回填前为空也不影响建索引）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid);
