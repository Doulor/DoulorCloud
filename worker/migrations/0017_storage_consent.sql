-- 网盘使用协议同意记录
--
-- 与 proxy_activation 的做法一致：用户点「开通网盘」前必须勾选同意，
-- 服务端记录同意的版本；协议更新后（版本号提升）要求重新同意。
--
-- 目的：明确用户不得存放违规内容、违规后果自负并可能永久封号，
-- 尽可能降低平台责任。

ALTER TABLE storage_accounts ADD COLUMN consent_version INTEGER;
ALTER TABLE storage_accounts ADD COLUMN consented_at TEXT;