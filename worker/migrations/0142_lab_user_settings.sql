-- 0142_lab_user_settings.sql
-- AI 实验室：**用户级设置**（2026-10-10）。
--
-- 目前只放一样东西：用户自己填的 Tavily key（联网搜索用）。
--
-- 为什么用户自己的 key 单独存、而不是塞进 `users`：
--   `users` 是全站最热的表，加一列就意味着所有查询都要多带一个密文字段；
--   而这种「某个功能自己才用得到」的配置天生属于功能自己的表。
--
-- ⚠️ 存的是**密文**（`encryptSecret(raw, SESSION_SECRET)`），
--    和 `r2_buckets` 的凭据同一个口径 —— key 永远只以明文出现在服务端内存里，
--    接口对外只回「有没有配」，不回内容。
--
-- 与站点 key 的关系：用户填了自己的就用自己的（不扣积分）；
-- 没填才回落到管理面板那几把站点 key，**那才扣积分**（见 handlers/lab-search.ts）。

CREATE TABLE IF NOT EXISTS lab_user_settings (
  user_id        TEXT PRIMARY KEY,
  -- 用户自己的 Tavily key（密文）；NULL = 没配，走站点 key
  tavily_key_enc TEXT,
  updated_at     TEXT NOT NULL
);
