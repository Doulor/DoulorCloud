import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser, isPrivileged, type UserRow } from "../auth"
import { requireFeature, userPermissions } from "../permissions"
import { dnsAccessFor, dnsAccessCovers, type DnsAccess } from "./dns-rental"
import { guardRateLimit } from "../ratelimit"
import { isAdminApiRequest } from "../api-source"
import { isApiRequest } from "../api-source"
import { requireOwnedDomain, assertFqdnOwned } from "../ownership"
import { zoneIdForFqdn, pickRootDomain, rootDomainFor } from "../root-domains"
import { getSettingNumber } from "../settings"
import {
  cfCreateDnsRecord,
  cfUpdateDnsRecord,
  cfDeleteDnsRecord,
} from "../cloudflare"
import type { Env } from "../env"

interface DnsRow {
  id: string
  domain_id: string
  subdomain_id: string | null
  cf_id: string | null
  name: string
  fqdn: string
  type: string
  content: string
  ttl: number
  proxied: number
  priority: number | null
  srv_weight: number | null
  srv_port: number | null
  srv_target: string | null
  status: string
  /** 因封禁被停用的时刻（null = 正常）。见 migrations/0134 与 user-suspension.ts */
  banned_at: string | null
  created_at: string
  updated_at: string
  /**
   * 该记录所属**子域名**的 fqdn（`xxxxx.tyu.me`）——由列表查询 LEFT JOIN subdomains 得来，
   * 不是 dns_records 自己的列。
   *
   * 为什么要有它（2026-10-16）：列表改成**跨全部域名**下发后，一屏里混着好几个域的记录，
   * 前端必须能逐行标出「这条属于哪个域」，否则用户根本分不清 3 个子域名里哪条是哪个。
   * 老数据的 `subdomain_id` 可能为空（0003 迁移之前），此时左连接给 null，
   * 前端按「fqdn 去掉记录名」兜底 —— 这里不猜，猜错比留空更糟。
   */
  subdomain_fqdn?: string | null
}

const ALLOWED_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "SRV"])

/**
 * 每用户 DNS 记录数上限。
 *
 * 取值的优先级与 `handlers/subdomains.ts` 的一级子域名配额**完全一致**：
 *   用户级覆盖（`users.max_dns_records`，迁移 0161）> 全局设置
 *   （`app_settings.dns_records_per_user`，默认 10）。
 *
 * 为什么要用户级覆盖：全局那条线是给所有人定的，站长经常只需要给**某一个人**
 * 放宽（他确实要用 30 条）或收紧（他在刷）。没有覆盖列的话，唯一办法是抬高
 * 全局上限 —— 那等于对全站放宽。
 *
 * 返回 `null` 表示**不限**，三种情况：
 *   · 管理员 / 站长（`isPrivileged`）—— 他们本来就要能替任何账号排查、修复记录，
 *     卡住管理员只会让「某个用户被上限卡死」这类故障没法现场处理；
 *   · 管理员 Key 的公开 API（`isAdminApiRequest`）—— 与站内其它限额一致
 *     （「管理员 Key 不限速不限配额」，2026-10-07；见 api-source.ts）；
 *   · **持有 `dns` 权限位的用户**（`userPermissions(user).dns`）——
 *     🔴 2026-10-17 站长明确要求：`dns` 权限位是**他一个一个手动点开**的，
 *     那一下就等于「我信任这个人，让他随便建」，再叠一个记录数上限等于授权没生效。
 *     记录数上限的本意是防**租用**侧滥用（谁都能花钱买、能刷），而权限位是人工闸，
 *     两者不是一回事。
 *
 * ⚠️ 但 `users.max_dns_records` **仍然优先于**权限位豁免：那是管理员显式对
 * 某一个账号下的「收紧/放宽」，必须有最高优先级，否则「他在刷」时就没有手段了。
 * 所以顺序是：管理员/Key → 用户级覆盖 → 权限位 → 全局额度。
 *
 * ⚠️ 2026-10-15 起本函数**导出**，并被 handlers/dns-rental.ts 的
 * `GET /api/dns/rental` 复用（价目卡上要写「这个账号每用户能建几条记录」）。
 * 这是**刻意**让 dns.ts ⇄ dns-rental.ts 形成一处循环 import（反向那条是本文件
 * 顶部引 dns-rental.ts 的 `dnsAccessFor`）：
 * 上限只能有**一处**实现，各写一份迟早出现「价目卡说 3 条、DNS 页说 10 条」
 * 这种谁也说不清哪个对的账（管理员改 `users.max_dns_records` 后尤其明显）。
 * ESM 的函数声明会被提升，两边的调用都发生在请求处理期（不是模块求值期），
 * 所以这个环不会读到未初始化的绑定。
 */
export async function dnsRecordLimit(
  env: Env,
  request: Request,
  user: UserRow
): Promise<number | null> {
  if (isAdminApiRequest(request) || isPrivileged(user.role)) return null
  // 覆盖列是迁移 0161 才加的：老环境（未执行迁移）里它是 undefined，
  // 此时按「没有覆盖」处理、回落全局设置，而不是误判成 0 把所有人锁死。
  //
  // 顺序刻意是「用户级覆盖」在「权限位豁免」**之前**：管理员显式给某人设的数字
  // 优先级最高（放宽或收紧都要能落地），不能被权限位把豁免兜走。
  if (typeof user.max_dns_records === "number") return user.max_dns_records
  // 2026-10-17：持有 `dns` 权限位 = 站长手动授权 = 不限记录数（详见上方注释）。
  // 落在全局额度之前的判断，所以租用/无权限用户的行为完全不变。
  if (userPermissions(user).dns) return null
  return await getSettingNumber(env, "dns_records_per_user")
}

/**
 * DNS 解析的「能力闸」（2026-10-14 改造）。
 *
 * 改造前这里只有一条路：`requireFeatureUser(env, request, "dns")` —— 权限位为 false
 * 就 403。现在 DNS 改成了**积分租用**（与内网穿透同一套做法），于是闸门变成三档
 * （权限位 / 免权限访问 / 有效租约），判定细节全在 handlers/dns-rental.ts 里。
 *
 * 为什么把「模式为 none」的那一档仍然交给 `requireFeature` 抛：
 *   · 错误码与文案与改造前**一模一样**（`FEATURE_NOT_PERMITTED`），
 *     已有的接口消费者、API 文档、以及 dns-permission.test.ts 的断言都不必改；
 *   · 「没有任何权限」这件事没变，变的只是「有权限」的判定多了一条租约路径。
 *
 * ⚠️ 所有四个接口（列表 / 建 / 改 / 删）都必须先过这里，且**必须排在 404 之前** ——
 *    否则无权用户能靠错误码差异探测「某条记录存不存在」
 *    （这条口径是 dns-permission.test.ts 明确钉住的）。
 */
async function requireDnsAccess(env: Env, user: UserRow): Promise<DnsAccess> {
  const access = await dnsAccessFor(env, user)
  if (access.mode === "none") requireFeature(userPermissions(user), "dns")
  return access
}

/**
 * 该 fqdn 所在根域是否被当前档位覆盖；不覆盖则 403。
 *
 * `allowExpired` 只在删除路径上传 true（理由见 dns-rental.ts 的 DnsAccess 注释：
 * 过期用户腾不掉的记录会永久占着 CF 的 zone 配额，得给他一个清理出口）。
 */
async function assertDnsRootCovered(
  env: Env,
  access: DnsAccess,
  fqdn: string,
  opts: { allowExpired?: boolean } = {}
): Promise<void> {
  if (access.mode === "full") return
  const root = (await rootDomainFor(env, fqdn))?.name ?? ""
  if (dnsAccessCovers(access, root, opts)) return
  const where = root || "该根域"
  if (access.mode === "expired") {
    throw new ApiError(
      403,
      `你的 DNS 解析租用已到期，${where} 下不能再操作解析记录。续期后即可继续使用。`,
      "DNS_RENTAL_REQUIRED"
    )
  }
  throw new ApiError(
    403,
    `${where} 的 DNS 解析需要先租用（按年计费，见「域名 → DNS 解析」的价格），或联系管理员开通权限。`,
    "DNS_RENTAL_REQUIRED"
  )
}

/**
 * 统计该用户名下的 DNS 记录数 —— **跨他名下所有 domain / subdomain**。
 *
 * 为什么按 `domains` 归属统计、而不是像列表页那样 JOIN `subdomains`：
 * `dns_records.subdomain_id` 可能是空的（0003 迁移之前的老数据），只认子域名会漏算
 * 这些行；而上限要对齐的是「这个用户在 CF zone 里到底占了多少条记录」，漏算 = 上限放松。
 *
 * 为什么排除 `banned_at` 不为空的行：那些记录已经**从 CF 上删掉**（只留本地台账，
 * 见 migrations/0134），既不占 zone 配额，用户在界面上也看不到它们
 * （listDns 把它们过滤掉了）。算进来的话，被处置过的用户会凭空少掉几条额度，
 * 却又找不到任何东西可删 —— 死结。
 */
async function countUserDnsRecords(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c
       FROM dns_records r
       JOIN domains d ON d.id = r.domain_id
      WHERE d.user_id = ? AND r.banned_at IS NULL`
  )
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/**
 * SRV 记录的端口/优先级/权重上限（RFC 2782 + CF 的字段约束：0–65535）。
 */
const SRV_MAX = 65535

/**
 * 把用户输入的 service / proto 规范成 `_xxx` 形态。
 *
 * 为什么要容错：SRV 的 service 与 proto 按规范必须带前导下划线
 * （`_sip._tcp.example.com`），但用户在面板上多半直接打 `sip` / `tcp`。
 * 这里统一补上下划线，省得因为少一个字符就报「记录不合法」而让人摸不着头脑。
 * 同时挡掉点号与空白 —— 它们会破坏记录名的分段结构。
 */
function normalizeSrvLabel(raw: string, field: string): string {
  const v = (raw ?? "").trim().replace(/^_+/, "")
  if (!v) throw new ApiError(400, `请填写 SRV ${field}`, "INVALID_INPUT")
  if (/[.\s]/.test(v)) {
    throw new ApiError(400, `SRV ${field} 不能包含点号或空格`, "INVALID_INPUT")
  }
  if (v.length > 30) {
    throw new ApiError(400, `SRV ${field} 过长`, "INVALID_INPUT")
  }
  return `_${v.toLowerCase()}`
}

/** 校验 0–65535 的整数（端口 / 优先级 / 权重共用） */
function parseSrvNumber(
  raw: unknown,
  field: string,
  opts: { min?: number; fallback?: number } = {}
): number {
  const min = opts.min ?? 0
  if (raw === undefined || raw === null || raw === "") {
    if (opts.fallback !== undefined) return opts.fallback
    throw new ApiError(400, `请填写 SRV ${field}`, "INVALID_INPUT")
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > SRV_MAX) {
    throw new ApiError(
      400,
      `SRV ${field} 必须是 ${min}–${SRV_MAX} 之间的整数`,
      "INVALID_INPUT"
    )
  }
  return n
}

/** SRV 的 target：提供服务的主机名。允许外部域名（SRV 本来就常指向别的域） */
function normalizeSrvTarget(raw: unknown): string {
  const v = String(raw ?? "").trim().replace(/\.$/, "")
  if (!v) throw new ApiError(400, "请填写 SRV 目标主机", "INVALID_INPUT")
  if (v.length > 253) throw new ApiError(400, "SRV 目标主机过长", "INVALID_INPUT")
  // 主机名允许字母数字、点、连字符、下划线（部分服务用下划线前缀的 target）
  if (!/^[a-zA-Z0-9._-]+$/.test(v)) {
    throw new ApiError(400, "SRV 目标主机含非法字符", "INVALID_INPUT")
  }
  return v
}

/**
 * SRV 记录的 content 展示串：`"优先级 权重 端口 目标"`。
 *
 * 这正是 CF 用 `data` 对象时它在面板上显示的样子，也是 DNS 里 SRV 的
 * rdata 顺序。存下来是为了列表展示（列表只渲染 content）与管理员排查时
 * 一眼能看懂 —— 真正的数据在 srv_* 三列里，下次更新记录时会用它们重建
 * `data` 对象。
 */
function srvContent(priority: number, weight: number, port: number, target: string): string {
  return `${priority} ${weight} ${port} ${target}`
}

function toPublicRecord(row: DnsRow) {
  return {
    id: row.id,
    subdomainId: row.subdomain_id,
    /**
     * 记录所属子域名的 fqdn（见 DnsRow.subdomain_fqdn）。
     * 列表接口一定带上它；单条读写（建/改）也带上，保持返回体形状一致 ——
     * 免得前端只在列表里能显示归属、建完那一下却拿不到。
     */
    subdomainFqdn: row.subdomain_fqdn ?? null,
    name: row.name,
    fqdn: row.fqdn,
    type: row.type,
    content: row.content,
    ttl: row.ttl,
    proxied: row.proxied === 1,
    priority: row.priority ?? undefined,
    /** SRV 专有字段；非 SRV 记录为 undefined */
    srv: row.type === "SRV"
      ? {
          weight: row.srv_weight ?? 0,
          port: row.srv_port ?? 0,
          target: row.srv_target ?? "",
        }
      : undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /**
     * 平台自动创建、只读（由 listDns 派生注入，见 loadManagedDns）。
     * 用户自建的一律 false —— 这里显式给出字段，好让派生项能推进同一个数组。
     */
    managed: false,
    managedBy: null as null | "profile" | "storage",
  }
}

async function loadUserDomain(env: Env, userId: string) {
  return env.DB.prepare("SELECT * FROM domains WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string; name: string; zone_id: string | null }>()
}

/**
 * 取**一条**记录（带它所属子域名的 fqdn）。
 *
 * 建 / 改这两个接口返回单条记录，也需要 `subdomainFqdn` 才能与列表返回体保持同一形状
 * （前端只认一种形状，省掉「列表里有、创建响应里没有」这种半吊子状态）。
 * 一次 LEFT JOIN 拿到，不做第二次查询。
 */
async function loadRecord(env: Env, id: string): Promise<DnsRow | null> {
  return env.DB.prepare(
    `SELECT r.*, s.fqdn AS subdomain_fqdn
       FROM dns_records r
       LEFT JOIN subdomains s ON s.id = r.subdomain_id
      WHERE r.id = ?`
  )
    .bind(id)
    .first<DnsRow>()
}

/**
 * 平台自己建的解析：个人名片 / 网盘直链绑定自定义域名时，`attachCustomDomain`
 * （见 custom-domain.ts）会为那个 fqdn 建一条 `AAAA 100::` 占位记录 —— 但它只存在
 * 于 Cloudflare，不落 `dns_records`。于是用户在「DNS 记录」页里既看不到自己名片的
 * 域名，也看不懂那个域名为什么解析得通（2026-10-01 反馈：「个人名片界面绑定域名
 * 不会在前面的 dns 记录那里显现」）。
 *
 * 这里把它**派生**出来展示，而不是绑定时补写一行，理由：
 *   1. 补写会让同一事实存在两处（dns_records 与 profiles / storage_prefixes），
 *      两边必须互相同步：用户在 DNS 页删掉那一行，就会得到「解析没了、名片却还
 *      显示已绑定」的死结 —— 正是同一条反馈里「删了很久还是在跳转」的成因。
 *   2. 派生是只读的，天然不可能不一致；而且**存量绑定立刻可见**，不必回填。
 */
interface ManagedDnsRow {
  fqdn: string
  subdomain_id: string | null
  /** 所属子域名的 fqdn（左连接得来，可能为 null），与 DnsRow.subdomain_fqdn 同义 */
  subdomain_fqdn: string | null
  ts: string | null
  kind: string
}

async function loadManagedDns(env: Env, userId: string): Promise<ManagedDnsRow[]> {
  try {
    // 左连接 subdomains 只为一个字段：这条派生记录挂在哪个域名下。
    // 跨域名列表里没有它就无法标出归属（用户看到的会是一堆不认识的主机名）。
    const res = await env.DB.prepare(
      `SELECT p.fqdn AS fqdn, p.subdomain_id AS subdomain_id, s.fqdn AS subdomain_fqdn,
              p.updated_at AS ts, 'profile' AS kind
         FROM profiles p
         LEFT JOIN subdomains s ON s.id = p.subdomain_id
        WHERE p.user_id = ? AND p.fqdn IS NOT NULL AND p.fqdn != ''
       UNION ALL
       SELECT sp.fqdn, sp.subdomain_id, s.fqdn, sp.created_at, 'storage'
         FROM storage_prefixes sp
         LEFT JOIN subdomains s ON s.id = sp.subdomain_id
        WHERE sp.user_id = ? AND sp.fqdn IS NOT NULL AND sp.fqdn != ''`
    )
      .bind(userId, userId)
      .all<ManagedDnsRow>()
    return res.results ?? []
  } catch (err) {
    // 派生展示失败不该让整个 DNS 列表打不开
    console.error("读取平台托管解析失败:", err)
    return []
  }
}

/** 取 fqdn 相对根域名的前缀（`blog.abc.doulor.cn` + `doulor.cn` → `blog.abc`） */
function relativeName(fqdn: string, rootDomain: string): string {
  const lower = fqdn.toLowerCase()
  const root = rootDomain.toLowerCase()
  if (root && lower.endsWith(`.${root}`)) return fqdn.slice(0, fqdn.length - root.length - 1)
  return fqdn.split(".")[0]
}

// GET /api/dns[?subdomainId=xxx] —— DNS 记录列表
//
// 权限闸与另外三个接口一致（读接口也要卡）：只读接口同样不能是后门 ——
// 权限一律服务端强制，绝不靠前端隐藏入口（仓库既有约定）。
// 2026-10-14 起闸门多了「有效租约」这一档（见 requireDnsAccess）。
//
// ── 参数语义（2026-10-16 定）──
//   · 带 `subdomainId` ⇒ 只返回**该子域名**下的记录（原行为，逐字保留）；
//   · 不带（`undefined`）⇒ 返回该用户名下**全部域名**的记录。
//
// 为什么不另开一个 `all=1` 显式参数：
//   ① 不带参数本来就不是「某一条」——它按 `domain_id` 过滤，而这个字段对同一用户
//      永远是他那一行主域名（见 createDns 里的注释），所以历史上它**已经**近似
//      「该用户的全部记录」；显式改成按 `d.user_id` 过滤只是把这个既成事实写准，
//      顺带修掉「用户有第二行 domain 时少给记录」的边角。
//   ② 真正的风险方向是**滤得太窄**而不是太宽：站长这次的故障就是前端一直传着
//      `subdomainId`，记录明明在，界面却说 0 条。参数漏传时返回「全部自己的记录」
//      最多显得罗嗦；返回「某个猜出来的域名」却会让人以为数据丢了 ——
//      后者的代价高得多。
//  ③ 安全性上没有放宽：过滤条件从 `d.user_id = ?` 出发，无论传不传参数都只可能
//      拿到**调用者自己**的记录（跨用户由这一句保证，不是由前端参数保证）。
// 反对意见也记在这里：省略即全量确实会掩盖前端「忘传参数」的 bug。为此前端并不
// 依赖默认值 —— domains.tsx 明确区分「全部视图」与「某个域名」两种请求，
// 而 `subdomainId` 一旦给出就仍然精确过滤（dns-list-all.test.ts 钉住了这条）。
export async function listDns(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await requireDnsAccess(env, user)
  const url = new URL(request.url)
  const subdomainId = url.searchParams.get("subdomainId")

  let rows
  if (subdomainId) {
    // 校验该子域名属于当前用户
    const sub = await env.DB.prepare(
      "SELECT id FROM subdomains WHERE id = ? AND user_id = ?"
    )
      .bind(subdomainId, user.id)
      .first()
    if (!sub) throw new ApiError(403, "无权访问该子域名", "FORBIDDEN")

    rows = await env.DB.prepare(
      // banned_at IS NOT NULL = 因封禁被停用（CF 上已删）。过滤掉它，
      // 否则解封后用户会在列表里看到一条「本地有、CF 上没有」的幽灵记录
      // ——点它解析不到，只会让人以为站点坏了。
      //
      // 左连接只为带出 `subdomain_fqdn`（归属列），条件与过滤都用不着它 ——
      // 一条 JOIN 解决，绝不按域名逐个再查一遍（N+1）。
      `SELECT r.*, s.fqdn AS subdomain_fqdn
         FROM dns_records r
         LEFT JOIN subdomains s ON s.id = r.subdomain_id
        WHERE r.subdomain_id = ? AND r.banned_at IS NULL
        ORDER BY r.created_at ASC`
    )
      .bind(subdomainId)
      .all<DnsRow>()
  } else {
    // 不带 subdomainId ⇒ 跨该用户**所有** domain 行的记录（一次 JOIN domains 拿全）。
    //
    // 为什么按 `domains.user_id` 而不是先取一行 domain 再按 domain_id 过滤：
    // 归属事实是「这条记录属于哪个用户」，domain_id 只是实现细节；按 user_id 过滤
    // 既与 countUserDnsRecords 的用量口径**逐字一致**（否则会出现「列表少一条、
    // 用量多一条」这种谁也解释不清的差），也不会在多 domain 行时漏数据。
    rows = await env.DB.prepare(
      `SELECT r.*, s.fqdn AS subdomain_fqdn
         FROM dns_records r
         JOIN domains d ON d.id = r.domain_id
         LEFT JOIN subdomains s ON s.id = r.subdomain_id
        WHERE d.user_id = ? AND r.banned_at IS NULL
        ORDER BY r.created_at ASC`
    )
      .bind(user.id)
      .all<DnsRow>()
  }

  const records = (rows.results ?? []).map(toPublicRecord)

  // 追加平台托管的解析（只读）。已有同 fqdn 的真实记录时不重复展示 ——
  // 那属于历史数据，用户当初手工建过，列表里以他自己那条为准。
  //
  // rootDomain 只用于算派生项的 `name`（相对根域的前缀）；跨域名列表下它取用户的
  // 第一行主域名 —— 派生项的 fqdn 基本都是某个子域名本身，算出来就是那个子域名名。
  const d = await loadUserDomain(env, user.id)
  const rootDomain = d?.name ?? ""
  const seen = new Set(records.map((r) => r.fqdn.toLowerCase()))
  for (const m of await loadManagedDns(env, user.id)) {
    const key = m.fqdn.toLowerCase()
    if (seen.has(key)) continue
    // 按子域名筛选时，派生项只在它自己的子域名下出现
    if (subdomainId && m.subdomain_id !== subdomainId) continue
    seen.add(key)
    records.push({
      id: `managed:${m.kind}:${key}`,
      subdomainId: m.subdomain_id,
      subdomainFqdn: m.subdomain_fqdn,
      name: relativeName(m.fqdn, rootDomain),
      fqdn: m.fqdn,
      type: "AAAA",
      content: "100::",
      ttl: 1,
      proxied: true,
      priority: undefined,
      srv: undefined,
      status: "active",
      createdAt: m.ts ?? "",
      updatedAt: m.ts ?? "",
      managed: true,
      managedBy: m.kind === "storage" ? "storage" : "profile",
    })
  }

  /**
   * 顺带下发「已用 / 上限」，供前端在选项卡顶部显示用量、并在到顶时禁用「新建记录」。
   *
   * 为什么由服务端算、而不是让前端数 `records.length`：上限是**跨该用户全部域名**
   * 的（见 countUserDnsRecords）—— 前端本地数出来的数字会随筛选跳变
   * （「全部」视图下还要多算平台托管的派生项），跟服务端真正卡的那条线对不上。
   * 跟着列表一起下发，则每次新建/删除后的重载都会同步刷新，不需要额外接口或额外请求。
   *
   * `limit === null` = 不限（管理员 / 管理员 Key），前端据此显示「不限」而不是假上限。
   */
  const limit = await dnsRecordLimit(env, request, user)
  const used = await countUserDnsRecords(env, user.id)

  return json({ records, dnsUsage: { used, limit } })
}

/** 请求体里 SRV 相关字段的形状（create / update 共用） */
interface SrvInput {
  srvService?: string
  srvProto?: string
  srvWeight?: number
  srvPort?: number
  srvTarget?: string
  srvPriority?: number
}

/**
 * 校验并组装一条 SRV 记录的字段。
 *
 * 记录名为什么由后端拼：SRV 的 `service` / `proto` 必须带前导下划线且
 * 顺序固定（`_service._proto.name`），交给前端拼的话每个入口都要重复这套规则，
 * 迟早有一处漏了。这里统一拼好再走与其它类型相同的 fqdn 逻辑。
 *
 * `prefix` 是「服务标签之后、基准域名之前」的那一段（可为空或 `@`）——
 * 例如想给 `_sip._tcp.blog.xxx.doulor.cn` 配 SRV，prefix 就是 `blog`；
 * 直接挂在基准域名下则为空。
 */
function normalizeSrv(
  input: SrvInput,
  prefix: string,
  fallbackPriority?: number | null
): {
  /** 相对标签链，如 `_sip._tcp` 或 `_sip._tcp.blog` */
  name: string
  priority: number
  weight: number
  port: number
  target: string
  /** 展示串：`"优先级 权重 端口 目标"` */
  content: string
} {
  const service = normalizeSrvLabel(String(input.srvService ?? ""), "服务名")
  const proto = normalizeSrvLabel(String(input.srvProto ?? ""), "协议")
  const weight = parseSrvNumber(input.srvWeight, "权重", { fallback: 0 })
  const port = parseSrvNumber(input.srvPort, "端口", { min: 1 })
  const target = normalizeSrvTarget(input.srvTarget)
  // 优先级 0 是合法值（RFC 2782 里 0 表示最高优先），所以不能用 `||` 兜底
  const priority = parseSrvNumber(
    input.srvPriority ?? fallbackPriority ?? undefined,
    "优先级",
    { fallback: 10 }
  )

  const cleanPrefix = !prefix || prefix === "@" ? "" : prefix
  const name = cleanPrefix ? `${service}.${proto}.${cleanPrefix}` : `${service}.${proto}`
  return {
    name,
    priority,
    weight,
    port,
    target,
    content: srvContent(priority, weight, port, target),
  }
}

export async function createDns(env: Env, request: Request): Promise<Response> {
  // 闸一 · 权限：没有「DNS 解析」权限、也没有有效租约 → 403。
  //
  // 2026-10-14 起的档位（细节见 requireDnsAccess）：
  //   · full    —— 权限位 / 免权限访问 / 管理员，所有根域都行；
  //   · rented  —— 只覆盖自己租过的根域，**按记录的根域判**（见下方 assertDnsRootCovered）；
  //   · expired —— 只剩过期租约：连建都不许（删除仍放行，那是腾配额的手段）。
  const user = await requireUser(env, request)
  const access = await requireDnsAccess(env, user)
  if (access.mode === "expired") {
    throw new ApiError(
      403,
      "你的 DNS 解析租用已到期，续期后才能新建记录（已建好的记录不受影响）",
      "DNS_RENTAL_REQUIRED"
    )
  }
  // ⚠️ 2026-09-26 审计：每次调用都会真发一次 Cloudflare API 请求并写一条
  // audit_logs，原先零限流 ⇒ 脚本化调用可刷爆平台 CF 配额。
  // 管理员 Key 的公开 API 调用不限速（2026-10-07）
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(env, `dns:create:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
  }
  // 闸二 · 数量：每用户记录数上限（权限之后、任何 CF 调用之前）。
  // 先数量后校验请求体的好处：到顶的用户拿到的是一条**说清为什么**的错误，
  // 而不是「名称和内容不能为空」这种无关的报错；也不会白白消耗一次 CF API 调用
  // —— 真撞到 CF 那边，回来的是 zone 级的 `81045`，比这里难懂得多。
  const limit = await dnsRecordLimit(env, request, user)
  if (limit !== null) {
    const used = await countUserDnsRecords(env, user.id)
    if (used >= limit) {
      throw new ApiError(
        400,
        `DNS 记录数已达上限（${limit} 条），请先删除不再使用的记录`,
        "DNS_RECORD_LIMIT"
      )
    }
  }
  const body = (await request.json()) as {
    subdomainId?: string
    /**
     * 顶级记录（挂在 '@' 主域名下）想建在**哪个根域**下，省略 = 沿用现状。
     *
     * 为什么要有它（2026-10-14 站长要求）：DNS 改成按根域定价的积分租用后，
     * 「我这个域名（比如 xxx.7u.nz）下的解析」必须能**明着选**，而不是只能
     * 悄悄用注册时分的那个默认根域。前端从 `/api/dns/rental` 拿到可选根域
     * （已按权限 + 租约筛过），后端在这里**再校验一次** —— 前端隐藏只是省事，
     * 真正的闸必须在服务端（仓库既有约定）。
     */
    rootDomain?: string
    name?: string
    type?: string
    content?: string
    ttl?: number
    proxied?: boolean
    priority?: number
  } & SrvInput

  const type = (body.type ?? "").toUpperCase()
  if (!ALLOWED_TYPES.has(type)) {
    throw new ApiError(400, "不支持的记录类型", "INVALID_TYPE")
  }

  const domain = await loadUserDomain(env, user.id)
  if (!domain) {
    throw new ApiError(400, "尚未分配域名", "NO_DOMAIN")
  }

  // 根域闸：`pickRootDomain` 会把「不认识的域」「已停用」「requires_feature 没解锁」
  // 三种情况全部挡掉（400 / 400 / 403），与建子域名走的是同一个函数 ——
  // doulor.cn 需要 `doulor` 权限这件事因此不可能在两条路径上出现不同口径。
  const chosenRoot = body.rootDomain
    ? await pickRootDomain(env, body.rootDomain, userPermissions(user))
    : null

  // SRV 的 content 由 service/proto/weight/port/target 推导，用户不直接填；
  // 其余类型的 content 是必填的。
  const rawName = (body.name ?? "").trim()
  const content = (body.content ?? "").trim()
  if (type !== "SRV" && (!rawName || !content)) {
    throw new ApiError(400, "名称和内容不能为空", "INVALID_INPUT")
  }

  // 归属的子域名：默认是 '@' 根域
  let subdomain: { id: string; name: string; fqdn: string } | null = null
  if (body.subdomainId) {
    subdomain = await env.DB.prepare(
      "SELECT id, name, fqdn FROM subdomains WHERE id = ? AND user_id = ?"
    )
      .bind(body.subdomainId, user.id)
      .first<{ id: string; name: string; fqdn: string }>()
    if (!subdomain) throw new ApiError(403, "无权访问该子域名", "FORBIDDEN")
  } else {
    subdomain = await env.DB.prepare(
      "SELECT id, name, fqdn FROM subdomains WHERE user_id = ? AND name = '@' LIMIT 1"
    )
      .bind(user.id)
      .first<{ id: string; name: string; fqdn: string }>()
  }
  if (!subdomain) throw new ApiError(400, "尚未分配域名", "NO_DOMAIN")

  // SRV：把 service/proto/prefix 拼成相对标签链；其余类型：name 就是前缀
  const srv = type === "SRV" ? normalizeSrv(body, rawName) : null
  const name = srv ? srv.name : rawName
  const finalContent = srv ? srv.content : content
  const priority = srv ? srv.priority : type === "MX" ? body.priority ?? 10 : undefined

  // 记录挂在子域名下时，fqdn 以该子域名为基准（xxx.doulor.cn → 前缀.xxx.doulor.cn）
  //
  // ⚠️ 与改造前**完全一致**：base 只由「选中的子域名」决定。
  //    `rootDomain` 不是用来改 base 的（那会造出用户并不拥有的 fqdn，
  //    assertFqdnOwned 会直接 403），它的作用是**声明这条记录应该落在哪个根域**，
  //    由后端校验「声明的根域」与「子域名实际所属的根域」是否一致 —— 见下。
  const base = subdomain.name === "@" ? domain.name : subdomain.fqdn
  if (chosenRoot) {
    // 2026-10-14：DNS 改成按根域定价后，前端会把「我选的是哪个根域」一起发上来。
    // 它必须是**声明**而不是**指令** —— 两者不一致说明前端选择器与实际子域名
    // 对不上（前端版本旧 / 被人为构造），这时宁可 400 也不要静默按子域名建，
    // 否则用户会在 A 域下建出记录却以为建在 B 域，账单与事实对不上。
    const subRoot = (await rootDomainFor(env, subdomain.fqdn))?.name ?? ""
    if (chosenRoot.name !== subRoot) {
      throw new ApiError(
        400,
        `${subdomain.fqdn} 属于 ${subRoot || "另一个根域"}，不能把它的记录归到 ${chosenRoot.name} 下`,
        "ROOT_DOMAIN_MISMATCH"
      )
    }
  }
  const fqdn = name === "@" || name === "" ? base : `${name}.${base}`
  await assertFqdnOwned(env, user.id, fqdn)

  // 闸三 · 租用覆盖：记录最终落在哪个根域，就必须对那个根域有额度。
  // 放在 fqdn 定下来**之后**：只有这时才知道这条记录到底属于哪个域。
  // （管理员 / 权限位持有者走 full 档，直接放行，不受租期影响。）
  await assertDnsRootCovered(env, access, fqdn)

  const ttl = body.ttl ?? 1
  const proxied =
    type === "A" || type === "AAAA" || type === "CNAME"
      ? (body.proxied ?? false)
      : false

  let cfId: string | null = null
  try {
    const result = await cfCreateDnsRecord(env, await zoneIdForFqdn(env, fqdn), {
      type,
      name: fqdn,
      // SRV 走 data 对象（CF 的 SRV 示例里只有 data，没有 content），其余类型反之
      ...(srv
        ? {
            data: {
              priority: srv.priority,
              weight: srv.weight,
              port: srv.port,
              target: srv.target,
            },
          }
        : { content: finalContent }),
      ttl,
      proxied,
      // 顶层的 priority 对 MX 与 SRV 都是 CF 要求的字段；SRV 时与 data.priority
      // 传同一个值，两边取值一致，无论 CF 以哪个为准都正确。
      ...(priority !== undefined ? { priority } : {}),
    })
    cfId = result.id
  } catch (err) {
    // Cloudflare 失败不阻断本地记录，标记为 error，后续可重试
    console.error("CF DNS create failed for", fqdn, ":", err)
  }

  const id = uuid()
  const now = new Date().toISOString()
  // ⚠️ `domain_id` 一律写用户**主域名**那一行，即便这条记录的 fqdn 落在另一个根域下
  // （例如主域名是 paji.tyu.me、记录建在 paji.7u.nz）—— 这是改造前就有的行为：
  // dns_records 的归属事实由 `fqdn` 承担（zone 也是按 fqdn 的后缀解析的），
  // 而 domain_id 只用于「这条记录属于谁」的归属校验与用量统计。
  // 改成按根域去建/找 domains 行会引入一整套「同一个用户多行 domains」的数据模型，
  // 而 subdomains 表本来就不挂 domain_id —— 那是一次独立的迁移，不该夹带在这里。
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dns_records
        (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, priority,
         srv_weight, srv_port, srv_target, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      domain.id,
      subdomain.id,
      cfId,
      name,
      fqdn,
      type,
      finalContent,
      ttl,
      proxied ? 1 : 0,
      priority ?? null,
      srv ? srv.weight : null,
      srv ? srv.port : null,
      srv ? srv.target : null,
      cfId ? "active" : "error",
      isApiRequest(request) ? "api" : "web",
      now,
      now
    ),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'dns.create', ?, ?, ?)"
    ).bind(uuid(), user.id, `创建 DNS 记录 ${fqdn} (${type})`, request.headers.get("CF-Connecting-IP"), now),
  ])

  const row = await loadRecord(env, id)

  return json({ record: toPublicRecord(row!) }, 201)
}

export async function updateDns(env: Env, request: Request, id: string): Promise<Response> {
  // 改记录同样属「DNS 解析」权限范围；但**不做数量检查** —— 修改不会新增记录，
  // 拿上限去卡修改只会让「已到顶的用户连改个 IP 都改不了」。
  const user = await requireUser(env, request)
  const access = await requireDnsAccess(env, user)
  // 管理员 Key 的公开 API 调用不限速（2026-10-07）
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(env, `dns:update:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
  }
  const body = (await request.json()) as {
    name?: string
    type?: string
    content?: string
    ttl?: number
    proxied?: boolean
    priority?: number
  } & SrvInput

  const existing = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  if (!existing) {
    throw new ApiError(404, "记录不存在", "NOT_FOUND")
  }

  await requireOwnedDomain(env, user.id, existing.domain_id)

  const type = (body.type ?? existing.type).toUpperCase()
  if (!ALLOWED_TYPES.has(type)) {
    throw new ApiError(400, "不支持的记录类型", "INVALID_TYPE")
  }

  const domain = await env.DB.prepare("SELECT name, zone_id FROM domains WHERE id = ?")
    .bind(existing.domain_id)
    .first<{ name: string; zone_id: string | null }>()

  // fqdn 基准：挂在子域名下则以该子域名（xxx.doulor.cn）为基准
  let base = domain!.name
  if (existing.subdomain_id) {
    const sub = await env.DB.prepare("SELECT name, fqdn FROM subdomains WHERE id = ?")
      .bind(existing.subdomain_id)
      .first<{ name: string; fqdn: string }>()
    if (sub && sub.name !== "@") base = sub.fqdn
  }

  const ttl = body.ttl ?? existing.ttl
  const proxied =
    type === "A" || type === "AAAA" || type === "CNAME"
      ? (body.proxied ?? existing.proxied === 1)
      : false

  // 目标类型是 SRV 时，用新字段重建；否则沿用原有字段。
  //
  // ⚠️ 从 SRV 改成别的类型（或反过来）时，srv_* 三列会被写回 null ——
  // 留着旧值会让「列表里显示的是 SRV 的 target，实际记录是 A 记录」这种
  // 数据与展示不一致，排查起来很费劲。
  let name: string
  let content: string
  let priority: number | undefined
  let srvWeight: number | null = null
  let srvPort: number | null = null
  let srvTarget: string | null = null
  let srvData: { priority: number; weight: number; port: number; target: string } | null = null

  if (type === "SRV") {
    // 更新时通常只改端口/权重/目标，service 与 proto 要从现有记录名里取回。
    // 记录名形如 `_sip._tcp` 或 `_sip._tcp.blog`，前两段固定是 service 与 proto。
    const labels = existing.type === "SRV" ? existing.name.split(".") : []
    const fallbackService = labels[0] ?? ""
    const fallbackProto = labels[1] ?? ""
    const fallbackPrefix = labels.slice(2).join(".")

    // 前缀以本次提交的 name 为准；**没传就沿用记录名里原有的** ——
    // 否则「只改端口」会顺手把 `_sip._tcp.blog` 变成 `_sip._tcp`，
    // 记录悄悄指到了别的名字上（比报错更难发现）。
    const prefix = body.name !== undefined ? body.name.trim() : fallbackPrefix

    const srv = normalizeSrv(
      {
        srvService: body.srvService ?? fallbackService,
        srvProto: body.srvProto ?? fallbackProto,
        srvWeight: body.srvWeight ?? existing.srv_weight ?? 0,
        srvPort: body.srvPort ?? existing.srv_port ?? undefined,
        srvTarget: body.srvTarget ?? existing.srv_target ?? "",
      },
      prefix,
      existing.priority
    )
    name = srv.name
    content = srv.content
    priority = srv.priority
    srvWeight = srv.weight
    srvPort = srv.port
    srvTarget = srv.target
    srvData = { priority: srv.priority, weight: srv.weight, port: srv.port, target: srv.target }
  } else {
    name = body.name?.trim() ?? existing.name
    content = body.content?.trim() ?? existing.content
    priority = type === "MX" ? (body.priority ?? existing.priority ?? 10) : undefined
  }

  const fqdn = name === "@" || name === "" ? base : `${name}.${base}`
  await assertFqdnOwned(env, user.id, fqdn)

  // 租用覆盖：既看记录**现在**在哪个根域（你得有资格动它），也看**改完**落在哪 ——
  // 只查前者的话，用户可以把记录改名搬到没租的根域下（base 由 subdomain 决定，
  // 但 name 是用户随便填的）。两边都查才没有缺口。
  await assertDnsRootCovered(env, access, existing.fqdn)
  await assertDnsRootCovered(env, access, fqdn)

  if (existing.cf_id) {
    await cfUpdateDnsRecord(env, await zoneIdForFqdn(env, fqdn), existing.cf_id, {
      type,
      name: fqdn,
      ...(srvData ? { data: srvData } : { content }),
      ttl,
      proxied,
      ...(priority !== undefined ? { priority } : {}),
    })
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE dns_records
        SET name = ?, fqdn = ?, type = ?, content = ?, ttl = ?, proxied = ?, priority = ?,
            srv_weight = ?, srv_port = ?, srv_target = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(
      name,
      fqdn,
      type,
      content,
      ttl,
      proxied ? 1 : 0,
      priority ?? null,
      srvWeight,
      srvPort,
      srvTarget,
      now,
      id
    )
    .run()

  const row = await loadRecord(env, id)

  return json({ record: toPublicRecord(row!) })
}

export async function deleteDns(env: Env, request: Request, id: string): Promise<Response> {
  // 删除同样只要权限、不看数量 —— 恰恰相反，删记录是用户腾出额度的手段，
  // 若在到顶时把删除也卡住，用户就彻底出不来了。
  //
  // 2026-10-14：租用**到期**的用户也放行删除（`allowExpired`）。理由与上面那句同源 ——
  // 他删不掉的记录会永久占着 Cloudflare 的 zone 配额（每 zone 200 条，全站共用几个域），
  // 而管理员并不知道哪条是他不再需要的。锁住删除只会把成本转嫁给全站。
  // ⚠️ 只有「曾经租过这个根域」的人有这条出口；完全没权限的人仍然 403。
  const user = await requireUser(env, request)
  const access = await requireDnsAccess(env, user)
  // 管理员 Key 的公开 API 调用不限速（2026-10-07）
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(env, `dns:delete:user:${user.id}`, 30, 60, "DNS 操作过于频繁，请稍后再试")
  }

  const existing = await env.DB.prepare("SELECT * FROM dns_records WHERE id = ?")
    .bind(id)
    .first<DnsRow>()

  if (!existing) {
    throw new ApiError(404, "记录不存在", "NOT_FOUND")
  }

  await requireOwnedDomain(env, user.id, existing.domain_id)
  // 删除路径放行「已过期」档位（理由见本函数顶部注释）：删自己的旧记录是腾配额，
  // 不是新增能力。完全没租过 / 没权限的人在 requireDnsAccess 那一步就已经 403 了。
  await assertDnsRootCovered(env, access, existing.fqdn, { allowExpired: true })

  if (existing.cf_id) {
    // ⚠️ 必须用**记录自己的 fqdn** 判 zone，不能用「用户主域的名字」：
    // 两者在「主域与记录不同根域」时不一致，拿主域判会把记录写到别的 zone 里 ——
    // 表现为记录建了、CF 上却解析不出来，之后删除还会 404。
    // 2026-10-02 迁移窗口期真的踩到了：19 条 `1.luna.tyu.me` 被写进 doulor.cn 的 zone。
    try {
      await cfDeleteDnsRecord(env, await zoneIdForFqdn(env, existing.fqdn), existing.cf_id)
    } catch (err) {
      // CF 上已经不存在这条记录（`81044 Record does not exist`）⇒ **视为删除成功**，
      // 继续把 DB 行清掉。
      //
      // 为什么必须容错：上面那批历史脏数据就是「DB 里有行、CF 上根本没有」——
      // 用户点删除会一直报 `Cloudflare API 调用失败: 404 ...`，记录删不掉、
      // 永远卡在列表里（2026-10-02 用户 ventus 反馈的就是这个）。
      // 删除本身是幂等的：目标已不在，目的就算达成了。
      // 真正的失败（网络 / 权限 / 限流）仍然照常抛出。
      const msg = err instanceof Error ? err.message : String(err)
      if (!/81044|Record does not exist|\b404\b/i.test(msg)) throw err
    }
  }

  await env.DB.prepare("DELETE FROM dns_records WHERE id = ?").bind(id).run()

  return new Response(null, { status: 204 })
}