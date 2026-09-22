export interface Env {
  DB: D1Database
  CLOUDFLARE_API_TOKEN?: string // 普通环境变量
  CLOUDFLARE_API_TOKEN_SECRET?: string // 推荐：Secret（优先）
  ZONE_ID: string
  ACCOUNT_ID?: string // Cloudflare 账户 ID（Email Routing destination 管理用）
  ROOT_DOMAIN: string // e.g. doulor.cn
  EMAIL_WORKER_NAME?: string // Email Routing 规则指向的 Worker 名，默认 doulor-mail-api
  ADMIN_INVITE_CODES?: string // comma-separated seed invite codes
  SESSION_SECRET?: string // 用于派生 AES-GCM 密钥（加密第三方长期凭据）
  // Email Workers 注入的入站邮件消息（仅 /_email/incoming 路由）
  email?: ForwardableEmailMessage

  // ---- R2 直链网盘（S3 兼容 API）----
  // 桶 `network` 位于 adoulor 账户，与本 Worker（Doulor 账户）跨账户，
  // 无法用 [[r2_buckets]] 绑定，因此走 S3 接口 + SigV4。
  R2_S3_ENDPOINT?: string
  R2_BUCKET?: string
  R2_S3_ACCESS_KEY_ID?: string
  R2_S3_SECRET_ACCESS_KEY?: string
  // 可选：Doulor 账户 token，含 Zone → Workers Routes → Edit，
  // 用于把自定义二级域名指到本 Worker（未配置时该功能自动隐藏）
  CF_WORKERS_TOKEN?: string
  WORKER_NAME?: string // 本 Worker 名，默认 doulor-mail-api

  // ---- AI 中转站（NewAPI）----
  NEWAPI_BASE_URL?: string
  NEWAPI_ADMIN_TOKEN?: string // Root 访问令牌（Secret）
  NEWAPI_ADMIN_USER_ID?: string // 令牌对应的用户 id，默认 1
}