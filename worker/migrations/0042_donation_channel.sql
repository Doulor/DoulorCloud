-- 0042_donation_channel.sql
-- 「AI 渠道捐献自动化」：记录自动创建的 NewAPI 渠道，以及这次审核是不是系统自动做的。
--
-- 背景：AI 类型捐献改为自动化 —— 提交时由服务端探测上游、在 NewAPI 建渠道并做一次
-- 真实连通性测试；通过就自动批准，失败就自动拒绝并写明原因，管理员可在管理面板
-- 人工复核（重试建渠道 / 直接放行）。
--
-- newapi_channel_id：自动（或管理员复核时）创建的 NewAPI 渠道 id。
--   - 有值 = 该捐献的资源已真正接入中转站
--   - 撤销捐献时据此把渠道删掉，收回资源（而不只是收回站点权限）
--   - 值一旦写入就不再清空：撤销后重新批准会重新建渠道并覆盖为新的 id，
--     序号用「有过渠道的捐献条数」推进，不会重复占用「捐献NN」这个名字。
--
-- auto_reviewed：这次审核是否为系统自动完成（1=自动，0=人工/尚未审核）。
--   管理面板据此区分「系统已自动通过」和「管理员点过通过」，并标示出
--   「被自动拒绝、等着人工复核」的那些。

ALTER TABLE donations ADD COLUMN newapi_channel_id INTEGER;
ALTER TABLE donations ADD COLUMN auto_reviewed INTEGER NOT NULL DEFAULT 0;
