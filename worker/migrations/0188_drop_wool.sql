-- 羊毛台账整体下线（2026-10-27）
--
-- 站长要求把「资源共享」社区模块跟 QQ 群打通：群里的羊毛直接发成资源贴，
-- 不再单独维护羊毛表。这里把旧表删掉，避免留下两套数据源。

DROP TABLE IF EXISTS wool_items;
DROP TABLE IF EXISTS wool_quota;
