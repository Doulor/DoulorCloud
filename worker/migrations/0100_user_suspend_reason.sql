-- 0100_user_suspend_reason.sql
-- 账号封禁原因（2026-10-02 站长要求）。
--
-- 背景：
--   被封禁的用户登录时只看到一句「账户已被停用」，完全不知道**为什么**被封，
--   申诉时只能瞎猜；管理员处理完申诉后，用户也无从得知结果。
--
--   站长的口径是：「管理员要能给出回复，用户下一次登录就能看见
--   封禁的原因以及管理员的回复」。
--   管理员回复本身已有地方存（`account_appeals.review_note`，0096 就建好了），
--   缺的是**封禁原因**这一侧 —— 所以这里给 users 补两列。
--
-- why 不用 audit_logs 顶替：审计日志是按操作流水记的、面向管理员排查，
--   而这里要在**用户每一次登录**时按 user_id 直接取出来展示，放在 users 行最合适。
--
-- ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，每条只能跑一次。
-- ⚠️ 线上必须**逐条**手工执行（一条命令里塞多条语句会静默不执行）：
--     npx wrangler d1 execute doulor-mail --remote --command "ALTER TABLE users ADD COLUMN suspend_reason TEXT"

ALTER TABLE users ADD COLUMN suspend_reason TEXT;

-- 封禁时间：登录页要显示「于 X 被封禁」，也方便排查长期未处理的封禁
ALTER TABLE users ADD COLUMN suspend_at TEXT;
