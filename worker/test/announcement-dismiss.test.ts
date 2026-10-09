// 公告「不再显示」的服务端记录（迁移 0136）。
//
// 背景（2026-10-10 站长反馈）：公告弹窗的「不再显示」原来只写浏览器 localStorage。
// 换设备 / 清浏览器数据 / 重装 App（WebToApp 的 WebView 存储随应用走）后记录就没了
// —— 用户看到的是「点了不再显示，过阵子又弹」。现在这份记录落服务端（真相源），
// localStorage 退化成首屏快读缓存（见 src/pages/dashboard.tsx 的 AnnouncementPopup）。
//
// 本文件锁死四件事：
//   A. dismiss 之后列表接口对该用户返回 dismissed: true（且只影响这一条）；
//   B. 幂等：重复 dismiss 只留一行；
//   C. 只认「已发布」公告的 id（草稿 / 不存在的 id 一律 404 且不落行）；
//   D. 记录是**按用户**的：A 屏蔽了不影响 B；未登录一律 401。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

async function seedAnnouncement(opts: {
  title?: string
  popupMode?: "none" | "once" | "every"
  status?: "draft" | "scheduled" | "published"
  pinned?: number
} = {}): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO announcements (id, title, body, category, pinned, created_at, popup_mode, status)
     VALUES (?, ?, ?, 'general', ?, ?, ?, ?)`
  )
    .bind(
      id,
      opts.title ?? "测试公告",
      "正文",
      opts.pinned ?? 1,
      new Date().toISOString(),
      opts.popupMode ?? "every",
      opts.status ?? "published"
    )
    .run()
  return id
}

async function listFor(user: TestUser) {
  const res = await fetchSelf(authRequest(user, "/api/announcements"))
  expect(res.status).toBe(200)
  return (await res.json()) as { announcements: { id: string; dismissed: boolean }[] }
}

function dismiss(user: TestUser, id: string) {
  return fetchSelf(
    authRequest(user, `/api/announcements/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
    })
  )
}

async function dismissalRows(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM announcement_dismissals WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? -1
}

describe("公告「不再显示」的服务端记录", () => {
  it("A. dismiss 之后列表带 dismissed: true，且只影响这一条", async () => {
    const u = await makeUser()
    const a = await seedAnnouncement({ title: "A" })
    const b = await seedAnnouncement({ title: "B" })

    const before = await listFor(u)
    expect(before.announcements.find((x) => x.id === a)?.dismissed).toBe(false)
    expect(before.announcements.find((x) => x.id === b)?.dismissed).toBe(false)

    const res = await dismiss(u, a)
    expect(res.status).toBe(200)

    const after = await listFor(u)
    expect(after.announcements.find((x) => x.id === a)?.dismissed).toBe(true)
    expect(after.announcements.find((x) => x.id === b)?.dismissed).toBe(false)
  })

  it("B. 幂等：重复 dismiss 只留一行", async () => {
    const u = await makeUser()
    const a = await seedAnnouncement()

    for (let i = 0; i < 3; i++) {
      expect((await dismiss(u, a)).status).toBe(200)
    }
    expect(await dismissalRows(u.id)).toBe(1)
  })

  it("C. 草稿 / 不存在的公告 id 一律 404，且不落行", async () => {
    const u = await makeUser()
    const draft = await seedAnnouncement({ status: "draft" })

    for (const id of [draft, uuid()]) {
      expect((await dismiss(u, id)).status).toBe(404)
    }
    expect(await dismissalRows(u.id)).toBe(0)
  })

  it("D. 记录是按用户的：A 屏蔽了不影响 B", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const ann = await seedAnnouncement()

    expect((await dismiss(a, ann)).status).toBe(200)

    expect((await listFor(a)).announcements.find((x) => x.id === ann)?.dismissed).toBe(true)
    expect((await listFor(b)).announcements.find((x) => x.id === ann)?.dismissed).toBe(false)
  })

  it("E. 未登录 → 401（不带 cookie 直接打）", async () => {
    const ann = await seedAnnouncement()
    const res = await fetchSelf(
      new Request(`https://cloud.doulor.cn/api/announcements/${ann}/dismiss`, {
        method: "POST",
      })
    )
    expect(res.status).toBe(401)
  })
})
