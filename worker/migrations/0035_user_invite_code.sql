-- 0035_user_invite_code.sql
-- 给 users 表补「注册时使用的邀请码」字段，用于违规行为溯源。
--
-- 背景：注册流程里虽然消费了邀请码（invite_codes.used_count + 1），
-- 但从未记录「哪个用户用了哪个码」，导致无法回答「这个用户是拿谁发的
-- 邀请码进来的」—— 违规用户溯源时只能靠猜。
--
-- 方案：users 加 invite_code_id（可空），指向 invite_codes.id。
--   - 可空：老用户没有这条记录（他们注册时还没有这个字段），
--     显示时回退为「未知」即可，不需要也无法补。
--   - 不用外键约束（SQLite 里 ALTER TABLE 加外键麻烦，且历史上 users 表
--     改动都很克制）；删除邀请码时靠 ON DELETE 语义在应用层处理，
--     这里只存 id，查不到就显示「已删除」。
--   - 邀请码本身可能被删（管理员清理），所以溯源查询要 LEFT JOIN 并容忍缺失。

ALTER TABLE users ADD COLUMN invite_code_id TEXT;

-- 溯源查询的热路径：按 invite_code_id 反查用了该码的用户（可选，加了更稳）
CREATE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code_id);
