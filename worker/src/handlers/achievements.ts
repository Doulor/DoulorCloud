import { json } from "../http"
import { requireUser } from "../auth"
import { grantAchievementRewards } from "../achievement-rewards"
import { getSettingBool } from "../settings"
import type { Env } from "../env"

/**
 * 成就系统。
 *
 * 成就是**纯计算**的：不落库、不记录解锁时间（只有「首次解锁时间」另存一张表），
 * 每次请求按当前数据实时算出每个成就的进度与是否达成。好处是无需迁移历史数据、
 * 也不会因为删除资源而出现「成就解锁了但数据没了」的矛盾。
 *
 * 两类成就：
 *   1. 单级成就（single）：达成即解锁，如「开通网盘」
 *   2. 分级成就（tiered）：同一勋章多个等级，如访问 10/50/200 次
 *
 * 数据来源：各功能表的记录数 / 是否存在。
 *
 * ⚠️ 两条设计约束（都踩过）：
 *   1. **阈值必须按线上真实分布定**，不能凭感觉。上线前实测过：全站 134 个用户、
 *      网盘只有 1 个文件、DNS 只有 3 条、访问次数最高 81 次。原先「访问 1000 次」
 *      那一档对所有人都是永远灰的 —— 看着像功能坏了，其实是目标不可达。
 *      定阈值前先 `wrangler d1 execute ... SELECT COUNT(*)` 看一眼真实数据。
 *   2. **不能引用「可能不存在」的表**。线上 `feedback` 表因为迁移没跑过而缺席，
 *      一条 SELECT 就能让整个成就接口 500。新增依赖前先确认线上有这张表
 *      （`SELECT name FROM sqlite_master`）。
 *
 * 性能：所有标量计数**合并成一条 SQL**（子查询 + `WITH me` 复用参数）。
 * Cloudflare 免费版单请求子请求上限 50，而本接口还有会话校验、限流、写解锁记录
 * 等开销；拆成 20 个独立查询会把余量吃光。
 */

interface AchievementDef {
  id: string
  name: string
  desc: string
  /** 图标标识，前端映射成 lucide 图标（见 src/pages/achievements.tsx 的 ICONS） */
  icon: string
  /** 所属分组 id（见 ACHIEVEMENT_GROUPS），前端按组展示 */
  group: string
  /** 获取途径：如何达成这个成就 */
  how: string
  /** 分级成就的阈值（升序）；单级成就为 undefined */
  tiers?: number[]
  /** 分级成就各等级的名称 */
  tierNames?: string[]
  /** 分级成就各等级的具体要求描述 */
  tierReqs?: string[]
  /**
   * 进度值的展示格式。目前只有「字节」一种（网盘容量），
   * 否则前端只能显示 `10485760 / 1073741824` 这种没人看得懂的数字。
   */
  valueFormat?: "bytes"
}

/**
 * 分组定义。顺序即展示顺序。
 *
 * 为什么必须分组：成就从 12 个扩到近 30 个之后，平铺一屏根本看不清进度，
 * 也没法判断「我哪个方向没玩」。
 */
export const ACHIEVEMENT_GROUPS: { id: string; label: string; desc: string }[] = [
  { id: "start", label: "起步", desc: "开通与身份" },
  { id: "resource", label: "资源", desc: "域名 / 邮箱 / 网盘 / AI" },
  { id: "usage", label: "使用", desc: "访问与分享" },
  { id: "social", label: "社交", desc: "社区 / 聊天" },
  { id: "contribute", label: "贡献", desc: "邀请与捐献" },
  { id: "special", label: "特殊", desc: "时间与元老" },
]

/** 「元老」判定：注册时间排在前 N 名 */
const VETERAN_TOP_N = 20

const MB = 1024 * 1024

/** 成就定义表。新增成就只需在此追加（记得同时给前端 ICONS 加图标映射）。 */
const ACHIEVEMENTS: AchievementDef[] = [
  // ---- 起步 ----
  {
    id: "storage_enable",
    name: "云端仓库",
    desc: "开通直链网盘",
    icon: "hard-drive",
    group: "start",
    how: "在「网盘」页面点击开通，同意使用协议即可解锁。",
  },
  {
    id: "ai_enable",
    name: "智核接入",
    desc: "开通 AI 中转站",
    icon: "sparkles",
    group: "start",
    how: "在「AI 中转站」页面绑定或创建账号（需已开通你的站内邮箱）。",
  },
  {
    id: "profile_enable",
    name: "数字名片",
    desc: "开通个人名片",
    icon: "contact",
    group: "start",
    how: "在「个人名片」页面点击开通。",
  },
  {
    id: "domain_bind",
    name: "域名主权",
    desc: "为网盘直链或名片绑定自定义域名",
    icon: "globe",
    group: "start",
    how: "在「网盘」或「个人名片」页面绑定一个自己的子域名作为访问入口。",
  },
  {
    id: "identity",
    name: "名分已定",
    desc: "设置昵称与头像",
    icon: "badge-check",
    group: "start",
    how: "在「设置 → 账号资料」里设置昵称并上传头像 —— 社区与名片都会用它展示你。",
  },

  // ---- 资源积累 ----
  {
    id: "subdomain",
    name: "开疆拓土",
    desc: "创建子域名",
    icon: "globe",
    group: "resource",
    how: "注册时分配的主域名就算一个；在「域名」页面添加更多子域名可以继续升级。",
    tiers: [1, 3, 5],
    tierNames: ["初出茅庐", "渐入佳境", "疆域辽阔"],
    tierReqs: ["创建 1 个子域名", "创建 3 个子域名", "创建 5 个子域名"],
  },
  {
    id: "mailbox",
    name: "信箱林立",
    desc: "添加邮箱地址",
    icon: "mail",
    group: "resource",
    how: "在「邮箱」页面添加地址（注册时的主邮箱计入）。",
    tiers: [1, 3],
    tierNames: ["首个信箱", "多线并行"],
    tierReqs: ["拥有 1 个邮箱地址", "拥有 3 个邮箱地址"],
  },
  {
    id: "dns",
    name: "解析大师",
    desc: "创建 DNS 记录",
    icon: "network",
    group: "resource",
    how: "在「域名」页面为子域名添加 DNS 记录。",
    tiers: [1, 5, 20],
    tierNames: ["初次解析", "熟练运维", "解析宗师"],
    tierReqs: ["创建 1 条 DNS 记录", "创建 5 条 DNS 记录", "创建 20 条 DNS 记录"],
  },
  {
    id: "storage_files",
    name: "数字仓廪",
    desc: "往网盘里存文件",
    icon: "folder-open",
    group: "resource",
    how: "在「网盘」页面拖入文件上传（每个文件计一件）。",
    tiers: [1, 5, 20],
    tierNames: ["初次入库", "小有积蓄", "囤积如山"],
    tierReqs: ["上传 1 个文件", "上传 5 个文件", "上传 20 个文件"],
  },
  {
    id: "storage_bytes",
    name: "空间占领",
    desc: "累计占用的网盘容量",
    icon: "database",
    group: "resource",
    how: "上传更大的文件即可推进（按当前占用总量算，删掉会回落）。",
    // 第三档 1000 MB 而非 1 GB（1024 MB）：用户反馈（38011049）网盘每人
    // 配额是 1 GB，占用到 1023 MB 时最后 1 MB 传不上去，永远够不到精确
    // 1024 MB 的门槛。降到 1000 MB 让满配额用户也能完成。
    tiers: [10 * MB, 200 * MB, 1000 * MB],
    tierNames: ["十兆起步", "两百兆", "千兆"],
    tierReqs: ["占用 10 MB", "占用 200 MB", "占用 1000 MB"],
    valueFormat: "bytes",
  },
  {
    id: "first_mail",
    name: "见信如晤",
    desc: "收到第一封邮件",
    icon: "inbox",
    group: "resource",
    how: "有人向你的站内邮箱发信，或注册时收到验证码邮件即可解锁。",
  },
  {
    id: "ai_key",
    name: "密钥工坊",
    desc: "在 AI 中转站创建 API Key",
    icon: "key-round",
    group: "resource",
    how: "在「AI 中转站」页面创建一个 API Key，用于在任意客户端调用模型。",
    tiers: [1, 3],
    tierNames: ["第一把钥匙", "多端并用"],
    tierReqs: ["创建 1 个 API Key", "创建 3 个 API Key"],
  },

  // ---- 使用深度 ----
  {
    id: "visit",
    name: "常客",
    desc: "访问控制台",
    icon: "log-in",
    group: "usage",
    how: "登录并访问控制台，同一小时内只计一次。",
    tiers: [10, 100, 1000],
    tierNames: ["初来乍到", "熟门熟路", "常驻居民"],
    tierReqs: ["访问 10 次", "访问 100 次", "访问 1000 次"],
  },
  {
    id: "profile_view",
    name: "声名远扬",
    desc: "名片被访问",
    icon: "eye",
    group: "usage",
    how: "分享你的个人名片，每次有人打开就 +1。",
    tiers: [10, 100, 1000],
    tierNames: ["小有名气", "广为人知", "名动四方"],
    tierReqs: ["名片被访问 10 次", "名片被访问 100 次", "名片被访问 1000 次"],
  },
  {
    id: "profile_publish",
    name: "公之于众",
    desc: "对外展示个人名片",
    icon: "send",
    group: "usage",
    how: "开通个人名片后填上昵称 —— 名片默认就是对外可见的，填了名字才算真在展示。",
  },
  {
    id: "profile_decor",
    name: "精心装扮",
    desc: "用图片或音乐装点名片",
    icon: "palette",
    group: "usage",
    how: "给名片设置背景图或背景音乐（任意一项即可）。",
  },
  {
    id: "tempbox",
    name: "分享即达",
    desc: "使用临时分享箱",
    icon: "package",
    group: "usage",
    how: "在「临时分享箱」上传文件并把接收码发给别人 —— 适合传不给留底的东西。",
    tiers: [1, 5, 20],
    tierNames: ["初次投递", "顺手拈来", "分享达人"],
    tierReqs: ["创建 1 个分享箱", "创建 5 个分享箱", "创建 20 个分享箱"],
  },

  // ---- 社交 ----
  {
    id: "posts",
    name: "笔耕不辍",
    desc: "在社区广场发帖",
    icon: "file-text",
    group: "social",
    how: "在「社区广场」发布帖子（删掉的不算）。",
    tiers: [1, 5, 20],
    tierNames: ["初次发声", "常驻楼主", "广场台柱"],
    tierReqs: ["发布 1 条帖子", "发布 5 条帖子", "发布 20 条帖子"],
  },
  {
    id: "comments",
    name: "妙语连珠",
    desc: "在社区回复他人",
    icon: "message-square",
    group: "social",
    how: "在别人的帖子下评论或回复（删掉的不算）。",
    tiers: [1, 10, 50],
    tierNames: ["第一次搭话", "有来有往", "话痨本痨"],
    tierReqs: ["发表 1 条评论", "发表 10 条评论", "发表 50 条评论"],
  },
  {
    id: "likes_received",
    name: "众望所归",
    desc: "帖子与评论累计被赞",
    icon: "heart",
    group: "social",
    how: "你发的帖子与评论被别人点赞的累计次数。",
    tiers: [5, 50, 500],
    tierNames: ["初获认同", "小受追捧", "人气爆棚"],
    tierReqs: ["累计被赞 5 次", "累计被赞 50 次", "累计被赞 500 次"],
  },
  {
    id: "likes_given",
    name: "点赞之交",
    desc: "给别人点赞",
    icon: "thumbs-up",
    group: "social",
    how: "给别人的帖子或评论点赞（同一个目标只算一次，取消点赞会收回）。",
    tiers: [10, 50, 200],
    tierNames: ["友善之心", "积极互动", "点赞狂魔"],
    tierReqs: ["点赞 10 次", "点赞 50 次", "点赞 200 次"],
  },
  {
    id: "chat",
    name: "畅所欲言",
    desc: "在聊天室发言",
    icon: "messages-square",
    group: "social",
    how: "在「聊天室」发一条消息。",
    tiers: [1, 10, 100],
    tierNames: ["打个招呼", "聊得开", "驻场选手"],
    tierReqs: ["发言 1 条", "发言 10 条", "发言 100 条"],
  },

  // ---- 贡献 ----
  {
    id: "inviter",
    name: "引路人",
    desc: "邀请朋友加入",
    icon: "user-plus",
    group: "contribute",
    how: "用自己创建的邀请码让别人注册成功（注册成功才计数）。",
    tiers: [1, 3, 10],
    tierNames: ["带来一个", "小有影响", "引荐之光"],
    tierReqs: ["邀请 1 人注册", "邀请 3 人注册", "邀请 10 人注册"],
  },
  {
    id: "donor",
    name: "无私奉献",
    desc: "捐献资源通过审核",
    icon: "gift",
    group: "contribute",
    how: "在「捐献」页面贡献 AI 渠道 / 代理订阅 / 内网穿透 / 商汤 Key，通过审核后计数。",
    tiers: [1, 3, 5],
    tierNames: ["初次贡献", "慷慨解囊", "中流砥柱"],
    tierReqs: ["捐献通过 1 次", "捐献通过 3 次", "捐献通过 5 次"],
  },
  {
    id: "donor_all",
    name: "全能贡献",
    desc: "三类以上的资源都捐过",
    icon: "layers",
    group: "contribute",
    how: "AI 渠道、代理订阅、内网穿透、商汤 Key 中，任意三种都成功捐献过一次。",
  },

  // ---- 功能权限 ----
  {
    id: "frp_enable",
    name: "内外通达",
    desc: "开通内网穿透",
    icon: "plug",
    group: "start",
    how: "在「内网穿透」页面开通，把家里的服务映射到公网。",
  },
  {
    id: "proxy_enable",
    name: "一路畅通",
    desc: "开通代理节点",
    icon: "route",
    group: "start",
    how: "在「代理节点」页面阅读并同意使用协议后开通。",
  },

  // ---- 特殊 ----
  {
    id: "veteran",
    name: "元老",
    desc: "首批注册用户",
    icon: "crown",
    group: "special",
    how: `注册时间排在全站前 ${VETERAN_TOP_N} 名。`,
  },
  {
    id: "loyal",
    name: "坚守者",
    desc: "注册满一年",
    icon: "calendar",
    group: "special",
    how: "从注册之日算起，持续使用本平台。",
    tiers: [30, 365],
    tierNames: ["满月", "周年"],
    tierReqs: ["注册满 30 天", "注册满 365 天"],
  },

  // ---- 真实行为（2026-10-03 新增）--------------------------------------
  // 这批成就有两个特点：① 全部来自「有真实成本/门槛」的行为（收发邮件、
  // 签到、攒积分、消费、反馈、分享、开启 2FA），不是「发条消息」那种零成本
  // 动作，刷不动；② 都依赖线上已存在的表，不新增迁移。
  {
    id: "two_factor",
    name: "安全卫士",
    desc: "开启二次验证",
    icon: "shield-check",
    group: "usage",
    how: "在「设置 → 安全」开启邮箱验证码或 TOTP 二次验证，登录多一层保护。",
  },
  {
    id: "mail_count",
    name: "邮路繁忙",
    desc: "累计收到的邮件",
    icon: "mail-check",
    group: "resource",
    how: "别人向你的站内邮箱发信都会累计（验证码、通知、往来邮件都算）。",
    tiers: [10, 100, 500],
    tierNames: ["十封往来", "百封不断", "千封大户"],
    tierReqs: ["收到 10 封邮件", "收到 100 封邮件", "收到 500 封邮件"],
  },
  {
    id: "checkin",
    name: "风雨无阻",
    desc: "累计签到天数",
    icon: "calendar-check",
    group: "usage",
    how: "在「积分」页每日签到，按**累计**签到天数计算（中间断签不清零，签一天算一天）。",
    tiers: [7, 30, 100],
    tierNames: ["坚持一周", "满月打卡", "百日如一日"],
    tierReqs: ["累计签到 7 天", "累计签到 30 天", "累计签到 100 天"],
  },
  {
    id: "points_balance",
    name: "积分大亨",
    desc: "积分余额",
    icon: "coins",
    group: "resource",
    how: "捐献、签到、活动、邀请都能攒积分，攒到一定数量即可解锁（按曾达到的最高余额算）。",
    tiers: [100, 500, 1000],
    tierNames: ["小有积分", "百元身家", "富可敌国"],
    tierReqs: ["余额达 100 分", "余额达 500 分", "余额达 1000 分"],
  },
  {
    id: "feedback",
    name: "直言不讳",
    desc: "提交反馈",
    icon: "megaphone",
    group: "contribute",
    how: "在「反馈」页提交问题或建议，帮平台变得更好。",
    tiers: [1, 5, 10],
    tierNames: ["首条反馈", "热心用户", "编外产品经理"],
    tierReqs: ["提交 1 条反馈", "提交 5 条反馈", "提交 10 条反馈"],
  },
  {
    id: "shop_orders",
    name: "消费达人",
    desc: "在积分商城购买",
    icon: "shopping-bag",
    group: "usage",
    how: "在「积分商城」用积分兑换商品或中转站余额（成功交付才计数）。",
    tiers: [1, 5, 20],
    tierNames: ["首单成交", "小有剁手", "消费达人"],
    tierReqs: ["购买 1 次", "购买 5 次", "购买 20 次"],
  },
  {
    id: "post_shares",
    name: "传播达人",
    desc: "分享帖子",
    icon: "share-2",
    group: "social",
    how: "把社区里值得看的帖子分享出去，让好内容被更多人看到。",
    tiers: [1, 20, 100],
    tierNames: ["首次分享", "乐于分享", "传播达人"],
    tierReqs: ["分享 1 次", "分享 20 次", "分享 100 次"],
  },
  {
    id: "stickers",
    name: "表情包收藏家",
    desc: "保存表情包",
    icon: "smile",
    group: "usage",
    how: "在聊天或社区里把喜欢的表情包存到自己的收藏。",
    tiers: [1, 10, 100],
    tierNames: ["收藏起步", "表情丰富", "收藏大家"],
    tierReqs: ["保存 1 个表情包", "保存 10 个表情包", "保存 100 个表情包"],
  },

  // ---- 2026-10-04 新增：深度使用与平台探索 ----------------------------
  // 这批成就继续复用已经存在的业务表，不引入新迁移。计数均为用户实际
  // 做过的事情：读信、参与活动、使用私信/OAuth/开放 API，以及把多个模块
  // 真正组合起来使用。这样成就数量增加的同时，每一枚都有清晰的来源。
  {
    id: "mail_read",
    name: "阅信有道",
    desc: "阅读收到的邮件",
    icon: "mail-check",
    group: "usage",
    how: "打开收件箱阅读邮件，按**累计已读**封数计算（读过的信即使删掉也不会少）。",
    tiers: [1, 10, 50],
    tierNames: ["拆开第一封", "往来渐多", "阅信达人"],
    tierReqs: ["累计读过 1 封邮件", "累计读过 10 封邮件", "累计读过 50 封邮件"],
  },
  {
    id: "dns_types",
    name: "解析百宝箱",
    desc: "使用不同类型的 DNS 记录",
    icon: "network",
    group: "resource",
    how: "创建 A、CNAME、TXT、MX 等不同类型的 DNS 记录，按类型去重。",
    tiers: [2, 4, 6],
    tierNames: ["两种类型", "多种解析", "全能解析"],
    tierReqs: ["使用 2 种 DNS 类型", "使用 4 种 DNS 类型", "使用 6 种 DNS 类型"],
  },
  {
    id: "post_edits",
    name: "精益求精",
    desc: "编辑自己发布的帖子",
    icon: "file-text",
    group: "social",
    how: "发布后继续编辑帖子，让内容越来越清楚。",
    tiers: [1, 5, 20],
    tierNames: ["首次打磨", "反复推敲", "内容匠人"],
    tierReqs: ["编辑 1 次帖子", "编辑 5 次帖子", "编辑 20 次帖子"],
  },
  {
    id: "post_images",
    name: "图文并茂",
    desc: "发布带图片的帖子",
    icon: "palette",
    group: "social",
    how: "在社区帖子里加入图片，让内容更直观。",
    tiers: [1, 3, 10],
    tierNames: ["图文首发", "配图熟手", "视觉表达"],
    tierReqs: ["发布 1 条带图片的帖子", "发布 3 条带图片的帖子", "发布 10 条带图片的帖子"],
  },
  {
    id: "comment_replies",
    name: "接话高手",
    desc: "回复社区里的评论",
    icon: "message-square",
    group: "social",
    how: "在评论下继续回复，让讨论形成来回交流。",
    tiers: [1, 5, 20],
    tierNames: ["接上话题", "讨论升温", "楼中楼常客"],
    tierReqs: ["回复 1 条评论", "回复 5 条评论", "回复 20 条评论"],
  },
  {
    id: "notification_read",
    name: "消息不漏",
    desc: "读完站内通知",
    icon: "inbox",
    group: "usage",
    how: "在消息中心查看站内通知，按已读通知数量累计。",
    tiers: [5, 25, 100],
    tierNames: ["留意动态", "消息灵通", "信息管家"],
    tierReqs: ["读过 5 条通知", "读过 25 条通知", "读过 100 条通知"],
  },
  {
    id: "direct_messages",
    name: "私信往来",
    desc: "使用站内私信",
    icon: "messages-square",
    group: "social",
    how: "通过站内私信与其他用户联系，按收发消息总数累计。",
    tiers: [1, 10, 50],
    tierNames: ["发出第一句", "有来有往", "私信常客"],
    tierReqs: ["收发 1 条私信", "收发 10 条私信", "收发 50 条私信"],
  },
  {
    id: "event_claims",
    name: "活动参与者",
    desc: "参加站内活动",
    icon: "gift",
    group: "contribute",
    how: "在消息中心或活动页面领取站内活动奖励。",
    tiers: [1, 3, 10],
    tierNames: ["首次参加", "活动积极分子", "活动常客"],
    tierReqs: ["参加 1 次活动", "参加 3 次活动", "参加 10 次活动"],
  },
  {
    id: "oauth_grants",
    name: "统一登录",
    desc: "授权其他应用使用账号登录",
    icon: "key-round",
    group: "usage",
    how: "在第三方应用的授权页同意使用 Doulor Cloud 登录。",
    tiers: [1, 2, 5],
    tierNames: ["首次授权", "多端通行", "身份中枢"],
    tierReqs: ["授权 1 个应用", "授权 2 个应用", "授权 5 个应用"],
  },
  {
    id: "public_api",
    name: "开放接口",
    desc: "开通公开 API",
    icon: "route",
    group: "start",
    how: "在账号设置里生成公开 API Key，用代码调用站点功能。",
  },
  {
    id: "profile_modules",
    name: "名片设计师",
    desc: "编排个人名片模块",
    icon: "palette",
    group: "resource",
    how: "在个人名片编辑器里启用并编排多个内容模块。",
    tiers: [2, 4, 6],
    tierNames: ["开始布置", "布局讲究", "名片大师"],
    tierReqs: ["配置 2 个名片模块", "配置 4 个名片模块", "配置 6 个名片模块"],
  },
  {
    id: "feature_count",
    name: "多面手",
    desc: "开通多个平台模块",
    icon: "layers",
    group: "start",
    how: "实际开通网盘、AI、名片、内网穿透、代理节点中的多个模块。",
    tiers: [2, 3, 5],
    tierNames: ["两项上手", "三线并行", "全能用户"],
    tierReqs: ["开通 2 个功能模块", "开通 3 个功能模块", "开通全部 5 个功能模块"],
  },
  {
    id: "points_earned",
    name: "积分积累家",
    desc: "累计获得积分",
    icon: "coins",
    group: "contribute",
    how: "通过签到、活动、邀请或管理员奖励获得积分，按历史累计收入计算。",
    tiers: [100, 500, 2000],
    tierNames: ["积少成多", "积分有余", "积分富户"],
    tierReqs: ["累计获得 100 分", "累计获得 500 分", "累计获得 2000 分"],
  },
  {
    id: "checkin_streak",
    name: "连续打卡",
    desc: "连续签到不断签",
    icon: "calendar-check",
    group: "usage",
    // 与「风雨无阻」的区别：那边按**累计签到天数**（断签不清零，签一天算一天），
    // 这边按**最高连续天数**（断签重算，但已解锁等级不掉）。档位刻意更低，
    // 让连续性更早出成绩（2026-10-04 用户 tasuyan 反馈两者重复，已拉开）。
    how: "连续多天签到**不间断**，按历史最高连续天数计算（中间断签会重算，但已解锁的等级不会掉）。",
    tiers: [3, 14, 60],
    tierNames: ["三日不断", "半月坚持", "六十天如一日"],
    tierReqs: ["连续签到 3 天", "连续签到 14 天", "连续签到 60 天"],
  },
]


/**
 * 称号：按**成就点**（每个已解锁等级记 1 点）分档。
 *
 * 为什么用「点」而不是「成就个数」：分级成就练到 Lv.3 却和只解锁 Lv.1 一样，
 * 会让人觉得刷等级没意义。点数把深度也计进去了。
 *
 * 上限参考：52 个成就 + 分级额外等级 ≈ 122 点。档位在 2026-10-03 与
 * 2026-10-04 各提过一次（成就从 60 点扩到 82 点、再扩到 122 点后，
 * 旧档位显得太低），梯度逐渐拉大，越往上越难：
 * 0/5/12/22/36/52/70/92/122。
 *
 * ⚠️ 只**追加**档位、不改动已有档位的阈值，避免老用户的称号凭空降级。
 */
const TITLES: { min: number; name: string }[] = [
  { min: 0, name: "初来乍到" },
  { min: 5, name: "新星" },
  { min: 12, name: "常客" },
  { min: 22, name: "老友" },
  { min: 36, name: "名人" },
  { min: 52, name: "传奇" },
  { min: 70, name: "至尊" },
  { min: 92, name: "宗师" },
  { min: 122, name: "萌新" },
]

/** 称号阶梯里的一个档位（供前端做「VIP 等级」式的线性展示） */
export interface TitleRung {
  name: string
  min: number
  /** 是否当前所处档位 */
  current: boolean
}

export function titleFor(points: number): {
  name: string
  min: number
  next: number | null
  nextName: string | null
  /** 完整称号阶梯（所有档位，前端线性展示用） */
  ladder: TitleRung[]
} {
  let idx = 0
  for (let i = 0; i < TITLES.length; i++) {
    if (points >= TITLES[i].min) idx = i
  }
  const cur = TITLES[idx]
  const nxt = TITLES[idx + 1] ?? null
  return {
    name: cur.name,
    min: cur.min,
    next: nxt ? nxt.min : null,
    nextName: nxt ? nxt.name : null,
    ladder: TITLES.map((t, i) => ({
      name: t.name,
      min: t.min,
      current: i === idx,
    })),
  }
}

/**
 * 记录新解锁的等级（首次达成时写库，保留最早时间）。
 * 只插入不存在的 (user, achievement, level)，已存在的不动。
 * 失败静默——成就展示不应因写库失败而中断。
 */
async function recordUnlocks(
  env: Env,
  userId: string,
  result: AchievementProgress[]
): Promise<void> {
  const now = new Date().toISOString()
  const stmts = []
  for (const a of result) {
    if (a.single) {
      if (a.level >= 1) {
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, level, unlocked_at) VALUES (?, ?, 1, ?)"
          ).bind(userId, a.id, now)
        )
      }
    } else {
      for (let lv = 1; lv <= a.level; lv++) {
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, level, unlocked_at) VALUES (?, ?, ?, ?)"
          ).bind(userId, a.id, lv, now)
        )
      }
    }
  }
  if (stmts.length === 0) return
  try {
    await env.DB.batch(stmts)
  } catch {
    // 忽略：写库失败不影响成就计算与展示
  }
}

/**
 * 把「历史已解锁的最高等级」合并进实时计算结果 —— **等级只升不降**。
 *
 * 为什么需要：成就原本的语义是「当前等级以实时计算为准」，于是加了 DNS 记录
 * 达成成就、后来把记录删了，成就就退回未完成。用户观感是「我的成就会被拿走」，
 * 而成就本该是「做过就算数」的纪念（2026-10-02 站长要求 + 用户 ventus 反馈）。
 *
 * 成就页与排行榜都调这个函数，保证两处口径一致 —— 否则同一用户在两个页面
 * 看到的成就点数会不一样，那比不做还糟。
 *
 * ⚠️ 只改 `level` / `maxed` / `nextTier`，**不动 `value`**：
 * `value` 表达的是「当前有多少」（资源删了就真的少了），
 * 与「曾经达成过什么」是两件事，别一起改了。
 */
export function mergeHistoricalLevels(
  achievements: AchievementProgress[],
  history: Map<string, number>
): void {
  for (const a of achievements) {
    const highest = history.get(a.id) ?? 0
    if (a.single) {
      if (highest >= 1 && a.level < 1) a.level = 1
      continue
    }
    if (highest > a.level) {
      const maxLevel = a.tiers?.length ?? 0
      a.level = Math.min(highest, maxLevel)
      a.maxed = a.level >= maxLevel
      a.nextTier = a.maxed ? null : (a.tiers?.[a.level] ?? null)
    }
  }
}

/**
 * 算某人的成就点数（含历史等级合并）。
 * 排行榜与成就页共用，保证同一用户在两个页面看到同一个数。
 */
export function achievementPointsOf(counts: UserCounts, history: Map<string, number>): number {
  const res = computeAchievements(counts)
  mergeHistoricalLevels(res.achievements, history)
  return res.achievements.reduce((sum, a) => sum + a.level, 0)
}

export interface AchievementProgress {  id: string
  name: string
  desc: string
  icon: string
  /** 所属分组 id */
  group: string
  /** 获取途径 */
  how: string
  /** 是否单级成就 */
  single: boolean
  /** 分级成就的阈值与等级名 */
  tiers?: number[]
  tierNames?: string[]
  tierReqs?: string[]
  /** 进度值的展示格式（bytes = 按 KB/MB/GB 展示） */
  valueFormat?: "bytes"
  /** 当前进度值 */
  value: number
  /** 已达成的等级数（0 = 未解锁）；单级成就为 0 或 1 */
  level: number
  /** 是否完全达成（最高级） */
  maxed: boolean
  /** 下一等级阈值（无则 null） */
  nextTier: number | null
  /** 首次解锁时间（未解锁为 null；历史最高等级可能高于当前等级） */
  unlockedAt: string | null
  /** 各等级的解锁时间（数组索引 = 等级-1，未解锁为 null） */
  unlockedLevels: (string | null)[]
}

/** 合并计数查询返回的一行（列名与 SQL 里的别名一一对应） */
export interface UserCounts {
  subdomain: number
  mailbox: number
  dns: number
  storage_files: number
  storage_bytes: number
  ai_keys: number
  mails: number
  identity: number
  published: number
  decorated: number
  domain_bind: number
  profile_view: number
  visit: number
  posts: number
  comments: number
  likes_given: number
  likes_received: number
  chat: number
  tempbox: number
  invited: number
  donations: number
  donation_kinds: number
  frp: number
  proxy: number
  storage_acc: number
  ai_acc: number
  profile_row: number
  veteran_rank: number
  /** 是否开启二次验证（0/1） */
  two_factor: number
  /** 累计签到天数 */
  checkin_count: number
  /** 积分余额 */
  points_balance: number
  /** 累计提交的反馈数 */
  feedback_count: number
  /** 积分商城成功交付的订单数 */
  shop_orders: number
  /** 累计分享帖子的次数 */
  shares_given: number
  /** 已保存的表情包数 */
  stickers: number
  /** 累计已读邮件封数（读过的信删掉也不清减） */
  mail_read: number
  /** 使用过的 DNS 记录类型数 */
  dns_types: number
  /** 编辑帖子次数 */
  post_edits: number
  /** 发布过的带图片帖子数 */
  post_images: number
  /** 回复评论次数（parent_id 非空） */
  comment_replies: number
  /** 已读站内通知数 */
  notification_read: number
  /** 收发私信总数 */
  direct_messages: number
  /** 参加活动次数 */
  event_claims: number
  /** 已授权的 OAuth 应用数 */
  oauth_grants: number
  /** 是否生成过公开 API Key */
  public_api: number
  /** 名片中已启用的模块数 */
  profile_modules: number
  /** 实际开通的平台功能数 */
  feature_count: number
  /** 历史累计获得的正积分 */
  points_earned: number
  /** 历史最高连续签到天数 */
  checkin_streak: number
  /** 注册时间（「坚守者」按天数算，个人空间也要显示加入时间） */
  created_at: string | null
}

/** 用户不存在 / 查不到时的全零计数（调用方不必到处写 `?.`） */
function emptyCounts(): UserCounts {
  return {
    subdomain: 0,
    mailbox: 0,
    dns: 0,
    storage_files: 0,
    storage_bytes: 0,
    ai_keys: 0,
    mails: 0,
    identity: 0,
    published: 0,
    decorated: 0,
    domain_bind: 0,
    profile_view: 0,
    visit: 0,
    posts: 0,
    comments: 0,
    likes_given: 0,
    likes_received: 0,
    chat: 0,
    tempbox: 0,
    invited: 0,
    donations: 0,
    donation_kinds: 0,
    frp: 0,
    proxy: 0,
    storage_acc: 0,
    ai_acc: 0,
    profile_row: 0,
    veteran_rank: 999,
    two_factor: 0,
    checkin_count: 0,
    points_balance: 0,
    feedback_count: 0,
    shop_orders: 0,
    shares_given: 0,
    stickers: 0,
    mail_read: 0,
    dns_types: 0,
    post_edits: 0,
    post_images: 0,
    comment_replies: 0,
    notification_read: 0,
    direct_messages: 0,
    event_claims: 0,
    oauth_grants: 0,
    public_api: 0,
    profile_modules: 0,
    feature_count: 0,
    points_earned: 0,
    checkin_streak: 0,
    created_at: null,
  }
}

/**
 * 取某个用户的全部原始计数（**一条** SQL）。
 *
 * 导出给「个人空间」复用：那边同样要展示统计与称号，各写一份查询迟早口径漂移。
 *
 * 让 20 多处子查询**共用一个参数** —— 否则要么把 user.id 绑定 20 遍，
 * 要么每个指标发一条请求（子请求数会爆）。
 *
 * ⚠️ 参数只能通过 `FROM (SELECT ? AS uid) me` 这种方式带进来：
 * 写成 `WITH me(uid) AS (VALUES (?))` 会在**子查询里报 `no such column: me.uid`**
 * —— SQLite 不允许在 SELECT 列表的嵌套标量子查询中引用 CTE 名
 * （实测确认，两种 CTE 写法都失败）。放 FROM 里就是普通的关联子查询，能解析。
 */
/**
 * 那 26 个计数子查询的列清单（**只此一份**）。
 *
 * 抽成函数是为了让「算某一个用户」与「算全站每个用户」共用同一份定义：
 * 排行榜要按**成就点**排序，而成就是这 26 个计数推出来的 ——
 * 定义写两份迟早漂移，然后排行榜与成就页的数字对不上，没人说得清哪个对。
 *
 * @param owner 指向「被统计的用户 id」那一列的表达式：
 *              单用户传 `me.uid`，全站传 `u.id`。
 */
function countColumns(owner: string, excludeApi: boolean): string {
  // 「API 计入成就」开关关闭时，排除通过公开 API 创建的记录（source='api'），
  // 防止脚本刷成就点。只影响 DNS 与邮箱这两个能被 API 创建的资源。
  const mailboxSrc = excludeApi ? " AND source != 'api'" : ""
  const dnsSrc = excludeApi ? " AND dr.source != 'api'" : ""
  return `
       -- 主域名（name='@'，注册时分配）也计入（2026-10-01 用户反馈：
      -- 原先排除它导致「创建 1 个子域名」这一档永远差一个，除非用户自己再建子域名）
      (SELECT COUNT(*) FROM subdomains WHERE user_id = {OWNER}) AS subdomain,
       (SELECT COUNT(*) FROM mailboxes WHERE user_id = {OWNER}${mailboxSrc}) AS mailbox,
       (SELECT COUNT(*) FROM dns_records dr JOIN subdomains s ON dr.subdomain_id = s.id
         WHERE s.user_id = {OWNER}${dnsSrc}) AS dns,
       (SELECT COUNT(*) FROM storage_objects WHERE user_id = {OWNER}) AS storage_files,
       (SELECT COALESCE(SUM(size), 0) FROM storage_objects WHERE user_id = {OWNER}) AS storage_bytes,
       (SELECT COUNT(*) FROM newapi_keys WHERE user_id = {OWNER}) AS ai_keys,
       (SELECT COUNT(*) FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id
         WHERE mb.user_id = {OWNER}) AS mails,
       (SELECT COUNT(*) FROM users WHERE id = {OWNER}
          AND nickname IS NOT NULL AND nickname != '' AND avatar_key IS NOT NULL) AS identity,
       -- 「已发布」这一项**不能只看 published**：2026-09-28 起开通名片就默认
       -- published=1，光看它会让「公之于众」变成和「数字名片」重复的白送成就
       -- （成就点会换成 NewAPI 订阅，是真金白银）。所以要求同时填了昵称。
       (SELECT COUNT(*) FROM profiles WHERE user_id = {OWNER} AND published = 1
          AND display_name IS NOT NULL AND TRIM(display_name) <> '') AS published,
       (SELECT COUNT(*) FROM profiles WHERE user_id = {OWNER} AND (
          (background_key IS NOT NULL AND background_key != '')
          OR (background_url IS NOT NULL AND background_url != '')
          OR (music_key IS NOT NULL AND music_key != '')
          OR (music_url IS NOT NULL AND music_url != '')
       )) AS decorated,
       (SELECT COUNT(*) FROM (
          SELECT 1 FROM profiles WHERE user_id = {OWNER} AND fqdn IS NOT NULL
          UNION ALL
          SELECT 1 FROM storage_prefixes WHERE user_id = {OWNER}
       )) AS domain_bind,
       (SELECT COALESCE(view_count, 0) FROM profiles WHERE user_id = {OWNER}) AS profile_view,
       (SELECT COALESCE(visit_count, 0) FROM user_stats WHERE user_id = {OWNER}) AS visit,
       (SELECT COUNT(*) FROM posts WHERE user_id = {OWNER} AND deleted_at IS NULL) AS posts,
       (SELECT COUNT(*) FROM post_comments WHERE user_id = {OWNER} AND deleted_at IS NULL) AS comments,
       (SELECT COUNT(*) FROM post_likes WHERE user_id = {OWNER}) AS likes_given,
       (SELECT COALESCE((SELECT SUM(like_count) FROM posts
                          WHERE user_id = {OWNER} AND deleted_at IS NULL), 0)
             + COALESCE((SELECT SUM(like_count) FROM post_comments
                          WHERE user_id = {OWNER} AND deleted_at IS NULL), 0)) AS likes_received,
       (SELECT COUNT(*) FROM chat_messages WHERE user_id = {OWNER}) AS chat,
       (SELECT COALESCE(tempbox_created, 0) FROM user_stats WHERE user_id = {OWNER}) AS tempbox,
       (SELECT COUNT(*) FROM users u JOIN invite_codes c ON u.invite_code_id = c.id
         WHERE c.created_by = {OWNER}) AS invited,
       (SELECT COUNT(*) FROM donations WHERE user_id = {OWNER} AND status = 'approved') AS donations,
       (SELECT COUNT(DISTINCT type) FROM donations
         WHERE user_id = {OWNER} AND status = 'approved') AS donation_kinds,
       (SELECT COUNT(*) FROM frp_accounts WHERE user_id = {OWNER}) AS frp,
       (SELECT COUNT(*) FROM proxy_activation WHERE user_id = {OWNER}) AS proxy,
       (SELECT COUNT(*) FROM storage_accounts WHERE user_id = {OWNER}) AS storage_acc,
       (SELECT COUNT(*) FROM newapi_accounts WHERE user_id = {OWNER}) AS ai_acc,
       (SELECT COUNT(*) FROM profiles WHERE user_id = {OWNER}) AS profile_row,
       (SELECT COUNT(*) FROM users WHERE created_at <
         (SELECT created_at FROM users WHERE id = {OWNER})) AS veteran_rank,
       -- ---- 2026-10-03 新增：真实行为类计数 ----
       (SELECT COUNT(*) FROM user_2fa WHERE user_id = {OWNER}
          AND (totp_confirmed = 1 OR email_enabled = 1)) AS two_factor,
       (SELECT COUNT(*) FROM daily_checkins WHERE user_id = {OWNER}) AS checkin_count,
       (SELECT COALESCE(balance, 0) FROM user_points WHERE user_id = {OWNER}) AS points_balance,
       (SELECT COUNT(*) FROM feedback WHERE user_id = {OWNER}) AS feedback_count,
       (SELECT COUNT(*) FROM point_orders WHERE user_id = {OWNER}
          AND status IN ('delivered', 'settled')) AS shop_orders,
       (SELECT COUNT(*) FROM post_shares WHERE user_id = {OWNER}) AS shares_given,
       (SELECT COUNT(*) FROM user_stickers WHERE user_id = {OWNER}) AS stickers,
       -- ---- 2026-10-04 新增：深度使用与平台探索 ----
       (SELECT COALESCE(mail_read_count, 0) FROM user_stats WHERE user_id = {OWNER}) AS mail_read,
       (SELECT COUNT(DISTINCT dr.type) FROM dns_records dr
          JOIN subdomains s ON dr.subdomain_id = s.id
         WHERE s.user_id = {OWNER}${dnsSrc}) AS dns_types,
       (SELECT COUNT(*) FROM post_edits e JOIN posts p ON e.post_id = p.id
         WHERE e.editor_id = {OWNER} AND p.deleted_at IS NULL) AS post_edits,
       (SELECT COUNT(*) FROM posts
         WHERE user_id = {OWNER} AND deleted_at IS NULL
           AND json_array_length(CASE WHEN json_valid(images) THEN images ELSE '[]' END) > 0) AS post_images,
       (SELECT COUNT(*) FROM post_comments
         WHERE user_id = {OWNER} AND parent_id IS NOT NULL AND deleted_at IS NULL) AS comment_replies,
       (SELECT COUNT(*) FROM notifications
         WHERE user_id = {OWNER} AND read = 1) AS notification_read,
       (SELECT COUNT(*) FROM direct_messages
         WHERE from_user_id = {OWNER} OR to_user_id = {OWNER}) AS direct_messages,
       (SELECT COUNT(*) FROM event_claims
         WHERE user_id = {OWNER} AND reward_status != 'failed') AS event_claims,
       (SELECT COUNT(*) FROM oauth_grants WHERE user_id = {OWNER}) AS oauth_grants,
       (SELECT COUNT(*) FROM user_api_keys WHERE user_id = {OWNER}) AS public_api,
       (SELECT COUNT(*) FROM profiles p, json_each(
          CASE WHEN json_valid(p.modules) THEN p.modules ELSE '[]' END
        ) WHERE p.user_id = {OWNER}
          AND json_extract(json_each.value, '$.enabled') = 1) AS profile_modules,
       (SELECT COUNT(*) FROM (
          SELECT user_id FROM storage_accounts WHERE user_id = {OWNER} AND enabled = 1
          UNION ALL SELECT user_id FROM newapi_accounts WHERE user_id = {OWNER}
          UNION ALL SELECT user_id FROM profiles WHERE user_id = {OWNER}
          UNION ALL SELECT user_id FROM frp_accounts WHERE user_id = {OWNER} AND enabled = 1
          UNION ALL SELECT user_id FROM proxy_activation WHERE user_id = {OWNER} AND enabled = 1
       )) AS feature_count,
       (SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0)
          FROM point_transactions WHERE user_id = {OWNER}) AS points_earned,
       (SELECT COALESCE(MAX(streak), 0) FROM daily_checkins WHERE user_id = {OWNER}) AS checkin_streak,
       (SELECT created_at FROM users WHERE id = {OWNER}) AS created_at
     `.replaceAll("{OWNER}", owner)
}

export async function loadUserCounts(env: Env, userId: string): Promise<UserCounts> {
  const excludeApi = !(await getSettingBool(env, "api_count_achievements"))
  const row = await env.DB.prepare(
    `SELECT ${countColumns("me.uid", excludeApi)}
     FROM (SELECT ? AS uid) me`
  )
    .bind(userId)
    .first<UserCounts>()

  return row ?? emptyCounts()
}

/** 全站计数行（比 UserCounts 多出身份字段，排行榜直接用） */
export interface AllUserCounts extends UserCounts {
  uid: string
  username: string
  nickname: string | null
  avatar_key: string | null
}

/**
 * 全站每个**活跃**用户的原始计数，供排行榜按成就点排序。
 *
 * 实测成本（2026-10-02，1151 个用户）：远程 D1 上约 **9ms**，`rows_read` 约 5100 ——
 * 因为 26 个子查询基本都走索引、每次只读 0~1 行。所以可以实时算，不必落快照表。
 *
 * ⚠️ 这里引用的表必须**线上真实存在**（`feedback` 就曾缺席过），
 * 新增依赖前先 `SELECT name FROM sqlite_master` 确认一次，否则整页 500。
 */
export async function loadAllUserCounts(env: Env): Promise<AllUserCounts[]> {
  const excludeApi = !(await getSettingBool(env, "api_count_achievements"))
  const res = await env.DB.prepare(
    `SELECT u.id AS uid, u.username AS username, u.nickname AS nickname,
            u.avatar_key AS avatar_key,
            ${countColumns("u.id", excludeApi)}
       FROM users u
      WHERE u.status = 'active'`
  ).all<AllUserCounts>()
  return res.results ?? []
}

/**
 * 由计数算出每个成就的进度（**纯函数**：不碰数据库，便于测试与复用）。
 */
export function computeAchievements(counts: UserCounts): {
  achievements: AchievementProgress[]
  summary: { unlocked: number; total: number; points: number; maxPoints: number }
  title: ReturnType<typeof titleFor>
} {
  const c = counts
  const registeredAt = c.created_at ? new Date(c.created_at) : null
  const daysSinceRegister = registeredAt
    ? Math.floor((Date.now() - registeredAt.getTime()) / 86400000)
    : 0

  // 每个成就的原始进度值（未列出的按 0 处理）
  const values: Record<string, number> = {
    storage_enable: (c?.storage_acc ?? 0) > 0 ? 1 : 0,
    ai_enable: (c?.ai_acc ?? 0) > 0 ? 1 : 0,
    profile_enable: (c?.profile_row ?? 0) > 0 ? 1 : 0,
    domain_bind: (c?.domain_bind ?? 0) > 0 ? 1 : 0,
    identity: (c?.identity ?? 0) > 0 ? 1 : 0,
    subdomain: c?.subdomain ?? 0,
    mailbox: c?.mailbox ?? 0,
    dns: c?.dns ?? 0,
    storage_files: c?.storage_files ?? 0,
    storage_bytes: c?.storage_bytes ?? 0,
    first_mail: (c?.mails ?? 0) > 0 ? 1 : 0,
    ai_key: c?.ai_keys ?? 0,
    visit: c?.visit ?? 0,
    profile_view: c?.profile_view ?? 0,
    profile_publish: (c?.published ?? 0) > 0 ? 1 : 0,
    profile_decor: (c?.decorated ?? 0) > 0 ? 1 : 0,
    tempbox: c?.tempbox ?? 0,
    posts: c?.posts ?? 0,
    comments: c?.comments ?? 0,
    likes_received: c?.likes_received ?? 0,
    likes_given: c?.likes_given ?? 0,
    chat: c?.chat ?? 0,
    inviter: c?.invited ?? 0,
    donor: c?.donations ?? 0,
    // 「全能贡献」= AI / 代理 / 内网穿透 / 商汤 里任意三种都捐过
    donor_all: (c?.donation_kinds ?? 0) >= 3 ? 1 : 0,
    frp_enable: (c?.frp ?? 0) > 0 ? 1 : 0,
    proxy_enable: (c?.proxy ?? 0) > 0 ? 1 : 0,
    veteran: (c?.veteran_rank ?? 999) < VETERAN_TOP_N ? 1 : 0,
    loyal: daysSinceRegister,
    // ---- 2026-10-03 新增：真实行为类 ----
    two_factor: c?.two_factor ?? 0,
    mail_count: c?.mails ?? 0,
    checkin: c?.checkin_count ?? 0,
    points_balance: c?.points_balance ?? 0,
    feedback: c?.feedback_count ?? 0,
    shop_orders: c?.shop_orders ?? 0,
    post_shares: c?.shares_given ?? 0,
    stickers: c?.stickers ?? 0,
    mail_read: c?.mail_read ?? 0,
    dns_types: c?.dns_types ?? 0,
    post_edits: c?.post_edits ?? 0,
    post_images: c?.post_images ?? 0,
    comment_replies: c?.comment_replies ?? 0,
    notification_read: c?.notification_read ?? 0,
    direct_messages: c?.direct_messages ?? 0,
    event_claims: c?.event_claims ?? 0,
    oauth_grants: c?.oauth_grants ?? 0,
    public_api: c?.public_api ?? 0,
    profile_modules: c?.profile_modules ?? 0,
    feature_count: c?.feature_count ?? 0,
    points_earned: c?.points_earned ?? 0,
    checkin_streak: c?.checkin_streak ?? 0,
  }

  const result: AchievementProgress[] = ACHIEVEMENTS.map((def) => {
    const value = values[def.id] ?? 0
    if (!def.tiers) {
      const unlocked = value > 0
      return {
        id: def.id,
        name: def.name,
        desc: def.desc,
        icon: def.icon,
        group: def.group,
        how: def.how,
        single: true,
        value,
        level: unlocked ? 1 : 0,
        maxed: unlocked,
        nextTier: null,
        unlockedAt: null,
        unlockedLevels: [],
      }
    }
    const level = def.tiers.filter((t) => value >= t).length
    const nextTier = def.tiers.find((t) => value < t) ?? null
    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      icon: def.icon,
      group: def.group,
      how: def.how,
      single: false,
      tiers: def.tiers,
      tierNames: def.tierNames,
      tierReqs: def.tierReqs,
      valueFormat: def.valueFormat,
      value,
      level,
      maxed: nextTier === null,
      nextTier,
      unlockedAt: null,
      unlockedLevels: [],
    }
  })

  const unlocked = result.filter((a) => a.level > 0).length
  const points = result.reduce((sum, a) => sum + a.level, 0)
  const maxPoints = ACHIEVEMENTS.reduce(
    (sum, def) => sum + (def.tiers ? def.tiers.length : 1),
    0
  )

  return {
    achievements: result,
    summary: { unlocked, total: result.length, points, maxPoints },
    title: titleFor(points),
  }
}

/**
 * GET /api/achievements —— 当前用户的成就。
 *
 * 与「个人空间」的区别：这里会**写**解锁记录（首次达成的等级落库，用于展示
 * 解锁时间），所以只能由本人调用；看别人的成就是纯读，见 space.ts。
 */
export async function getAchievements(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const counts = await loadUserCounts(env, user.id)
  const snapshot = computeAchievements(counts)

  // 记录新解锁（首次达成某等级时写库），并读回所有历史解锁时间
  await recordUnlocks(env, user.id, snapshot.achievements)

  const unlockRows = await env.DB.prepare(
    "SELECT achievement_id, level, unlocked_at FROM user_achievements WHERE user_id = ?"
  )
    .bind(user.id)
    .all<{ achievement_id: string; level: number; unlocked_at: string }>()

  const unlockMap = new Map<string, Map<number, string>>()
  for (const r of unlockRows.results ?? []) {
    if (!unlockMap.has(r.achievement_id)) unlockMap.set(r.achievement_id, new Map())
    unlockMap.get(r.achievement_id)!.set(r.level, r.unlocked_at)
  }
  for (const a of snapshot.achievements) {
    const m = unlockMap.get(a.id)
    if (!m) continue
    // 单级成就：等级 1 即解锁
    if (a.single) {
      a.unlockedAt = m.get(1) ?? null
    } else {
      const maxLevel = a.tiers?.length ?? 0
      a.unlockedLevels = Array.from({ length: maxLevel }, (_, i) => m.get(i + 1) ?? null)
      // unlockedAt 取最高已解锁等级的时间（有历史记录时）
      const times = a.unlockedLevels.filter((t): t is string => !!t)
      a.unlockedAt = times.length ? times[times.length - 1] : null
    }
  }

  // 等级只升不降（历史最高等级覆盖实时计算值）。与排行榜共用同一个函数，
  // 避免同一用户在两个页面看到不同的成就点数。
  const history = new Map<string, number>()
  for (const [id, levels] of unlockMap) {
    history.set(id, Math.max(...levels.keys()))
  }
  mergeHistoricalLevels(snapshot.achievements, history)

  // 合并历史等级后 summary 会变，必须重算 —— 否则徽章数/成就点数与列表对不上。
  // ⚠️ 必须放在 grantAchievementRewards 之前：那个函数按点数发订阅，用旧值会少发。
  snapshot.summary = {
    unlocked: snapshot.achievements.filter((a) => a.level > 0).length,
    total: snapshot.achievements.length,
    points: snapshot.achievements.reduce((sum, a) => sum + a.level, 0),
    maxPoints: snapshot.summary.maxPoints,
  }
  snapshot.title = titleFor(snapshot.summary.points)

  // 成就奖励：每满 N 点发放一份 AI 订阅（防重复见 achievement_rewards 表）。
  // 大多数用户不跨档位、会立即返回；只有刚满档的用户才会真正调 NewAPI 发订阅。
  await grantAchievementRewards(env, user.id, user.username, snapshot.summary.points)

  return json({
    achievements: snapshot.achievements,
    groups: ACHIEVEMENT_GROUPS,
    summary: snapshot.summary,
    title: snapshot.title,
    /** 用于名片页/展示的注册时间 */
    registeredAt: counts.created_at ?? null,
  })
}
