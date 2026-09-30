-- 0069_users_last_login.sql
-- 用户存活率统计：users 增加「最后登录时间」列。
--
-- 为什么不能直接查 sessions：
--   定时运维每小时执行 `DELETE FROM sessions WHERE expires_at < 7天前`，
--   所以 sessions 里**只保留最近约一周的会话**。用它统计「最近 7 天登录过」是准的，
--   但想看 30 天 / 90 天存活率就会严重低估（实测 7 天与 30 天都是 207 人，
--   不是因为大家都活跃，而是更老的记录已经被删了）。
--
-- 新增的列由 `auth.ts` 的 login 在每次登录成功时更新 —— 它不受会话清理影响，
-- 能支撑任意时间窗口的存活率。老用户执行下面的回填语句补上历史值。

ALTER TABLE users ADD COLUMN last_login_at TEXT;

-- 回填：用现存会话里最近的一次登录时间补齐（会话只覆盖最近一周，所以回填结果
-- 也只到最近一周；更早的真实登录时间已随会话一起被清理，无法追溯）。
-- created_at 在库里存在两种格式（"YYYY-MM-DD HH:MM:SS" 与 ISO "…T…Z"）混用，
-- MAX() 按字符串比较，同日情况下 ISO 格式排在后面，取到的仍是较新的那条。
UPDATE users
   SET last_login_at = (
     SELECT MAX(created_at) FROM sessions WHERE sessions.user_id = users.id
   )
 WHERE last_login_at IS NULL;
