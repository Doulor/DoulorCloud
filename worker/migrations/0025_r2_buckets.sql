-- ⚠️ 编号说明：本文件原名 0023_r2_buckets.sql，与同时期其他 AI 新增的
-- 0023_identity.sql 撞号。两者内容均已应用到线上，此处仅重命名以消除歧义。
-- 文件名序号不代表执行顺序。
-- 多桶 R2 支持
--
-- 背景：免费额度每账户 10 GB，单桶装不下太多用户。用多个 Cloudflare 账户的桶
-- （1 号桶 network 在 adoulor，2 号桶 network2 在 bdoulor）横向扩容。
--
-- r2_buckets：桶配置。S3 凭据用 SESSION_SECRET 派生的 AES-GCM 加密后存库
--   （见 crypto.ts 的 encryptSecret），管理面板可增删改。
--   max_users / quota_per_user 可在管理面板随时调整，分配逻辑据此自动均衡。
--
-- storage_accounts.bucket_id：用户归属的桶。
--   NULL 表示「未纳入多桶管理」——老用户保持 NULL，继续走 env 里配置的默认桶，
--   避免迁移影响既有数据；只有新开通的用户才会被自动分配到具体桶。

CREATE TABLE IF NOT EXISTS r2_buckets (
  id                TEXT PRIMARY KEY,           -- 标识，如 b1 / b2
  name              TEXT NOT NULL,              -- 显示名，如 "1 号桶 network"
  account_id        TEXT,                       -- Cloudflare 账户 ID（Analytics 用）
  endpoint          TEXT NOT NULL,              -- S3 endpoint
  bucket_name       TEXT NOT NULL,              -- 桶名
  access_key_id_enc TEXT NOT NULL,              -- 加密的 Access Key ID
  secret_key_enc    TEXT NOT NULL,              -- 加密的 Secret Access Key
  analytics_token_enc TEXT,                     -- 可选：读 A/B 类操作数的 token（加密）
  max_users         INTEGER NOT NULL DEFAULT 8,         -- 人数上限
  quota_per_user    INTEGER NOT NULL DEFAULT 1073741824, -- 每人配额（1 GiB）
  enabled           INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

ALTER TABLE storage_accounts ADD COLUMN bucket_id TEXT;