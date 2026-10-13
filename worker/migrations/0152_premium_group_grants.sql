-- 0152_premium_group_grants.sql
-- 「付费分组」授权名单（站长 2026-10-11 要求）。
--
-- 背景：NewAPI 的用户分组是「一个标签 → 一组可用分组」的映射
-- （见 `service/group.go` 的 `GetUserUsableGroups`）。「付费」分组本来是给
-- 充值用户的（`TopupGroupRatio` 里充值倍率 10），站长要给**指定的白名单用户**
-- 白开这个分组 ⇒ 站点侧需要记一份名单。
--
-- 设计要点：
--   1. **永久有效**（站长明确要求「永久的」）⇒ 刻意**没有 expires_at**；
--   2. 与订阅系统**完全独立**：订阅有期限、走 `newapi_accounts` / 订阅表，
--      而这里是纯粹的「分组授权」，**不产生任何额度**（额度仍由 group-sync 按
--      有效 wb 账号数算）；
--   3. 主键落在 `user_id` 上 ⇒ 一个人最多一条，重复授权天然幂等；
--   4. 管理员账号被删也保留这条记录（`granted_by` 存的是用户名快照，不是外键）。
--
-- 联动：`worker/src/handlers/group-sync.ts::composeGroup()` 读这张表，
-- 命中的用户在组合分组名末尾追加 `-付费`，由 vps2 的 group-sync 服务
-- （每 60 秒一轮）同步进 NewAPI 的 `users."group"`。
CREATE TABLE IF NOT EXISTS premium_group_grants (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 操作人用户名（审计用）
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_premium_group_grants_time ON premium_group_grants(granted_at);
