-- 0040_donation_revoke.sql
-- 捐献「撤销审核」：记录审核通过时是否真正授予了权限，供撤销时精确收回。
--
-- 背景：审核通过捐献时是 `perms[feature] = true`，但如果用户本来就
-- 有该权限（邀请码注册带的、其它捐献、管理员手动开），这次捐献其实
-- 没「新增」权限。撤销时需要知道「权限是不是这次捐献给的」，否则
-- 收回会误伤用户原本就有的权限。
--
-- granted_feature：审核通过那一刻，该 feature 是否「从无到有」。
--   1 = 本次捐献真正授予了权限（撤销时应考虑收回）
--   0 = 用户此前已有该权限（撤销时不应收回）

ALTER TABLE donations ADD COLUMN granted_feature INTEGER;
