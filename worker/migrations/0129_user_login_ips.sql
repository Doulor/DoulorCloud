-- 登录 IP 记录（2026-10-08 站长要求：新增「IP 监管」）
--
-- 用途：记录每个用户**登录时**的来源 IP，供管理端「IP 监管」查出
--       「多个不同账号共用同一个 IP」的可疑情况（小号 / 团伙）。
--
-- 设计要点（改之前先读）：
--   · 一个 (user_id, ip) 只留**一行**，重复出现只累加 times 并刷新 last_seen_at。
--     因为经常换节点的人会有一堆 IP —— 那是**正常现象**，不该膨胀成日志表。
--   · 所以这张表是「用户 × IP 的去过重集合」，不是流水账。
--   · ip 单独建索引：管理端是「按 IP 反查有哪些用户」，与主键方向相反。
--
-- ⚠️ 历史用户只有 audit_logs 里的**注册 IP**，没有登录 IP 记录；
--    这张表只能记录上线之后的登录。注册时也会写入一行（作为首个 IP）。

CREATE TABLE IF NOT EXISTS user_login_ips (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  ip            TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  -- 见过几次（同一 IP 反复登录会累加）。仅作参考，不参与风险判定。
  times         INTEGER NOT NULL DEFAULT 1
);

-- 同一用户同一 IP 只留一行（UPSERT 靠它）
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_login_ips_user_ip
  ON user_login_ips(user_id, ip);

-- 按 IP 反查：管理端「哪些账号共用这个 IP」
CREATE INDEX IF NOT EXISTS idx_user_login_ips_ip
  ON user_login_ips(ip);
