-- 用户被封禁时，让其**对外生效的资源**一并停止（可逆）：DNS 解析 / 子域名。
--
-- 背景（站长 2026-10-08）：封禁此前只做三件事 —— 标记 users.status、
-- 拉黑注册 IP、停用中转站账号。而用户留下的 DNS 解析、子域名、邮箱转发、
-- 邀请码**都还在对外生效**：封了一个人，他的解析照常响应、邮箱照常转发、
-- 邀请码照样能把人拉进来。本迁移与配套代码把前两项也停掉。
--
-- 语义（两列都是**时间戳**，不是布尔）：
--   · NULL      = 正常（未因封禁停用）；
--   · 非空      = 因封禁被停用，值为停用时刻；解封时按它挑出要恢复的行。
--
-- 为什么用时间戳而不是布尔：排查时能直接看出「什么时候被停的」，
-- 而且天然能表达「哪一次封禁」（同一行被反复封/解也可区分先后）。
--
-- 为什么**不直接删行**：解封要能原样恢复。DNS 记录的完整字段
-- （type/content/ttl/proxied/priority/srv_*）都留在本地，解封时据此
-- 在 Cloudflare 上重建；子域名只标记，解析靠它下面的记录。
--
-- ⚠️ 线上执行顺序（站内规矩）：**先加列、再部署后端**。
--    后端代码会引用这两列，结构没到位就是「引用不存在的列」⇒ 接口 500。

ALTER TABLE dns_records ADD COLUMN banned_at TEXT;
ALTER TABLE subdomains ADD COLUMN banned_at TEXT;

-- 按「是否被停用」筛选（恢复时全表扫这两列）
CREATE INDEX IF NOT EXISTS idx_dns_records_banned ON dns_records(banned_at);
CREATE INDEX IF NOT EXISTS idx_subdomains_banned ON subdomains(banned_at);
