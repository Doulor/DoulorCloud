export interface Env {
  DB: D1Database
  /** 出站邮件绑定（Cloudflare Email Service，见 wrangler.toml 的 [[send_email]]） */
  EMAIL?: SendEmail
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
  // ⚠️ 多桶配置存 D1 的 r2_buckets 表（见 migrations/0023），**日常无需这些 env 变量**。
  // 以下 4 项是「默认桶」兜底：仅当某用户的 storage_accounts.bucket_id 为 NULL
  // （未纳入多桶管理）时才用到。当前线上所有用户都已分配具体桶，故它们可留空。
  R2_S3_ENDPOINT?: string
  R2_BUCKET?: string
  R2_S3_ACCESS_KEY_ID?: string
  R2_S3_SECRET_ACCESS_KEY?: string
  // 全局 R2 凭据（唯一的 R2 token）：一个 Cloudflare API Token 覆盖所有账户。
  // 用途：
  //   1. 桶操作 —— 桶记录里凭据留空时回退到这里（新增桶无需重复填凭据）
  //   2. 读 A/B 类操作数 —— 桶记录里 analytics_token_enc 可覆盖
  // 所需权限：Account → Workers R2 Storage → Edit
  //           Account → Account Analytics → Read（读操作数）
  R2_API_TOKEN?: string
  // 可选：Doulor 账户 token，含 Zone → Workers Routes → Edit，
  // 用于把自定义二级域名指到本 Worker（未配置时该功能自动隐藏）
  CF_WORKERS_TOKEN?: string
  WORKER_NAME?: string // 本 Worker 名，默认 doulor-mail-api

  // ---- AI 中转站（NewAPI）----
  NEWAPI_BASE_URL?: string
  NEWAPI_ADMIN_TOKEN?: string // Root 访问令牌（Secret）
  NEWAPI_ADMIN_USER_ID?: string // 令牌对应的用户 id，默认 1

  // ---- 代理节点 ----
  // 订阅链接可能需要鉴权（部分订阅系统要求 Authorization 头）；
  // 配置后 Worker 抓取订阅源时会带上 Bearer 头。
  PROXY_API_TOKEN?: string
}