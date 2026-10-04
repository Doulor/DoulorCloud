-- 0114_whitelist_guard_triggers.sql
--
-- 把「监管白名单」从「每个功能各自记得检查」升级为**数据库层面的硬约束**
-- （2026-10-04 站长要求：「白名单本身的存在就杜绝以后所有封禁项目」）。
--
-- 背景：白名单原先只写在个别代码路径里（手工封禁一处、商汤巡检一处），
-- 于是每加一个新的「处置」功能，都要人工记得补一次白名单判断 ——
-- 漏了就是白名单用户被照常处置（通知限权功能就是这么漏的）。
-- 这类「靠自觉」的约定迟早会再漏，所以改成**结构性保证**：
-- 只要 `moderation_whitelist` 里有这个用户名，下面两类写操作在触发器中
-- 直接 ABORT，任何代码路径（包括以后新写的）都绕不过去。
--
--   1. 封禁：users.status 由非 suspended 变为 suspended
--   2. 权限收回：users.permissions 里任一模块由「允许」变为「不允许」
--
-- ⚠️ 判定口径必须与 JS 侧 `parsePermissions` 一致：
--    **键缺失 / JSON 非法 / 整列为 NULL 都视为「允许」**（历史兼容，见 permissions.ts）。
--    所以这里用 `COALESCE(json_extract(...), 1) = 1` 判「原本允许」，
--    用 `= 0` 判「现在不允许」；JSON 非法时兜底成 '{}'（等价于全允许，
--    与 permissions.ts 的 PERMISSIONS_JSON_EXPR 同一个思路）。
--
-- ⚠️ 只覆盖「降级」方向：把权限从 false 改成 true（恢复、发放）永远放行，
--    否则白名单用户一旦被误锁就再也恢复不了。
--
-- ⚠️ 有意**不覆盖**：删除用户（`DELETE FROM users`）。那是管理员的显式销毁动作，
--    不是「封禁」，且用户的邮箱/子域名/文件都要一并清理，语义完全不同。
--    需要删的话，站长应先把该用户移出白名单（触发器会明确提示这一点）。

-- ---------------------------------------------------------------------------
-- 1) 禁止封禁白名单用户
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_whitelist_block_suspend
BEFORE UPDATE OF status ON users
FOR EACH ROW
WHEN NEW.status = 'suspended'
  AND OLD.status <> 'suspended'
  AND EXISTS (
    SELECT 1 FROM moderation_whitelist w
     WHERE w.username = NEW.username COLLATE NOCASE
  )
BEGIN
  SELECT RAISE(ABORT, 'USER_WHITELISTED: 该账号在监管白名单中，不会被封禁');
END;

-- ---------------------------------------------------------------------------
-- 2) 禁止收回白名单用户的任何模块权限
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_whitelist_block_permission_revoke
BEFORE UPDATE OF permissions ON users
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM moderation_whitelist w
     WHERE w.username = NEW.username COLLATE NOCASE
  )
  AND (
    -- r2
    (COALESCE(json_extract(CASE WHEN json_valid(OLD.permissions) THEN OLD.permissions ELSE '{}' END, '$.r2'), 1) = 1
     AND COALESCE(json_extract(CASE WHEN json_valid(NEW.permissions) THEN NEW.permissions ELSE '{}' END, '$.r2'), 1) = 0)
    -- ai
    OR (COALESCE(json_extract(CASE WHEN json_valid(OLD.permissions) THEN OLD.permissions ELSE '{}' END, '$.ai'), 1) = 1
        AND COALESCE(json_extract(CASE WHEN json_valid(NEW.permissions) THEN NEW.permissions ELSE '{}' END, '$.ai'), 1) = 0)
    -- frp
    OR (COALESCE(json_extract(CASE WHEN json_valid(OLD.permissions) THEN OLD.permissions ELSE '{}' END, '$.frp'), 1) = 1
        AND COALESCE(json_extract(CASE WHEN json_valid(NEW.permissions) THEN NEW.permissions ELSE '{}' END, '$.frp'), 1) = 0)
    -- proxy
    OR (COALESCE(json_extract(CASE WHEN json_valid(OLD.permissions) THEN OLD.permissions ELSE '{}' END, '$.proxy'), 1) = 1
        AND COALESCE(json_extract(CASE WHEN json_valid(NEW.permissions) THEN NEW.permissions ELSE '{}' END, '$.proxy'), 1) = 0)
    -- doulor
    OR (COALESCE(json_extract(CASE WHEN json_valid(OLD.permissions) THEN OLD.permissions ELSE '{}' END, '$.doulor'), 1) = 1
        AND COALESCE(json_extract(CASE WHEN json_valid(NEW.permissions) THEN NEW.permissions ELSE '{}' END, '$.doulor'), 1) = 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'USER_WHITELISTED: 该账号在监管白名单中，权限不会被收回');
END;
