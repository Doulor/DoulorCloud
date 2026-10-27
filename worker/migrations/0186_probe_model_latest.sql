-- 模型探活结果（2026-10-27）
--
-- 与服务探针分开存：服务只有 4 个固定目标（probe_latest），
-- 模型则是「已启用渠道」里的一大票，且要单独出一张长图。

CREATE TABLE IF NOT EXISTS probe_model_latest (
  model      TEXT PRIMARY KEY,
  ok         INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  ms         INTEGER,
  checked_at INTEGER NOT NULL
);
