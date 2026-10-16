/**
 * 中转站登记（2026-10-12）的接口边界 + 审核制（2026-10-16）。
 *
 * 守住的语义：
 *   · 令牌**永不回显**（响应里只能有 baseUrl，不能有 token 字段）；
 *   · 地址是**用户随手填的**，必须挡 SSRF（内网 / 本机 / 非 https）；
 *   · 登记前**先探测**：探测不通就不许落库（坏配置不进库）；
 *   · 只有登记人（或站长）能改 / 删；
 *   · 🔴 审核制：新登记是 pending 且**不可用**；批准后才可用；被拒（带理由）不可用；
 *     所有者**看得见**自己那台待审/被拒的站，但**用不了**（读上游一律 403）。
 *
 * ⚠️ 上游一律打桩：这里换掉 globalThis.fetch 只接管假中转站那一台主机
 *   （`relay-review.example.com`），其余请求原样放行 —— 与 profile-music.test.ts
 *   同一套做法。真连别人的站会让这个文件随时变红。
 */
import { afterEach, describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

async function createRelay(
  user: U,
  body: Record<string, unknown>
): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/relay/providers", json("POST", body)))
}

/* ------------------------------------------------------------ 上游打桩 */

/** 假中转站的站点地址（https + 非内网，能过 normalizeBaseUrl 的 SSRF 闸门） */
const FAKE_BASE = "https://relay-review.example.com"
const FAKE_ADMIN_TOKEN = "admin-token-1234567890"

let restores: Array<() => void> = []

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * 打桩一台**已经配好 OIDC 的 NewAPI**：登记时的探测（读用户资料）与 OIDC 检测
 * 都会走过这些接口；批准后读余额、模型也走它。
 */
function stubFakeNewApi(owner: U): void {
  const email = `${owner.username}@doulor.cn`
  const routes: Record<string, unknown> = {
    "/api/user/search": { data: [{ id: 7, username: owner.username, email, quota: 2500000 }] },
    "/api/status": { data: { quota_display_type: "CNY", quota_per_unit: 500000 } },
    "/api/subscription/admin/users/7/subscriptions": { data: [] },
    "/api/subscription/plans": { data: [] },
    // OIDC 指向本站 ⇒ 允许入驻（与真实检测同一条判据）
    "/api/option/": {
      data: [
        { key: "oidc.enabled", value: "true" },
        { key: "oidc.authorization_endpoint", value: "https://cloud.doulor.cn/oauth/authorize" },
        { key: "oidc.client_id", value: "doulor-cloud" },
      ],
    },
    "/api/models": { data: ["gpt-4o-mini"] },
  }
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    if (url.hostname === "relay-review.example.com") {
      const hit = routes[url.pathname]
      return jsonRes(hit ?? { success: true, data: null })
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

afterEach(() => {
  for (const r of restores) r()
  restores = []
})

/** 登记一台假站（打桩已就绪），返回它的 id */
async function registerFake(owner: U, name = "审核测试站"): Promise<string> {
  const res = await createRelay(owner, {
    name,
    kind: "newapi",
    baseUrl: FAKE_BASE,
    adminToken: FAKE_ADMIN_TOKEN,
  })
  expect(res.status, await res.clone().text()).toBe(200)
  const body = await res.json<{ provider: { id: string } }>()
  return body.provider.id
}

async function listOf(user: U): Promise<Record<string, unknown>[]> {
  const res = await fetchSelf(authRequest(user, "/api/relay/providers"))
  expect(res.status).toBe(200)
  const body = await res.json<{ providers: Record<string, unknown>[] }>()
  return body.providers
}

async function reviewAs(
  admin: U,
  id: string,
  action: "approve" | "reject",
  note?: string
): Promise<Response> {
  return fetchSelf(
    authRequest(
      admin,
      `/api/admin/relay-providers/${encodeURIComponent(id)}/review`,
      json("POST", note ? { action, note } : { action })
    )
  )
}

describe("中转站登记", () => {
  it("未登录 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/relay/providers"))
    expect(res.status).toBe(401)
  })

  it("列表默认空，且不含任何令牌字段", async () => {
    const user = await makeUser({})
    const res = await fetchSelf(authRequest(user, "/api/relay/providers"))
    expect(res.status).toBe(200)
    const body = await res.json<{ providers: Record<string, unknown>[]; maxPerUser: number }>()
    expect(Array.isArray(body.providers)).toBe(true)
    expect(body.maxPerUser).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toMatch(/token/i)
  })

  it("挡 SSRF：内网 / 本机 / 非 https 一律拒绝", async () => {
    const user = await makeUser({})
    const bad = [
      "http://example.com", // 明文 http（会泄露令牌）
      "https://127.0.0.1",
      "https://localhost:8080",
      "https://192.168.1.10",
      "https://169.254.169.254", // 云元数据地址
      "https://10.0.0.5",
      "https://cloud.doulor.cn", // 不给自己开环
      "not-a-url",
    ]
    for (const baseUrl of bad) {
      const res = await createRelay(user, {
        name: "测试站",
        kind: "newapi",
        baseUrl,
        adminToken: "admin-token-1234567890",
      })
      expect(res.status, `应拒绝 ${baseUrl}`).toBe(400)
    }
  })

  it("类型非法 / 令牌过短 / 名字含敏感词 都被拒", async () => {
    const user = await makeUser({})
    const base = { name: "测试站", baseUrl: "https://relay.example.com", adminToken: "admin-token-1234567890" }
    expect((await createRelay(user, { ...base, kind: "unknown" })).status).toBe(400)
    expect((await createRelay(user, { ...base, kind: "newapi", adminToken: "short" })).status).toBe(400)
    // 名字走与 OAuth 应用同一条校验（防冒充官方），空名字也该被拒
    expect((await createRelay(user, { ...base, kind: "newapi", name: "" })).status).toBe(400)
  })

  it("探测不通 ⇒ 不落库（坏配置进不了库）", async () => {
    const user = await makeUser({})
    const res = await createRelay(user, {
      name: "连不上的站",
      kind: "sub2api",
      // 这个域名必然连不上 ⇒ 探测失败 ⇒ 400
      baseUrl: "https://relay-probe-should-fail.invalid",
      adminToken: "admin-token-1234567890",
    })
    expect(res.status).toBe(400)
    const list = await fetchSelf(authRequest(user, "/api/relay/providers"))
    const body = await list.json<{ providers: unknown[] }>()
    expect(body.providers).toEqual([])
  })

  it("别人的站不能改 / 不能删", async () => {
    const owner = await makeUser({})
    const other = await makeUser({})
    // 直接插库造一条（跳过探测），只为验证归属校验
    await env.DB.prepare(
      `INSERT INTO relay_providers
         (id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, created_at, updated_at)
       VALUES ('rp_test_1', '朋友的站', 'newapi', 'https://relay.example.com', 'x', ?, 1, 100, ?, ?)`
    )
      .bind(owner.id, new Date().toISOString(), new Date().toISOString())
      .run()

    const put = await fetchSelf(
      authRequest(other, "/api/relay/providers/rp_test_1", json("PUT", { name: "改名" }))
    )
    expect(put.status).toBe(403)
    const del = await fetchSelf(
      authRequest(other, "/api/relay/providers/rp_test_1", { method: "DELETE" })
    )
    expect(del.status).toBe(403)

    // 登记人自己可以删
    const own = await fetchSelf(
      authRequest(owner, "/api/relay/providers/rp_test_1", { method: "DELETE" })
    )
    expect(own.status).toBe(200)
  })

  it("普通用户看不到管理端列表（403）", async () => {
    const user = await makeUser({})
    const res = await fetchSelf(authRequest(user, "/api/admin/relay-providers"))
    expect(res.status).toBe(403)
  })
})

/* ---------------------------------------------------------------- 审核制 */

describe("中转站审核制（2026-10-16）", () => {
  it("新入驻是 pending 且不可用：能看见自己的站、读不了任何上游数据", async () => {
    const owner = await makeUser({})
    const other = await makeUser({})
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "等审核的站")

    // 落库状态：审核列 pending，enabled 仍为 1（两把锁是分开的）
    const row = await env.DB.prepare(
      "SELECT review_status, enabled FROM relay_providers WHERE id = ?"
    )
      .bind(id)
      .first<{ review_status: string; enabled: number }>()
    expect(row?.review_status).toBe("pending")
    expect(row?.enabled).toBe(1)

    // 登记接口的响应就要如实说明「还不能用」
    const created = await fetchSelf(authRequest(owner, "/api/relay/providers"))
    const mine = (await created.json<{ providers: Record<string, unknown>[] }>()).providers.find(
      (p) => p.id === id
    )
    expect(mine?.reviewStatus).toBe("pending")
    expect(mine?.usable).toBe(false)
    expect(mine?.mine).toBe(true)

    // 所有者看得见（上面刚断言）—— 但**别人看不见**这台未审核的站
    expect((await listOf(other)).some((p) => p.id === id)).toBe(false)

    // 所有者自己也不能「用」它：/me、/keys、/models 一律 403 PENDING_REVIEW
    for (const suffix of ["me", "keys", "models"]) {
      const res = await fetchSelf(
        authRequest(owner, `/api/relay/providers/${encodeURIComponent(id)}/${suffix}`)
      )
      expect(res.status, `${suffix} 应当被审核闸拦住`).toBe(403)
      expect((await res.json<{ code: string }>()).code).toBe("PENDING_REVIEW")
    }
  })

  it("批准之后可用：别的用户也看得到，/me 真的读到余额", async () => {
    const owner = await makeUser({})
    const other = await makeUser({})
    const admin = await makeUser({ role: "admin" })
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "待批准的站")

    const res = await reviewAs(admin, id, "approve")
    expect(res.status).toBe(200)
    expect((await res.json<{ reviewStatus: string }>()).reviewStatus).toBe("approved")

    // 普通用户现在能在列表里看到它
    const seen = (await listOf(other)).find((p) => p.id === id)
    expect(seen?.usable).toBe(true)
    expect(seen?.reviewStatus).toBe("approved")

    // /me 通了（上游被打桩：¥2500000 / 500000 = ¥5.00）
    const me = await fetchSelf(authRequest(other, `/api/relay/providers/${encodeURIComponent(id)}/me`))
    expect(me.status).toBe(200)
    const view = (await me.json<{ view: { reachable: boolean; balance: number | null } }>()).view
    expect(view.reachable).toBe(true)
    expect(view.balance).toBeCloseTo(5)

    // /models 也放行（这条路径原先**没有**任何状态检查，是本次一并补上的漏洞）
    const models = await fetchSelf(
      authRequest(other, `/api/relay/providers/${encodeURIComponent(id)}/models`)
    )
    expect(models.status).toBe(200)
    expect((await models.json<{ models: string[] }>()).models).toEqual(["gpt-4o-mini"])
  })

  it("拒绝必须带理由，被拒后不可用、且理由能读到", async () => {
    const owner = await makeUser({})
    const admin = await makeUser({ role: "admin" })
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "会被拒的站")

    // 不写理由 ⇒ 400（否则用户不知道要改什么）
    const noReason = await reviewAs(admin, id, "reject")
    expect(noReason.status).toBe(400)
    expect((await noReason.json<{ code: string }>()).code).toBe("REASON_REQUIRED")

    const note = "管理员令牌权限不足，读不到用户列表"
    expect((await reviewAs(admin, id, "reject", note)).status).toBe(200)

    // 所有者侧：列表带状态与理由
    const mine = (await listOf(owner)).find((p) => p.id === id)
    expect(mine?.reviewStatus).toBe("rejected")
    expect(mine?.reviewNote).toBe(note)
    expect(mine?.usable).toBe(false)

    // 用不了，且错误消息把理由带回来（界面上直接就有话说）
    const me = await fetchSelf(authRequest(owner, `/api/relay/providers/${encodeURIComponent(id)}/me`))
    expect(me.status).toBe(403)
    const err = await me.json<{ code: string; error: string }>()
    expect(err.code).toBe("REVIEW_REJECTED")
    expect(err.error).toContain(note)

    // 改一改就能重新排队（否则被拒 = 死局，只能删掉重登记）
    const put = await fetchSelf(
      authRequest(owner, `/api/relay/providers/${encodeURIComponent(id)}`, json("PUT", { name: "改过名的站" }))
    )
    expect(put.status).toBe(200)
    const after = (await put.json<{ provider: Record<string, unknown> }>()).provider
    expect(after.reviewStatus).toBe("pending")
    expect(after.reviewNote).toBeNull()
  })

  it("批准后仍可临时停用：停用立刻读不到上游，恢复后又可以", async () => {
    const owner = await makeUser({})
    const other = await makeUser({})
    const admin = await makeUser({ role: "admin" })
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "会被停用的站")
    expect((await reviewAs(admin, id, "approve")).status).toBe(200)

    const meUrl = `/api/relay/providers/${encodeURIComponent(id)}/me`
    expect((await fetchSelf(authRequest(other, meUrl))).status).toBe(200)

    // 停用（审核态不动）⇒ 立刻不可用；连登记人自己也读不到（原先是 owner 例外）
    const off = await fetchSelf(
      authRequest(admin, `/api/admin/relay-providers/${encodeURIComponent(id)}/enabled`, json("POST", { enabled: false }))
    )
    expect(off.status).toBe(200)
    expect((await off.json<{ usable: boolean }>()).usable).toBe(false)
    expect((await fetchSelf(authRequest(other, meUrl))).status).toBe(403)
    const own = await fetchSelf(authRequest(owner, meUrl))
    expect(own.status).toBe(403)
    expect((await own.json<{ code: string }>()).code).toBe("DISABLED")

    // 恢复 ⇒ 又能用，且审核态仍是 approved（两把锁互不覆盖）
    const on = await fetchSelf(
      authRequest(admin, `/api/admin/relay-providers/${encodeURIComponent(id)}/enabled`, json("POST", { enabled: true }))
    )
    expect((await on.json<{ usable: boolean }>()).usable).toBe(true)
    expect((await fetchSelf(authRequest(other, meUrl))).status).toBe(200)
  })

  it("「恢复启用」一台未批准的站：接口明说它仍然不可用", async () => {
    const owner = await makeUser({})
    const admin = await makeUser({ role: "admin" })
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "未批准的站")

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/relay-providers/${encodeURIComponent(id)}/enabled`, json("POST", { enabled: true }))
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ enabled: boolean; usable: boolean }>()
    expect(body.enabled).toBe(true)
    // 两把锁只开了一把 ⇒ 管理端不能显示成「已生效」
    expect(body.usable).toBe(false)
  })

  it("普通用户不能批准 / 拒绝（403），管理端列表要求权限域", async () => {
    const owner = await makeUser({})
    const normal = await makeUser({})
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "谁都别想批的站")

    expect((await reviewAs(normal, id, "approve")).status).toBe(403)
    expect((await reviewAs(normal, id, "reject", "随便拒一下")).status).toBe(403)

    // 动作值非法也要挡住（不能靠拼字符串绕过审核语义）
    const admin = await makeUser({ role: "admin" })
    const bad = await fetchSelf(
      authRequest(admin, `/api/admin/relay-providers/${encodeURIComponent(id)}/review`, json("POST", { action: "delete" }))
    )
    expect(bad.status).toBe(400)
    expect((await bad.json<{ code: string }>()).code).toBe("INVALID_ACTION")

    // 管理端列表：普通用户 403、且**不含**令牌字段
    expect((await fetchSelf(authRequest(normal, "/api/admin/relay-providers"))).status).toBe(403)
    const adminList = await fetchSelf(authRequest(admin, "/api/admin/relay-providers"))
    expect(adminList.status).toBe(200)
    const text = await adminList.text()
    expect(text).not.toMatch(/token_enc|tokenEnc|adminToken/i)
    const list = JSON.parse(text) as { providers: Record<string, unknown>[] }
    const row = list.providers.find((p) => p.id === id)
    expect(row?.reviewStatus).toBe("pending")
    expect(row?.ownerUsername).toBe(owner.username)
    expect(typeof row?.sort).toBe("number")
    expect(row?.createdAt).toBeTruthy()
  })

  it("审核态认不出来的值按「待审核」处理（fail-closed）", async () => {
    const owner = await makeUser({})
    const now = new Date().toISOString()
    // 直接写库造一个「列被手工改坏」的行：不能因为认不出状态就放行
    await env.DB.prepare(
      `INSERT INTO relay_providers
         (id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, review_status, created_at, updated_at)
       VALUES ('rp_bad_status', '状态坏的站', 'newapi', 'https://relay-review.example.com', 'x', ?, 1, 100, 'weird', ?, ?)`
    )
      .bind(owner.id, now, now)
      .run()

    const res = await fetchSelf(
      authRequest(owner, "/api/relay/providers/rp_bad_status/me")
    )
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("PENDING_REVIEW")
  })
})

/* ------------------------------------------------- 免审入驻（2026-10-16 站长要求） */

/**
 * 「部分用户免审、入驻即批准」。
 *
 * 两类免审（判据见 handlers/relay-providers.ts 的 canSkipReview）：
 *   1. `isPrivileged()` —— **只认 root / superadmin**（worker/src/auth.ts）；
 *      普通 `admin`（自定义管理员）**不在内**，这一点在下面有一条专门的用例钉住。
 *   2. 持 `relay_auto` 权限位的用户 —— 管理员在成员详情里逐个勾选。
 * 两者都没有 ⇒ 仍然 pending（审核制原样不动）。
 */
describe("中转站免审入驻（2026-10-16）", () => {
  /** 直读库里那一行的审核痕迹 —— 免审的关键证据就在这里（不留 NULL） */
  async function reviewRow(id: string) {
    return env.DB.prepare(
      "SELECT review_status, reviewed_at, reviewed_by FROM relay_providers WHERE id = ?"
    )
      .bind(id)
      .first<{
        review_status: string
        reviewed_at: string | null
        reviewed_by: string | null
      }>()
  }

  // ⚠️ 分成两个 it（而不是一个 it 里循环两个角色）：stubFakeNewApi 每次调用都会往
  //    afterEach 的还原栈里压一条，同一个用例里压两条会让还原顺序反过来、
  //    把打桩后的 fetch 留到下一个用例（打桩泄漏）。一个用例只打一次桩最省心。
  // ⚠️ 站点名要避开 assertClientNameAllowed 的敏感词表（"admin" / "管理" / "官方"…），
  //    否则 400 卡在登记之前，测的就不是免审了。
  const roleNames = { superadmin: "免审站-超管", root: "免审站-站长" } as const
  for (const role of ["superadmin", "root"] as const) {
    it(`${role}（isPrivileged）登记即 approved：痕迹写全、立刻对所有人可用`, async () => {
      const owner = await makeUser({ role })
      stubFakeNewApi(owner)
      const id = await registerFake(owner, roleNames[role])

      const row = await reviewRow(id)
      expect(row?.review_status, `${role} 应当免审`).toBe("approved")
      // 「别留 NULL」是这次明确要求的：免审 ≠ 没有审核痕迹
      expect(row?.reviewed_at).toBeTruthy()
      expect(row?.reviewed_by).toBe(owner.id)

      // 免审 = 不用等人点那一下：别的用户现在就能看到它、并且真的读得到上游
      const other = await makeUser({})
      const seen = (await listOf(other)).find((p) => p.id === id)
      expect(seen?.usable).toBe(true)
      expect(seen?.reviewStatus).toBe("approved")
      const me = await fetchSelf(
        authRequest(other, `/api/relay/providers/${encodeURIComponent(id)}/me`)
      )
      expect(me.status).toBe(200)
    })
  }

  it("普通 admin（自定义管理员）**不在** isPrivileged 内 ⇒ 仍然要排队", async () => {
    // isPrivileged 的真实口径是 root / superadmin；admin 只是「被授权做事的人」，
    // 不因为顶着 admin 的头衔就自动免审（要免审得另外勾 relay_auto）。
    const owner = await makeUser({ role: "admin" })
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "免审站-普通角色")
    expect((await reviewRow(id))?.review_status).toBe("pending")
  })

  it("持 relay_auto 权限位的用户免审（reviewed_at 非空）；没有该权限位的仍 pending", async () => {
    // 打一次桩就够：NewAPI 探测在「只搜到一条」时会回落到那一条（见 relay-adapters.ts），
    // 因此同一个桩可以支撑多个不同用户的登记。
    const stubHost = await makeUser({})
    stubFakeNewApi(stubHost)

    // ---- 1) 被勾上 relay_auto：直接 approved，且审核痕迹写全 ----
    const trusted = await makeUser({})
    await setPermissions(
      trusted.id,
      JSON.stringify({ r2: true, ai: true, proxy: true, doulor: false, dns: false, relay_auto: true })
    )
    const id = await registerFake(trusted, "免审用户的站")
    const row = await reviewRow(id)
    expect(row?.review_status).toBe("approved")
    expect(row?.reviewed_at).toBeTruthy()
    expect(row?.reviewed_at).not.toBeNull()
    expect(row?.reviewed_by).toBe(trusted.id)

    // 别人也能立刻看到（免审的意义就在这里）
    const other = await makeUser({})
    expect((await listOf(other)).find((p) => p.id === id)?.usable).toBe(true)

    // ---- 2) 权限 JSON 为 NULL（绝大多数新用户）⇒ 仍 pending ----
    // 这一条是「新权限键**绝不能**进 DEFAULT_ALLOWED」的回归测试：
    // parsePermissions 对缺失的键按 allPermissions() 兜底，relay_auto 必须落在 false。
    const normal = await makeUser({})
    const normalId = await registerFake(normal, "普通用户的站")
    expect((await reviewRow(normalId))?.review_status).toBe("pending")

    // ---- 3) 显式写成 false（管理员取消勾选后的形态）⇒ 同样 pending ----
    const revoked = await makeUser({})
    await setPermissions(revoked.id, JSON.stringify({ relay_auto: false }))
    const revokedId = await registerFake(revoked, "被取消免审的站")
    expect((await reviewRow(revokedId))?.review_status).toBe("pending")
  })

  it("管理端勾选 relay_auto 能真的落库（PUT /admin/users/:username 往返不被过滤）", async () => {
    // 这条钉的是「管理端那个开关不是摆设」，也顺带钉住站长关心的那个坑：
    // 前端是把**整份 permissions 对象**回传的（admin.tsx 的 handleTogglePermission），
    // 后端必须原样认下这个新键 —— normalizePermissions 是按 FEATURES 迭代的，
    // 只要 FEATURES 里有 relay_auto 就不会被过滤掉。
    const admin = await makeUser({ role: "root" })
    const target = await makeUser()
    stubFakeNewApi(target)

    const put = await fetchSelf(
      authRequest(admin, `/api/admin/users/${encodeURIComponent(target.username)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          permissions: {
            r2: true,
            ai: false,
            proxy: false,
            doulor: false,
            dns: false,
            relay_auto: true,
          },
        }),
      })
    )
    expect(put.status, await put.clone().text()).toBe(200)

    const stored = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(target.id)
      .first<{ permissions: string | null }>()
    const parsed = JSON.parse(stored?.permissions ?? "null") as Record<string, boolean>
    expect(parsed.relay_auto).toBe(true)

    // 端到端：管理端勾上之后，这个人登记的中转站直接 approved
    const id = await registerFake(target, "勾选后登记的站")
    expect((await reviewRow(id))?.review_status).toBe("approved")
  })

  it("免审通过的站，管理员**仍然**能一键停用（事后兜底不动）", async () => {
    const owner = await makeUser({})
    await setPermissions(owner.id, JSON.stringify({ relay_auto: true }))
    stubFakeNewApi(owner)
    const id = await registerFake(owner, "免审但会被停用的站")
    expect((await reviewRow(id))?.review_status).toBe("approved")

    const admin = await makeUser({ role: "admin" })
    const meUrl = `/api/relay/providers/${encodeURIComponent(id)}/me`
    const other = await makeUser({})
    expect((await fetchSelf(authRequest(other, meUrl))).status).toBe(200)

    const off = await fetchSelf(
      authRequest(
        admin,
        `/api/admin/relay-providers/${encodeURIComponent(id)}/enabled`,
        json("POST", { enabled: false })
      )
    )
    expect(off.status).toBe(200)
    expect((await off.json<{ usable: boolean }>()).usable).toBe(false)

    // 审核态不动（两把锁互不覆盖），但已经不可用：连登记人自己也读不到
    expect((await reviewRow(id))?.review_status).toBe("approved")
    expect((await fetchSelf(authRequest(other, meUrl))).status).toBe(403)
    const own = await fetchSelf(authRequest(owner, meUrl))
    expect(own.status).toBe(403)
    expect((await own.json<{ code: string }>()).code).toBe("DISABLED")
  })
})
