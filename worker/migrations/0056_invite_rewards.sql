-- Doulor Cloud D1 迁移：邀请奖励发放记录（防重复）
--
-- 背景：被邀请人通过「贡献 workbuddy 账户」解锁 AI 中转站权限时，给邀请人
-- 开一张「邀请套餐」订阅。为防「同一被邀请人重复触发」（绑定多个账号/重复捐献），
-- 用本表记录「已发过奖励的被邀请人」，同一被邀请人只发一次。
--
-- 幂等：CREATE TABLE IF NOT EXISTS。

CREATE TABLE IF NOT EXISTS invite_rewards (
  invitee_user_id  TEXT PRIMARY KEY,          -- 被邀请人（谁触发了奖励）
  inviter_user_id  TEXT NOT NULL,             -- 邀请人（谁收到了奖励）
  granted_at       TEXT NOT NULL,             -- 发放时间
  plan_id          INTEGER NOT NULL DEFAULT 0 -- 发放的订阅套餐 id
);

CREATE INDEX IF NOT EXISTS idx_invite_rewards_inviter ON invite_rewards(inviter_user_id);
