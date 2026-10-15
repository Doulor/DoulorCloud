/**
 * 根域的「邮件路由」链路（2026-10-16）。
 *
 * 背景：管理端「根域与租用」页上，站长为某个根域点「开通邮件路由 / 指向本 Worker」，
 * 背后是 Cloudflare 的 Email Routing。这条链路原本有一个**假成功**：
 * 后端在「enable 与 dns 两条路都失败」时仍返回 `200 + ok:false`，而前端只 await
 * 响应、不看 `ok`，于是弹出「已开通 Email Routing」—— 而 CF 上一条记录都没建，
 * 那个域**收不到任何信**。假成功比报错难查得多：站长会以为问题出在别处。
 *
 * 所以本文件钉的是出事时才看得见的那几条线，而不是「happy path 能跑通」：
 *   1. **失败必须能被看出来**：enable-email 两条路都失败 ⇒ HTTP 非 2xx +
 *      `EMAIL_ROUTING_ENABLE_FAILED`（不能是 200）；set-catchall 失败 ⇒ 不写审计
 *      （审计在 PUT **之后**，这个顺序就是「没成功就别记成成功」）。
 *   2. **成功时的载荷契约**：catch-all 必须指向 `emailWorkerName(env)`
 *      （`EMAIL_WORKER_NAME` > `WORKER_NAME` > `doulor-mail-api`），且可重复调用 ——
 *      指错 Worker 与没开一样：信到了 Worker 门口没人接。
 *   3. **收信本身**（端到端）：上面两步只是把管道接通，真正决定「这封信进谁的
 *      收件箱 / 要不要退信」的是 `incomingEmail`。没建过的地址必须
 *      `setReject("收件人不存在")` —— 静默丢信会让发信人以为地址有效、继续发。
 *      子域地址（`x@mail.tyu.me`）是最容易漏的一种：它**确实**属于本站根域
 *      （`isOwnDomain` 按后缀匹配），但没人建过这个信箱。
 *
 * ⚠️ CF 侧全部打桩（`vi.stubGlobal("fetch")`）：真账号上的 Email Routing 是站长的
 * 生产配置，测试里一次都不能碰，也不该依赖网络。非 api.cloudflare.com 的出站请求
 * 一律直接抛错 —— 打桩期间出现别的网络调用，说明测试或代码写错了。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { ApiError } from "../src/http"
import { resetRootDomainCache } from "../src/root-domains"
import { rootDomainAction } from "../src/handlers/admin-root-domains"
import { incomingEmail } from "../src/email-delivery"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import type { Env } from "../src/env"

const ROOT = "mailrt.test"
const ZONE = "zone-mailrt.test"

// ---------------------------------------------------------------------------
// Cloudflare API 打桩（Email Routing 专用）
// ---------------------------------------------------------------------------

/** 假 CF 侧的 Email Routing 状态：本文件关心的全部状态就这几个字段 */
interface CfMailState {
  /** `/email/routing` 的 enabled（= 「这个域到底开没开通」） */
  enabled: boolean
  /** 现存 catch-all 规则；null = CF 上还没有 */
  catchAll: { enabled: boolean; actions: { type: string; value: string[] }[] } | null
  /** 两个开通接口各自返回的状态码（>=400 即失败） */
  enableStatus: number
  dnsStatus: number
  /** catch-all PUT 的状态码（>=400 即失败） */
  catchAllStatus: number
}

let state: CfMailState
let cfCalls: { method: string; path: string; body: unknown }[]

function cfJson(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function installCf() {
  state = {
    enabled: false,
    catchAll: null,
    enableStatus: 200,
    dnsStatus: 200,
    catchAllStatus: 200,
  }
  cfCalls = []

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const url = new URL(raw)
    if (url.hostname !== "api.cloudflare.com") {
      throw new Error(`测试中出现预期外的出站请求：${raw}`)
    }

    const method = (init?.method ?? "GET").toUpperCase()
    const path = url.pathname.replace(/^\/client\/v4/, "")
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    cfCalls.push({ method, path, body })

    // 「按名字找 zone」：本文件里根域都带 zone_id，用不到它；
    // 只有「zone 解析不到」那条用例会走到，且必须是空结果。
    if (method === "GET" && path === "/zones") {
      return cfJson([])
    }

    // 现状探测：Email Routing 开没开
    if (method === "GET" && path === `/zones/${ZONE}/email/routing`) {
      return cfJson({ enabled: state.enabled })
    }

    // catch-all 规则：GET 读现状、PUT 设规则
    if (path === `/zones/${ZONE}/email/routing/rules/catch_all`) {
      if (method === "GET") return cfJson(state.catchAll ?? { enabled: false, actions: [] })
      if (method === "PUT") {
        if (state.catchAllStatus >= 400) return cfJson(null, state.catchAllStatus)
        state.catchAll = body as CfMailState["catchAll"]
        return cfJson(state.catchAll)
      }
    }

    // 开通：新版 /enable 与旧版 /dns 两条路
    const enablePath = path.match(/^\/zones\/([^/]+)\/email\/routing\/(enable|dns)$/)
    if (enablePath && method === "POST") {
      const status = enablePath[2] === "enable" ? state.enableStatus : state.dnsStatus
      if (status >= 400) return cfJson(null, status)
      state.enabled = true
      return cfJson({ enabled: true })
    }

    return cfJson(null, 404)
  })
}

/** 打到 CF 的写请求路径（按调用顺序），用来断言「到底打了哪条路」 */
function cfPosts(): string[] {
  return cfCalls.filter((c) => c.method === "POST").map((c) => c.path)
}

/** 最后一次 catch-all PUT 的载荷 */
function lastCatchAllPut(): { actions: { type: string; value: string[] }[] } | undefined {
  const puts = cfCalls.filter(
    (c) => c.method === "PUT" && c.path === `/zones/${ZONE}/email/routing/rules/catch_all`
  )
  return puts.at(-1)?.body as { actions: { type: string; value: string[] }[] } | undefined
}

// ---------------------------------------------------------------------------
// 数据库种子与请求
// ---------------------------------------------------------------------------

let admin: TestUser

async function seedRoot(name: string, zoneId: string | null) {
  await env.DB.prepare(
    `INSERT INTO root_domains
       (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
     VALUES (?, ?, NULL, NULL, 0, 0, 1, ?)`
  )
    .bind(name, zoneId, new Date().toISOString())
    .run()
  resetRootDomainCache()
}

function actionReq(user: TestUser, payload: Record<string, unknown>): Request {
  return authRequest(user, "/api/admin/root-domains/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

/** 断言一定抛 ApiError，并把错误本体交回给用例（看 status / code / message） */
async function catchApiError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run()
  } catch (err) {
    expect(err, `期望抛 ApiError，实际抛了：${String(err)}`).toBeInstanceOf(ApiError)
    return err as ApiError
  }
  throw new Error("期望抛 ApiError，但请求成功了")
}

/**
 * 造一个「只改了某几个绑定」的 env，用来验 `emailWorkerName` 的优先级。
 *
 * ⚠️ 这里**必须**显式列出要用的绑定，不能写成 `Object.assign(Object.create(env), extra)`：
 * workerd 注入的 `env` 是一个会把赋值**写回真实绑定**的宿主对象（实测：
 * 在 `Object.create(env)` 出来的子对象上写 `EMAIL_WORKER_NAME`，`env.EMAIL_WORKER_NAME`
 * 立刻也跟着变了），于是「临时换一个 Worker 名」会污染同一个文件里后面所有用例 ——
 * 表现是随机的、看起来毫不相干的断言变红。
 */
function withEnv(extra: Record<string, unknown>): Env {
  return {
    DB: env.DB,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    ROOT_DOMAIN: env.ROOT_DOMAIN,
    ZONE_ID: env.ZONE_ID,
    ACCOUNT_ID: env.ACCOUNT_ID,
    ...extra,
  } as unknown as Env
}

/** 这个管理员写了多少条某动作的审计（按 user_id 限定，不受其它文件干扰） */
async function auditCount(action: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) c FROM audit_logs WHERE user_id = ? AND action = ?"
  )
    .bind(admin.id, action)
    .first<{ c: number }>()
  return row?.c ?? 0
}

beforeEach(async () => {
  installCf()
  await env.DB.prepare("DELETE FROM root_domains").run()
  resetRootDomainCache()
  admin = await makeUser({ role: "admin" })
  await seedRoot(ROOT, ZONE)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 1. enable-email：成功路径与两条路的关系
// ---------------------------------------------------------------------------

describe("enable-email —— 开通邮件路由", () => {
  it("成功：打 /email/routing/enable，响应里 emailRouting.enabled = true", async () => {
    const res = await rootDomainAction(env, actionReq(admin, { action: "enable-email", name: ROOT }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      attempts: string[]
      emailRouting: { enabled: boolean }
    }

    // 成功时 ok 仍然是 true（契约里保留了这个字段，只是它不再是失败的唯一信号）
    expect(body.ok).toBe(true)
    // 响应里的现状必须来自**重新探测**，不能只是「我调过了所以成功」
    expect(body.emailRouting.enabled).toBe(true)
    expect(state.enabled).toBe(true)

    // 新版接口一次成功，就不该再去碰旧版
    expect(cfPosts()).toEqual([`/zones/${ZONE}/email/routing/enable`])
    expect(body.attempts.join(" / ")).toContain("/email/routing/enable=ok")
  })

  it("回落：/enable 返回 4xx 时改打 /email/routing/dns（两条路都试过才算失败）", async () => {
    state.enableStatus = 404

    const res = await rootDomainAction(env, actionReq(admin, { action: "enable-email", name: ROOT }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { attempts: string[]; emailRouting: { enabled: boolean } }

    expect(body.emailRouting.enabled).toBe(true)
    // 两条路都真的打了，且顺序固定（enable 在前、dns 在后）
    expect(cfPosts()).toEqual([
      `/zones/${ZONE}/email/routing/enable`,
      `/zones/${ZONE}/email/routing/dns`,
    ])
    expect(body.attempts.join(" / ")).toContain("/email/routing/dns=ok")
  })

  it("两条路都失败 ⇒ HTTP 非 2xx + EMAIL_ROUTING_ENABLE_FAILED（钉住「假成功」的修法）", async () => {
    state.enableStatus = 403
    state.dnsStatus = 403

    // 走**真路由**而不是直接调 handler：这一条要证明的是「HTTP 状态码能反映失败」，
    // 而 HTTP 状态码是 index.ts 的错误处理拼出来的（handler 里抛的是 ApiError）。
    const res = await fetchSelf(actionReq(admin, { action: "enable-email", name: ROOT }))

    expect(res.status).not.toBe(200)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { code: string; error: string; ok: boolean }
    expect(body.code).toBe("EMAIL_ROUTING_ENABLE_FAILED")
    // 失败响应里也保留 ok:false —— 万一还有调用方在读这个字段，语义不变
    expect(body.ok).toBe(false)
    // 报错必须说清「是哪两条路都失败了」，否则站长只能看到一句无从下手的失败
    expect(body.error).toContain("/email/routing/enable")
    expect(body.error).toContain("/email/routing/dns")

    // CF 侧确实没开起来（不是「其实开好了只是接口报错」）
    expect(state.enabled).toBe(false)
  })

  it("两个接口都报错、但 Email Routing 其实已启用 ⇒ 按成功处理（幂等，不误报失败）", async () => {
    // 线上会出现「这个 zone 早就手工开好了，CF 对重复开通回 4xx」——
    // 此时唯一可信的依据是现状探测，只看 POST 成败会把「本来就配好了」报成错误。
    state.enabled = true
    state.enableStatus = 409
    state.dnsStatus = 409

    const res = await rootDomainAction(env, actionReq(admin, { action: "enable-email", name: ROOT }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; emailRouting: { enabled: boolean } }
    expect(body.ok).toBe(true)
    expect(body.emailRouting.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. set-catchall：载荷契约、幂等、失败不写审计
// ---------------------------------------------------------------------------

describe("set-catchall —— 把 catch-all 指向本 Worker", () => {
  it("载荷契约：actions[0].value[0] = emailWorkerName(env)，默认 doulor-mail-api", async () => {
    const res = await rootDomainAction(env, actionReq(admin, { action: "set-catchall", name: ROOT }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      worker: string
      emailRouting: { catchAllTarget: string | null; workerMatches: boolean }
    }

    // 默认值（wrangler.toml 里没有 EMAIL_WORKER_NAME / WORKER_NAME）
    expect(body.worker).toBe("doulor-mail-api")
    const put = lastCatchAllPut()
    expect(put).toMatchObject({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: ["doulor-mail-api"] }],
    })
    // 界面上的「收信已就绪」直接读 workerMatches，它必须与刚写下去的载荷一致
    expect(body.emailRouting.catchAllTarget).toBe("doulor-mail-api")
    expect(body.emailRouting.workerMatches).toBe(true)
  })

  it("优先级：EMAIL_WORKER_NAME > WORKER_NAME > doulor-mail-api", async () => {
    // 只有 WORKER_NAME ⇒ 用它
    await rootDomainAction(
      withEnv({ WORKER_NAME: "worker-name-only" }),
      actionReq(admin, { action: "set-catchall", name: ROOT })
    )
    expect(lastCatchAllPut()?.actions[0].value[0]).toBe("worker-name-only")

    // 两个都配了 ⇒ EMAIL_WORKER_NAME 胜出（它才是「邮件路由指向谁」的专用绑定）
    await rootDomainAction(
      withEnv({ WORKER_NAME: "worker-name-only", EMAIL_WORKER_NAME: "email-worker-name" }),
      actionReq(admin, { action: "set-catchall", name: ROOT })
    )
    expect(lastCatchAllPut()?.actions[0].value[0]).toBe("email-worker-name")
  })

  it("幂等：连打两次得到同一份载荷（重试不会把规则改成别的样子）", async () => {
    await rootDomainAction(env, actionReq(admin, { action: "set-catchall", name: ROOT }))
    const first = lastCatchAllPut()

    await rootDomainAction(env, actionReq(admin, { action: "set-catchall", name: ROOT }))
    const second = lastCatchAllPut()

    expect(second).toEqual(first)
    expect(second?.actions[0].value[0]).toBe("doulor-mail-api")
    // 两次都真的 PUT 了（幂等靠载荷相同，而不是靠「第二次跳过」）
    expect(
      cfCalls.filter(
        (c) => c.method === "PUT" && c.path === `/zones/${ZONE}/email/routing/rules/catch_all`
      )
    ).toHaveLength(2)
  })

  it("CF 502 ⇒ 抛错且**不写审计**（审计在 PUT 之后，没成功就不能记成成功）", async () => {
    // 先用一次成功建立基线：成功时**确实**有审计 —— 否则「没写审计」这条断言
    // 可能只是因为审计压根不工作（测了个空）。
    await rootDomainAction(env, actionReq(admin, { action: "set-catchall", name: ROOT }))
    expect(await auditCount("admin.rootdomain.setCatchAll")).toBe(1)

    state.catchAllStatus = 502
    const err = await catchApiError(() =>
      rootDomainAction(env, actionReq(admin, { action: "set-catchall", name: ROOT }))
    )
    expect(err.status).toBe(502)

    // 审计条数没变：失败的那次没有留下「已把 catch-all 指向 X」的记录
    expect(await auditCount("admin.rootdomain.setCatchAll")).toBe(1)
    // CF 上的规则也还是上一次成功那份，没被改坏
    expect(state.catchAll?.actions[0].value[0]).toBe("doulor-mail-api")
  })
})

// ---------------------------------------------------------------------------
// 3. 权限与前置条件
// ---------------------------------------------------------------------------

describe("权限与前置条件", () => {
  it("普通用户 403（不是 500、也不是 HTML 兜底），且不会去碰 Cloudflare", async () => {
    const user = await makeUser()
    const err = await catchApiError(() =>
      rootDomainAction(env, actionReq(user, { action: "enable-email", name: ROOT }))
    )
    expect(err.status).toBe(403)
    expect(err.code).toBe("FORBIDDEN")
    // 鉴权在碰 CF 之前：越权请求不该产生任何出站调用
    expect(cfCalls).toHaveLength(0)
  })

  it("zone 解析不到 ⇒ CF_ZONE_UNRESOLVED（不猜一个 zone 就往下写）", async () => {
    await env.DB.prepare("DELETE FROM root_domains WHERE name = ?").bind(ROOT).run()
    // 登记了根域，但 zone_id 为空、CF 也查不到（打桩的 /zones 返回空）
    await seedRoot(ROOT, null)

    for (const action of ["enable-email", "set-catchall"] as const) {
      const err = await catchApiError(() =>
        rootDomainAction(env, actionReq(admin, { action, name: ROOT }))
      )
      expect(err.status).toBe(502)
      expect(err.code).toBe("CF_ZONE_UNRESOLVED")
    }
    // 两个动作都没在 CF 上写任何东西
    expect(cfCalls.filter((c) => c.method !== "GET")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. 端到端收信：incomingEmail 的去处判定
// ---------------------------------------------------------------------------

describe("端到端收信：incomingEmail", () => {
  /** 构造一封最小可解析的 RFC822 邮件，并记下 setReject 的理由 */
  function makeMessage(to: string) {
    const lines = [
      "From: Sender <sender@example.com>",
      `To: ${to}`,
      "Subject: hello",
      `Message-ID: <mid-${crypto.randomUUID()}@example.com>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body text",
    ]
    const bytes = new TextEncoder().encode(lines.join("\r\n"))
    const rejected: string[] = []
    return {
      rejected,
      msg: {
        from: "sender@example.com",
        to,
        headers: new Headers({ subject: "hello" }),
        raw: new ReadableStream({
          start(c) {
            c.enqueue(bytes)
            c.close()
          },
        }),
        rawSize: bytes.byteLength,
        setReject(reason: string) {
          rejected.push(reason)
        },
        async forward() {},
        async reply() {
          return new Response(null)
        },
      },
    }
  }

  async function countMessages(address: string): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) c FROM messages m
         JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE b.address = ? COLLATE NOCASE`
    )
      .bind(address)
      .first<{ c: number }>()
    return row?.c ?? 0
  }

  /** 退信时**绝不能**留下孤儿行（没有对应信箱的 messages 行） */
  async function orphanMessages(): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) c FROM messages m LEFT JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.id IS NULL"
    ).first<{ c: number }>()
    return row?.c ?? 0
  }

  beforeEach(async () => {
    // 收信要认的根域：用 tyu.me（真实的多根域场景），
    // 这样「子域地址」那条用例才真的落在「属于本站根域、但信箱没建过」上。
    await seedRoot("tyu.me", null)
  })

  it("已建邮箱的地址：落库到该信箱（收件箱里能看到这封信）", async () => {
    const user = await makeUser()
    const address = `${user.username}@tyu.me`
    await env.DB.prepare(
      "INSERT INTO mailboxes (id, user_id, address, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), user.id, address, new Date().toISOString())
      .run()

    const box = makeMessage(address)
    await incomingEmail(box.msg as never, env)

    expect(box.rejected).toEqual([])
    expect(await countMessages(address)).toBe(1)
    const row = await env.DB.prepare(
      `SELECT m.subject, m.from_address FROM messages m
         JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE b.address = ? COLLATE NOCASE`
    )
      .bind(address)
      .first<{ subject: string; from_address: string }>()
    expect(row).toMatchObject({ subject: "hello", from_address: "Sender <sender@example.com>" })
  })

  it("没建过的地址（含子域地址）：setReject(收件人不存在)，不留任何行", async () => {
    // `nobody@mail.tyu.me` 是最容易漏的一种：它**确实**属于本站根域 tyu.me
    // （isOwnDomain 按后缀匹配），但没人建过 `nobody` 这个信箱。
    // 拒收（而不是静默丢弃）是刻意的：退信让写错地址的人立刻知道，静默丢信
    // 会让群发者以为地址有效、继续发 —— 见 email-delivery.ts 的注释。
    for (const address of ["nobody@tyu.me", "nobody@mail.tyu.me"]) {
      const box = makeMessage(address)
      await incomingEmail(box.msg as never, env)

      expect(box.rejected).toEqual(["收件人不存在"])
      expect(await countMessages(address)).toBe(0)
      // 也没被误当成「别人的域」拒（那说明 isOwnDomain 判断退化了）
      expect(box.rejected).not.toEqual(["收件人不是本站域名的邮箱"])
    }
    expect(await orphanMessages()).toBe(0)
  })
})
