-- AI 实验室「免费试用」额度计数。
--
-- 背景：管理员可以把实验室的模型来源切成「全站统一用我提供的 Key」，
-- 用户端标为免费试用。此时调用走的是站长的额度，必须能按人按周期封顶，
-- 否则一把 Key 敞开给全站用，被刷爆只是时间问题。
--
-- period_key 由 worker/src/lab-config.ts::labQuotaPeriodKey 生成：
--   · day   → YYYY-MM-DD（按站点时区 site_timezone_offset_hours，非硬编码 +8）
--   · month → YYYY-MM
--   · total → 固定字符串 "total"（一次性发放，永不重置）
-- 换周期不会互相污染，旧的计数行留着也不影响新周期 —— 不需要清理任务。

CREATE TABLE IF NOT EXISTS lab_free_usage (
  user_id    TEXT    NOT NULL,
  period_key TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, period_key)
);
