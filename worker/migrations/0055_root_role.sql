-- Doulor Cloud D1 迁移：引入 root（站长）角色
-- 在 0054 之上执行（保持幂等）。
--
-- 背景：此前权限体系只有 user / admin 两档，「主管理员」的保护靠硬编码
-- username='doulor'（admin.ts 里的 if 判断）。现在引入正式的 root 角色：
--   root = 站长，唯一，拥有 admin 的全部权限，且不能被其它角色修改/删除。
--
-- 本迁移只做数据侧：
--   1. 把现有主管理员（username='doulor'）的 role 从 admin 改成 root。
--   2. role 没有 CHECK 约束（D1/SQLite 侧不限制取值），无需改表结构 ——
--      合法性由应用层白名单保证。
--
-- ⚠️ 幂等：只更新「当前是 admin 的 doulor」，已改成 root 的不会再被改回去。
-- 将来若 root 换了人，手工 UPDATE 即可，不需要再跑迁移。
-- 不更新 updated_at：迁移语句无参数绑定能力，且这只是角色标记、不改业务时间戳。

UPDATE users SET role = 'root'
 WHERE username = 'doulor' COLLATE NOCASE AND role = 'admin';
