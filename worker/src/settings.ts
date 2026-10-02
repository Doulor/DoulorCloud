/**
 * 全局运行参数（app_settings 表）。
 *
 * 所有可调数值都放在这里，让管理员能在管理面板即时修改而不需要重新部署。
 * 读取失败时回落到默认值，保证功能不会因为配置缺失而完全不可用。
 */
import { uuid } from "./crypto"
import type { Env } from "./env"

export const SETTING_DEFAULTS = {
  /** 新开通网盘的默认配额（字节） */
  storage_quota_bytes: "1073741824", // 1 GiB
  /** 网盘功能总开关 */
  storage_enabled: "1",
  /** 单文件大小上限（字节） */
  storage_max_file_bytes: "104857600", // 100 MiB
  /** AI 中转站总开关 */
  newapi_enabled: "1",
  /** 新开通 AI 账号的试用额度（NewAPI quota 单位，500000 = $1） */
  newapi_trial_quota: "500000",
  /** 新账号所属分组（也是站点自动创建的 Key 所属分组） */
  newapi_group: "default",
  /**
   * **捐献模型**（AI 渠道捐献）所属的 NewAPI 分组，默认 `donation`。
   *
   * 为什么要单独一个分组：捐献来的渠道来源杂、稳定性参差，跟站点自有的
   * `default` 渠道混在一个分组里，既看不清谁是谁，也没法单独控制谁能用。
   * 分出去之后：
   *   - 捐献渠道只进这个分组 ⇒ 用 `default` 分组的旧 Key **调不到捐献模型**；
   *   - 用户要调捐献模型，得**另建一个 Key 并选这个分组**（站点建 Key 的对话框已放开选择）；
   *   - 为此开通账号时会把本分组一并加进用户的 groups（否则用户在面板里选不到它）。
   *
   * ⚠️ 前端「全部可用模型」里的「捐献」分组**不是**按本设置项归类的，
   * 而是按模型名前缀 `donation-`（见 `donation-provision.ts` 的 `DONATION_MODEL_PREFIX`）。
   * 改这里不影响那个展示口径。
   */
  newapi_donation_group: "donation",
  /** 是否给予不限额度（1/0），开启后忽略试用额度 */
  newapi_unlimited_quota: "0",
  /** 免费订阅套餐 id（绑定后自动/手动开通；0 = 不自动开通） */
  newapi_free_plan_id: "1",
  /** 邀请奖励总开关（1/0）。被邀请人解锁 AI 权限时给邀请人发邀请订阅 */
  invite_reward_enabled: "1",
  /** workbuddy 反代账号邀请的奖励套餐 id（被邀请人绑定 wb 账号时发放） */
  invite_reward_plan_id: "2",
  /** 其他 AI 渠道捐献（自定义渠道 / 商汤 Key）的奖励套餐 id */
  invite_reward_ai_plan_id: "3",
  /** 成就奖励总开关（1/0）。用户成就点每满 N 点发一份 AI 订阅 */
  achievement_reward_enabled: "0",
  /** 成就奖励的订阅套餐 id（NewAPI 里的「成就奖励」套餐） */
  achievement_reward_plan_id: "4",
  /** 每满多少成就点发一份订阅（默认 10） */
  achievement_reward_points: "10",
  /**
   * 前端「全部可用模型」卡片要展示的分组（逗号分隔）。
   * donation（捐献）分组始终动态追加，无需写在这里。
   * 空串 = 只显示 donation；缺省 = default（管理员可改成 default,付费 等）。
   */
  newapi_visible_groups: "default",
  /** NewAPI quota 与美元换算：quota_per_unit */
  newapi_quota_per_unit: "500000",
  /**
   * 推荐模型分档（JSON 数组字符串，由管理员在管理面板维护）。
   *
   * 为什么单独放一个设置项而不是硬编码：上游渠道随时增减，模型好坏也随版本变化，
   * 写死在代码里就得每次改代码重新部署。存 JSON 让管理员在面板里随时增删梯队。
   *
   * 形如：
   *   [{"tier":"第一梯队","desc":"综合最强，日常首选","models":["glm-5.2","deepseek-v4-pro"]}]
   * 数组顺序即展示顺序（第一梯队在最上）；模型名不校验是否真实存在 ——
   * 管理员可能预先填好尚未上线的模型名，前端只展示不调用。
   */
  newapi_recommended_models: "[]",
  /** 每个用户默认可创建的一级子域名数量（可被 users.max_subdomains 覆盖） */
  subdomain_quota_default: "5",
  /** 每个用户默认的邀请码创建额度（捐献会额外增加，见 quotas.ts） */
  invite_quota_base: "3",
  /**
   * 各模块在邀请码里是「基础权限」还是「受限模式」。逗号分隔的模块名列表。
   *
   *   基础权限：创建邀请码时可直接勾选，**不消耗模块额度**。
   *   受限模式：需消耗对应模块额度（由捐献获批或管理员发放获得）。
   *
   * 默认只有 r2 是基础权限 —— R2 由站长自持，无人能「捐献」网盘资源，
   * 若纳入额度体系则该额度永远为 0，形成死路。
   * 其余模块（ai/frp/proxy）默认受限，靠捐献获取额度。
   *
   * ⚠️ 这只是**默认值**，不是硬编码：管理员可以把 r2 也改成受限模式
   * （那样就得在管理面板「用户额度」里手动给它发额度）。
   * 空串是合法值，表示「全部受限」—— 解析见 quotas.parseBasicFeatures，
   * 别再把空串当成「没配」而回落默认值。
   */
  invite_basic_features: "r2",
  /**
   * 免权限访问的模块（逗号分隔的模块名列表）。
   *
   * 设置后该模块**不再要求用户权限**，没有权限的人也能访问/启用 ——
   * 用于把某个模块对所有人开放，而不必逐个改用户的 permissions。
   *
   * 空串 = 全部按权限卡（默认）。它只旁路「访问时的权限校验」这一层，
   * 不改 users.permissions，也不影响各模块自己的全局总开关（*_enabled），
   * 与 invite_basic_features（管「建码时能否勾选」）是两件事。
   */
  open_features: "",
  /**
   * 限时开放注册总开关（1/0）。
   *
   * 打开后注册**不再需要邀请码**（见 handlers/auth.ts 的 register）——
   * 用于做活动/推广期间临时放开注册。默认关。
   *
   * 与「邀请码」不冲突：有码的人填了码仍按码走（权限来自码、邀请人照常拿奖励）；
   * 没码的人直接注册，拿到的是「默认邀请码」的那套权限（见下）。
   */
  open_registration: "0",
  /**
   * 开放注册的截止时间（ISO 8601，可选）。留空 = 只要总开关开着就一直开放。
   *
   * 填了之后到点自动失效，无需管理员守着手动关 —— 这就是「限时」的含义。
   * 存储统一成 `toISOString()` 形态（管理面板提交的本地时间会先转成 UTC），
   * 比较用 `Date.parse` 取时间戳，避免字符串直接比大小在时区上出错。
   */
  open_registration_until: "",
  /**
   * 哪些模块的捐献走「自动审核」（逗号分隔的模块名列表）。
   *
   *   - ai：自动探测上游 + 逐个测模型，只留可用的；全不可用则自动拒绝。
   *   - proxy：逐个真实拉取订阅链接，能解析出节点的才导入；全无效则自动拒绝。
   *   - frp：仅做 config.yml 的语法/必填字段校验（**不验证连通性**，见下）。
   *
   * 不在列表里的模块一律转人工审核。默认只对 ai、proxy 自动 —— 因为这两者
   * 能「真的调一次」验证可用性；frp 的 config.yml 虽指向公网 frps，但 frpc↔frps
   * 是私有 TCP 协议（非 HTTP），Cloudflare Worker 出站只能发 HTTP/HTTPS、
   * 建不了任意 TCP 连接，无法握手验证，故只能静态校验、判定不可靠。
   *
   * 空串 = 全部转人工。若要关闭全部自动审核，存空串即可。
   */
  auto_review_features: "ai,proxy",
  /**
   * 昵称附加保留词（逗号分隔，大小写不敏感）。
   * 与「保留域名」同在管理面板「保留名」标签管理。
   * 基础保留词（管理员/站长/admin 等）硬编码在 identity.ts，无法删除。
   * 管理员自己设昵称时跳过这些检查，不会被自己的名单挡住。
   */
  reserved_nicknames: "",
  /** 代理节点功能总开关 */
  proxy_enabled: "1",
  /** 临时分享箱总开关 */
  tempbox_enabled: "1",
  /** 临时分享箱默认保存时长（分钟） */
  tempbox_default_minutes: "30",
  /** 临时分享箱单文件上限（字节，默认 256 MiB） */
  tempbox_max_file_bytes: "268435456",
  /** 临时分享箱每批次文件数上限 */
  tempbox_max_files: "20",
  /** 临时分享箱上传是否必须登录（1=默认，访客只可查看/下载） */
  tempbox_upload_requires_login: "1",
  /** frp 内网穿透总开关 */
  frp_enabled: "1",
  /** frp 核心包下载地址（可由后台替换） */
  frp_core_url: "https://r2data.doulor.cn/Firef%20Frp.zip",
  /** 管理员接收「新申请」通知的邮箱；为空则不发通知 */
  frp_admin_notify_email: "",
  /**
   * 管理员接收「新反馈」通知的邮箱；为空则不发通知。
   *
   * 为什么不复用上面的 frp_admin_notify_email：那个键名只表达「内网穿透申请」，
   * 拿它装反馈会让「这个邮箱到底在收什么」变得说不清（也无法单独关掉反馈邮件）。
   * 复用省下的是一个设置项，代价是语义混乱，不划算。
   *
   * 实际发信点在 handlers/feedback.ts 的 createFeedback：用户每提交一条就发一封。
   * 反馈不像捐献那样「自动通过就不用打扰管理员」，所以没有 needsHuman 这类判断。
   */
  feedback_admin_notify_email: "",
  /** 社区发帖最多图片数 */
  community_post_max_images: "9",
  /** 社区广场总开关 */
  community_enabled: "1",
  /**
   * 聊天室总开关（1/0）。默认 **0（关闭）** —— 2026-09-30 紧急调整。
   *
   * 背景：D1 免费层「行写 10 万/天」被打满（99.5%+，写库直接报 7500），
   * 而聊天页的心跳/在线状态是写库大头；当时**连「写一行把它关掉」都做不到**
   * （写库本身失败），所以只能靠「默认关」+ 部署来落地。
   *
   * ⚠️ 额度恢复后在管理面板 → 设置里打开即可（那一次写就能把状态记住）。
   * 关闭时普通用户调聊天接口一律 403 CHAT_DISABLED（管理员放行），
   * 前端聊天页会显示「聊天室已关闭」并停止轮询 —— 这比开着更省读额度。
   */
  chat_enabled: "0",
  /** 是否允许访客（未登录）浏览社区广场 */
  community_guest_access: "1",
  /** 压缩后单张图片上限（字节，默认 1 MiB） */
  community_image_max_bytes: "1048576",
  /**
   * WorkBuddy 反代网关捐献通道总开关。
   *
   * 打开后捐献页会出现「反代账号」卡：捐献者登录自己的 WorkBuddy 国际版账号，
   * 登录成功即把账号加入网关共享池、并自动解锁本站「AI 中转站」权限（免审核）。
   */
  wb2api_enabled: "1",
  /** 反代网关站点地址（网关自身的 api_key 见 wb2api_credentials 表 / env Secret） */
  wb2api_base_url: "https://wb2api.doulor.cn",
  /**
   * 反代网关对接的 WorkBuddy 域：'cn'（国内版）或 'global'（国际版）。
   *
   * ⚠️ 2026-09-30 起这只是**默认选中项** —— 捐献者可以在捐献页自己改选，
   * 真正的取值以 `POST /api/wb2api/login/start` 收到的 `realm` 为准
   * （见 handlers/wb2api.ts 的 normalizeRealm）。管理员在这里设的是初始值。
   */
  wb2api_realm: "cn",
  /**
   * 每个用户最多可绑定的 WorkBuddy 账号数。
   *
   * 为什么要有上限：绑定成功即自动解锁 ai 权限且免审核，不限量就等于
   * 「绑几个号 = 白拿几次权限」，也容易被单人用小号占满共享池。
   */
  wb2api_max_bindings: "3",
  /**
   * 是否在捐献页显示「反代账号」捐献入口（1/0，默认 1 = 显示）。
   *
   * 与 `wb2api_enabled` 的区别（两项都会隐藏卡片，但语义不同）：
   *   - `wb2api_enabled` = **通道总开关**：关掉后不仅隐藏入口，接口也会拒绝新的绑定；
   *   - 本项 = **纯展示开关**：通道照常工作（已绑定的账号继续留在网关池里、
   *     接口仍接受登录），只是**不再向还没绑定过的用户展示这个入口**。
   *     已经绑定过的用户仍看得到卡片，以便管理 / 撤销自己的绑定。
   *
   * 用途：上游临时不可用时先把入口撤下，不必动通道本身（也不会影响到存量绑定）。
   */
  wb2api_donation_visible: "1",
  /**
   * 商汤日日新 Key 捐献通道总开关。
   *
   * 打开后捐献页的「AI 模型」里会出现「贡献商汤 Key」卡：捐献者提交自己的
   * 商汤 API Key，系统验证有效后直接建渠道并入中转站，同时解锁本站
   * 「AI 中转站」权限（免审核，与反代账号通道同一语义）。
   */
  sensenova_enabled: "1",
  /**
   * 是否在捐献页显示「贡献商汤 Key」入口（1/0，默认 1 = 显示）。
   *
   * 语义与 `wb2api_donation_visible` / `cli2api_donation_visible` 一致：
   *   - `sensenova_enabled` = **通道总开关**：关掉后不仅隐藏卡片，提交也会被拒（403）；
   *   - 本项 = **纯展示开关**：只是不在捐献页展示这个入口，提交接口照常可用
   *     （已通过审核的 Key 继续留在中转站渠道里）。
   *
   * 用途：暂时不想收新 Key（例如目标渠道要维护）时先把入口撤下。
   */
  sensenova_donation_visible: "1",
  /**
   * 商汤上游地址。做成可配置是为了「以后商汤用不了了好换其他服务」——
   * 换地址即可，不用改代码。Key 只能通过该地址鉴权，所以这同时也保证了
   * 「提交的 Key 确实属于这个上游」。
   */
  sensenova_base_url: "https://token.sensenova.cn",
  /**
   * 捐献来的商汤 Key 要**并入哪个渠道**（NewAPI 的渠道 ID，必须是多密钥渠道）。
   *
   * 为什么要有这一项：商汤不是一个渠道一个 Key，而是**一个多密钥渠道**里挂多把
   * Key（NewAPI 原生支持，轮询使用、坏了单独跳过）。所以捐献来的 Key 该做的是
   * 「追加进那个已有渠道」，而不是新建渠道 —— 新建会凭空多出一堆条目，且与
   * 管理员手工维护的模型列表对不上。
   *
   * 留空 = 通道处于「未配置」状态：捐献会转人工（不自动放行，也不碰任何渠道）。
   * 目标渠道不是多密钥渠道时同样拒绝自动加 Key —— 那会把原有 Key 覆盖掉。
   *
   * 默认值 17 是**本部署**的渠道（站长自建的商汤多密钥渠道「日日新」）；
   * 和 `frp_core_url` / `wb2api_base_url` 一样属于「部署相关默认值」。
   * 管理员清空后不会回落成 17（库里存了空串就按空串走），不会「关不掉」。
   */
  sensenova_channel_id: "17",

  /* ---- CLI2API 反代绑定通道（第二条，与 wb2api 并列）--------------------
   * 用户登录自己的 Qoder / WorkBuddy / Trae 账号 → 账号进入 cli2api 共享池
   * → 自动解锁本站「AI 中转站」权限。接口形态与 wb2api 不同，故独立一套。
   */
  /** 通道总开关 */
  cli2api_enabled: "1",
  /** 网关地址（末尾斜杠会被去掉） */
  cli2api_base_url: "https://cli2api.doulor.cn",
  /** 绑定时使用的上游：qoder / workbuddy / trae / devin */
  cli2api_provider: "qoder",
  /** 上游区域：qoder 支持 global/cn，workbuddy 支持 cn/global */
  cli2api_region: "cn",
  /** 每人可绑定的账号数上限 */
  cli2api_max_bindings: "3",
  /**
   * 是否在捐献页显示 CLI2API 捐献入口（1/0，默认 1 = 显示）。
   * 语义与 `wb2api_donation_visible` 完全一致：纯展示开关，
   * 关掉后只对「还没绑定过的用户」隐藏卡片，通道本身照常工作
   * （与 `cli2api_enabled` 那个通道总开关不是一回事）。
   */
  cli2api_donation_visible: "1",

  /* ---- 出站邮件发送通道（多通道 + 路由）------------------------------
   * 三种发送方式：CF Email Routing（自带 send_email 绑定）、自建 Posta 网关、
   * 第三方 Brevo。发信时按下面规则路由（见 mailer.ts 的 sendMail）。
   */
  /**
   * 普通邮件的发送顺序（逗号分隔），前面的优先，失败向后回退。
   * 收件人命中 mail_cf_targets 白名单时不走这个顺序，直接走 CF。
   *
   * ⚠️ **`posta` 绝不能排在第一位**（2026-09-30 踩过的坑）：
   *   Posta 是**异步队列** —— HTTP 200 只表示「已排队」，真正的投递失败发生在那之后，
   *   本站完全看不到。于是 sendMail 会把它当成「已发送」直接 return，
   *   **后面的 Brevo 永远不会被用到**（当时第二、三把 Brevo Key 明明还有 400+ 额度）。
   *   那阵子 posta 的上游是一台腾讯免费邮箱（foxmail），它对**非 QQ 域名**的收件人
   *   一律 550 拒信 —— 结果是「发 QQ 邮箱能收到、其他所有人静默收不到」。
   *   把 posta 放在 Brevo **之后**就不会遮挡主通道：Brevo 能发就发，发不了才轮到它。
   *
   * 末尾的 cf 是兜底（未配置 posta/brevo 时仍能发已验证邮箱，向后兼容）。
   */
  mail_transport_order: "brevo,posta,cf",
  /**
   * 走 CF Email Routing 发信的收件邮箱白名单（逗号分隔，管理员在面板手动配置）。
   * CF 只能发「已验证 destination」，送达率高且免费 —— 适合「目标固定、量大」的通知
   * （如发给管理员的捐献/反馈/FRP 申请通知）。命中白名单的邮箱直接走 CF，
   * 其余邮箱走上面的 mail_transport_order 顺序。
   */
  mail_cf_targets: "",
  /**
   * Posta 网关的**基础地址**（不要带路径），如 https://xxx.doulor.cn。
   * 发信接口固定为 `${posta_url}/api/v1/emails/send`（见 mailer.ts 的 sendViaPosta）。
   */
  posta_url: "",
  /** Posta 的 API key（psk_ 开头，需含 send 权限；只写不读，GET 不返回明文） */
  posta_key: "",
  /**
   * Posta 通道的发件人（RFC 5322 显示名格式，如 `Name <addr>`）。
   * 默认用 QQ 邮箱授权账号 —— QQ SMTP 强制要求信封 MAIL FROM 与登录账号一致
   * （否则 501 "Mail from address must be same as authorization user"，实测 2026-09-28），
   * 所以不能填 no-reply@doulor.cn 这类别名。若 Posta 后台换用支持自有域名的
   * SMTP 服务商，这里同步改成 doulor.cn 的地址即可。
   */
  posta_from: "Doulor Cloud <DoulorCloud@foxmail.com>",
  /**
   * Brevo（Sendinblue）API key —— **支持多把，逗号/换行分隔，额度叠加**（只写不读）。
   *
   * 免费版是按**账号**限 300 封/天的，多注册几个账号、各配一把 Key，日额度就能
   * 累加（3 把 ≈ 900 封/天）。发信时轮询各把、某把额度用完自动顺延下一把
   * （见 mailer.ts 的 sendViaBrevo / parseBrevoKeys）。
   */
  brevo_api_key: "",
  /** Brevo 发件人邮箱（需在 Brevo 后台验证过该地址） */
  brevo_sender_email: "",
  /** Brevo 发件人显示名 */
  brevo_sender_name: "Doulor Cloud",
  /**
   * 公告群发的首选通道（posta / brevo），默认 posta。
   *
   * 为什么单独一项而不是复用 mail_transport_order：群发 200+ 封会吃满第三方
   * 免费额度（Brevo 免费版 300 封/天），而日常单封通知的量级完全不同。
   * 管理员需要「日常走 A、群发走 B」的能力，所以把群发的主通道独立出来。
   *
   * 只影响优先级：命中 mail_cf_targets 白名单的仍走 CF；首选通道失败时
   * 依然按 mail_transport_order 回退（见 mailer.ts 的 sendMail opts.prefer）。
   */
  announcement_mail_transport: "posta",

  /* ---- 积分系统 ---------------------------------------------------------
   * 积分是落库的余额（见 points.ts），与「成就点」无关。用途有两个：
   * 按比例兑换中转站余额（积分商城里那个「兑换」商品位），以及在商城里买东西；
   * 活动奖励也可以发积分。
   *
   * ⚠️ 这三个键的编辑入口不在「设置」页，而在 管理面板 → 积分 → 商城
   *    商品表**第一行的内置商品行**里（用户 2026-09-28 要求把兑换当成商城里的一件商品，
   *    且不能单独摆一张卡片，配置就跟着挪进那一行）。
   */
  /**
   * 积分兑换总开关（1/0）。关掉后积分页仍可看余额与流水，只是「兑换中转站余额」
   * 这个商品位不可下单 —— 已发的积分不会消失，管理员重开即可继续用。
   * 注意：它**只管兑换**，商城里其它商品各自有上架开关（point_products.enabled）。
   */
  points_enabled: "1",
  /**
   * 兑换比例：**每 1 积分值多少元**（默认 1，支持小数，如 0.5 / 10）。
   * 兑换 X 积分 ⇒ X * points_yuan_per_point 元。填 10 就是「1 积分 = 10 元」。
   *
   * ⚠️ 2026-09-28 由 `points_per_yuan`（多少积分换 1 元）翻转而来：旧语义下
   *    「1 积分 = 10 元」要填 0.1，而旧前端用 Math.round + Math.max(1, …) 处理，
   *    0.1 会被静默吃成 1 —— 站长改了比例却怎么都不生效，根因就在这里。
   *    新语义取值恒 ≥ 1，不会再被取整吃掉。
   */
  points_yuan_per_point: "1",
  /**
   * 每人每日兑换次数上限（0 = 不限）。
   * 兑换会真实调用 NewAPI 加额度，不限次等于给脚本开了个刷接口的口子。
   */
  points_redeem_daily_limit: "5",

  /* ---- 捐献奖励积分（0 = 该类型不发）-----------------------------------
   * 按「**用户捐了什么**」分档，而不是按「解锁了什么权限」——
   * `ai` 与 `sensenova` 的权限都是 ai，但一份自定义渠道和一把商汤 Key 的价值不同，
   * 合成一个键就没法分开定价（同 DONATION_TYPE_LABELS 的理由）。
   *
   * 三个反代账号档位（workbuddy / qoder / trae）按**上游 provider** 分，
   * 与具体走哪条通道（wb2api / cli2api）无关：cli2api 的 provider 是管理员
   * 随时可切换的，按通道定价会让「换个 provider 奖励就变了」。
   *
   * ⚠️ 编辑入口在 管理面板 → 积分 → 商城 → 「捐献奖励」，不在「设置」页。
   * ⚠️ 这是**可重复赚积分**的通道：每通过一笔新捐献就发一次（幂等键是单据 id，
   *    同一笔单据被重复审核不会重复发）。积分能按 `points_yuan_per_point`
   *    兑成中转站余额，调高之前先想清楚发放量。
   */
  donation_points_ai: "3",
  donation_points_sensenova: "2",
  donation_points_frp: "10",
  donation_points_proxy: "3",
  donation_points_workbuddy: "10",
  donation_points_qoder: "10",
  donation_points_trae: "10",
  /**
   * 捐献奖励的**每人每日发放次数上限**（0 = 不限）。
   *
   * 为什么需要：捐献分是「可重复赚」的通道，而「同一份资源」只靠 payload 去重 ——
   * 用户给订阅地址加个小尾巴（`?a=2`）就能当成一笔新单据反复提交，等于可以刷分。
   * 这个闸按「今天已发的捐献笔数」封顶，给刷分加一个硬顶。
   *
   * ⚠️ 只影响**发放**，不影响捐献本身：超限的那笔捐献照样通过审核 / 绑定成功、
   *    权限照给，只是不发分（过了今天自动恢复，**不补领**）。
   * ⚠️ 计数口径 = 今天（UTC 日界）该用户 `reason='donation'` 且 `delta>0` 的流水条数，
   *    所以**历史补发**的流水也会占当天额度（补发是一次性的，次日即无影响）。
   * ⚠️ 编辑入口与档位同在一个弹窗：管理面板 → 积分 → 商城 → 「捐献奖励」。
   */
  donation_points_daily_limit: "10",

  /* ---- 邀请奖励积分（2026-09-30 新增）------------------------------------
   * 两笔账，都发给**邀请人**：
   *   1. 邀请奖励：每成功邀请 1 个好友注册 → `invite_points_per_friend` 分（一次性）
   *   2. 邀请返佣：被邀请人之后赚到的积分（捐献 / 活动）→ 邀请人抽成
   *      `invite_points_commission_percent`%（**一级**，只认直接邀请人）
   *
   * ⚠️ 编辑入口：管理面板 → 积分 → 商城 → 「邀请奖励」。
   * ⚠️ 积分能按 `points_yuan_per_point` 兑成中转站余额 —— 线上是「1 积分 = 10 元」，
   *    所以 20 分 = 200 元。改这里的数字前先算清楚发放量。
   */
  /**
   * 邀请奖励总开关（1/0）。默认 **0（关闭）**：
   * 打开后每次成功邀请都会真实增发积分（可兑换成 AI 余额），必须先确认数字。
   */
  invite_points_enabled: "0",
  /**
   * 每成功邀请 1 个好友注册，邀请者得多少积分（0 = 不发）。
   * 同一被邀请人一辈子只发一次（幂等键 `invite:<被邀请人id>`）。
   */
  invite_points_per_friend: "20",
  /**
   * 邀请返佣比例（%）：被邀请人赚到的积分，邀请者抽成多少（0 = 关闭）。
   *
   * 只对**平台增发**的积分生效，且**排除**这几类（见 points.ts 的
   * `COMMISSIONABLE_REASONS`）：
   *   · `admin`（管理员手动发放）—— 否则管理员发 1000 分，邀请者白得 100；
   *   · `shop_sell`（用户商城卖家收益）—— 那是买家支出的转移，零和，抽成即凭空增发；
   *   · `redeem` / `shop`（用户消费，本来就是负数）；
   *   · `invite` / `invite_commission` 自身 —— 否则 A→B→C 会层层抽成，指数增发。
   *
   * 返佣是**持续的**：被邀请人每赚一笔分，邀请人就抽一次，没有次数上限
   * （只有 `invite_points_daily_limit` 那个日闸兜底）。
   */
  invite_points_commission_percent: "10",
  /**
   * 每人每日通过邀请（奖励 + 返佣）最多拿到多少积分（0 = 不限）。
   *
   * 这是**防小号刷分**的硬顶：注册只要一个邮箱，且限时开放注册期间
   * 「不含权限的邀请码」不消耗次数（可无限复用），不设闸就能靠注册小号刷分。
   * 口径 = 今天（UTC 日界）该用户 `reason IN ('invite','invite_commission')`
   * 且 `delta > 0` 的流水合计。
   */
  invite_points_daily_limit: "0",
  /**
   * 是否只把「**真正消耗了次数**的邀请」算作一次有效邀请（1/0，默认 1）。
   *
   * 为什么默认开：限时开放注册期间，不含权限的邀请码**不消耗次数**
   * （见 20.2 节），此时一条普通码可以无限注册小号 —— 不设这道闸，
   * 「每邀请 1 人 +20 分」就等于「随便注册小号白拿 200 元/个」。
   * 关掉它的唯一理由：你就是想在开放注册期间也照发（那就务必配上每日上限）。
   */
  invite_points_require_consumed: "1",
  /**
   * Cloudflare 账号套餐（「CF 额度」面板用）：`auto` | `free` | `paid`，默认 auto。
   *
   * 为什么需要它：免费版与付费版的额度口径**完全不同** ——
   * 免费版是「每天 10 万次请求、10 万行写」这类**按天硬上限**（超额直接报错，
   * 站点会挂），付费版是「每月 1000 万次请求含在 $5 里、超出按量计费」的
   * **按自然月**口径（不再有每日上限）。用错一套数字，面板要么虚报红色告警、
   * 要么把真正会中断服务的上限藏起来。
   *
   * `auto` 的判定顺序（见 handlers/cf-quota.ts 的 detectPlan）：
   *   1. 读 `/accounts/{id}/subscriptions`，能读到 WORKERS_PAID 就是付费版；
   *   2. 读不到（令牌常缺「账户账单 · 读取」权限）则用**用量反证**：
   *      免费版撞上日上限会直接失败，所以任何一天超出日上限 ⇒ 一定已是付费版；
   *   3. 都不成立则按免费版显示（保守：宁可提示得严一点，也不要把
   *      「其实会被硬拦」的日上限藏掉），并在面板上提示管理员手动指定。
   */
  cf_plan: "auto",
} as const

export type SettingKey = keyof typeof SETTING_DEFAULTS

/** 推荐模型的一个梯队（第一梯队 / 第二梯队 …） */
export interface RecommendedTier {
  /** 梯队名，如「第一梯队」 */
  tier: string
  /** 一句话说明，可空 */
  desc: string
  /** 该梯队包含的模型名 */
  models: string[]
}

/**
 * 清洗推荐模型分档。写入（管理面板保存）与读取（status 下发）共用，
 * 保证「存进去什么」和「读出来什么」走同一套规则。
 *
 * 丢弃规则：无梯队名 / 无模型的分档直接丢掉（空梯队展示出来只是噪音）；
 * 上限 8 个梯队 × 30 个模型，防管理员误粘超长内容撑爆前端。
 */
export function sanitizeRecommendedModels(input: unknown): RecommendedTier[] {
  if (!Array.isArray(input)) return []
  const out: RecommendedTier[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue
    const o = raw as Record<string, unknown>
    const tier = typeof o.tier === "string" ? o.tier.trim().slice(0, 20) : ""
    if (!tier) continue
    const models = Array.isArray(o.models)
      ? o.models
          .filter((m): m is string => typeof m === "string")
          .map((m) => m.trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 30)
      : []
    if (models.length === 0) continue
    out.push({
      tier,
      desc: typeof o.desc === "string" ? o.desc.trim().slice(0, 120) : "",
      models,
    })
    if (out.length >= 8) break
  }
  return out
}

/** 从设置值（JSON 字符串）解析推荐分档，坏 JSON 一律当空 */
export function parseRecommendedModels(raw: string | null | undefined): RecommendedTier[] {
  if (!raw) return []
  try {
    return sanitizeRecommendedModels(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 一次性读取全部设置（含默认值兜底） */
export async function getSettings(env: Env): Promise<Record<SettingKey, string>> {
  const rows = await env.DB.prepare("SELECT key, value FROM app_settings")
    .all<{ key: string; value: string }>()

  const result = { ...SETTING_DEFAULTS } as Record<SettingKey, string>
  for (const row of rows.results ?? []) {
    if (row.key in SETTING_DEFAULTS) {
      result[row.key as SettingKey] = row.value
    }
  }
  return result
}

export async function getSetting(env: Env, key: SettingKey): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? SETTING_DEFAULTS[key]
}

export async function getSettingNumber(
  env: Env,
  key: SettingKey
): Promise<number> {
  const raw = await getSetting(env, key)
  const n = Number(raw)
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key])
}

export async function getSettingBool(env: Env, key: SettingKey): Promise<boolean> {
  const raw = await getSetting(env, key)
  return raw === "1" || raw.toLowerCase() === "true"
}

/** 写入设置（仅接受已知 key，避免前端塞入任意键） */
export async function updateSettings(
  env: Env,
  values: Partial<Record<SettingKey, string>>
): Promise<void> {
  const now = new Date().toISOString()
  const statements = Object.entries(values)
    .filter(([key]) => key in SETTING_DEFAULTS)
    .map(([key, value]) =>
      env.DB.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(key, String(value), now)
    )

  if (statements.length > 0) {
    await env.DB.batch(statements)
  }
}

/** 人类的字节数格式化（供前端复用同一套逻辑时参考） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

/** 记录审计日志（失败不影响主流程） */
export async function audit(
  env: Env,
  userId: string | null,
  action: string,
  detail: string,
  ip?: string | null
): Promise<void> {
  try {
    // 截断超长 detail：设置更新、JSON 快照等可能拼出几千字，存满既浪费 D1
    // 又让「最近活动」卡片的单行文本无法截断显示。500 字足够传达信息。
    const clipped = detail.length > 500 ? detail.slice(0, 497) + "…" : detail
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(uuid(), userId, action, clipped, ip ?? null, new Date().toISOString())
      .run()
  } catch (err) {
    console.error("审计日志写入失败:", err)
  }
}