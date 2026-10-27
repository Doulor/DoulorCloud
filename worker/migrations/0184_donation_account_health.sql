-- 捐献账号健康状态：wb / qoder 也纳入（2026-10-27）
--
-- 背景：号池里 workbuddy-intl 210 个号、qoder 28 个号已被禁用，但站点侧的绑定
-- 全是 status='active' → group-sync 照旧按「绑定数 × ¥400/天」发额度，
-- 用户白拿额度、还收不到任何提醒。
--
-- 现在统一口径（与小浣熊一致）：
--   · status='invalid' → **不再计入每日额度**（额度收回）
--   · 但**分组不变**：composeGroup 用 status IN ('active','invalid') 判断，
--     用户仍然保留 workbuddy / qoder 分组（站长 2026-10-27 明确要求）
--   · 号恢复可用 → 状态自动回 active → 额度自动加回

ALTER TABLE wb2api_bindings ADD COLUMN status_note TEXT;
ALTER TABLE wb2api_bindings ADD COLUMN invalid_at INTEGER;
ALTER TABLE wb2api_bindings ADD COLUMN invalid_reason TEXT;
ALTER TABLE wb2api_bindings ADD COLUMN last_checked_at INTEGER;

ALTER TABLE qoder2api_bindings ADD COLUMN status_note TEXT;
ALTER TABLE qoder2api_bindings ADD COLUMN invalid_at INTEGER;
ALTER TABLE qoder2api_bindings ADD COLUMN invalid_reason TEXT;
ALTER TABLE qoder2api_bindings ADD COLUMN last_checked_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_wb2api_bindings_status ON wb2api_bindings(status, user_id);
CREATE INDEX IF NOT EXISTS idx_qoder2api_bindings_status ON qoder2api_bindings(status, user_id);
