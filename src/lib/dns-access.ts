/**
 * 「域名 → DNS 解析」页的访问推导（**纯函数**：无 React、无请求、无别名依赖）。
 *
 * 为什么把它从 pages/domains.tsx 里抽出来（2026-10-16）：
 * 这一页「能不能看记录 / 能不能建记录 / 要不要显示价目表」由**两个来源**共同决定 ——
 *   ① 前端自己的 `hasFreeDns`：`/api/me` 的用户快照里 `permissions.dns === true`
 *      或 role 是 root / superadmin；
 *   ② 服务端的 `accessMode`：`GET /api/dns/rental` 下发，口径见
 *      worker/src/handlers/dns-rental.ts 的 `dnsAccessFor`（**三档**：
 *      权限位 / 免权限访问 open_features / 有效租约）。
 * 两个来源**必须**一致，否则就会出现「服务端放行、前端却把入口藏起来」的死角。
 *
 * 🔴 2026-10-16 真实故障（站长报的 paji）：
 *   老代码把 ② 的 `"full"` 档整个漏掉了 ——
 *     `canManageDns = hasFreeDns || accessMode === "rented" || accessMode === "expired"`
 *   于是只要「服务端说 full、前端的用户快照却是 false」，用户就会看到：
 *     价目表 + 「你的账号已开通 DNS 解析额度」横幅（横幅的渲染条件正是
 *     `freeAccess === true`，即服务端 accessMode 就是 "full"），
 *     却**完全看不到记录列表，也看不到「添加记录」按钮** ——
 *   而服务端对他其实是全放开的（GET /api/dns 200、POST /api/dns 201）。
 *
 *   `hasFreeDns` 为 false 而服务端为 full 是**完全合法**的状态，至少两种：
 *     · 管理面板把 dns 设成「免权限访问」（`open_features` 含 dns）——
 *       `dnsAccessFor` 的第 2 档，与权限位互相独立，横幅文案本身也写了这来源；
 *     · 用户快照还没到 / 没拿到（`useAuth` 在 `/api/me` 失败时把 user 置 null，
 *       而本页不看 loading 就直接渲染）—— 此时能拿到的只有服务端的 accessMode。
 *
 * 所以这里的口径是：**以服务端 accessMode 为准，full 一律按「免费额度」处理**，
 * 前端那份快照只作为「还没等到服务端回答时的乐观短路」。
 *
 * ⚠️ 副作用（要的就是这个）：`mode !== "full"` 才显示租用价目面板，
 * full 的用户（含服务端判定的）不再看到价目表与「已开通额度」横幅 ——
 * 与「有权限位 / 管理员不显示价目表」的既有口径一致（他们本来就不用买）。
 */

/** 服务端下发的访问档位，与 worker/src/handlers/dns-rental.ts 的 DnsAccessMode 同形 */
export type DnsAccessMode = "full" | "rented" | "expired" | "none"

export interface DnsAccessView {
  /** 实际生效的档位；`hasFreeDns` 时直接是 full（不必等租用请求回来） */
  mode: DnsAccessMode
  /** 能不能看记录列表（expired 也放行 —— 服务端允许他们删掉自己的旧记录） */
  canManage: boolean
  /** 能不能**新建 / 修改**记录（到期后只能删） */
  canWrite: boolean
  /**
   * 要不要显示「解析额度价目 / 我的租约」面板。
   *
   * ⚠️ 这**不是**页面上的最终判据：pages/domains.tsx 还会在「他手上仍有租约」时
   * 照样显示面板（`access.showRentalPanel || hasRentalsToManage`）—— full 档的人
   * 不必再买，但他已经买过、尤其开着自动续费的那份租约必须有地方看与关，
   * 否则免权限访问期间他会找不到任何入口却继续被扣分。
   */
  showRentalPanel: boolean
}

/**
 * 把「前端的免费额度快照」与「服务端的档位」收敛成唯一一份页面口径。
 *
 * `serverAccessMode` 传 null / undefined = 租用状态还没拉到（或请求失败）——
 * 那按 "none" 处理（宁可不渲染记录区，也不要拿一个没确认的档位去放行）。
 */
export function dnsAccessView(
  hasFreeDns: boolean,
  serverAccessMode: DnsAccessMode | null | undefined
): DnsAccessView {
  const mode: DnsAccessMode = hasFreeDns ? "full" : (serverAccessMode ?? "none")
  return {
    mode,
    /**
     * ⚠️ 这里刻意写成「非 none 即可」，而不是枚举 `rented || expired`：
     * 少写一个档位（正是 paji 那次：漏了 "full"）不会报错、只会静静地把人关在门外，
     * 而写成「非 none」之后，将来再加档位也不会重犯。
     */
    canManage: mode !== "none",
    canWrite: mode === "full" || mode === "rented",
    showRentalPanel: mode !== "full",
  }
}

/** 一个可选的根域（子域名列表页与租用面板下发的形状取交集） */
export interface DnsRootChoice {
  name: string
  label?: string | null
}

/**
 * 新建记录时**能用**的根域。
 *
 * 有免费额度（含服务端判定的 full）⇒ 后端下发的全部可选根域（`GET /api/subdomains`
 * 的 rootDomains，已按权限筛过）；
 * 否则 ⇒ 租用面板里 `usable` 的那些根域（买 200 的 tyu.me 不等于能用 500 的 7u.nz）。
 *
 * 为什么两档都要走「服务端下发的清单」而不是前端硬编码：根域是站长可增删的，
 * 写死会在换域时让整页显示错域名（见 pages/domains.tsx 顶部注释）。
 */
export function usableDnsRoots(
  freeAccess: boolean,
  rootOptions: readonly DnsRootChoice[],
  rentalOptions: readonly (DnsRootChoice & { usable: boolean })[]
): { name: string; label: string }[] {
  const source: readonly DnsRootChoice[] = freeAccess
    ? rootOptions
    : rentalOptions.filter((o) => o.usable)
  return source.map((r) => ({ name: r.name, label: r.label || r.name }))
}

export interface RecordDomainChoice {
  id: string
  fqdn: string
  /** 该子域名所属的根域（用于提交时给服务端做一致性校验） */
  root: string
}

/**
 * 「新建记录」能落在哪些域名下 = 我名下的子域名 ∩ 我能用的根域。
 *
 * 为什么不是直接列根域：DNS 记录只能挂在自己**确实拥有**的子域名之下
 * （服务端 `assertFqdnOwned` 只认 `subdomains` 表里的行），
 * 拿根域拼一个 `<用户名>.<根域>` 拼出来的是用户并不拥有的 fqdn，必然 403。
 *
 * ⚠️ 这个推导**可能是空数组**，而且线上真实存在这种数据形态：
 * 名下子域名都不在「当前可用根域」之下时（例：只租了 tyu.me，子域名却只有
 * `x.7u.nz`），可选域名一个都没有 —— 此时记录区**照常渲染**（历史记录还看得见、
 * 删得掉），只是「添加记录 / 批量添加」按钮变成 disabled（见 createTarget 与
 * writeDisabled）。这是刻意的：藏掉按钮会让人以为页面坏了。
 *
 * 另：记录名 `name === "@"` 的**主域名行**同样会出现在这里 ——
 * 判断用的是整条 `fqdn` 的后缀，与记录名无关（`paji.tyu.me` 落在 tyu.me 下）。
 */
export function recordDomainChoices(
  subdomains: readonly { id: string; fqdn: string }[],
  roots: readonly DnsRootChoice[]
): RecordDomainChoice[] {
  return subdomains
    .map((s) => {
      const root = roots.find((r) =>
        s.fqdn.toLowerCase().endsWith(`.${r.name.toLowerCase()}`)
      )
      return root ? { id: s.id, fqdn: s.fqdn, root: root.name } : null
    })
    .filter((x): x is RecordDomainChoice => x !== null)
}
