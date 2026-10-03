// 名片自动缩放：接口层的读写与边界校验。
//
// 这个功能的渲染逻辑在客户端（视口高度只有浏览器知道），所以这里只锁两件事：
//   1. 三个字段能正确读写、能出现在 GET /api/profile 的响应里
//   2. 越界/非法输入被夹到合法区间（不信任前端，也不信任历史脏数据）
//
// 渲染层的行为（zoom 生效、内容不长时不缩、顶部不再被裁）用 Playwright
// 在真实浏览器里验证，见 scripts/verify-autoscale.cjs。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

const get = (u: { cookie: string }) => authRequest(u, "/api/profile")
const put = (u: { cookie: string }, body: unknown) =>
  authRequest(u, "/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM profiles").run()
})

describe("名片自动缩放 —— 默认值", () => {
  it("开通后默认开启自动缩放，起始 100%、下限 50%", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    const res = await fetchSelf(get(u))
    const body = (await res.json()) as {
      profile: { scaleMode: string; scaleMin: number; scaleManual: number }
    }
    expect(body.profile.scaleMode).toBe("auto")
    expect(body.profile.scaleMin).toBe(50)
    expect(body.profile.scaleManual).toBe(100)
  })

  it("选项元数据随 GET 一起下发（前端滑杆的上下限与服务端同源）", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    const res = await fetchSelf(get(u))
    const body = (await res.json()) as {
      scaleModes: string[]
      scaleModeOptions: { id: string }[]
      scaleMinRange: { min: number; max: number }
      scaleManualRange: { min: number; max: number }
    }
    expect(body.scaleModes).toEqual(["off", "auto"])
    expect(body.scaleModeOptions.map((o) => o.id)).toEqual(["auto", "off"])
    expect(body.scaleMinRange).toEqual({ min: 30, max: 100 })
    expect(body.scaleManualRange).toEqual({ min: 50, max: 150 })
  })
})

describe("名片自动缩放 —— 写入", () => {
  it("能保存模式与两个比例", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    const res = await fetchSelf(
      put(u, { scaleMode: "off", scaleMin: 60, scaleManual: 120 })
    )
    expect(res.status).toBe(200)

    const after = (await (await fetchSelf(get(u))).json()) as {
      profile: { scaleMode: string; scaleMin: number; scaleManual: number }
    }
    expect(after.profile.scaleMode).toBe("off")
    expect(after.profile.scaleMin).toBe(60)
    expect(after.profile.scaleManual).toBe(120)
  })

  it("未传字段时保持原值（不影响只改昵称这类局部保存）", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))
    await fetchSelf(put(u, { scaleMode: "off", scaleMin: 60, scaleManual: 120 }))

    await fetchSelf(put(u, { displayName: "只改昵称" }))

    const after = (await (await fetchSelf(get(u))).json()) as {
      profile: { scaleMode: string; scaleMin: number; scaleManual: number }
    }
    expect(after.profile.scaleMode).toBe("off")
    expect(after.profile.scaleMin).toBe(60)
    expect(after.profile.scaleManual).toBe(120)
  })

  it("非法的模式字符串被忽略，保持原值", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))
    await fetchSelf(put(u, { scaleMode: "auto" }))

    await fetchSelf(put(u, { scaleMode: "不存在的模式" }))

    const after = (await (await fetchSelf(get(u))).json()) as {
      profile: { scaleMode: string }
    }
    expect(after.profile.scaleMode).toBe("auto")
  })
})

describe("名片自动缩放 —— 区间夹取", () => {
  it("起始比例超出 50~150 被夹回边界", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    await fetchSelf(put(u, { scaleManual: 999 }))
    let p = ((await (await fetchSelf(get(u))).json()) as {
      profile: { scaleManual: number }
    }).profile
    expect(p.scaleManual).toBe(150)

    await fetchSelf(put(u, { scaleManual: 1 }))
    p = ((await (await fetchSelf(get(u))).json()) as {
      profile: { scaleManual: number }
    }).profile
    expect(p.scaleManual).toBe(50)
  })

  it("下限比例超出 30~100 被夹回边界", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    await fetchSelf(put(u, { scaleMin: 500 }))
    let p = ((await (await fetchSelf(get(u))).json()) as {
      profile: { scaleMin: number }
    }).profile
    expect(p.scaleMin).toBe(100)

    await fetchSelf(put(u, { scaleMin: -20 }))
    p = ((await (await fetchSelf(get(u))).json()) as {
      profile: { scaleMin: number }
    }).profile
    expect(p.scaleMin).toBe(30)
  })

  it("非数字（字符串/NaN/null）不破坏数据，回落到默认值", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    await fetchSelf(put(u, { scaleMin: "abc", scaleManual: null }))

    const p = ((await (await fetchSelf(get(u))).json()) as {
      profile: { scaleMin: number; scaleManual: number }
    }).profile
    expect(p.scaleMin).toBe(50)
    expect(p.scaleManual).toBe(100)
  })

  it("小数被截断成整数（滑杆步进是 5，不该出现小数）", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    await fetchSelf(put(u, { scaleManual: 87.6 }))

    const p = ((await (await fetchSelf(get(u))).json()) as {
      profile: { scaleManual: number }
    }).profile
    expect(p.scaleManual).toBe(87)
    expect(Number.isInteger(p.scaleManual)).toBe(true)
  })
})

describe("名片自动缩放 —— 实时预览", () => {
  // 编辑器的预览 iframe 走 /api/profile/preview，必须与公开页渲染同一套配置，
  // 否则「所见即所得」失效：改了滑杆但预览不变，用户以为没生效。
  const preview = (u: { cookie: string }, body: unknown) =>
    authRequest(u, "/api/profile/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  it("预览 HTML 用的是表单里的比例（未保存也能看到效果）", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    const res = await fetchSelf(
      preview(u, { scaleMode: "off", scaleMin: 35, scaleManual: 130 })
    )
    expect(res.status).toBe(200)
    const { html } = (await res.json()) as { html: string }
    expect(html).toContain('{"mode":"off","min":0.35,"manual":1.3}')
  })

  it("未传缩放字段时用库里已保存的值", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))
    await fetchSelf(put(u, { scaleMode: "auto", scaleMin: 45, scaleManual: 85 }))

    const res = await fetchSelf(preview(u, { displayName: "只改昵称" }))
    const { html } = (await res.json()) as { html: string }
    expect(html).toContain('{"mode":"auto","min":0.45,"manual":0.85}')
  })

  it("预览的越界输入同样被夹取（前端被绕过也不能写坏预览）", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

    const res = await fetchSelf(preview(u, { scaleMin: 9999, scaleManual: -5 }))
    const { html } = (await res.json()) as { html: string }
    expect(html).toContain('{"mode":"auto","min":1,"manual":0.5}')
  })
})

describe("名片自动缩放 —— 公开页渲染", () => {
  it("公开页 HTML 带上了缩放配置，且 --pz 有默认值", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))
    // 发布前必须有昵称（服务端会拦）
    await fetchSelf(put(u, { displayName: "测试名片" }))
    await fetchSelf(put(u, { scaleMode: "auto", scaleMin: 40, scaleManual: 90 }))
    const pubRes = await fetchSelf(
      authRequest(u, "/api/profile/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ published: true }),
      })
    )
    expect(pubRes.status).toBe(200)

    const res = await fetchSelf(
      new Request(`https://cloud.doulor.cn/profile/${u.username}`)
    )
    expect(res.status).toBe(200)
    const html = await res.text()

    // 配置以 JSON 注入 JS（顺序固定，故可直接断言）
    expect(html).toContain('{"mode":"auto","min":0.4,"manual":0.9}')
    // 兜底值：JS 没跑起来时也不能缩放错乱
    expect(html).toContain("--pz,1")
    // 修复顶部裁切的两处 CSS
    expect(html).toContain("justify-content:safe center")
    expect(html).toContain("html,body{height:auto}")
  })
})
