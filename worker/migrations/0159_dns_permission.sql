-- 0159_dns_permission.sql
--
-- DNS 解析记录改为**按权限开放**：给存量普通用户的 permissions JSON 显式写上
-- `"dns": false`（2026 站长要求。新权限 feature 的定义见 src/permissions.ts 的 FEATURES）。
--
-- 为什么这件事要动存量数据（而不是只加个新键就完事）：
--   `parsePermissions` 对 JSON 里**没有出现的键**是按 `allPermissions()` 兜底的，而
--   `allPermissions()` 又只看 `DEFAULT_ALLOWED`。dns 不在这份名单里（它是配额闸：
--   Cloudflare 每个 zone 的解析记录数有硬上限，全站共用少数几个 zone），
--   所以**缺键本来就已经解析成 false** —— 本迁移不改任何人的实际能力，它做的是
--   「把状态写明白」：之后无论谁再动 DEFAULT_ALLOWED，这批用户的 dns 都不会
--   被静默放开；排查「这人到底有没有 DNS 权限」时也不必再去脑补缺键的兜底口径。
--
-- ⚠️ 本迁移**只动权限**，绝不碰 dns_records：
--   存量记录要不要清理由站长的运维脚本单独决定（删记录是不可逆的破坏性动作，
--   不该藏在一条会被自动执行的迁移里）。
--
-- 例外（站长明确要求）：
--   · `paji` —— 站长的账号，不限制；
--   · `role != 'user'` —— 管理员/站长不受权限体系约束（requireFeatureUser 对
--     `isPrivileged()` 直接放行），给他们写上 false 只会让数据看起来自相矛盾。
--
-- 写法说明（与 0128_donation_quota_types.sql 同一套，也和 src/permissions.ts 的
-- `PERMISSIONS_JSON_EXPR` 同源）：
--   · `CASE WHEN json_valid(permissions) ... ELSE '{}' END` ——
--     `json_set(NULL, …)` 会返回 NULL 把整列抹掉，`json_extract` 遇到坏 JSON 会抛错。
--     兜底成 `'{}'` 是安全的：parsePermissions 的口径里 `'{}'` 与 NULL 完全等价。
--   · `json('false')` 而不是 `0` —— 权限键必须是 **JSON 布尔**（parsePermissions 只认
--     `typeof v === "boolean"`），写成数字会被当成「缺键」而回落，白写一场。
--   · 只 json_set 目标键、不重建整个对象 —— 其它模块的权限（含历史残留的 profile/frp）
--     原样保留。
--
-- 幂等：json_set 重复执行结果不变，重跑无副作用。本迁移不回滚 ——
-- 要恢复只需把 permissions 改回去（或直接给用户勾上 dns 权限），没有结构变更。
--
-- ⚠️ 不会被 0114 的白名单触发器 ABORT：那个触发器只列举了 r2/ai/frp/proxy/doulor
--    五个键的「允许 → 不允许」，dns 不在其中（它是本次新加的）。
--    真要给它加上 dns 的话，得先想清楚「白名单用户能不能被收回 DNS」——
--    那是另一个决定，不要顺手改。

UPDATE users
   SET permissions = json_set(
         CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END,
         '$.dns', json('false')
       )
 WHERE role = 'user'
   -- 大小写不敏感：站长的用户名在别处（0114 的触发器、管理端检索）也是按 NOCASE 比的
   AND username <> 'paji' COLLATE NOCASE;
