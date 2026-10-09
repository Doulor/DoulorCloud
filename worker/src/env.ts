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
  /**
   * OIDC 协议元数据的规范来源（如 `https://cloud.doulor.cn`），可留空。
   *
   * ⚠️ 2026-09-25 审计（L19）：不配置时 issuer / picture 会回落到
   * 「请求的 Host」——通过 `*.workers.dev` 访问就会宣告另一个 issuer。
   * 见 handlers/oauth.ts 的 canonicalOrigin()：本机调试与自定义域名会自动处理，
   * 只有需要强制指定（例如自定义域名与 ROOT_DOMAIN 不同源）时才设这一项。
   */
  OAUTH_ISSUER_ORIGIN?: string
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
  /**
   * 数据库备份直传令牌（2026-10-06）。
   *
   * 家里云的每日 cron 拿它换一个预签名上传地址，把 new-api 主库的 pg_dump
   * 直接 PUT 到 R2 平台桶（`db-backups/`）。见 handlers/db-backup.ts。
   * ⚠️ 未配置时该功能整体关闭（503），不会退化成公开上传口。
   */
  BACKUP_UPLOAD_TOKEN?: string
  /**
   * 中转站 step-up 安全验证（2026-10-07）。
   *
   * new-api 新版给「改用户状态/角色」等敏感写操作加了二次验证：必须用**会话型身份**
   * （具名访问令牌）先调 `/api/verify` 换一个**一次性** proof，再带 `X-Security-Proof`
   * 头调 `/api/user/manage`。老式访问令牌（`NEWAPI_ADMIN_TOKEN`）拿不到会话身份，
   * 所以这条链路必须用下面这对凭据：
   *   · `NEWAPI_STEPUP_TOKEN`    —— 一个**具名** Access token（需含 `user:write` 作用域）
   *   · `NEWAPI_STEPUP_PASSWORD` —— 该令牌所属账号的登录密码（`method=password` 要用）
   *
   * ⚠️ 所属账号**不能开 2FA**：开了之后 new-api 只提供 2FA 动态码方式，密码方式不再列出，
   * 自动化就用不了（`securityVerificationPolicy()`：`if state.HasTwoFA { methods = ["2fa"] }`）。
   * 因此建议单独建一个「机器人管理员账号」专用，别用 root。
   *
   * 两者都没配时，`adminSetUserStatus` 退回老路径（在 rc.41 上会失败并记审计）。
   */
  NEWAPI_STEPUP_TOKEN?: string
  NEWAPI_STEPUP_PASSWORD?: string

  // 全局 R2 凭据（唯一的 R2 token）：一个 Cloudflare API Token 覆盖所有账户。  // 用途：
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

  // ---- WorkBuddy 反代网关捐献通道 ----
  // 网关自身面板的访问密钥（Bearer）。作为 D1 单行表 wb2api_credentials 的
  // 回落：管理员可在管理面板在线更新（优先），也可用 wrangler secret put 配置。
  WB2API_API_KEY?: string
  /** 网关站点地址的 env 兜底（正常走 app_settings.wb2api_base_url） */
  WB2API_BASE_URL?: string

  // ---- Qoder2API 反代网关捐献通道（第二条，与 wb2api 并列）----
  // ⚠️ 这是该实例的 **console key（管理员密钥）**，不是给客户端用的 API key ——
  // qoder2api 的 `/api/*` 全部要求它，泄露等于整个账号池被拿走。
  // 作为 D1 单行表 qoder2api_credentials 的回落：管理员可在管理面板在线更新（优先），
  // 也可用 `wrangler secret put QODER2API_PANEL_PASSWORD` 配置。
  QODER2API_PANEL_PASSWORD?: string
  /** 网关站点地址的 env 兜底（正常走 app_settings.qoder2api_base_url） */
  QODER2API_BASE_URL?: string
}