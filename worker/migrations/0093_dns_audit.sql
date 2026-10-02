-- DNS 解析合规审计
--
-- 背景（2026-10-01）：站内 DNS 解析功能此前**没有任何审核** —— 用户建记录直接
-- 打 Cloudflare API，成不成只由 CF 的字段校验决定，不判断「这条记录该不该存在」。
-- 结果是平台上出现了「整段域名转发给外部站点」「用平台域名托管 Pageis 站点」
-- 「指向内网地址」这类记录，站长既看不到、也没有地方处理。
--
-- 本表保存**扫描发现项**，不是记录本身（记录仍在 dns_records）。
--
-- 为什么发现项要落库而不是每次现算：
--   1. 需要「已忽略 / 已处理」的处置状态，现算的没有记忆，同一批告警会一直刷。
--   2. 角标要的是「待处理条数」，一条 COUNT 比每次全表跑规则便宜得多。
--   3. 记录被删掉后仍要留档（record_id 置空），否则「告警消失」与「被处理了」
--      这两种情况分不出来。
--
-- ⚠️ 线上 `d1_migrations` 是空的，**不要跑 `wrangler d1 migrations apply`**，
--    手工执行本文件：
--      npx wrangler d1 execute doulor-mail --remote --file=./migrations/0093_dns_audit.sql
--    且必须**先建表、后部署代码** —— 否则接口在运行时才报 no such table。

CREATE TABLE IF NOT EXISTS dns_audit_findings (
  -- 确定性 id：hash(rule|fqdn|type|content)，同一条问题重复扫描不会产生新行
  id            TEXT PRIMARY KEY,
  -- 关联的 dns_records.id。记录被删除后这里保留旧 id（**不置空**）：
  -- 置空会让「哪条记录惹的祸」在事后完全查不出来，而删除记录恰恰是最常见的处置动作。
  -- 「这条记录还在不在」由 status 表达（记录消失 ⇒ resolved）。
  record_id     TEXT,
  fqdn          TEXT NOT NULL,
  type          TEXT NOT NULL,
  content       TEXT NOT NULL,
  -- 归属者（快照，用户改名/注销后仍可追溯）
  username      TEXT,
  -- 规则 id，如 private-ip / forward-domain（见 worker/src/dns-audit.ts）
  rule          TEXT NOT NULL,
  severity      TEXT NOT NULL,              -- high | medium | low
  detail        TEXT NOT NULL,              -- 面向站长的中文说明
  status        TEXT NOT NULL DEFAULT 'open', -- open | ignored | resolved
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  reviewed_by   TEXT,                       -- 处置人 username
  reviewed_at   TEXT,
  note          TEXT                        -- 处置备注（忽略原因等）
);

CREATE INDEX IF NOT EXISTS idx_dns_findings_status ON dns_audit_findings(status, severity);
CREATE INDEX IF NOT EXISTS idx_dns_findings_record ON dns_audit_findings(record_id);
CREATE INDEX IF NOT EXISTS idx_dns_findings_fqdn ON dns_audit_findings(fqdn);

-- 上次扫描的时间戳（单行表，与 app_settings 分开存，避免污染设置快照）
CREATE TABLE IF NOT EXISTS dns_audit_runs (
  id           TEXT PRIMARY KEY,            -- 固定 'last'
  ran_at       TEXT NOT NULL,
  mode         TEXT NOT NULL,               -- hourly | manual
  scanned      INTEGER NOT NULL,            -- 扫描记录数
  found        INTEGER NOT NULL,            -- 本次发现问题数
  high         INTEGER NOT NULL,
  medium       INTEGER NOT NULL,
  low          INTEGER NOT NULL,
  note         TEXT                         -- 例如「未做解析探测」的原因
);
