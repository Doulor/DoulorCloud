// 个人名片「开通即对外显示」。
//
// 改动前：点「开通名片」只建一条 published=0 的空行，用户还得再去「对外展示」里
// 手动点一次「启用」才会真的公开 —— 很多人以为开通就完事了，名片一直是 404。
// 改动后：开通即 published=1，公开地址立刻可访问（没昵称就用用户名兜底显示）。
//
// ⚠️ 这个改动顺带把「空骨架行」变成了「已发布」，而活动领奖条件 has_profile
// 原来就是看 published 的 —— 等于重新打开了「点一下开通就领走 500 元」的漏洞。
// 所以 has_profile 的判据同步加了一道「必须填了昵称」，本文件把它一起锁住。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { CONDITION_HANDLERS } from "../src/event-rewards"
import { loadUserCounts } from "../src/handlers/achievements"

const jsonHeaders = { "Content-Type": "application/json" }

const enable = (u: TestUser) =>
  fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))

const getProfile = async (u: TestUser) =>
  (await (await fetchSelf(authRequest(u, "/api/profile"))).json()) as {
    enabled: boolean
    profile: { published: boolean; slug: string; displayName: string | null } | null
  }

const publish = (u: TestUser, published: boolean) =>
  fetchSelf(
    authRequest(u, "/api/profile/publish", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ published }),
    })
  )

/** 匿名访客访问公开名片页 */
const visit = (slug: string) =>
  fetchSelf(new Request(`https://cloud.doulor.cn/profile/${slug}`, { redirect: "manual" }))

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM profiles").run()
})

describe("开通名片 —— 默认对外显示", () => {
  it("开通后 published 立即为 true，不用再手动启用", async () => {
    const u = await makeUser()
    const res = await enable(u)
    expect(res.status).toBe(201)
    expect((await res.json<{ published: boolean }>()).published).toBe(true)

    const got = await getProfile(u)
    expect(got.enabled).toBe(true)
    expect(got.profile!.published).toBe(true)
  })

  it("开通后公开地址立刻能访问（没填昵称就用用户名兜底，不是 404 也不是空白页）", async () => {
    const u = await makeUser()
    const { profile } = await getProfile(u)
    expect(profile).toBeNull() // 开通前确实没有名片

    await enable(u)
    const res = await visit(u.username.toLowerCase())
    expect(res.status).toBe(200)
    const html = await res.text()
    // 兜底名 = 用户名，说明页面渲染出来了而不是开天窗
    expect(html).toContain(u.username)
  })

  it("重复开通不会覆盖已有名片（published 状态保持用户自己的选择）", async () => {
    const u = await makeUser()
    await enable(u)
    await publish(u, false)

    const again = await enable(u)
    expect(again.status).toBe(200) // 已存在 → 走 early return
    expect((await getProfile(u)).profile!.published).toBe(false)
  })
})

describe("对外展示开关 —— 不再强制先填昵称", () => {
  it("没昵称也能关掉再打开（改之前会 400 DISPLAY_NAME_REQUIRED，自相矛盾）", async () => {
    const u = await makeUser()
    await enable(u)

    expect((await publish(u, false)).status).toBe(200)
    expect(await visit(u.username.toLowerCase()).then((r) => r.status)).toBe(404)

    const on = await publish(u, true)
    expect(on.status).toBe(200)
    expect((await on.json<{ published: boolean }>()).published).toBe(true)
    expect(await visit(u.username.toLowerCase()).then((r) => r.status)).toBe(200)
  })
})

describe("活动领奖条件 has_profile —— 挡住「点一下开通就领钱」", () => {
  // 直测条件处理器：它就是一个 SQL 判据，比绕一圈建活动更能定位问题
  const check = (u: TestUser) => CONDITION_HANDLERS.has_profile(env, u.id, {})

  it("没开通 → 不通过", async () => {
    expect(await check(await makeUser())).toBe(false)
  })

  it("只点了开通、什么都没填 → 不通过（这是 gaozx1 那次的漏洞形态）", async () => {
    const u = await makeUser()
    await enable(u)
    expect((await getProfile(u)).profile!.published).toBe(true) // 确实已发布
    expect(await check(u)).toBe(false) // 但仍然不算「做了名片」
  })

  it("填了昵称 → 通过", async () => {
    const u = await makeUser()
    await enable(u)
    await fetchSelf(
      authRequest(u, "/api/profile", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ displayName: "张三" }),
      })
    )
    expect(await check(u)).toBe(true)
  })

  it("昵称是纯空格不算数", async () => {
    const u = await makeUser()
    await enable(u)
    // 绕过 PUT 的 trim 校验直接写库，确认判据里的 TRIM 真的生效
    await env.DB.prepare("UPDATE profiles SET display_name = '   ' WHERE user_id = ?")
      .bind(u.id)
      .run()
    expect(await check(u)).toBe(false)
  })

  it("填了昵称但把名片关掉 → 不通过（published 这一半也要满足）", async () => {
    const u = await makeUser()
    await enable(u)
    await fetchSelf(
      authRequest(u, "/api/profile", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ displayName: "李四" }),
      })
    )
    await publish(u, false)
    expect(await check(u)).toBe(false)
  })
})

describe("成就「公之于众」—— 不能变成开通就白送", () => {
  // 成就点是真金白银（每满 10 点发一份 NewAPI 订阅），所以这里也要卡内容。
  // 否则「公之于众」会和「数字名片（开通名片）」完全重复。
  const setDisplayName = (u: TestUser, displayName: string) =>
    fetchSelf(
      authRequest(u, "/api/profile", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ displayName }),
      })
    )

  it("只点开通（无昵称）→ 「数字名片」解锁，但「公之于众」没解锁", async () => {
    const u = await makeUser()
    await enable(u)
    const counts = await loadUserCounts(env, u.id)
    expect(counts.profile_row).toBe(1) // 数字名片：有行就算
    expect(counts.published).toBe(0) // 公之于众：还得有名字
  })

  it("填了昵称 → 「公之于众」解锁", async () => {
    const u = await makeUser()
    await enable(u)
    await setDisplayName(u, "王五")
    expect((await loadUserCounts(env, u.id)).published).toBe(1)
  })

  it("昵称被清空 → 又变回未解锁（判据是实时算的，不落库）", async () => {
    const u = await makeUser()
    await enable(u)
    await setDisplayName(u, "赵六")
    expect((await loadUserCounts(env, u.id)).published).toBe(1)

    await env.DB.prepare("UPDATE profiles SET display_name = NULL WHERE user_id = ?")
      .bind(u.id)
      .run()
    expect((await loadUserCounts(env, u.id)).published).toBe(0)
  })
})
