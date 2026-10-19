/**
 * 把 AI 实验室的**作品绑到用户自己的域名**上（2026-10-10 站长要求）。
 *
 * 机制**照抄直链网盘那一套**，不另造轮子：
 *   · 建 DNS 记录（AAAA 100:: + **开代理**）—— doulor.cn 没有泛解析，
 *     只加 Worker Route 不建解析，域名根本到不了 Cloudflare；
 *   · 给这个 fqdn 加一条 Worker Route（`<fqdn>/*`）指到本站 Worker；
 *   · Worker 的 `hostedDirectLink()` 按 Host 分流，命中本表就吐作品内容。
 *
 * 相关函数直接复用 `handlers/storage.ts` 的 `createWorkerRoute` / `removeWorkerRoute`，
 * 保证两边行为一致（否则一处修了另一处没修，迟早出事）。
 *
 * 🔴 绑定的三条不可退让的约束（都踩过坑，别拆）：
 *   1. **归属**：fqdn 必须真在这个用户名下（`assertFqdnOwned`）—— 否则任何人
 *      都能把作品挂到别人的子域上，整站被顶掉（finding#9）；
 *   2. **唯一**：一个 fqdn 只能绑一个作品（表上的 UNIQUE + 友好判重）；
 *   3. **数量**：每人最多 `MAX_DOMAINS_PER_USER` 个，且这条判定必须与写入在
 *      同一条 SQL 里（finding#29，并发可击穿"先 COUNT 再 INSERT"）。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { rootDomainFor, zoneIdForFqdn } from "../root-domains"
import { RESERVED_NAMES } from "../reserved-names"
import {
  cfCreateDnsRecord,
  cfListDnsRecords,
  cfDeleteDnsRecord,
  isCoveredByWildcard,
} from "../cloudflare"
import { createWorkerRoute, removeWorkerRoute } from "./storage"
import { readFiles, type LabProjectRow } from "./lab"
import { buildSdk } from "./lab-store"
import { pickEntry } from "../lab-preview"
import { assertFqdnOwned } from "../ownership"
import type { Env } from "../env"
import { canUseRootDomain } from "../root-domains"
import { userPermissions } from "../permissions"

/** 每个用户最多绑几个域名（跟直链网盘一个量级，别让人拿来刷域名） */
const MAX_DOMAINS_PER_USER = 5

/** `lab_project_domains` 的一行（换绑回滚要把它**原样**放回去，所以取全字段） */
interface LabProjectDomainRow {
  id: string
  project_id: string
  user_id: string
  fqdn: string
  created_at: string
}

/** 归一化并校验域名：只收「本站根域名之下的子域名」 */
function cleanFqdn(raw: unknown): string {
  const fqdn = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : ""
  if (
    !fqdn ||
    fqdn.length > 253 ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(fqdn)
  ) {
    throw new ApiError(400, "域名格式不对，只要子域名部分（例如 blog.doulor.cn）", "INVALID_FQDN")
  }
  return fqdn
}

/** 按扩展名给 Content-Type（托管的是用户写的静态页，够用就行） */
function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    woff2: "font/woff2",
    txt: "text/plain; charset=utf-8",
  }
  return map[ext] ?? "text/plain; charset=utf-8"
}

/** 取作品（校验归属） */
async function loadOwnedProject(env: Env, projectId: string, userId: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM lab_projects WHERE id = ? AND user_id = ?"
  )
    .bind(projectId, userId)
    .first<LabProjectRow>()
  if (!row) throw new ApiError(404, "作品不存在", "NOT_FOUND")
  return row
}

/** 读某个作品当前绑的域名（没有就 null） */
export async function getBoundDomain(env: Env, projectId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT fqdn FROM lab_project_domains WHERE project_id = ? LIMIT 1"
  )
    .bind(projectId)
    .first<{ fqdn: string }>()
  return row?.fqdn ?? null
}

/**
 * GET /api/lab/projects/:id/domain —— 当前绑的域名（没绑回 null）。
 * 单独一个接口而不是塞进作品详情里：详情接口的返回结构很多地方在用，
 * 为了一个字段去动它不划算。
 */
export async function getProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  await loadOwnedProject(env, projectId, user.id)
  return json({ fqdn: await getBoundDomain(env, projectId) })
}

/**
 * PUT /api/lab/projects/:id/domain —— body: { fqdn }
 * 绑定（或改绑）域名。
 */
export async function setProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => null)) as { fqdn?: unknown } | null
  // 先按格式挡掉（与改造前同序：格式错误不必先查库）
  const fqdn = cleanFqdn(body?.fqdn)
  const project = await loadOwnedProject(env, projectId, user.id)
  return json({ fqdn: await bindProjectDomain(env, project, fqdn, user) })
}

/**
 * 绑定 / 改绑域名的**核心**（作者侧与管理端共用）。
 *
 * 调用方必须先确认「有权改这个作品」：作者侧 `loadOwnedProject`，
 * 管理端 `requireAdminScope(env, request, "lab")`。
 *
 * ⚠️ 下面所有校验都是按**作品的作者**（`owner`）算的，与「谁在点按钮」无关：
 *    · 归属校验 —— 域名必须真在作者名下，管理员代绑也不能挪到别人子域上；
 *    · 保留名 / 根域权益 —— 管理员代绑不该替作者绕过权益门禁；
 *    · 数量上限 —— 算在作者头上（`lab_project_domains.user_id`）。
 *    管理员能做的是「替作者操作」，不是「以管理员身份获得额外权力」。
 */
export async function bindProjectDomain(
  env: Env,
  project: LabProjectRow,
  rawFqdn: unknown,
  owner: { id: string; permissions?: string | null }
): Promise<string> {
  // 下面沿用 `user` / `projectId` 两个局部名（改造前就是这样），语义是「作品作者」与「作品 id」
  const user = owner
  const projectId = project.id
  const fqdn = cleanFqdn(rawFqdn)

  // 只有**公开**的作品才对外供；私密作品绑域名没有意义（也避免被当成绕过审核的后门）
  if (project.visibility !== "public") {
    throw new ApiError(400, "先把作品设为公开，才能绑定域名", "NOT_PUBLIC")
  }
  // 只允许本站根域名之下的子域名 —— 否则会去给别人家的域名建 DNS 记录
  const rootRow = await rootDomainFor(env, fqdn)
  if (!rootRow) {
    throw new ApiError(400, "只能绑定本站根域名下的子域名", "INVALID_FQDN")
  }

  // 🔴 保留名保护（2026-10-14 安全事件后补上）
  //
  // 这一段缺失的后果，真实发生过，不是理论推演：
  //
  //   · 普通用户（无 doulor 权益）能把作品绑到 **cloud.doulor.cn**；
  //   · 而 index.ts 的 hostedDirectLink 会在 API 路由**之前**接管「任何命中作品表的
  //     Host」，于是主应用整个 /api/* 面被替换成攻击者 HTML —— 可在主品牌域上钓鱼、
  //     收割会话；
  //   · 解绑时 removeWorkerRoute 会删掉 `<fqdn>/*`，**把主应用自己的 Worker 路由删掉**。
  //     2026-10-14 主站打不开的直接原因就是这条：cloud.doulor.cn/* 先被删、再被重建时
  //     指错了 Worker（指到 API Worker 而不是前端 Worker），首页因此永远返回 404。
  //
  // 保留名清单本来就在 reserved-names.ts 里（cloud / wb2api / panel 相关都在），
  // 注释里甚至写明「绑定会创建 <fqdn>/* 路由」——只是这个接口从来没调用它。
  const label = fqdn.split(".")[0]
  if (RESERVED_NAMES.has(label)) {
    throw new ApiError(403, "这个域名属于平台保留名，不能绑定作品", "RESERVED_HOSTNAME")
  }

  // 二级保留名也要挡：`x.panel.doulor.cn` 这种只判首标签是拦不住的。
  // 做法是逐段检查（不是只看第一个标签），成本一样。
  const segs = fqdn.split(".")
  for (let i = 0; i < segs.length - 2; i++) {
    if (RESERVED_NAMES.has(segs[i])) {
      throw new ApiError(403, "这个域名属于平台保留名，不能绑定作品", "RESERVED_HOSTNAME")
    }
  }

  // 🔴 权益门禁（补上 2026-10-14 事故的另一半）
  //
  // 上面只挡了保留名，但**非保留名**的 doulor.cn 子域仍然能被任何普通用户绑定 ——
  // 而绑上去之后，`hostedDirectLink` 会在 API 路由之前接管该 Host 的整个 /api/* 面。
  // 也就是说：攻击者绑 `evil.doulor.cn`，就得到一个「在运营方品牌域下、可执行同源
  // 脚本」的托管点（可做钓鱼，也可用作同站 CSRF 的跳板，见 finding#8/#13）。
  //
  // 同站其它入口（邮箱、子域申请）都是走这条门禁的，这里一直漏了：
  //   POST /api/subdomains、POST /api/mailbox → canUseRootDomain/pickRootDomain
  if (!canUseRootDomain(userPermissions(user), rootRow)) {
    throw new ApiError(403, "没有绑定该根域名下子域的权益", "ROOT_DOMAIN_NOT_PERMITTED")
  }

  // ── 当前绑定（换绑要释放旧 DNS；幂等重绑要认得出「没变」）───────────────
  //
  // 取**整行**而不只是 fqdn：下面「先预占、再打 Cloudflare」的顺序下，CF 失败时
  // 必须把旧行原样放回去（`restorePreemptedBinding`），只记 fqdn 是补不回来的。
  const prevRow = await env.DB.prepare(
    "SELECT id, project_id, user_id, fqdn, created_at FROM lab_project_domains WHERE project_id = ? LIMIT 1"
  )
    .bind(projectId)
    .first<LabProjectDomainRow>()
  const previous = prevRow?.fqdn ?? null

  // 幂等重绑：请求的 fqdn 与**当前绑定的那一个**完全一致 ⇒ 这次调用没有"新增"
  //
  // 这个分支要放开归属校验，理由是线上有存量行绑在自己没登记过的 host 上
  // （2026-10-16 核实：`starfall.tyu.me` 属于站长账号，但该账号的 subdomains 里
  //  从未有过这一行 ⇒ assertFqdnOwned 必然 403）。同 fqdn 重存不产生任何新权力
  //  （行本来就在、内容本来就在出），但用户"修一下解析/路由"的能力得以保留。
  // 换绑到任何**别的** host 仍然必须过归属校验。
  const unchanged = previous !== null && previous.toLowerCase() === fqdn

  // 🔴 归属校验（2026-10-16 渗透测试 finding#9：跨用户子域劫持 / Content Spoofing）
  //
  // 在此之前本函数只校验「根域已登记 + 不是保留名 + 有该根域权益 + 表内唯一 +
  // 目标主机名没有现成解析」，**从没问过"这个 fqdn 到底是不是你的"**。
  // 后果（线上真实数据已证实）：`teest` 把作品绑到了 `idortest01.tyu.me` ——
  // 那是 `idortest01` 名下的子域名。只要受害者还没建 AAAA 记录
  // （`/api/subdomains` 本身不建记录），`existing.length === 0` 就直接过
  // HOSTNAME_IN_USE 那关 ⇒ 建 AAAA 100:: + Route + 落库 ⇒ 整站被顶掉。
  //
  // assertFqdnOwned 的口径（`ownership.ts`，与 dns.ts 写记录时**同一把尺子**）：
  //   · 用户拥有 `blog.tyu.me` ⇒ `blog.tyu.me` 本身、以及 `x.blog.tyu.me` 都算他的；
  //   · 不含别人的一级子域（`alice.tyu.me`）⇒ 403 FORBIDDEN。
  // 放在 FQDN_TAKEN 之前：否则攻击者可以拿 409/403 的差别探测「别人的域名有没有被绑过」。
  if (!unchanged) {
    await assertFqdnOwned(env, user.id, fqdn)
  }

  // 域名全局唯一：被别人占了就报错，不静默抢
  // （只是快路径/友好报错；真正的唯一性由 fqdn 的 UNIQUE 约束兜底，见下面的 INSERT）
  const taken = await env.DB.prepare(
    "SELECT project_id FROM lab_project_domains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first<{ project_id: string }>()
  if (taken && taken.project_id !== projectId) {
    throw new ApiError(409, "这个域名已经绑给另一个作品了", "FQDN_TAKEN")
  }

  const newId = uuid()
  const now = new Date().toISOString()

  /**
   * 🔴 数量上限 + 落库：**一条事务，守卫写在 SQL 里**（2026-10-16 渗透测试 finding#29）
   *
   * 原实现是 `SELECT COUNT(*)` → 判 `>= 5` → 打两次 CF API → `DELETE` + `INSERT`。
   * 判定与写入之间隔着两次远程调用，既无事务也无守卫 ⇒ 并发请求可以**同时**通过
   * 那条判定。线上现场：账号 `idortest01` 名下 8 条 `race-N-probe.tyu.me`
   * （上限 5，8 并发全部成功）。
   *
   * 现在照抄 `handlers/subdomains.ts` 的原子额度写法（同一个思路还见
   * `quotas.ts` 的 `consumeQuotaForInvite`）：把额度判定塞进 INSERT 的 WHERE，
   * D1/SQLite 对同库的写是串行化的，并发再多也只有名额内的几条能插进去；
   * `meta.changes === 0` 就是"没插进去"（超限），据此给业务错误而不是 500。
   *
   * ⚠️ 为什么是「先插后删」而不是「先删后插」：
   *   1. 先删的话，删完到插入之间有一个窗口 —— 此时这个项目**名下无域名**，
   *      并发的另一个请求会看到"空出来的名额"并把它占走，于是本次 INSERT
   *      撞上上限 ⇒ 用户从「有 1 个域名」变成「0 个」，正常换绑被搞坏。
   *   2. 先插的话，INSERT 失败（超限 / 唯一冲突）时旧行**原封不动**，
   *      失败的换绑退化成"什么都没发生"，而不是"把原来的弄丢了"。
   *   3. 两条语句必须同一个事务：`DB.batch` 是一次 SQL 事务（与
   *      `points-shop.ts:1764` 的注释同一口径），所以不存在"插进去了没删掉旧的"
   *      或"删了旧的没插进新的"的中间态。
   *
   * ⚠️ DELETE 上的 `EXISTS` 守卫是故意的：超限时 INSERT 插 0 行，若 DELETE 照删，
   *    就把旧绑定删没了 —— 这正是上面第 2 点要防的事。EXISTS 让它只在
   *    「新行真的插进去了」时才执行（同一事务内看得见刚插入的行）。
   *
   * ⚠️ 额度用 COUNT(*) 而不是 COUNT(DISTINCT project_id)：语义与原实现一致
   *    （一行 = 一个已绑定的域名）。`project_id <> ?` 让换绑**不占新名额**。
   */
  if (!unchanged) {
    let inserted: boolean
    try {
      const [ins] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO lab_project_domains (id, project_id, user_id, fqdn, created_at)
           SELECT ?, ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM lab_project_domains
                    WHERE user_id = ? AND project_id <> ?) < ?`
        ).bind(newId, projectId, user.id, fqdn, now, user.id, projectId, MAX_DOMAINS_PER_USER),
        env.DB.prepare(
          `DELETE FROM lab_project_domains
            WHERE project_id = ? AND id <> ?
              AND EXISTS (SELECT 1 FROM lab_project_domains WHERE id = ?)`
        ).bind(projectId, newId, newId),
      ])
      inserted = (ins.meta?.changes ?? 0) > 0
    } catch (err) {
      // fqdn 是 UNIQUE：并发抢同一个域名时，两个请求都会过上面的友好判重，
      // 但只有一个能插进去 —— 另一个在这里撞约束，按业务错误返回而不是 500。
      if (/UNIQUE constraint failed/i.test(String(err))) {
        throw new ApiError(409, "这个域名已经绑给另一个作品了", "FQDN_TAKEN")
      }
      throw err
    }
    if (!inserted) {
      throw new ApiError(400, `最多绑定 ${MAX_DOMAINS_PER_USER} 个域名`, "TOO_MANY_DOMAINS")
    }
  }

  // 1) DNS 记录：AAAA 100:: + 开代理（与直链网盘同一口径）
  //    zone 按 fqdn 解析，不能写死 —— 记录可能属于 tyu.me 而不是 doulor.cn
  //
  // ⚠️ 顺序：DB 预占已经成功，这里才开始动 Cloudflare。CF 侧任何一步失败都要
  //    **回滚预占**（`restorePreemptedBinding`），否则用户会拿到一个"库里绑了、
  //    实际解析不出来"的域名，而且旧绑定已经被同一条事务里的 DELETE 删掉了。
  //    这也是「先预占再动 CF」的代价，必须成对写。
  let dnsCreated = false
  try {
    const zoneId = await zoneIdForFqdn(env, fqdn)
    const existing = await cfListDnsRecords(env, zoneId, fqdn)

    // 已经有解析记录 ≠ 允许接管。只有「我们自己为作品域名建的那种记录」
    // （AAAA 100:: + 开代理，见下面 cfCreateDnsRecord）才可复用；
    // 其余情况说明这个主机名**正在承载别的服务**（主站、网关、别人的站点……），
    // 一旦接管就等于把它整站顶掉 —— 必须拒绝，而不是"跳过建记录继续绑"。
    //
    // 🔴 归属校验加上之后，这条**仍然必须留**（两者防的不是同一件事）：
    //    · assertFqdnOwned 回答「这个域名是不是你的」；
    //    · HOSTNAME_IN_USE 回答「这个域名是不是已经在干别的活」——
    //      它可以是**用户自己的** host：`cloud.xxx.tyu.me` 那种自己给自己建的
    //      网关/邮箱网页、管理员手工加过的 A/AAAA、平台在某 host 上配的路由。
    //      这类主机名一旦被作品接管，被顶掉的是用户自己/平台正在跑的服务，
    //      归属校验一点都拦不住（它本来就属于这个用户）。
    //    另外它也覆盖「同一个 fqdn 的旧作品行已被清掉但解析记录还在」这种
    //    历史遗留状态：那种记录是我们签名的（100::）⇒ 放行并复用，不重复建。
    if (existing.length) {
      // 只认内容：cfListDnsRecords 的类型只暴露 {id,type,content}，拿不到 proxied 标志；
      // 而 100:: 正是本接口为作品域名写的那种占位地址（见下面 cfCreateDnsRecord）。
      const ours = existing.some(
        (r) => r.type === "AAAA" && String(r.content || "").startsWith("100::")
      )
      if (!ours) {
        throw new ApiError(409, "这个域名已经在承载其他服务，不能绑定作品", "HOSTNAME_IN_USE")
      }
    }

    // 该根域已配 `*.<根域>` 泛解析时**不建记录** —— 泛解析已经能把它解析到
    // Cloudflare，再建一条只会白占配额（配额耗尽的后果见 isCoveredByWildcard 注释）。
    const wildcardCovered = await isCoveredByWildcard(env, fqdn)
    if (!existing.length && !wildcardCovered) {
      try {
        await cfCreateDnsRecord(env, zoneId, {
          type: "AAAA",
          name: fqdn,
          content: "100::",
          ttl: 1,
          proxied: true,
        })
        dnsCreated = true
      } catch (err) {
        console.error("作品域名 DNS 记录创建失败:", fqdn, err)
        throw new ApiError(502, "无法为该域名创建解析记录，请稍后再试", "CF_ERROR")
      }
    }

    // 2) Worker 路由
    await createWorkerRoute(env, fqdn)
  } catch (err) {
    // 回滚：把预占的绑定行退回换绑前的样子，并清掉**这一次**新建的解析记录
    //（只清我们刚建的：上面 `!existing.length` 已保证这条是本请求创建的）。
    if (!unchanged) {
      await restorePreemptedBinding(env, newId, prevRow)
    }
    if (dnsCreated) {
      await releaseLabDnsRecord(env, fqdn)
    }
    throw err
  }

  // 3) 换绑：释放旧域名占用的解析记录
  //
  // ⚠️ 必须放在**落库成功之后**（原来在 DELETE/INSERT 之前）：
  //    先释放、再发现插入失败的话，旧绑定行还在、它的解析记录却已经被删掉，
  //    用户的域名当场就解析不了了。
  //
  // ⚠️ 换绑时必须**释放旧域名占的解析记录**，否则记录只增不减，
  //    最终撞上 Cloudflare 的记录数上限（81045），届时所有用户都绑不了新域名。
  //    这是 2026-10-15 那次事故的根因，别把它改回去。
  if (previous && previous.toLowerCase() !== fqdn.toLowerCase()) {
    await releaseLabDnsRecord(env, previous)
  }

  return fqdn
}

/**
 * 把「已经预占的绑定行」退回换绑前的样子（Cloudflare 侧失败时用）。
 *
 * 语义：
 *   · 删掉本次插入的新行；
 *   · 若换绑前有旧行，按**原 id / 原 created_at** 放回去（不新建一个"看起来像"的行）。
 *
 * 两条语句放在同一个 `DB.batch`（事务）里：只有"删新 + 还原旧"一起生效，
 * 才不会出现「新的删了、旧的也没回来」—— 那等于用户的绑定凭空消失。
 *
 * 失败只记日志不往上抛：调用点正在处理 CF 的原始错误，把它盖掉会更难排查。
 */
async function restorePreemptedBinding(
  env: Env,
  newId: string,
  prev: LabProjectDomainRow | null
): Promise<void> {
  const stmts = [env.DB.prepare("DELETE FROM lab_project_domains WHERE id = ?").bind(newId)]
  if (prev) {
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO lab_project_domains (id, project_id, user_id, fqdn, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(prev.id, prev.project_id, prev.user_id, prev.fqdn, prev.created_at)
    )
  }
  try {
    await env.DB.batch(stmts)
  } catch (err) {
    console.error("回滚作品域名绑定失败，请手工核对 lab_project_domains:", newId, err)
  }
}

/**
 * 释放某个作品域名占用的 DNS 记录。
 *
 * 🔴 为什么必须有（2026-10-15 生产事故）：
 *   在此之前，改绑与解绑**都不删 DNS 记录**（旧注释写着"删它要动 DNS，风险大于收益"）。
 *   于是每绑一次就**永久占用一条解析记录**，只增不减 —— 而 Cloudflare 免费套餐的
 *   zone 有**记录数硬上限**（约 200 条），撞上之后**任何**新记录都建不了，
 *   报错是 `81045 Record quota exceeded`。
 *
 *   实际后果：站长的 `deity` 想在 lab 里绑 `sandbox` 子域，界面提示"本地已保存，
 *   但 Cloudflare 拒绝了这次修改"，解析自然也就一直是失效的 —— 配额满了，
 *   记录根本没建出来。而占满配额的主要是安全测试那几天反复绑/解绑留下的孤儿记录。
 *
 * 安全性：只删**我们自己特征**的那一条（AAAA + `100::`，正是本接口下面创建的写法）。
 * 用户自己的域名下可能另有在用的解析，绝不能被我们顺手删掉。
 */
async function releaseLabDnsRecord(env: Env, fqdn: string): Promise<void> {
  try {
    const zoneId = await zoneIdForFqdn(env, fqdn)
    const records = await cfListDnsRecords(env, zoneId, fqdn)
    for (const r of records) {
      const ours = r.type === "AAAA" && String(r.content || "").startsWith("100::")
      if (!ours) continue
      await cfDeleteDnsRecord(env, zoneId, r.id)
    }
  } catch (err) {
    // 释放失败不阻断解绑：留一条遗留记录远好过让用户卡在"解绑失败"
    console.error("释放作品域名 DNS 记录失败（已解绑，忽略）:", fqdn, err)
  }
}

/**
 * 释放某个作品的域名绑定：DB 行 + Worker Route + DNS 记录。
 *
 * 解绑（`clearProjectDomain`）与删作品（`lab.ts` 的 `deleteProjectCascade`）
 * 共用这一份 —— 删作品时若只删 `lab_project_domains` 行，Route 与 AAAA 记录
 * 会永久留在 Cloudflare 上，就是 2026-10-15 那次记录配额被占满（81045）的同款成因。
 *
 * 返回被释放的 fqdn（本来没绑就是 null）。所有 CF 操作都是尽力而为：
 * 失败只记日志，不阻断「解绑 / 删除」这件用户可见的事。
 */
export async function releaseProjectDomain(
  env: Env,
  projectId: string
): Promise<string | null> {
  const bound = await getBoundDomain(env, projectId)
  if (!bound) return null
  await env.DB.prepare("DELETE FROM lab_project_domains WHERE project_id = ?")
    .bind(projectId)
    .run()
  // 路由删掉，DNS 记录也一并释放
  // （只删我们建的那种 AAAA 100::；用户自己域名下的解析不会被动到）
  try {
    await removeWorkerRoute(env, bound)
  } catch (err) {
    console.error("删除作品域名路由失败（已解绑，忽略）:", bound, err)
  }
  await releaseLabDnsRecord(env, bound)
  return bound
}

/** DELETE /api/lab/projects/:id/domain —— 解绑 */
export async function clearProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  await loadOwnedProject(env, projectId, user.id)
  await releaseProjectDomain(env, projectId)
  return json({ fqdn: null })
}

/* ------------------------------------------------------------------ */
/* 按域名出内容（由 index.ts 的分发器调用）                            */
/* ------------------------------------------------------------------ */

/** 这个 Host 有没有绑作品 */
export async function isHostedLabHost(env: Env, host: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM lab_project_domains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(host)
    .first()
  return Boolean(row)
}

/**
 * 把作品内容按请求路径吐出去。
 * 请求 `/`（或空）取 `index.html`；多文件作品按路径取对应文件。
 */
export async function serveHostedLab(
  env: Env,
  request: Request,
  host: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT p.* FROM lab_project_domains d
       JOIN lab_projects p ON p.id = d.project_id
      WHERE d.fqdn = ? COLLATE NOCASE LIMIT 1`
  )
    .bind(host)
    .first<LabProjectRow>()

  // ⚠️ 取消公开 / 重新设为私密后，域名要**立刻**失效 ——
  //    否则「先公开骗过审核、再改回私密」就成了绕过审核的通道。
  if (!row || row.visibility !== "public") {
    return new Response("Not Found", { status: 404 })
  }

  const files = await readFiles(env, row)

  /**
   * 入口解析统一走 `pickEntry()`（index.html → 任意 .html → 第一个文件）。
   *
   * 2026-10-20 修：原来这里死取 `index.html`，入口叫 main.html 的作品绑了域名后
   * 打开首页直接 404 —— 而同一个作品在编辑器里预览却正常（预览用的 pickEntry）。
   * 两套解析逻辑不一致，用户看到的是「预览好好的，绑域名就白屏」。
   */
  const entryPath = pickEntry(files)
  if (!entryPath) {
    return new Response("Not Found", { status: 404 })
  }
  const raw = new URL(request.url).pathname.replace(/^\/+/, "")
  // 请求 `/`（或空）走入口；其它路径精确匹配，不中则回落入口（SPA 友好）。
  // 注意用 `!== undefined` 判断存在性——空文件也是合法文件。
  const path = raw && files[raw] !== undefined ? raw : entryPath
  const content = files[path]
  if (!content) {
    return new Response("Not Found", { status: 404 })
  }

  /**
   * 往 HTML 里注入作品存储的 SDK（`window.LabStore`）。
   * 只注入 HTML —— 其它文件（css/js/图片）不需要。
   * 注入在这里而不是发布时：作品内容随时会改，发布时插一次会在下次保存后丢失。
   */
  let body = content
  if (path.toLowerCase().endsWith(".html")) {
    const sdk = buildSdk(row.id, `https://cloud.${env.ROOT_DOMAIN}`)
    body = body.includes("</body>")
      ? body.replace(/<\/body>/i, `${sdk}\n</body>`)
      : body + sdk
  }

  // ---------------------------------------------------------------- 安全响应头
  //
  // 🔴 少这三个头会出事，而且出的是大事（2026-10-14 安全审计，findings #3/#4/#10）：
  //
  //   · 用户作品是**完全可控内容**，却以同源方式交付。没有 CSP 时，作品页里的内联脚本
  //     就能注册 scope 落在本域下的 Service Worker —— 而 SW **一旦装上就无法被服务端撤销**
  //     （脚本后来 404 也不会注销既有注册，这是 SW 规范的预期行为）。
  //     受害者浏览器因此被长期劫持，运营方恢复服务端也无济于事。
  //   · 同样因为同源，作品脚本能读同源 Cookie/存储、调用带凭据的同源 API。
  //
  // `sandbox` **不带 allow-same-origin** ⇒ 页面落到不透明源（opaque origin）：
  //   脚本照常运行、表单/弹窗照常，但拿不到同源权限 —— SW 注册被拒、Cookie/存储读不到、
  //   带凭据的同源请求失效。这条链路就此切断，而普通静态作品（HTML/CSS/JS/图片）不受影响。
  //
  // 口径与 handlers/lab.ts 的相册原始文件一致（那里早就加了 sandbox），不要只改一边。
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(path),
    // 用户随时会改作品，别让边缘缓存把旧版本留太久
    "Cache-Control": "public, max-age=60",
    // 防「非 HTML 却拿回 text/html」之类的嗅探（本站已在多处踩过这个坑）
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "sandbox allow-scripts allow-modals allow-forms allow-popups allow-downloads allow-pointer-lock",
  }

  return new Response(body, { headers })
}
