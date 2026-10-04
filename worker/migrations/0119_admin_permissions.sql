-- 管理员权限系统（2026-10-04 站长需求）：角色四层 + 白名单权限组。
--
-- 1. 角色：现有 admin → superadmin（超级管理员，全权）；新增 admin（自定义白名单）。
--    迁移把存量 admin 全部升级为 superadmin（行为不变：仍拥有全部管理权限）。
-- 2. admin_roles：权限组（一个名字 + 一套权限 scope 数组），成员可引用。
-- 3. users.admin_role_id：成员引用的权限组（可空 = 未加入任何组）。
-- 4. users.admin_scope：该成员的**最终白名单**（JSON 数组，可空 = 纯引用组的权限）。
--    白名单语义：数组里有才有，没有一律无；没有「排除」概念，杜绝黑名单越权。
--    「单人额外修改」= 把组权限 + 用户勾选结果落成一份完整白名单存这里，
--    同时保留 admin_role_id（表示仍在该组），前端据此标记「自定义」。

CREATE TABLE IF NOT EXISTS admin_roles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE users ADD COLUMN admin_role_id TEXT;
ALTER TABLE users ADD COLUMN admin_scope TEXT;

-- 存量管理员升级为超级管理员（全权，行为与旧 admin 完全一致）。
-- 新角色「admin」= 白名单自定义，由站长在成员管理里显式授予。
UPDATE users SET role = 'superadmin' WHERE role = 'admin';
