-- 0193_mail_send_usage.sql
-- CF 发信的月度用量计数（2026-11-08 站长要求：不允许产生超额扣费）
--
-- 背景：Cloudflare Email Sending 在 Workers Paid 下含 3,000 封/月，超出按
-- $0.35/千封计费。本站的原则是"能免费就不花钱"，所以发信链先走 Brevo
-- （超额度只是发不出去、不扣费），CF 只做备用，并且由本地计数卡死上限
-- （设置项 cf_send_monthly_cap，默认 2900）。
--
-- 为什么不用 Cloudflare 账单/用量 API 当依据：没有轻量的只读接口，而且那要
-- 额外的 token 权限；本地计数已经够用 —— 本 Worker 是这一账号下唯一发信方。
-- 代价是"别的系统也在这个账号发信"时会低估用量，所以默认上限比 3,000 低 100 封。
--
-- 口径（见 worker/src/mailer.ts 的 noteCfSendUsage）：
--   · 只有**被 Cloudflare 受理**（HTTP 2xx）的才 +1；API 边界被拒的不计（官方口径）。
--   · 硬退（permanent bounce）也算 —— 官方口径是"accepted 即计入"。
--   · 发往 mail_cf_targets 白名单（已验证 destination）的信永远免费，**不记**。
--
-- period 的格式是 `YYYY-MM`，但"一个月"不一定从 1 号开始：设置项
-- cf_send_period_start_day 可以让它与 Cloudflare 的账期（订阅周年日）对齐。
CREATE TABLE IF NOT EXISTS mail_send_usage (
  -- 目前只有 'cf'（brevo / posta 的额度是按天重置的，不需要计数表）
  channel    TEXT    NOT NULL,
  -- 计费窗口，YYYY-MM
  period     TEXT    NOT NULL,
  -- 已受理封数
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (channel, period)
);
