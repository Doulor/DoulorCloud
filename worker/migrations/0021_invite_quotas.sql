-- 邀请码额度体系
--
-- 规则（用户定义）：
--   * 基础额度：每个用户默认可创建 3 个邀请码（只含域名/邮箱/个人名片权限）
--   * 每笔**获批**的捐献：+2 个邀请码额度，且 +1 个对应模块的权限额度
--   * 创建邀请码时附加模块权限会消耗对应模块的权限额度
--
--   例：捐献 frp + proxy → 邀请码额度 3+2+2=7，frp 额度 1、proxy 额度 1。
--   建 2 个码（各带一个权限）→ 用掉 2 个邀请码额度与各自模块额度，
--   剩余邀请码额度 5，可再建 5 个只含基础权限的码。
--
-- 额度独立于 users.permissions：
--   permissions 决定「自己能用什么」，额度决定「能给邀请码授什么」。
--   捐献获批时两者同时增加（自己解锁 + 获得可转授的额度）。

-- 捐献累计获得的邀请码额度
ALTER TABLE users ADD COLUMN invite_quota_bonus INTEGER NOT NULL DEFAULT 0;
-- 已消耗的邀请码额度
ALTER TABLE users ADD COLUMN invite_quota_used INTEGER NOT NULL DEFAULT 0;
-- 各模块可转授额度，JSON 形如 {"r2":0,"ai":1,"frp":1,"proxy":0}
ALTER TABLE users ADD COLUMN feature_quota TEXT;
-- 各模块已消耗额度
ALTER TABLE users ADD COLUMN feature_quota_used TEXT;

-- 便于按创建者查邀请码（用户自助创建后需要列出自己的）
CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by);
