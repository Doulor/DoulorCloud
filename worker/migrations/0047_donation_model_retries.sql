-- 0047_donation_model_retries.sql
-- AI 渠道捐献里「没通过可用性测试」的模型，结构化落库以便自动重试。
--
-- 为什么需要：`provisionDonationChannel` 建渠道后逐个模型真实测一次，失败的
-- 从渠道里剔除。但失败模型名此前只写进 `donations.review_note` 那段给人看的
-- 文本里，**没有结构化记录** —— 于是某模型当时因超时/限流没通过，之后恢复了
-- 也永远不会被补回渠道。
--
-- 真实案例：一个 Grok 上游 9 个模型只有 1 个通过，其余 8 个被永久剔除，
-- 其中 6 个报的是「测试超时（超过 10 秒无响应）」——纯属当时抖了一下。
--
-- 设计取舍：
--   - 与 `donations` 只靠外键关联，**不解析 review_note 文本**（文本是给人看的，
--     格式随时可能改，拿它当数据源迟早出问题）；
--   - 主键 (donation_id, model) 保证同一笔捐献里同一模型只有一行，重试更新用
--     ON CONFLICT DO UPDATE 即可；
--   - `channel_id` 冗余存一份：即使 donations 行被撤销、渠道被删，也能据此判断
--     「这个模型所属的渠道还在不在」，从而把重试标记为 exhausted 而不是反复试。

CREATE TABLE IF NOT EXISTS donation_model_retries (
  donation_id   TEXT NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,          -- 上游真实模型名（不带 donation- 前缀）
  channel_id    INTEGER NOT NULL,       -- 所属 NewAPI 渠道
  status        TEXT NOT NULL,          -- uncertain | failed | recovered | exhausted
  reason        TEXT,                   -- 最近一次失败原因（面向管理员）
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_tried_at TEXT NOT NULL,
  next_retry_at TEXT NOT NULL,          -- 到期才会被重试任务捞起
  created_at    TEXT NOT NULL,
  PRIMARY KEY (donation_id, model)
);

-- 重试任务的核心查询：WHERE status IN (...) AND next_retry_at <= now
CREATE INDEX IF NOT EXISTS idx_dmr_due ON donation_model_retries(status, next_retry_at);
