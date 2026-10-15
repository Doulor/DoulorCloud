/**
 * DNS 解析「积分租用」（2026-10-14 站长要求）。
 *
 * 背景：DNS 解析原先是一道**权限闸**（`FEATURES` 里的 `dns`，管理员逐个开），
 * 入口还藏在「域名」页的第二个选项卡里，没权限的人连按钮都看不到。站长的口径是：
 * 这东西不该等人来申请，而应该**明码标价、人人可买** —— 与内网穿透（frp）改成
 * 「积分租用 + 到期自动回收」是同一套做法（见 handlers/frp-rental.ts 与本文件
 * 顶部这份对照说明）。
 *
 * ---------------------------------------------------------------------------
 * 与 frp 租用的**同**与**不同**（照抄的时候别抄错地方）
 * ---------------------------------------------------------------------------
 * 相同：
 *   · 扣分只走 `points.ts` 的 `applyPoints` —— 它原子、余额不足直接拒、带 dedup_key
 *     防重复提交；租约落库失败必须把钱退回去（绝不能让用户付了分却没有租约）。
 *   · 一个用户在一个「资源」上只留一份有效租约（frp 是按节点，这里是按根域）。
 *   · 到期**不删行**，只把 status 翻成 expired：删了就查不出「他买过没有、花了多少」，
 *     而这正是站长排查「我明明买过为什么不能用」时唯一能看的东西。
 *   · 到期前 24 小时窗口内自动续费（用户可开关；积分不够就关掉开关并写下原因）。
 *
 * 不同（很重要，别照抄 frp 的落地机制）：
 *   · frp 的「落地」由服务器上的 agent 轮询后完成（D1 是期望状态，面板是实际状态，
 *     两者靠 sync_state 对账）。**DNS 没有 agent** —— 记录是 Worker 直接调
 *     Cloudflare API 建的。所以这里没有同步状态、没有 pending，D1 就是唯一真值。
 *   · 因此「回收」的形态也不同：frp 到期是 agent 把面板账号 disable（隧道立刻断）；
 *     DNS 到期只是**收回能力**（不能再建/改记录）。已经建出去的解析记录**不删** ——
 *     删记录是不可逆的破坏性动作，而且会静默掐断用户正在跑的服务（邮件收不到、
 *     网站打不开），比「多占几条 CF 配额」严重得多。真要大扫除由站长在管理端按记录处置。
 *
 * ---------------------------------------------------------------------------
 * 权限模型的最终口径（三档，互相独立，不要互相推断）
 * ---------------------------------------------------------------------------
 *   1. `dns` 权限位为 true（管理员手工开的、或 paji）—— **不受租期影响**，
 *      所有根域都能用。这是站长明确要求的：租用是给普通用户的入口，
 *      不是给已有权限的人加一道到期倒计时。
 *   2. 管理面板把 dns 设为「免权限访问」（`open_features`）—— 同上，全放开。
 *   3. 有效租约 —— **按根域**解锁，且只解锁这一个根域。价格本来就是一域一价
 *      （tyu.me 200 / 7u.nz 500，见 0160 迁移），按根域授权才对得上定价：
 *      否则买 200 的那个就能去用 500 的域，定价形同虚设。
 *
 * 管理员 / 站长（`isPrivileged`）与管理员 Key 的公开 API 一律全放开，
 * 口径与 handlers/dns.ts 的记录数上限、其它模块的权限判断完全一致。
 */
import { ApiError, json } from "../http"
import { requireUser, isPrivileged, type UserRow } from "../auth"
import { hasFeature, isFeatureOpen, userPermissions } from "../permissions"
import { applyPoints, getPointsBalance } from "../points"
import { listRootDomains, pickRootDomain, canUseRootDomain } from "../root-domains"
import { audit, getSettingNumber } from "../settings"
import type { Env } from "../env"
// ⚠️ 与 handlers/dns.ts 互为 import（那边引本文件的 `dnsAccessFor`）—— 刻意如此。
// 价目卡要写的「每用户几条记录」必须与「域名 → DNS 解析」页的 `dnsUsage.limit`
// 是**同一个数**，所以直接复用那个函数，不在这里另写一份取值逻辑。
// 两边都只在请求处理期调用它（不是模块求值期），ESM 的函数提升不存在时序问题。
import { dnsRecordLimit } from "./dns"

const DAY_MS = 86_400_000

/**
 * 租期的**兜底值**：一年（365 天）。
 *
 * 2026-10-15 起真正生效的租期是设置项 `dns_rental_days`（站长可改，见下面的
 * rentalDays）；这里这份常量只在设置项读不到 / 存了非法值时兜底。
 * 用 365 天而不是「加一个日历年」：后者在闰年要处理 2/29 这类边界，
 * 而用户看到的是「剩余 N 天」，365 天的算术与展示天然一致。
 */
const RENTAL_DAYS_FALLBACK = 365

/**
 * 当前租期（天）：读设置项 `dns_rental_days`，**非法值一律回落到 365 天**。
 *
 * 为什么不缓存：这是购买/续费路径上的低频调用（一次购买只读一次），
 * 而缓存会带来「管理员在后台改了租期，用户买到旧租期」的困惑。
 *
 * 为什么不把常量直接删掉：兜底值需要一个单一出处，散落的字面量 365
 * 改起来必然漏掉一处。
 *
 * ⚠️ 口径是**回落（fallback）而不是夹取（clamp）**，两端不同，别改成对称的 clamp：
 *   · 空串 / 非数字 / 0 / 负数 —— 一律按 **365 天**算，**不夹到 1 天**。
 *     空串是最容易踩的一个：`app_settings` 里读出来是 ""，`Number("")` 是 0，
 *     若按「夹到下限 1」处理，用户付完积分拿到的就是**一天后就到期**的租约
 *     —— 这正是「马上过期」的荒唐结果，比租期偏长恶劣得多（站长填错时宁可多给）。
 *     ⚠️ 这里刻意**不**让 0 表示「不限 / 不过期」（站内确实有设置项是那个语义）：
 *     0 天租约 = 收钱不办事，同样不可接受。
 *   · 只有**上限**才夹：> 3650 天（≈10 年）按 3650 算，防「把 365 手滑写成 365000」
 *     （同一个 3650 也写在 src/pages/admin.tsx 的输入框夹取里）。
 *   · 两边必须是同一条线，否则「后台显示 30、实际按 365 开」这种账没人算得清。
 */
async function rentalDays(env: Env): Promise<number> {
  const n = await getSettingNumber(env, "dns_rental_days")
  const days = Math.trunc(n)
  if (!Number.isFinite(days) || days < 1) return RENTAL_DAYS_FALLBACK
  return Math.min(3650, days)
}

/** 价格基准：`root_domains.dns_price_per_year` 是**一年**（365 天）的价 */
const DAYS_PER_YEAR = 365

/**
 * 按当前租期折算的**实收积分**。
 *
 * 口径（2026-10-15 把租期改成可配置项时一并定的，别随手改成四舍五入）：
 *   · 基准：`root_domains.dns_price_per_year` 是**每年**（365 天）的价 ——
 *     tyu.me = 200、7u.nz = 500、doulor.cn = 0（0 = 该域不参与售卖，调用方直接拒）。
 *   · 换算：`年价 × 租期天数 ÷ 365`，然后**向上取整**（Math.ceil）。
 *   · 最小扣费 = 1 分：年价 > 0 且天数 ≥ 1 时 ceil 的结果必然 ≥ 1，
 *     不会出现「0 分租一期」这种能被套利的漏洞。
 *   · 租期 = 365 天时结果**恰好等于年价**（200×365/365 = 200）—— 默认口径下
 *     价格分毫不变，站长不动这个设置项就等于回到改造前的行为。
 *
 * 为什么是 ceil，而不是 floor / round：
 *   · floor：30 天的 16.43 抹成 16，零头白送，短租期越多平台累计少收越多；
 *   · round：在「年价便宜 + 租期很短」时会算出 0（年价 100 分 × 1 天 = 0.27 → 0），
 *     等于白送一期 —— 这是价格表上的一个套利口子，不能留；
 *   · ceil：代价只是「零头多收不到 1 分」（用户侧不可感知），方向永远安全，
 *     而且结果必然是整数 —— 积分是整数账，不能让 16.438356164383562 这种数字
 *     进流水、进界面。
 *   取整之后**不另设**「最低 X 分」之类门槛：根域年价本身就只有几百积分，
 *   再垫一个最低档只会让「租 1 天」这种短租变得莫名其妙。
 *
 * ⚠️ 改设置项会**同时**改到期日与实收积分，例子（tyu.me，年价 200）：
 *     30 天 ⇒ ceil(200×30/365) = ceil(16.438…) = **17 分**（既不是 16，也不是 0）；
 *    182 天 ⇒ ceil(99.72…) = 100 分；365 天 ⇒ 200 分；730 天 ⇒ 400 分。
 * ⚠️ 只作用于**本次**购买 / 续期 / 自动续费：已经买下的租约到期日不动
 *    （与 frp 的套餐快照同一取舍 —— 用户是按当时看到的价格付的钱）。
 */
function priceForDays(yearPrice: number, days: number): number {
  // 先乘后除：`(200 × 365) / 365` 在双精度下精确等于 200；而先算比例
  // （`200 × (365/365)`）换个天数就可能得到 199.99999999999997，
  // 被 ceil 抬成 200/201 —— 整年的结果必须精确，不能靠运气。
  return Math.ceil((yearPrice * days) / DAYS_PER_YEAR)
}

/** 自动续费的提前窗口（与 frp 同口径：提前 24 小时续，避免出现服务中断的空窗） */
const AUTO_RENEW_WINDOW_MS = 24 * 3600 * 1000

interface RentalRow {
  id: string
  user_id: string
  root_domain: string
  price_points: number
  status: string
  started_at: string
  expires_at: string
  auto_renew: number
  last_error: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * 租约行下发给「服务端内部消费方」的公开形状（管理端列表按用户维度和它拼）。
 *
 * 之所以要导出类型与转换函数：管理端（handlers/admin-dns.ts）需要展示
 * 「到期时间 + 剩余天数」，而剩余天数的口径必须与用户端**完全一致** ——
 * 两边各算一遍的结果迟早会出现「管理端说还剩 3 天、用户端说 2 天」这种扯皮。
 */
export type DnsRentalRow = RentalRow

/**
 * 当前用户对 DNS 解析的访问档位。
 *
 * `mode` 的三档对应上面注释里的 1/2/3 条；`expired` 是**过渡档**：
 * 手上只剩已过期的租约时，建/改记录一律拒绝，但**删除自己的记录仍然放行**。
 *
 * 为什么给过期租约留删除口（而不是一并 403）：用户腾不掉的记录会**永久占着**
 * Cloudflare 的 zone 配额（每 zone 200 条，全站共用几个 zone），
 * 而「删记录」恰恰是把配额还回来的唯一手段。把他锁在门外，代价由全站承担。
 * ⚠️ 但它**只**覆盖他自己曾经租过的根域：没有租约的人（纯权限外用户）
 * 连这个口子都不给 —— 仓库既有约定是「所有接口一律服务端强制权限」，
 * 凭空开放删除等于把一个未授权写路径留在线上。
 */
export type DnsAccessMode = "full" | "rented" | "expired" | "none"

export interface DnsAccess {
  mode: DnsAccessMode
  /** 有效租约覆盖的根域（小写）；mode='full' 时为空数组 = 全部根域 */
  activeRoots: string[]
  /** 只剩历史（已过期 / 已停用）租约的根域，用于放行「删除自己的旧记录」 */
  expiredRoots: string[]
}

/** 全放开（管理员 / 免权限访问）：覆盖任意根域 */
const FULL_ACCESS: DnsAccess = { mode: "full", activeRoots: [], expiredRoots: [] }

/**
 * 解析用户的 DNS 访问档位。
 *
 * ⚠️ 只在**权限位没通过**时才会去查租约表：绝大多数请求（有权限的用户、
 * 管理员）走不到那一步，与 auth.ts 的 `requireFeatureUser` 里「只在被卡住时
 * 才读免权限总开关」是同一个取舍 —— 不让这条查询变成热点路径上的固定开销。
 */
export async function dnsAccessFor(env: Env, user: UserRow): Promise<DnsAccess> {
  if (isPrivileged(user.role)) return FULL_ACCESS

  const perms = userPermissions(user)
  if (hasFeature(perms, "dns")) return FULL_ACCESS
  if (await isFeatureOpen(env, "dns")) return FULL_ACCESS

  try {
    // 一次把所有租约取回来分类，而不是「先查 active 再查历史」两次：
    // 关键是**已经过了到期时间但 status 还没被 cron 翻过来**的那些行 ——
    // 按 status 分两次查会把它们漏在两边的空隙里，于是用户既拿不到额度
    // （正确），又拿不到「只能删除」的那条过渡档（错误：他会看到「你没有权限」，
    // 而事实是「你租过、已到期」，两句话该做的事完全不同）。
    const res = await env.DB.prepare(
      `SELECT root_domain, status, expires_at FROM dns_rentals WHERE user_id = ?`
    )
      .bind(user.id)
      .all<{ root_domain: string; status: string; expires_at: string }>()

    const now = Date.now()
    const activeRoots: string[] = []
    const expiredRoots: string[] = []
    for (const r of res.results ?? []) {
      const exp = Date.parse(r.expires_at)
      // 到期即视为失效，不等 cron 把 status 翻过来 —— 否则「cron 还没跑」的那段
      // 窗口里，一个已经过期的用户仍然建得出记录（口径与 frp 的 getFrpAgentDesired 一致）。
      const live = r.status === "active" && Number.isFinite(exp) && exp > now
      if (live) activeRoots.push(r.root_domain.toLowerCase())
      else expiredRoots.push(r.root_domain.toLowerCase())
    }

    return {
      mode: activeRoots.length > 0 ? "rented" : expiredRoots.length > 0 ? "expired" : "none",
      activeRoots,
      expiredRoots,
    }
  } catch (err) {
    // 表不存在（迁移没跑）时不能把有权限的用户一起挡掉 —— 上面两条 return 已经放行了
    // 权限位那条路，走到这里说明这人本来就没权限，退化成「无租用」是安全方向。
    console.error("读取 dns_rentals 失败（迁移 0161 是否已执行？）:", err)
    return { mode: "none", activeRoots: [], expiredRoots: [] }
  }
}

/**
 * 该档位是否覆盖某个根域。
 *
 * `allowExpired` 只在删除路径上传 true（见 DnsAccess 的注释）。
 * 根域为空（fqdn 不属于任何已登记根域，例如迁移漏跑退化成主域）时：
 * 只有 full 放行 —— 拿不准归属就按「不覆盖」处理，宁可让人来找管理员。
 */
export function dnsAccessCovers(
  access: DnsAccess,
  rootDomain: string,
  opts: { allowExpired?: boolean } = {}
): boolean {
  if (access.mode === "full") return true
  const root = (rootDomain ?? "").trim().toLowerCase()
  if (!root) return false
  if (access.activeRoots.includes(root)) return true
  return Boolean(opts.allowExpired && access.expiredRoots.includes(root))
}

/**
 * 读某个根域的年价。
 *
 * 为什么再查一次库而不是复用 `getRootDomainByName` 的行：`RootDomainRow` 是
 * root-domains.ts 里**按需扩展**的结构，而该模块有一层 10 秒读缓存 ——
 * 价格是站长随时会改的定价数据，跟着缓存走会出现「改了价、用户那边还是旧价」
 * 的窗口期，而扣分是按这里的价格扣的。所以价格走独立查询，不进那层缓存。
 */
async function priceOf(env: Env, rootName: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT dns_price_per_year FROM root_domains WHERE name = ? COLLATE NOCASE LIMIT 1`
  )
    .bind(rootName)
    .first<{ dns_price_per_year: number | null }>()
  return Number(row?.dns_price_per_year ?? 0)
}

function daysLeft(expiresAt: string): number {
  const exp = Date.parse(expiresAt)
  return Number.isFinite(exp) ? Math.ceil((exp - Date.now()) / DAY_MS) : 0
}

/** 单条租约下发给前端 / 管理端的形状 */
export function toPublicDnsRental(row: DnsRentalRow) {
  const left = daysLeft(row.expires_at)
  const expired = Date.parse(row.expires_at) <= Date.now()
  return {
    id: row.id,
    rootDomain: row.root_domain,
    pricePoints: row.price_points,
    /** 到期即视为 expired，即便 status 还没被 cron 翻过来（口径见 dnsAccessFor） */
    status: expired && row.status === "active" ? "expired" : row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    daysLeft: left,
    autoRenew: row.auto_renew === 1,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------- 用户端

/**
 * GET /api/dns/rental —— 可租的根域 + 我的积分 + 我的租约。
 *
 * 一个接口把「下拉框要用的可选根域」和「用户端面板要展示的价目/我的租期」一起下发：
 * 两处需要的是同一份数据（根域名、年价、我能不能用、我的租约到什么时候），
 * 拆成两个接口只会让它们迟早漂移。
 *
 * 2026-10-15 租期改成可配置项后，这里额外下发两个**面板要显示**的字段：
 *   · `rentalDays` —— 当前设置的租期（天）。面板上写「租 X 天」用的就是它，
 *     前端**不要**自己猜 365，否则站长把租期改成 30 天时界面会与实收不符。
 *   · `options[].termPrice` —— 这个根域按**当前租期**折算的实际售价（见 priceForDays），
 *     与 `options[].yearPrice`（年价，价目表上写「¥价/年」用的）是两个不同的数。
 *
 * 2026-10-15（同日）再补一个 `recordLimit`：站长要求价目卡上写清「这个额度的账号一共能建
 * 几条记录」（形如 `tyu.me 解析额度（3 条）· 200 积分/年`）。它取的是
 * handlers/dns.ts 那个**同一个** `dnsRecordLimit`（用户级覆盖 > 全局设置，
 * 管理员为 null = 不限），口径与 `GET /api/dns` 的 `dnsUsage.limit` 完全一致 ——
 * 两个数字必须永远相等，否则用户会拿着价目卡上的条数来质问解析页为什么不让建。
 */
export async function listDnsRentalOptions(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const [balance, access, roots, days, recordLimit] = await Promise.all([
    getPointsBalance(env, user.id),
    dnsAccessFor(env, user),
    listRootDomains(env),
    rentalDays(env),
    // 上限是「每用户」的，与具体根域无关：同一个数会画在每一张价目卡上
    // （与 dnsUsage.limit 一样是账号维度的口径，不是按根域分配的）。
    dnsRecordLimit(env, request, user),
  ])

  const mine = await env.DB.prepare(
    `SELECT * FROM dns_rentals WHERE user_id = ? ORDER BY expires_at DESC`
  )
    .bind(user.id)
    .all<RentalRow>()

  const rentalByRoot = new Map<string, RentalRow>()
  for (const r of mine.results ?? []) {
    // 同一根域可能有多行（历史的 expired + 当前的 active）：优先留有效的那条
    const key = r.root_domain.toLowerCase()
    const prev = rentalByRoot.get(key)
    if (!prev || (r.status === "active" && prev.status !== "active")) rentalByRoot.set(key, r)
  }

  const perms = userPermissions(user)
  const freeAccess = access.mode === "full"

  const options = roots
    .filter((r) => r.enabled === 1)
    .map((r) => {
      const yearPrice = Number(r.dns_price_per_year ?? 0)
      const rental = rentalByRoot.get(r.name)
      // 权限闸（`requires_feature`，如 doulor.cn 要 `doulor`）由 root-domains.ts
      // 统一判定 —— 与建子域名走的是同一个函数，两边口径不会漂移。
      const permitted = isPrivileged(user.role) || canUseRootDomain(perms, r)
      const covered = dnsAccessCovers(access, r.name)
      return {
        name: r.name,
        label: r.label ?? r.name,
        isDefault: r.is_default === 1,
        requiresFeature: r.requires_feature,
        yearPrice,
        /** 按当前租期折算的实收积分（yearPrice × rentalDays ÷ 365，向上取整） */
        termPrice: yearPrice > 0 ? priceForDays(yearPrice, days) : 0,
        /** yearPrice = 0 表示这个域不参与租用售卖（doulor.cn 就是这样，它走权限门控） */
        forSale: yearPrice > 0,
        /** 权限闸是否放行（不放行的域连买都不该出现在价目里） */
        permitted,
        /** 免费可用：权限位 / 免权限访问 / 管理员 —— 这些人不需要买 */
        freeAccess,
        /** 当前是否真的能建记录（免费额度 或 有效租约 或 管理员） */
        usable: freeAccess || covered,
        rental: rental ? toPublicDnsRental(rental) : null,
      }
    })

  return json({
    balance,
    accessMode: access.mode,
    freeAccess,
    /**
     * 该账号当前生效的「每用户解析记录数」上限；`null` = **不限**。
     *
     * 与 `GET /api/dns` 的 `dnsUsage.limit` 同口径（同一个 `dnsRecordLimit`）：
     * 用户级覆盖 `users.max_dns_records` > 全局设置 `dns_records_per_user`；
     * 只有管理员 / 站长 / 管理员 Key（`isPrivileged` / `isAdminApiRequest`）才是 null。
     * ⚠️ null 表示**不限**，不是 0、也不是「没读到」——前端必须区分对待
     * （0 会渲染成「0 条」，把「不限」说成「一条都不能建」）。
     */
    recordLimit,
    /** 当前设置的租期（天）；面板上的「租 X 天」一律用它（见本函数注释） */
    rentalDays: days,
    options,
    /** 我的全部租约（含已过期、含根域已被停用/删除的历史行） */
    rentals: (mine.results ?? []).map(toPublicDnsRental),
  })
}

/**
 * POST /api/dns/rental/purchase —— 用积分买下某个根域的解析能力（一期）。
 *
 * 「一期」= 设置项 `dns_rental_days` 的当前值（默认 365 天 = 一年），
 * 扣费按**年价 × 租期 ÷ 365** 折算（口径见 priceForDays）。
 *
 * 幂等：`requestId` 由前端生成（crypto.randomUUID），拼进 applyPoints 的 dedupKey。
 * 双击 / 网络重试不会重复扣分；重复请求会拿到 409 而不是再扣一次。
 */
export async function purchaseDnsRental(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    rootDomain?: string
    requestId?: string
  }
  const rootName = String(body.rootDomain ?? "").trim().toLowerCase()
  if (!rootName) throw new ApiError(400, "缺少根域", "BAD_PURCHASE")

  // 权限闸 + 启用状态：`pickRootDomain` 会把「没启用」「没解锁 requires_feature」
  // 都挡在这里（403 / 400），不必在本文件里重复那套判断。
  const root = await pickRootDomain(env, rootName, userPermissions(user))

  // 🚨 价格必须**先按当前租期折算再扣**：`priceOf` 拿到的是年价，
  // 租期不是 365 天时直接拿它扣就是多收（租 30 天收一年的钱）。
  const days = await rentalDays(env)
  const yearPrice = await priceOf(env, root.name)
  if (yearPrice <= 0) {
    throw new ApiError(409, `${root.name} 当前不开放租用`, "RENTAL_NOT_FOR_SALE")
  }
  const price = priceForDays(yearPrice, days)

  const existing = await env.DB.prepare(
    `SELECT id FROM dns_rentals
      WHERE user_id = ? AND root_domain = ? AND status = 'active' LIMIT 1`
  )
    .bind(user.id, root.name)
    .first<{ id: string }>()
  if (existing) {
    throw new ApiError(
      409,
      `你已经有 ${root.name} 的有效租约了，请直接续期`,
      "ALREADY_RENTED"
    )
  }

  // 先扣分再落库：反过来会出现「租约在、钱没扣」（异常路径难补）。
  // 落库失败由下面的 catch 全额退回，语义与 frp 的购买完全一致。
  const deducted = await applyPoints(env, {
    userId: user.id,
    delta: -price,
    reason: "dns_rental",
    detail: `DNS 解析租用 · ${root.name}（${days} 天）`,
    dedupKey: body.requestId ? `dns_rental:buy:${body.requestId}` : null,
  })
  if (!deducted.applied) {
    if (deducted.reason === "duplicated") {
      throw new ApiError(409, "这次购买已经处理过了，请刷新页面查看", "DUPLICATE_REQUEST")
    }
    throw new ApiError(
      402,
      `积分不足：需要 ${price}，你当前有 ${deducted.balance}`,
      "INSUFFICIENT_POINTS"
    )
  }

  const id = `dnsr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  const at = new Date()
  const expires = new Date(at.getTime() + days * DAY_MS).toISOString()

  try {
    await env.DB.prepare(
      `INSERT INTO dns_rentals
         (id, user_id, root_domain, price_points, status, started_at, expires_at,
          auto_renew, last_error, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, 0, NULL, NULL, ?, ?)`
    )
      .bind(id, user.id, root.name, price, at.toISOString(), expires, at.toISOString(), at.toISOString())
      .run()
  } catch (err) {
    // 🚨 落库失败必须把钱退回去 —— 绝不能让用户付了积分却什么都没有。
    // 幂等键带上租约 id：即使重试也不会退两次。
    await applyPoints(env, {
      userId: user.id,
      delta: price,
      reason: "dns_rental",
      detail: `DNS 解析租用 · ${root.name} 开通失败，积分已退回`,
      dedupKey: `dns_rental:refund:${id}`,
    })
    throw err
  }

  await audit(env, user.id, "dns.rental.purchase", `${root.name} / -${price}`)

  return json({
    ok: true,
    id,
    rootDomain: root.name,
    expiresAt: expires,
    balance: deducted.balance,
    pricePoints: price,
    /** 实际生效的租期（天）：小票上写「租 N 天、到期 X」用，别让前端各自猜 365 */
    rentalDays: days,
    /** 该根域的年价，供界面同时展示「年价 / 本期价」 */
    yearPrice,
  })
}

/**
 * POST /api/dns/rental/renew —— 续一期（一期 = 当前租期，见设置项 dns_rental_days）。
 *
 * ⚠️ 查询必须带 `user_id`：否则拿着别人的租约 id 就能替别人续期
 * （花自己的分、把别人的到期日往后推）。越权时返回 404 而不是 403 ——
 * 403 等于确认「这个 id 确实存在」，与 frp 改令牌那条是同一个道理。
 */
export async function renewDnsRental(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { id?: string; requestId?: string }
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少租约", "BAD_RENEW")

  const row = await env.DB.prepare(
    `SELECT * FROM dns_rentals WHERE id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<RentalRow>()
  if (!row) throw new ApiError(404, "租约不存在", "RENTAL_NOT_FOUND")
  if (row.status === "cancelled") {
    throw new ApiError(409, "该租约已被停用，请联系管理员", "RENTAL_CANCELLED")
  }

  // 与购买同口径：年价 × 当前租期 ÷ 365，向上取整，最小 1 分（见 priceForDays）
  const days = await rentalDays(env)
  const yearPrice = await priceOf(env, row.root_domain)
  if (yearPrice <= 0) {
    throw new ApiError(
      409,
      `${row.root_domain} 当前不开放租用，无法自助续期，请联系管理员`,
      "RENTAL_NOT_FOR_SALE"
    )
  }
  const price = priceForDays(yearPrice, days)

  const deducted = await applyPoints(env, {
    userId: user.id,
    delta: -price,
    reason: "dns_rental",
    detail: `DNS 解析续期 · ${row.root_domain}（+${days} 天）`,
    dedupKey: body.requestId ? `dns_rental:renew:${body.requestId}` : null,
  })
  if (!deducted.applied) {
    if (deducted.reason === "duplicated") {
      throw new ApiError(409, "这次续期已经处理过了，请刷新页面查看", "DUPLICATE_REQUEST")
    }
    throw new ApiError(
      402,
      `积分不足：需要 ${price}，你当前有 ${deducted.balance}`,
      "INSUFFICIENT_POINTS"
    )
  }

  // 未过期从「原到期日」顺延，已过期从「现在」起算 ——
  // 不吞掉剩余天数，也不让过期用户倒扣（与 frp 的续期口径完全一致）。
  const base = Math.max(Date.now(), Date.parse(row.expires_at) || 0)
  const next = new Date(base + days * DAY_MS).toISOString()
  const at = new Date().toISOString()

  await env.DB.prepare(
    `UPDATE dns_rentals
        SET expires_at = ?, status = 'active', last_error = NULL, updated_at = ?
      WHERE id = ?`
  )
    .bind(next, at, id)
    .run()

  await audit(env, user.id, "dns.rental.renew", `${row.root_domain} → ${next} / -${price}`)

  return json({
    ok: true,
    expiresAt: next,
    balance: deducted.balance,
    pricePoints: price,
    rentalDays: days,
    yearPrice,
  })
}

/**
 * POST /api/dns/rental/auto-renew —— 开关自动续费（只能改自己的租约）。
 *
 * 语义与 frp 完全一致：到期前 24 小时内，若开着且积分够，自动按**当时的年价与租期**
 * 续一期（实收积分 = 年价 × 租期 ÷ 365，见 priceForDays）；
 * 积分不够时服务端会把开关关掉并把原因写进 last_error（用户下次打开页面就能看到
 * 「为什么没续上」，而不是过几天发现解析不能建了再来问）。
 *
 * ⚠️ 用 `WHERE id = ? AND user_id = ?` 而不是「先查后判断」：后者中间有窗口，
 *    而且「查到了但不属于你」与「不存在」必须返回**同样的 404**。
 */
export async function setDnsRentalAutoRenew(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; autoRenew?: unknown }
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少租约 id", "BAD_REQUEST")
  if (typeof body.autoRenew !== "boolean") {
    throw new ApiError(400, "autoRenew 必须是布尔值", "BAD_REQUEST")
  }

  const res = await env.DB.prepare(
    `UPDATE dns_rentals SET auto_renew = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  )
    .bind(body.autoRenew ? 1 : 0, new Date().toISOString(), id, user.id)
    .run()

  if (!res.meta.changes) throw new ApiError(404, "租约不存在", "RENTAL_NOT_FOUND")
  return json({ ok: true, id, autoRenew: body.autoRenew })
}

// ---------------------------------------------------------------- 定时任务

/**
 * 到期回收 + 自动续费（由每小时那条 cron 调用，见 index.ts 的 scheduled）。
 *
 * 两步，顺序不能反：
 *   1. **先回收**：把已到期的 active 翻成 expired。访问判定本来就带
 *      `expires_at > now`（见 dnsAccessFor），所以这一步的作用是让状态**可观测** ——
 *      管理端与用户端显示的 status 从此与真实能力一致，不必各自再算一遍时间。
 *   2. **再自动续费**：刚被翻成 expired 的那些行如果开着 auto_renew，就不该被续
 *      （用户已经把开关关掉、或者本来就打算停），所以续费只扫**仍为 active**
 *      且在 24 小时窗口内的行。
 *
 * 为什么必须是定时任务、而不是等用户打开页面时顺手续：自动续费的意义就是
 * 「用户不在的时候也别断」。只在有人访问时才续，与手动续费没有区别。
 */
export async function expireAndAutoRenewDnsRentals(
  env: Env
): Promise<{ expired: number; renewed: number; insufficient: number; skipped: number }> {
  const out = { expired: 0, renewed: 0, insufficient: 0, skipped: 0 }
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  // 整批只读一次设置项：一是省掉逐行读库（最多 200 行），
  // 二是保证同一批租约按**同一个**租期与价格续 —— 读到一半设置项被改，
  // 会出现「同一批里有人续了 365 天、有人续了 30 天」这种没法解释的结果。
  const days = await rentalDays(env)

  try {
    const swept = await env.DB.prepare(
      `UPDATE dns_rentals SET status = 'expired', updated_at = ?
        WHERE status = 'active' AND expires_at <= ?`
    )
      .bind(nowIso, nowIso)
      .run()
    out.expired = swept.meta?.changes ?? 0
  } catch (err) {
    // 迁移没跑（表不存在）不该把整条 cron 打断 —— 它同时还要跑别的运维
    console.error("DNS 租约到期回收失败（迁移 0161 是否已执行？）:", err)
    return out
  }

  const horizon = new Date(nowMs + AUTO_RENEW_WINDOW_MS).toISOString()
  const due = await env.DB.prepare(
    `SELECT id, user_id, root_domain, expires_at FROM dns_rentals
      WHERE auto_renew = 1 AND status = 'active' AND expires_at <= ?
      LIMIT 200`
  )
    .bind(horizon)
    .all<{ id: string; user_id: string; root_domain: string; expires_at: string }>()

  for (const r of due.results ?? []) {
    const yearPrice = await priceOf(env, r.root_domain)
    if (yearPrice <= 0) {
      // 价格被改成 0（不再售卖）或根域已被删：没有价格就续不了。
      // ⚠️ **不关掉开关** —— 这是数据/定价本身的问题，不是用户的错
      // （与 frp 里「没有套餐的租约直接跳过」同一条取舍）。
      out.skipped++
      continue
    }
    // 自动续费按**续费那一刻**的年价与租期收（与手动续费同一口径）：
    // 站长调价/调租期后，之前买下的租约到期时也按新价续 —— 用户看到的是
    // 「自动续费失败：积分不足（需要 X）」，X 就是这里的实收值，不会有惊喜。
    const price = priceForDays(yearPrice, days)

    const deducted = await applyPoints(env, {
      userId: r.user_id,
      delta: -price,
      reason: "dns_rental",
      detail: `DNS 解析自动续费 · ${r.root_domain}（+${days} 天）`,
      // 幂等键带上原到期时间：同一期只续一次，即使 cron 被重复触发
      dedupKey: `dns_rental:autorenew:${r.id}:${r.expires_at}`,
    })

    if (!deducted.applied) {
      await env.DB.prepare(
        `UPDATE dns_rentals SET auto_renew = 0, last_error = ?, updated_at = ? WHERE id = ?`
      )
        .bind(
          `自动续费失败：积分不足（需要 ${price}，当前 ${deducted.balance}）`,
          nowIso,
          r.id
        )
        .run()
      out.insufficient++
      continue
    }

    // 从**原到期时间**往后推，而不是从现在推 —— 否则 cron 延迟执行会把用户的时间吃掉
    const base = Date.parse(r.expires_at)
    const from = Number.isFinite(base) ? base : nowMs
    await env.DB.prepare(
      `UPDATE dns_rentals SET expires_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`
    )
      .bind(new Date(from + days * DAY_MS).toISOString(), nowIso, r.id)
      .run()
    out.renewed++
  }

  return out
}

/* --------------------------------------------------------------------------
 * 管理端复用的小工具
 * ----------------------------------------------------------------------- */

/**
 * 管理员手工给某个用户开一份租约（不扣分）。
 *
 * 为什么要有它：用户付了钱但自动落库失败、或线下结算（充值 / 补偿）时，
 * 站长需要一个不依赖积分余额的口子。`created_by` 记下操作人，
 * 与用户自己买的租约（created_by 为 NULL）区分得开。
 *
 * ⚠️ `days` 由调用方（管理端）**显式给定**，不取设置项 `dns_rental_days` ——
 * 手工开租约本来就是「站长想给几天就给几天」（补偿三天、送半年都说得通），
 * 跟着全局租期走反而失去这个口子。但落库的 `price_points` 仍按同一套
 * 折算口径记成「这 N 天值多少积分」（见 priceForDays），这样管理端列表里
 * 「手工租约」与「用户自购租约」的价格才可比，不是两个口径的账。
 */
export async function grantDnsRental(
  env: Env,
  adminId: string,
  userId: string,
  rootDomain: string,
  days: number
): Promise<{ id: string; expiresAt: string }> {
  const at = new Date()
  const expires = new Date(at.getTime() + days * DAY_MS).toISOString()
  const id = `dnsr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  const price = priceForDays(await priceOf(env, rootDomain), days)

  // 已有有效租约时**顺延**而不是插新行 —— 唯一索引只允许一行 active，
  // 硬插会撞约束并抛 500，而「顺延」正好是管理员想表达的意思。
  const existing = await env.DB.prepare(
    `SELECT id, expires_at FROM dns_rentals
      WHERE user_id = ? AND root_domain = ? AND status = 'active' LIMIT 1`
  )
    .bind(userId, rootDomain)
    .first<{ id: string; expires_at: string }>()

  if (existing) {
    const base = Math.max(Date.now(), Date.parse(existing.expires_at) || 0)
    const next = new Date(base + days * DAY_MS).toISOString()
    await env.DB.prepare(
      `UPDATE dns_rentals SET expires_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`
    )
      .bind(next, at.toISOString(), existing.id)
      .run()
    return { id: existing.id, expiresAt: next }
  }

  await env.DB.prepare(
    `INSERT INTO dns_rentals
       (id, user_id, root_domain, price_points, status, started_at, expires_at,
        auto_renew, last_error, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 0, NULL, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      rootDomain,
      price,
      at.toISOString(),
      expires,
      adminId,
      at.toISOString(),
      at.toISOString()
    )
    .run()

  return { id, expiresAt: expires }
}

/** 供管理端列表用：按到期时间升序取全部租约（附用户名） */
export async function listAllDnsRentals(env: Env): Promise<
  (DnsRentalRow & { username: string | null })[]
> {
  const res = await env.DB.prepare(
    `SELECT r.*, u.username AS username
       FROM dns_rentals r LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.expires_at ASC`
  ).all<DnsRentalRow & { username: string | null }>()
  return res.results ?? []
}
