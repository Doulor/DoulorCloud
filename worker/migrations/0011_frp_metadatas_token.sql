-- Doulor Cloud D1 迁移：申请审批时记录 metadatas.token
-- 该令牌需与管理员在 frps-panel 里创建的保持一致，用户才能生成可用配置。
ALTER TABLE frp_applications ADD COLUMN metadatas_token TEXT;
