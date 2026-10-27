-- 模型探活的候选清单（2026-10-27）
--
-- 为什么单独存：一次探几十个模型会超过 Worker 的后台执行预算而被掐断，
-- 所以改成「清单落库 + 每轮只探最久没探过的 8 个」轮流覆盖。

CREATE TABLE IF NOT EXISTS probe_model_list (
  model      TEXT PRIMARY KEY,
  source     TEXT,
  updated_at INTEGER NOT NULL
);
