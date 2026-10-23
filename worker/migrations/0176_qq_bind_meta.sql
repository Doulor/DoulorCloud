-- 0176: QQ 绑定补充信息（2026-10-24）
--
-- QQ 官方 API 不提供 QQ 号，只有 openid。为了在网站上能区分/认出是哪个 QQ，
-- 记下绑定来源（私聊 c2c / 群 group + group_openid），并允许用户自填备注。

ALTER TABLE qq_bindings ADD COLUMN scope TEXT NOT NULL DEFAULT 'c2c';
ALTER TABLE qq_bindings ADD COLUMN group_openid TEXT;
ALTER TABLE qq_bindings ADD COLUMN label TEXT;
