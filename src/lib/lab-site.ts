/**
 * 网页实验室的「站内操作」层 —— 让 AI 助手能读写用户**自己的**站内数据
 * （子域名、DNS、邮箱、网盘、只读的账号/活动/通知…）。
 *
 * ## 设计要点（改之前先读完）
 *
 * 1. **白名单操作，不是任意 URL。**
 *    模型只能从 `SITE_OPS` 里挑 `op`，真实请求由本文件用代码拼出来。
 *    这样模型**没法**自己构造 `/api/admin/...` 之类的路径 —— 越权不靠提示词拦，
 *    靠「它根本没有这个能力」拦。安全边界写在代码里，不写在提示词里。
 *
 * 2. **身份就是浏览器会话。**
 *    请求走同源 `/api/*`，带的是用户自己的 cookie，后端照常鉴权 ——
 *    所以 AI 天然只能碰到这个用户自己的东西，做不了跨用户操作。
 *    （前提：作品预览必须始终待在不同源的 sandbox iframe 里，别让作品本身拿到会话。）
 *
 * 3. **提示词里不放手册。**
 *    手册有几千字，每轮都塞进系统提示既贵又容易让模型分心。
 *    改成：系统提示里只留一句索引，模型**需要时**自己输出 `<lab_site_manual/>` 拉取，
 *    拉过一次这一轮对话就一直带着（见 lab.tsx 的循环）。
 *
 * 4. **写操作一律弹站内确认框。**
 *    用户看到「要删哪个东西」再点确认，不点就不执行，并把「用户拒绝」如实回喂给模型。
 *
 * 5. **红线（下面 `RED_LINES` 与语义）：**
 *    积分/充值/消费/转让、权限与角色、封禁解封与一切管理端动作、密码与 2FA 与邮箱验证、
 *    删除账号、中转站令牌与 API Key、OAuth 授权 —— **全都不暴露**。
 *    这些要么涉钱、要么涉账号安全、要么一按就不可逆，不适合让模型代劳。
 */

/**
 * 解析 `<lab_site>` 标签的正文（模型给的 JSON 参数）。
 *
 * 为什么不用 `JSON.parse` 一把梭：免费渠道的模型偶尔会写成单引号、
 * 或者包一层 ```json。这里顺手把这两种常见走样修掉，
 * 剩下的真错了就如实报错回喂 —— 让它自己改，别由我们猜。
 */
export function parseSiteArgs(
  content: string
): { value: Record<string, unknown> } | { error: string } {
  let s = (content ?? "").trim()
  if (!s) return { value: {} }
  // 去掉可能套上的代码块围栏
  s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim()
  if (!s) return { value: {} }
  try {
    const v = JSON.parse(s)
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { value: v as Record<string, unknown> }
    }
    return { error: "参数必须是一个 JSON 对象（形如 {\"name\":\"blog\"}）" }
  } catch {
    // 单引号 JSON 的常见走样：整体替换引号后再试一次
    try {
      const v = JSON.parse(s.replace(/'/g, '"'))
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return { value: v as Record<string, unknown> }
      }
    } catch {
      /* 落到下面的报错 */
    }
    return { error: "参数不是合法 JSON。请用双引号，例如 {\"name\":\"blog\"}" }
  }
}

/** 一次站内操作的请求形状 */
export interface SiteCall {
  method: string
  path: string
  body?: unknown
}

export interface SiteOp {
  id: string
  /** 手册里的分组名（中文，直接给模型看） */
  group: string
  /** 一句话说明 */
  desc: string
  /** 写操作（默认 false = 只读）。写操作必须过用户确认 */
  write?: boolean
  /** 删除 / 覆盖类不可逆操作 → 确认框标红（只影响观感，不影响是否弹窗） */
  danger?: boolean
  /** 参数说明，写进手册 */
  args?: string
  /** 拼真实请求；参数不合法时返回 { error } */
  build: (args: Record<string, unknown>) => SiteCall | { error: string }
  /** 写操作的确认框文案 */
  confirm?: (args: Record<string, unknown>) => { title: string; desc: string; detail?: string }
}

/* ------------------------------------------------------------------ */
/* 参数小工具                                                          */
/* ------------------------------------------------------------------ */

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v == null) return undefined
  const s = String(v).trim()
  return s || undefined
}

/** 必填字符串参数；缺失就返回错误说明（不抛异常，错误要能回喂给模型） */
function needStr(
  args: Record<string, unknown>,
  key: string,
  label: string
): string | { error: string } {
  const s = optStr(args, key)
  if (!s) return { error: `缺少参数 ${key}（${label}）` }
  return s
}

function qs(pairs: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(pairs)) if (v) sp.set(k, v)
  const s = sp.toString()
  return s ? `?${s}` : ""
}

/** 把模型给的参数按白名单字段摘出来（多余字段直接丢掉，别原样转发给后端） */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) out[k] = args[k]
  return out
}

const isErr = (v: unknown): v is { error: string } =>
  typeof v === "object" && v !== null && "error" in v

/* ------------------------------------------------------------------ */
/* 操作清单                                                            */
/* ------------------------------------------------------------------ */

export const SITE_OPS: SiteOp[] = [
  /* ---------------- 账号（只读） ---------------- */
  {
    id: "me.get",
    group: "账号",
    desc: "取我自己的账号信息：用户名、邮箱、角色、积分余额、各功能是否开通",
    build: () => ({ method: "GET", path: "/me" }),
  },

  /* ---------------- 子域名 ---------------- */
  {
    id: "subdomains.list",
    group: "子域名",
    desc: "列出我的全部子域名（含 id、完整域名、状态、DNS 记录条数、通用配额）",
    build: () => ({ method: "GET", path: "/subdomains" }),
  },
  {
    id: "subdomains.create",
    group: "子域名",
    write: true,
    desc: "新建一个子域名",
    args: '{"name":"blog","rootDomain":"可选，如 tyu.me / doulor.cn", "parentId":"可选，挂到某个子域名下面"}',
    build: (a) => {
      const name = needStr(a, "name", "子域名前缀，只能小写字母数字和连字符")
      if (isErr(name)) return name
      return {
        method: "POST",
        path: "/subdomains",
        body: pick({ name, rootDomain: optStr(a, "rootDomain"), parentId: optStr(a, "parentId") }, [
          "name",
          "rootDomain",
          "parentId",
        ]),
      }
    },
    confirm: (a) => ({
      title: "新建子域名",
      desc: "AI 想在你的账号下新建一个子域名。",
      detail: `${optStr(a, "name") ?? "?"}${
        optStr(a, "rootDomain") ? `.${optStr(a, "rootDomain")}` : ""
      }`,
    }),
  },
  {
    id: "subdomains.delete",
    danger: true,
    group: "子域名",
    write: true,
    desc: "删掉一个子域名（连同它下面的 DNS 记录）",
    args: '{"id":"子域名 id（先用 subdomains.list 查）"}',
    build: (a) => {
      const id = needStr(a, "id", "子域名 id")
      if (isErr(id)) return id
      return { method: "DELETE", path: `/subdomains/${encodeURIComponent(id)}` }
    },
    confirm: (a) => ({
      title: "删除子域名",
      desc: "这个操作不可撤销，该子域名下的 DNS 记录会一起消失。",
      detail: String(optStr(a, "id") ?? "?"),
    }),
  },

  /* ---------------- DNS ---------------- */
  {
    id: "dns.list",
    group: "DNS",
    desc: "列出 DNS 记录。不给 subdomainId 就是账号主域名的记录",
    args: '{"subdomainId":"可选，子域名 id"}',
    build: (a) => ({ method: "GET", path: `/dns${qs({ subdomainId: optStr(a, "subdomainId") })}` }),
  },
  {
    id: "dns.create",
    group: "DNS",
    write: true,
    desc: "新增一条 DNS 记录",
    args: '{"name":"www","type":"A","content":"1.2.3.4","ttl":1,"proxied":false,"subdomainId":"可选","priority":"仅 MX 需要"}',
    build: (a) => {
      const name = needStr(a, "name", "记录名，如 www 或 @")
      if (isErr(name)) return name
      const type = needStr(a, "type", "记录类型，如 A / AAAA / CNAME / TXT / MX")
      if (isErr(type)) return type
      const content = needStr(a, "content", "记录内容")
      if (isErr(content)) return content
      return {
        method: "POST",
        path: "/dns",
        body: pick(
          {
            name,
            type,
            content,
            ttl: a.ttl,
            proxied: a.proxied,
            priority: a.priority,
            subdomainId: optStr(a, "subdomainId"),
          },
          ["name", "type", "content", "ttl", "proxied", "priority", "subdomainId"]
        ),
      }
    },
    confirm: (a) => ({
      title: "新增 DNS 记录",
      desc: "AI 想给你的域名添加一条解析记录。",
      detail: `${optStr(a, "type") ?? "?"}  ${optStr(a, "name") ?? "?"}  →  ${
        optStr(a, "content") ?? "?"
      }`,
    }),
  },
  {
    id: "dns.update",
    danger: true,
    group: "DNS",
    write: true,
    desc: "改一条已有的 DNS 记录",
    args: '{"id":"记录 id","name":"可选","type":"可选","content":"可选","ttl":"可选","proxied":"可选"}',
    build: (a) => {
      const id = needStr(a, "id", "记录 id")
      if (isErr(id)) return id
      const body = pick(a, ["name", "type", "content", "ttl", "proxied", "priority"])
      if (!Object.keys(body).length) return { error: "没有给出要改的字段" }
      return { method: "PUT", path: `/dns/${encodeURIComponent(id)}`, body }
    },
    confirm: (a) => ({
      title: "修改 DNS 记录",
      desc: "AI 想修改一条已有的解析记录。",
      detail: `${String(optStr(a, "id") ?? "?")}\n${JSON.stringify(
        pick(a, ["name", "type", "content", "ttl", "proxied"]),
        null,
        2
      )}`,
    }),
  },
  {
    id: "dns.delete",
    danger: true,
    group: "DNS",
    write: true,
    desc: "删掉一条 DNS 记录",
    args: '{"id":"记录 id"}',
    build: (a) => {
      const id = needStr(a, "id", "记录 id")
      if (isErr(id)) return id
      return { method: "DELETE", path: `/dns/${encodeURIComponent(id)}` }
    },
    confirm: (a) => ({
      title: "删除 DNS 记录",
      desc: "删掉后解析立刻失效，不可撤销。",
      detail: String(optStr(a, "id") ?? "?"),
    }),
  },

  /* ---------------- 邮箱 ---------------- */
  {
    id: "mailbox.list",
    group: "邮箱",
    desc: "列出我的邮箱地址（含 id、地址、转发目标、是否临时邮箱、配额）",
    build: () => ({ method: "GET", path: "/mailbox" }),
  },
  {
    id: "mailbox.messages",
    group: "邮箱",
    desc: "列出某个邮箱收到的信件（标题、发件人、时间）",
    args: '{"mailboxId":"邮箱 id（先用 mailbox.list 查）"}',
    build: (a) => {
      const id = needStr(a, "mailboxId", "邮箱 id")
      if (isErr(id)) return id
      return { method: "GET", path: `/mailbox/${encodeURIComponent(id)}/messages` }
    },
  },
  {
    id: "mailbox.create",
    group: "邮箱",
    write: true,
    desc: "新建一个邮箱地址",
    args: '{"localPart":"hello","domain":"可选，如 tyu.me"}',
    build: (a) => {
      const localPart = needStr(a, "localPart", "邮箱前缀，如 hello")
      if (isErr(localPart)) return localPart
      return {
        method: "POST",
        path: "/mailbox",
        body: pick({ localPart, domain: optStr(a, "domain") }, ["localPart", "domain"]),
      }
    },
    confirm: (a) => ({
      title: "新建邮箱",
      desc: "AI 想在你名下新建一个邮箱地址。",
      detail: `${optStr(a, "localPart") ?? "?"}@${optStr(a, "domain") ?? "默认域名"}`,
    }),
  },
  {
    id: "mailbox.delete",
    danger: true,
    group: "邮箱",
    write: true,
    desc: "删掉一个邮箱地址",
    args: '{"id":"邮箱 id"}',
    build: (a) => {
      const id = needStr(a, "id", "邮箱 id")
      if (isErr(id)) return id
      return { method: "DELETE", path: `/mailbox/${encodeURIComponent(id)}` }
    },
    confirm: (a) => ({
      title: "删除邮箱",
      desc: "该地址收到的历史邮件会一并清掉，不可撤销。",
      detail: String(optStr(a, "id") ?? "?"),
    }),
  },

  /* ---------------- 网盘 ---------------- */
  {
    id: "storage.list",
    group: "网盘",
    desc: "列网盘某个目录下的文件与子目录（含大小、用量/配额）。不给 path 就是根目录",
    args: '{"path":"可选，如 photos/2024"}',
    build: (a) => ({ method: "GET", path: `/storage/objects${qs({ path: optStr(a, "path") })}` }),
  },
  {
    id: "storage.shares",
    group: "网盘",
    desc: "列出我建过的目录分享链接",
    build: () => ({ method: "GET", path: "/storage/shares" }),
  },
  {
    id: "storage.folder.create",
    group: "网盘",
    write: true,
    desc: "在网盘里新建一个目录",
    args: '{"path":"photos/2024"}',
    build: (a) => {
      const path = needStr(a, "path", "目录路径，如 photos/2024")
      if (isErr(path)) return path
      return { method: "POST", path: "/storage/folder", body: { path } }
    },
    confirm: (a) => ({
      title: "新建网盘目录",
      desc: "AI 想在你的网盘里创建一个目录。",
      detail: String(optStr(a, "path") ?? "?"),
    }),
  },
  {
    id: "storage.share.create",
    danger: true,
    group: "网盘",
    write: true,
    desc: "把某个目录做成分享链接（同一目录已有分享时会复用，不会重复建）",
    args: '{"path":"可选，默认根目录","title":"可选，分享标题"}',
    build: (a) => {
      const body = pick({ path: optStr(a, "path") ?? "", title: optStr(a, "title") }, [
        "path",
        "title",
      ])
      return { method: "POST", path: "/storage/shares", body }
    },
    confirm: (a) => ({
      title: "创建分享链接",
      desc: "创建后任何人拿到链接都能访问这个目录，注意别把私密文件夹分享出去。",
      detail: `${optStr(a, "path") || "（根目录）"}`,
    }),
  },
  {
    id: "storage.share.delete",
    danger: true,
    group: "网盘",
    write: true,
    desc: "删掉一条分享链接",
    args: '{"id":"分享 id（先用 storage.shares 查）"}',
    build: (a) => {
      const id = needStr(a, "id", "分享 id")
      if (isErr(id)) return id
      return { method: "POST", path: "/storage/shares/delete", body: { id } }
    },
    confirm: (a) => ({
      title: "删除分享链接",
      desc: "删掉后原来的分享地址立即失效。",
      detail: String(optStr(a, "id") ?? "?"),
    }),
  },

  /* ---------------- 其他只读 ---------------- */
  {
    id: "frp.status",
    group: "内网穿透",
    desc: "看我的 FRP 隧道状态与申请记录（不做申请/取消，那要人工审核）",
    build: () => ({ method: "GET", path: "/frp" }),
  },
  {
    id: "events.list",
    group: "活动",
    desc: "列出站内活动与投票",
    build: () => ({ method: "GET", path: "/events" }),
  },
  {
    id: "titles.mine",
    group: "称号",
    desc: "看我的称号与佩戴情况",
    build: () => ({ method: "GET", path: "/titles/mine" }),
  },
  {
    id: "invites.mine",
    group: "邀请",
    desc: "看我的邀请码与邀请战绩",
    build: () => ({ method: "GET", path: "/my-invites" }),
  },
  {
    id: "points.shop",
    group: "积分",
    desc: "看积分商城有哪些商品、各要多少分（**只能看，不能买**）",
    build: () => ({ method: "GET", path: "/points/products" }),
  },
  {
    id: "notifications.list",
    group: "通知",
    desc: "看站内通知",
    build: () => ({ method: "GET", path: "/notifications" }),
  },
  {
    id: "donations.list",
    group: "捐赠",
    desc: "看我的捐赠记录（只读）",
    build: () => ({ method: "GET", path: "/donations" }),
  },
  {
    id: "vouchers.list",
    group: "兑换券",
    desc: "看我的兑换券（只读；**不提供兑换**）",
    build: () => ({ method: "GET", path: "/vouchers" }),
  },
]

const OP_BY_ID = new Map(SITE_OPS.map((o) => [o.id, o]))

export function findSiteOp(id: string): SiteOp | undefined {
  return OP_BY_ID.get((id ?? "").trim())
}

/* ------------------------------------------------------------------ */
/* 手册（按需注入给模型）                                               */
/* ------------------------------------------------------------------ */

/** 红线：这些事**不做**，模型必须如实拒绝，不许猜接口 */
const RED_LINES = `· **积分与钱**：充值、消费、买商品、转积分、兑换券核销 —— 一律不做。
· **权限与身份**：改角色、加/减权限、封禁、解封、申诉处理、任何管理端动作 —— 一律不做。
· **账号安全**：改密码、开/关 2FA、邮箱验证、删除账号、改用户名 —— 一律不做。
· **密钥**：中转站令牌、API Key 的创建/读取/吊销 —— 一律不做。
· **站内没有的操作不要猜**：只能用下面列出的 op，猜出来的 id 会直接失败。`

/**
 * 生成手册正文。**由 SITE_OPS 推导**，不手写 —— 免得加了操作忘了改手册，
 * 或者改了参数说明两处对不上。
 */
export function buildSiteManual(): string {
  const groups = new Map<string, SiteOp[]>()
  for (const op of SITE_OPS) {
    const list = groups.get(op.group) ?? []
    list.push(op)
    groups.set(op.group, list)
  }

  const lines: string[] = []
  lines.push(
    "【站内操作手册】\n\n" +
      "你除了能读写项目文件，还能**读写这个用户自己的站内数据**：子域名、DNS 记录、邮箱、网盘、称号等。\n" +
      "请求以用户本人的身份发出（沿用他当前的登录状态），所以只能碰到他自己的东西。\n\n" +
      "调用格式（就地输出标签，不要放进代码块，不要贴 JSON 到标签外面）：\n" +
      '  无参数：<lab_site op="操作id"></lab_site>\n' +
      '  有参数：<lab_site op="操作id">\n{"参数名":"值"}\n</lab_site>\n' +
      "  · 正文是一段 JSON 对象；参数里不要出现 `>` 字符（会提前截断标签，用「大于」二字代替）。\n" +
      "  · 同一轮可以写多个 <lab_site>，结果会在下一轮一起返回给你。\n" +
      "  · 结果里的报错原样看，多半是参数不对或权限不够；照着改，不要用同样的参数反复重试。"
  )

  const emit = (write: boolean) => {
    for (const [group, ops] of groups) {
      const picked = ops.filter((o) => !!o.write === write)
      if (!picked.length) continue
      lines.push(`\n── ${group} ──`)
      for (const op of picked) {
        lines.push(`${op.id} —— ${op.desc}`)
        if (op.args) lines.push(`   参数：${op.args}`)
      }
    }
  }

  lines.push("\n【只读操作】直接执行，不会打扰用户：")
  emit(false)
  lines.push("\n【写入操作】会弹窗让用户确认；**用户点了拒绝就不执行**，并把这件事告诉你：")
  emit(true)
  lines.push("\n【不做的事】用户要求这些时，直接说明做不了，不要绕：\n" + RED_LINES)
  lines.push(
    "\n【动手顺序】\n" +
      "1. 先只读（list）拿到真实 id —— 不要凭空编 id，也不要把用户随口说的名字当 id。\n" +
      "2. 再写入，一次只做一件；多个写操作会逐个弹窗，别一口气堆五条。\n" +
      "3. 做完把关键结果用中文讲清楚（建了什么、在哪、链接是什么）。"
  )

  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

/** 回喂给模型的单次结果上限（防止把上下文撑爆） */
const MAX_RESULT_CHARS = 6000

export interface SiteRunResult {
  op: string
  ok: boolean
  /** 已经格式化好的、可直接回喂给模型的文本 */
  text: string
  /** 给时间线卡片展示的一行摘要 */
  summary: string
}

function clip(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s
  return `${s.slice(0, MAX_RESULT_CHARS)}\n…（结果过长已截断，共 ${s.length} 字符）`
}

/**
 * 执行一次站内操作。
 *
 * `approve` 由调用方提供：写操作在**真正发请求之前**调用它，
 * 返回 false 就当作「用户拒绝」，直接返回，不发请求。
 * 把确认逻辑做成回调而不是写死在这里，是为了让本文件保持无 UI 依赖（可单测）。
 */
export async function runSiteOp(
  opId: string,
  args: Record<string, unknown>,
  approve?: (op: SiteOp, args: Record<string, unknown>) => Promise<boolean>,
  fetchImpl: typeof fetch = fetch
): Promise<SiteRunResult> {
  const op = findSiteOp(opId)
  if (!op) {
    return {
      op: opId,
      ok: false,
      summary: `未知操作 ${opId}`,
      text: `[站内操作 ${opId}] 失败：没有这个操作。请先输出 <lab_site_manual/> 看手册里有哪些 op。`,
    }
  }

  const call = op.build(args ?? {})
  if (isErr(call)) {
    return {
      op: op.id,
      ok: false,
      summary: call.error,
      text: `[站内操作 ${op.id}] 失败：${call.error}`,
    }
  }

  // 写操作：先问用户。拒绝就到此为止，绝不静默执行。
  if (op.write && approve) {
    const yes = await approve(op, args ?? {})
    if (!yes) {
      return {
        op: op.id,
        ok: false,
        summary: "用户拒绝",
        text: `[站内操作 ${op.id}] **用户拒绝了这次操作**，没有执行。不要再重复申请同一个操作，改为告诉用户这件事、并问他接下来想怎么做。`,
      }
    }
  }

  const init: RequestInit = {
    method: call.method,
    credentials: "include",
    headers: { accept: "application/json" },
  }
  if (call.body !== undefined) {
    init.headers = { ...(init.headers as Record<string, string>), "content-type": "application/json" }
    init.body = JSON.stringify(call.body)
  }

  let res: Response
  try {
    res = await fetchImpl(`/api${call.path}`, init)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      op: op.id,
      ok: false,
      summary: "网络错误",
      text: `[站内操作 ${op.id}] 请求失败（网络层）：${msg}`,
    }
  }

  const raw = await res.text()
  let pretty = raw
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    /* 不是 JSON 就原样给 */
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = JSON.parse(raw) as { error?: string; code?: string }
      if (j.error) msg = `${j.error}${j.code ? `（${j.code}）` : ""}`
    } catch {
      /* 保持 HTTP 状态码 */
    }
    return {
      op: op.id,
      ok: false,
      summary: msg,
      text: `[站内操作 ${op.id}] 失败：${msg}\n原始响应：${clip(pretty)}`,
    }
  }

  return {
    op: op.id,
    ok: true,
    summary: "成功",
    text: `[站内操作 ${op.id}] 成功，返回：\n${clip(pretty)}`,
  }
}
