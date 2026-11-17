import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"

import {
  FEATURE_DEFS,
  FEATURE_GROUPS,
  featureForJob,
  featureForPublicPath,
  featureForRoute,
  featureById,
  type FeatureJobKey,
  type PublicPathKey,
} from "../src/features"
import { SETTING_DEFAULTS } from "../src/settings"
import { invalidateFeatureStates } from "../src/features"
import { authRequest, fetchSelf, makeUser, setSetting } from "./helpers"

/**
 * 功能开关注册表的不变量。
 *
 * 这一层不碰 D1：注册表是纯数据 + 纯函数，最容易出错的地方是
 * 「两个功能抢同一段路由前缀」「设置键没进 SETTING_DEFAULTS（于是写不进去）」
 * —— 这两种错都会表现成「管理员点了开关，但功能没关」，而且**不会报错**。
 */
describe("feature registry invariants", () => {
  it("id 唯一", () => {
    const ids = FEATURE_DEFS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("每个 settingKey 都在 SETTING_DEFAULTS 里（否则 updateSettings 会把它过滤掉）", () => {
    for (const f of FEATURE_DEFS) {
      expect(SETTING_DEFAULTS, `${f.id} 的 ${f.settingKey}`).toHaveProperty(f.settingKey)
    }
  })

  it("每个功能的分组都合法", () => {
    const groups = new Set(FEATURE_GROUPS.map((g) => g.key))
    for (const f of FEATURE_DEFS) expect(groups.has(f.group)).toBe(true)
  })

  it("同一段路由前缀不能被两个功能同时声明", () => {
    // 注意：**允许**前缀包含（/mail 与 /mail/accounts）。那是刻意的：
    // 最长前缀优先，所以 /mail/accounts 归「第三方邮箱同步」、其余 /mail/* 归邮箱中心。
    // 这里只拦「完全相同的字符串被两个功能抢」——那才会让归属取决于声明顺序。
    const seen = new Map<string, string>()
    for (const f of FEATURE_DEFS) {
      for (const r of f.routes) {
        const key = r.toLowerCase()
        expect(seen.has(key), `${key} 被 ${seen.get(key)} 与 ${f.id} 同时声明`).toBe(false)
        seen.set(key, f.id)
      }
    }
  })

  it("嵌套前缀（如 /mail 与 /mail/accounts）按最长者归属", () => {
    // 这条是给「以后有人加了更长的子前缀」兜底：只要最长前缀真的生效，就不会错配。
    for (const f of FEATURE_DEFS) {
      for (const r of f.routes) {
        expect(featureForRoute(r.toLowerCase())?.id, r).toBe(f.id)
        expect(featureForRoute(r.toLowerCase() + "/child")?.id, r + "/child").toBe(f.id)
      }
    }
  })

  it("后台任务键与公开资源键各自只归属一个功能", () => {
    const jobs = new Map<string, string>()
    const paths = new Map<string, string>()
    for (const f of FEATURE_DEFS) {
      for (const j of f.jobs ?? []) {
        expect(jobs.has(j), `job ${j} 被 ${jobs.get(j)} 与 ${f.id} 同时声明`).toBe(false)
        jobs.set(j, f.id)
      }
      for (const p of f.publicPaths ?? []) {
        expect(paths.has(p), `publicPath ${p} 被重复声明`).toBe(false)
        paths.set(p, f.id)
      }
    }
  })

  it("每个 id 都能按 id 反查回来", () => {
    for (const f of FEATURE_DEFS) expect(featureById(f.id)?.id).toBe(f.id)
    expect(featureById("nope")).toBeNull()
  })
})

describe("featureForRoute：最长前缀 + 底座路径永不拦", () => {
  const cases: [string, string | null][] = [
    ["/mailbox/latest-unread", "mail"],
    ["/mail/img", "mail"],
    ["/mail/accounts", "externalMailSync"],
    ["/mail/oauth/start", "externalMailSync"],
    ["/chat/messages", "chat"],
    ["/dm/unread", "dm"],
    ["/collection/invest/state", "game"],
    ["/gallery", "gallery"],
    ["/lab/chat", "lab"],
    ["/storage/objects", "storage"],
    ["/subdomains", "domains"],
    ["/dns/rental/purchase", "dns"],
    ["/dev/status", "ai"],
    ["/relay/providers", "ai"],
    ["/wb2api/status", "wb2api"],
    ["/qoder2api/status", "qoder2api"],
    ["/proxy", "proxy"],
    ["/frp/rental/mine", "frp"],
    ["/community/posts", "community"],
    ["/profile/publish", "profile"],
    ["/my-space", "space"],
    ["/stickers", "stickers"],
    ["/feedback", "feedback"],
    ["/fun-links", "funLinks"],
    ["/points/products", "points"],
    ["/vouchers/redeem", "points"],
    ["/checkin", "checkin"],
    ["/achievements", "achievements"],
    ["/leaderboard", "leaderboard"],
    ["/titles/mine", "titles"],
    ["/events", "events"],
    ["/donations", "donations"],
    ["/tip-qr", "donations"],
    ["/announcements", "announcements"],
    ["/oauth/token", "oauthProvider"],
    ["/v1/mail/send", "publicApi"],
    ["/api-key", "publicApi"],
    ["/push/subscribe", "push"],
    ["/qq/webhook", "qq"],
    ["/analytics/track", "analytics"],
    ["/perf/collect", "perf"],
    ["/diag-logs", "diagLog"],
    // 账户底座：任何功能开关都不能拦这些，否则关掉功能后用户连「打开/关闭」都做不了
    ["/admin/settings", null],
    ["/admin/features", null],
    ["/me", null],
    ["/settings/avatar", null],
    ["/login", null],
    ["/logout", null],
    ["/register", null],
    ["/appeal", null],
    ["/attention", null],
    ["/notifications", null],
    ["/notice/pending", null],
    ["/features", null],
    // 前缀必须按「段」对齐：/mailx 不该命中 /mail
    ["/mailx", null],
    ["/proxying", null],
  ]

  for (const [path, want] of cases) {
    it(`${path} → ${want ?? "不拦"}`, () => {
      expect(featureForRoute(path)?.id ?? null).toBe(want)
    })
  }
})

describe("featureForJob / featureForPublicPath", () => {
  it("后台任务能反查到功能（它们决定 cron 是否跳过）", () => {
    const expected: Partial<Record<FeatureJobKey, string>> = {
      mailSync: "externalMailSync",
      trashPurge: "mail",
      gameTick: "game",
      frpProbe: "frp",
      frpReconcile: "frp",
      frpAutoRenew: "frp",
      dnsAutoRenew: "dns",
      pointsAutoConfirm: "points",
      eventClaims: "events",
      eventQuotaRetry: "events",
      eventTgRevoke: "events",
      donationHealth: "donations",
      newapiSync: "ai",
      wb2Resume: "wb2api",
      qoderResume: "qoder2api",
      tgDigest: "telegram",
    }
    for (const [job, id] of Object.entries(expected)) {
      expect(featureForJob(job as FeatureJobKey)?.id, job).toBe(id)
    }
  })

  it("公开资源能反查到功能（它们决定 /dl /s /p /c 是否还对外）", () => {
    const expected: Partial<Record<PublicPathKey, string>> = {
      directLink: "storage",
      storageShare: "storage",
      hostedLink: "storage",
      hostedLab: "lab",
      avatar: "profile",
      profileAsset: "profile",
      profilePage: "profile",
      communityImage: "community",
      tgWebhook: "telegram",
      mailImage: "mail",
    }
    for (const [key, id] of Object.entries(expected)) {
      expect(featureForPublicPath(key as PublicPathKey)?.id, key).toBe(id)
    }
  })
})


/**
 * 端到端：开关真的会拦 HTTP（而不只是「注册表里看着有」）。
 *
 * 这一组用例存在的理由：历史上本站多个 *_enabled 开关**只在前端隐藏入口**，
 * 后端照常放行 —— 于是「关了功能额度照烧」。这里用 SELF.fetch 走完整路由，
 * 证明拦截发生在 index.ts 的 route() 守卫上。
 */
describe("功能开关的 HTTP 拦截（端到端）", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM app_settings WHERE key IN ('leaderboard_enabled')").run()
    invalidateFeatureStates()
  })

  it("关掉排行榜后 /api/leaderboard 返回 403 FEATURE_DISABLED", async () => {
    const u = await makeUser()
    await setSetting("leaderboard_enabled", "0")
    invalidateFeatureStates()

    const res = await fetchSelf(authRequest(u, "/api/leaderboard"))
    expect(res.status).toBe(403)
    const body = await res.json<{ code: string; feature: string }>()
    expect(body.code).toBe("FEATURE_DISABLED")
    expect(body.feature).toBe("leaderboard")
  })

  it("重新打开后同一个接口恢复（不再 403）", async () => {
    const u = await makeUser()
    await setSetting("leaderboard_enabled", "0")
    invalidateFeatureStates()
    expect((await fetchSelf(authRequest(u, "/api/leaderboard"))).status).toBe(403)

    await setSetting("leaderboard_enabled", "1")
    invalidateFeatureStates()
    const res = await fetchSelf(authRequest(u, "/api/leaderboard"))
    expect(res.status).not.toBe(403)
  })

  it("账户底座永远不被拦：/api/me 与 /api/settings/email 在若干开关关闭时仍可用", async () => {
    // ⚠️ 只关**少数**几个键：测试文件并行共享同一个 D1，把全部键写成 0 会污染
    // 其它用例（例如 perf/diag 的采集端点在 10 秒缓存过期后突然 403）。
    const u = await makeUser()
    for (const key of ["leaderboard_enabled", "chat_enabled", "mail_enabled", "storage_enabled"]) {
      await setSetting(key, "0")
    }
    invalidateFeatureStates()
    expect((await fetchSelf(authRequest(u, "/api/me"))).status).toBe(200)
    expect((await fetchSelf(authRequest(u, "/api/settings/email"))).status).toBe(200)
    // 管理接口同样不被功能开关拦（root 才能进，但至少不是 FEATURE_DISABLED）
    const root = await makeUser({ role: "root" })
    const adminRes = await fetchSelf(authRequest(root, "/api/admin/features"))
    expect(adminRes.status).toBe(200)
    for (const key of ["leaderboard_enabled", "chat_enabled", "mail_enabled", "storage_enabled"]) {
      await setSetting(key, "1")
    }
    invalidateFeatureStates()
  })
})

describe("管理端 /admin/features（端到端）", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM app_settings WHERE key IN ('leaderboard_enabled')").run()
    invalidateFeatureStates()
  })

  it("root 能读、能批量关、能再开；写库落到 settings", async () => {
    const root = await makeUser({ role: "root" })

    const list = await fetchSelf(authRequest(root, "/api/admin/features"))
    expect(list.status).toBe(200)
    const listed = await list.json<{ groups: unknown[]; features: { id: string; enabled: boolean }[] }>()
    expect(listed.groups.length).toBeGreaterThan(0)
    expect(listed.features.some((f) => f.id === "leaderboard" && f.enabled)).toBe(true)

    const off = await fetchSelf(
      authRequest(root, "/api/admin/features", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: { leaderboard: false }, note: "test" }),
      })
    )
    expect(off.status).toBe(200)
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'leaderboard_enabled'").first<{ value: string }>()
    expect(row?.value).toBe("0")

    // 普通用户此时被拦
    const u = await makeUser()
    expect((await fetchSelf(authRequest(u, "/api/leaderboard"))).status).toBe(403)

    const on = await fetchSelf(
      authRequest(root, "/api/admin/features", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: { leaderboard: true } }),
      })
    )
    expect(on.status).toBe(200)
    expect((await fetchSelf(authRequest(u, "/api/leaderboard"))).status).not.toBe(403)
  })

  it("普通用户无权访问；未登记的功能 id 被拒", async () => {
    const u = await makeUser()
    expect((await fetchSelf(authRequest(u, "/api/admin/features"))).status).toBe(403)

    const root = await makeUser({ role: "root" })
    const bad = await fetchSelf(
      authRequest(root, "/api/admin/features", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: { not_a_feature: false } }),
      })
    )
    expect(bad.status).toBe(400)
    const body = await bad.json<{ code: string }>()
    expect(body.code).toBe("UNKNOWN_FEATURE")
  })

  it("公开 /api/features 返回状态表（前端据此隐藏入口）", async () => {
    await setSetting("leaderboard_enabled", "0")
    invalidateFeatureStates()
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/features"))
    expect(res.status).toBe(200)
    const body = await res.json<{ states: Record<string, boolean> }>()
    expect(body.states.leaderboard).toBe(false)
    expect(body.states.mail).not.toBe(false)
  })
})


describe("公开资源：关掉网盘/名片后入口也失效", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "DELETE FROM app_settings WHERE key IN ('storage_enabled','profile_enabled')"
    ).run()
    invalidateFeatureStates()
  })

  it("storage_enabled=0 → /dl 与 /s 返回 403 FEATURE_DISABLED", async () => {
    await setSetting("storage_enabled", "0")
    invalidateFeatureStates()
    for (const path of ["/dl/a/b.txt", "/s/token123"]) {
      const res = await fetchSelf(new Request("https://cloud.doulor.cn" + path))
      expect(res.status, path).toBe(403)
      const body = await res.json<{ code: string }>()
      expect(body.code).toBe("FEATURE_DISABLED")
    }
  })

  it("profile_enabled=0 → /profile 与 /p 返回 403 FEATURE_DISABLED", async () => {
    await setSetting("profile_enabled", "0")
    invalidateFeatureStates()
    for (const path of ["/profile/someone", "/p/someone/avatar", "/u/someone/avatar"]) {
      const res = await fetchSelf(new Request("https://cloud.doulor.cn" + path))
      expect(res.status, path).toBe(403)
      const body = await res.json<{ code: string }>()
      expect(body.code).toBe("FEATURE_DISABLED")
    }
  })
})
