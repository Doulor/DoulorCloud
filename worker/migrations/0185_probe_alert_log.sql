-- 告警冷却（2026-10-27）
--
-- 中转站这类目标会 401/502 来回抖，每次翻转都推群会把群吵死。
-- 每个目标 30 分钟内最多报一次；故障与恢复共用同一条冷却记录。

CREATE TABLE IF NOT EXISTS probe_alert_log (
  name          TEXT PRIMARY KEY,
  last_alert_at INTEGER NOT NULL
);
