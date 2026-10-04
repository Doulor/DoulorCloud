-- 0113_admin_notices_require_donation.sql
--
-- 「通知」功能扩展（2026-10-04 站长要求）：
--   在「确认收到前禁用 AI 中转站」之外，再加一层门槛 ——
--   用户点了「确认收到」之后，AI 中转站权限**也不直接解锁**，
--   必须先捐献站长在发布时勾选的渠道（wb 反代账号 / 内网穿透 / 代理节点）。
--
-- require_donation：JSON 数组，值域 ["wb","frp","proxy"]，NULL = 不要求捐献。
--   语义是「任选其一」：选中的渠道里**任意一个**已获批/已绑定即算满足。
--   想强制某一个（例如必须贡献 workbuddy），发布时只勾那一个即可。
--
-- 为什么不用新表：门槛信息与通知一一对应，且随通知撤回一起失效，
-- 挂在 admin_notices 上是最自然的（与 restrict_features 同类）。

ALTER TABLE admin_notices ADD COLUMN require_donation TEXT;
