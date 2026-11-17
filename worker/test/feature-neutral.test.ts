/**
 * 中立性（2026-11-17 站长要求）：
 *
 *   「如果我把所有的开关全部打开，功能上不会有任何的区别。」
 *
 * 这一组用例守的就是这句话 —— 开关只能「关掉东西」，**不能**在打开时改变任何行为：
 *   1. 全部打开时，守卫对任何已登记路由都不得返回 403 FEATURE_DISABLED；
 *   2. 读不到开关状态（D1 故障）时必须 fail-open（否则等于给全站加了一个单点故障）。
 *
 * ⚠️ 这个文件刻意独立：它必须在**本文件第一条请求之前**把开关全部置 1，
 * 这样 isolate 内的 10 秒状态缓存读到的就是「全开」，不会受其它用例污染。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"

import { FEATURE_DEFS, getFeatureStates, invalidateFeatureStates } from "../src/features"
import { authRequest, fetchSelf, makeUser, setSetting } from "./helpers"
import type { Env } from "../src/env"

/** 把全部功能开关置为 1（= 站长所说的「所有开关全部打开」） */
async function enableAll(): Promise<void> {
  for (const f of FEATURE_DEFS) await setSetting(f.settingKey, "1")
  invalidateFeatureStates()
}

beforeEach(async () => {
  await enableAll()
})

describe("fail-open：读不到状态时按「全开」处理", () => {
  it("D1 抛错 → getFeatureStates 返回全 true（绝不把全站带崩）", async () => {
    invalidateFeatureStates()
    const broken = {
      DB: {
        prepare() {
          throw new Error("d1 down for test")
        },
      },
    } as unknown as Env
    const states = await getFeatureStates(broken)
    for (const f of FEATURE_DEFS) expect(states[f.id], f.id).toBe(true)
    invalidateFeatureStates()
  })
})

describe("全部开关打开时：公开资源入口同样不被拦", () => {
  it("/dl、/s、/u、/c、/p、/profile 都不会返回 FEATURE_DISABLED", async () => {
    const paths = [
      "/dl/someone/file.txt",
      "/s/sometoken",
      "/u/someone/avatar",
      "/c/somepost/pic.png",
      "/p/someone/avatar",
      "/profile/someone",
    ]
    for (const path of paths) {
      const res = await fetchSelf(new Request("https://cloud.doulor.cn" + path))
      const body = await res.clone().json<{ code?: string }>().catch(() => ({}))
      expect(
        res.status === 403 && body?.code === "FEATURE_DISABLED",
        path + " 被功能开关拦了"
      ).toBe(false)
    }
  })
})

describe("全部开关打开时：守卫不拦任何功能", () => {
  it("GET /api/features 返回全开", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/features"))
    expect(res.status).toBe(200)
    const body = await res.json<{ states: Record<string, boolean> }>()
    for (const f of FEATURE_DEFS) expect(body.states[f.id], f.id).toBe(true)
  })

  it("各功能代表接口都不会被守卫拦成 FEATURE_DISABLED", async () => {
    const u = await makeUser({ role: "root" })
    /**
     * 取每个功能里**只读、无副作用**的代表接口。
     * 允许 400/404/500 等业务结果（那些是各 handler 自己的事），
     * 只禁止「被功能开关拦下」这一种 —— 那才是中立性问题。
     */
    const probes: [string, string][] = [
      ["mail", "GET /api/mailbox"],
      ["mail", "GET /api/mailbox/latest-unread"],
      ["externalMailSync", "GET /api/mail/accounts"],
      ["tempbox", "GET /api/tempbox/config"],
      ["domains", "GET /api/subdomains"],
      ["dns", "GET /api/dns"],
      ["storage", "GET /api/storage"],
      ["ai", "GET /api/dev/status"],
      ["wb2api", "GET /api/wb2api/status"],
      ["qoder2api", "GET /api/qoder2api/status"],
      ["lab", "GET /api/lab/settings"],
      ["proxy", "GET /api/proxy"],
      ["frp", "GET /api/frp/rental/mine"],
      ["community", "GET /api/community/config"],
      ["chat", "GET /api/chat/unread"],
      ["dm", "GET /api/dm/unread"],
      ["profile", "GET /api/profile"],
      ["space", "GET /api/my-space"],
      ["stickers", "GET /api/stickers"],
      ["feedback", "GET /api/feedback"],
      ["gallery", "GET /api/gallery"],
      ["game", "GET /api/collection/plugins"],
      ["funLinks", "GET /api/fun-links"],
      ["points", "GET /api/points"],
      ["checkin", "GET /api/checkin"],
      ["achievements", "GET /api/achievements"],
      ["leaderboard", "GET /api/leaderboard"],
      ["titles", "GET /api/titles/mine"],
      ["events", "GET /api/events"],
      ["donations", "GET /api/donations"],
      ["announcements", "GET /api/announcements"],
      ["oauthProvider", "GET /api/oauth/grants"],
      ["push", "GET /api/push/public-key"],
      ["analytics", "GET /api/analytics/track"],
      ["diagLog", "GET /api/diag-logs"],
      ["perf", "GET /api/perf/collect"],
    ]

    for (const [feature, spec] of probes) {
      const [method, path] = spec.split(" ")
      const res = await fetchSelf(authRequest(u, path, { method }))
      const body = await res.clone().json<{ code?: string }>().catch(() => ({}))
      const blocked = res.status === 403 && body?.code === "FEATURE_DISABLED"
      expect(blocked, feature + " " + spec + " 被功能开关拦了").toBe(false)
    }
  })
})
