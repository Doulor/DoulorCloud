// Web Push 订阅端点的守卫（部署前加固，2026-11-10）。
//
// 背景：`POST /api/push/subscribe` 的 `endpoint` 是**用户提交**的地址，而服务端之后
// 会主动向它 POST（`pushToUser` → `sendPush`）—— 不过 SSRF 守卫就是一个现成的
// "让 Worker 去打内网 / 元数据地址"的面。浏览器给的推送端点都是公网 https
// （FCM / Mozilla / Apple / WNS），因此这里钉住：
//   1. 内网 / 本机 / 非 https 的端点一律 400，不入库；
//   2. 公网 https 端点按 `URL.href` 规范化入库（同一端点不同写法不产生重复行）；
//   3. 退订走同一套规范化（否则订了删不掉）。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const JSON_HEADERS = { "Content-Type": "application/json" }
const KEYS = { p256dh: "p256dh-fake-key", auth: "auth-fake-key" }

async function post(user: TestUser, path: string, body: unknown): Promise<Response> {
  return fetchSelf(
    authRequest(user, path, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
  )
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => ({}))) as { code?: string }).code
}

async function endpointRows(userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint"
  )
    .bind(userId)
    .all<{ endpoint: string }>()
  return (rows.results ?? []).map((r) => r.endpoint)
}

describe("POST /api/push/subscribe 端点守卫", () => {
  it("内网 / 本机地址一律 400 INVALID_INPUT，且不入库", async () => {
    const u = await makeUser()
    for (const endpoint of [
      "https://127.0.0.1/push",
      "https://localhost/push",
      "https://10.0.0.7/push",
      "https://192.168.1.5/push",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/push",
    ]) {
      const res = await post(u, "/api/push/subscribe", { endpoint, keys: KEYS })
      expect(res.status).toBe(400)
      expect(await codeOf(res)).toBe("INVALID_INPUT")
    }
    expect(await endpointRows(u.id)).toEqual([])
  })

  it("非 https（含 http://）一律 400", async () => {
    const u = await makeUser()
    for (const endpoint of ["http://fcm.googleapis.com/wp/a", "ws://fcm.googleapis.com/x", "fcm.googleapis.com/x"]) {
      const res = await post(u, "/api/push/subscribe", { endpoint, keys: KEYS })
      expect(res.status).toBe(400)
      expect(await codeOf(res)).toBe("INVALID_INPUT")
    }
    expect(await endpointRows(u.id)).toEqual([])
  })

  it("公网 https 端点可订阅，并按 URL.href 规范化入库", async () => {
    const u = await makeUser()
    const res = await post(u, "/api/push/subscribe", {
      endpoint: "HTTPS://FCM.GOOGLEAPIS.COM:443/wp/abc",
      keys: KEYS,
      ua: "unit-test",
    })
    expect(res.status).toBe(200)
    expect(await endpointRows(u.id)).toEqual(["https://fcm.googleapis.com/wp/abc"])
  })

  it("退订用同一套规范化：订的是原串、退的是变体，也能删掉", async () => {
    const u = await makeUser()
    const on = await post(u, "/api/push/subscribe", {
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/xyz",
      keys: KEYS,
    })
    expect(on.status).toBe(200)

    const off = await post(u, "/api/push/unsubscribe", {
      endpoint: "https://UPDATES.PUSH.SERVICES.MOZILLA.COM/wpush/v2/xyz",
    })
    expect(off.status).toBe(200)
    expect(await endpointRows(u.id)).toEqual([])
  })

  it("不能退订别人的订阅", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const endpoint = "https://fcm.googleapis.com/wp/shared"
    expect((await post(owner, "/api/push/subscribe", { endpoint, keys: KEYS })).status).toBe(200)

    expect((await post(other, "/api/push/unsubscribe", { endpoint })).status).toBe(200)
    // 端点仍然属于 owner（退订只删自己那一行）
    expect(await endpointRows(owner.id)).toEqual([endpoint])
    expect(await endpointRows(other.id)).toEqual([])
  })
})
