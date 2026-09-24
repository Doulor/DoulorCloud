# Doulor Cloud

一站式云端平台：二级域名、域名邮箱、直链网盘与 AI API，开箱即用。**纯静态前端 + Serverless 后端**。

## 架构

```
Browser
  ↓
Cloudflare Pages（纯静态前端：Vite + React + TS）
  ↓
Cloudflare Workers（API：鉴权 / 权限 / Cloudflare API 调用）
  ↓
D1（数据）/ KV / R2 / Cloudflare API
```

- 前端不含任何 Node 运行时，不依赖 SSR。
- 所有敏感凭证（Cloudflare Token、Zone ID、会话密钥）仅存在于 Worker 环境变量。
- 前端绝不信任任何身份 / 所有权字段，权限一律在 Worker 端校验。

## 目录结构

```
src/                     # 前端（Vite + React + TS）
  components/ui/         # shadcn/ui 组件
  components/            # 业务组件
  layouts/               # Landing / Dashboard 布局
  pages/                 # 页面
  lib/                   # 工具
  services/api.ts        # 统一 API 请求层
  hooks/                 # useAuth / useTheme
  types/                 # 共享类型
worker/                  # Cloudflare Worker（独立 package）
  src/                   # Worker 源码
  migrations/            # D1 迁移（0002 起，按序执行）
  schema.sql             # D1 基线表结构 + 后续模型
  wrangler.toml          # Worker 配置
  .dev.vars.example      # 环境变量样例
```

## 前端开发

```bash
npm install
npm run dev        # Vite 开发服务器，/api 代理到 localhost:8787
npm run build      # 产出 dist/，纯静态，可直接部署 Cloudflare Pages
```

## Worker 开发

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # 填入真实值
npm run db:init                  # 初始化 D1（本地需先 wrangler d1 create）
npm run dev                      # wrangler dev，默认 http://localhost:8787
npm run deploy                   # 部署到 Cloudflare
```

## 环境变量 / Secrets（全部通过 Cloudflare 配置）

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN_SECRET` | Cloudflare Token（Secret）：Zone→DNS Edit + Account→Email Routing Addresses Edit |
| `ZONE_ID` | 根域名 Zone ID |
| `ACCOUNT_ID` | Cloudflare 账户 ID（管理转发目标地址用） |
| `ROOT_DOMAIN` | 根域名，默认 `doulor.cn` |
| `SESSION_SECRET` | 用于派生 AES-GCM 密钥，加密第三方长期凭据（如 NewAPI token） |
| `R2_S3_ENDPOINT` / `R2_BUCKET` / `R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY` | 网盘 S3 兼容接口（跨账户 R2） |
| `NEWAPI_BASE_URL` / `NEWAPI_ADMIN_TOKEN` | AI 中转站（NewAPI）管理端 |
| `CF_WORKERS_TOKEN` | 可选：绑定自定义直链域名用（缺省时该功能隐藏） |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/register` | 注册（需邀请码） |
| POST | `/api/login` / `/api/logout` | 登录 / 登出 |
| GET | `/api/me` | 当前用户 + 统计 |
| PUT | `/api/password` | 修改密码（校验当前密码，踢掉其他会话） |
| GET/POST | `/api/subdomains` | 子域名列表 / 创建（根域直系，含主域名共 5 个） |
| DELETE | `/api/subdomains/:id` | 删除子域名 |
| GET/POST | `/api/dns` | DNS 记录列表 / 创建（不限条数） |
| PUT/DELETE | `/api/dns/:id` | 更新 / 删除 DNS 记录 |
| GET/POST | `/api/mailbox` | 邮箱列表 / 添加（每用户最多 3 个） |
| PUT/DELETE | `/api/mailbox/:id` | 转发设置 / 删除邮箱 |
| GET | `/api/mailbox/:id/messages` | 收件箱列表（不含正文） |
| GET/DELETE | `/api/mailbox/:id/messages/:mid` | 邮件详情（含正文，自动标已读）/ 删除 |
| POST | `/api/mailbox/:id/messages/:mid/read` | 标记已读/未读 |
| GET/POST | `/api/storage*` | 网盘：用量、直链上传、提交、下载、绑定域名 |
| GET/POST | `/api/dev/*` | AI 中转站：状态、绑定、API Key 管理 |
| GET/POST/PUT/DELETE | `/api/admin/*` | 管理端：用户、邀请码、全局设置、网盘运维 |

## 权限模型

- 用户注册后获得 `username.doulor.cn`（主域名），可再创建最多 4 个根域直系子域名
  （`xxx.doulor.cn`），合计 5 个。
- 所有写操作先经 `requireUser`（session → D1 身份）；DNS 写入再经 `assertFqdnOwned`
  校验目标 FQDN 是否落在该用户名下的某个子域名内。
- 邮箱只能操作自己名下的收件箱（`requireMailbox` 比对 `user_id`）。
- 越权访问一律 403 / 404，绝不信任前端传入的身份或所有权字段。
- 管理员端点额外要求 `role === 'admin'`；主管理员 `doulor` 不可被删除或降权。

## 部署

线上环境（2026-09-21 起）：

- **前端站点 Worker**（静态资产）：`doulor-mail` → https://mail.doulor.cn
  - 根目录 `wrangler.jsonc`（`assets.not_found_handling = single-page-application` + 自定义域路由）
  - 根目录执行 `npm run build && npx wrangler deploy --config wrangler.jsonc --name doulor-mail`
- **API Worker**：`doulor-mail-api` → 路由 `doulor.cn/api/*` + `mail.doulor.cn/api/*`
  - `cd worker && npx wrangler deploy --config wrangler.toml --name doulor-mail-api`
  - Secret：`CLOUDFLARE_API_TOKEN_SECRET`（限权 Token，仅 Worker 端，已用 `wrangler secret put` 配置）
- **D1**：`doulor-mail`（id `9ae6127c-75f7-4688-bbe3-31ed856859c5`）
  - `cd worker && npx wrangler d1 execute doulor-mail --remote --file=./migrations/000N_*.sql`
- **GitHub**：https://github.com/Doulor/doulor-mail （私有）

> ⚠️ **基础设施标识符不可重命名**：Worker 名 `doulor-mail-api` 被 5 条 Email Routing 规则
> 硬引用（改名会中断收信）；D1 名 `doulor-mail` 承载全部数据；
> `crypto.ts` 中的 HKDF salt `doulor-mail-secret-v1` 用于加密已存的第三方凭据（改动会导致无法解密）。
> 产品对外名称已统一为 **Doulor Cloud**，上述标识符保持不变。

### Email 入站

已启用。`worker/wrangler.toml` 的 `[email]` 段 + 每个邮箱一条 Email Routing 规则
（`<address>` → `doulor-mail-api`），由 `register` / `createMailbox` 自动创建。

**转发目标必须先验证**：Cloudflare 只允许转发到账户级已验证的 destination address。
Worker 在用户设置转发时会自动注册目标并触发验证邮件；未验证的目标不会真正转发，
界面上会标记为「转发待验证」。

### 邮件解析

入站邮件用 `postal-mime` 解析（RFC 2047 主题解码、quoted-printable/base64、
HTML-only 邮件的正文回退），存入 D1 `messages.text_body`。
