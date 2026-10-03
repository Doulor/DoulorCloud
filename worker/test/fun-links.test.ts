// 「有趣的网页分享」接口契约。
//
// 这是工具箱里唯一一个**要读库**的模块（其余 25 个都在浏览器本地跑），
// 所以这里锁三件事：
//   1. 普通用户只看得到上架的；管理员能看全部；
//   2. 链接只接受 http / https（挡 `javascript:` / `data:` 这类注入）；
//   3. 非管理员不能写。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

interface LinkDTO {
  id: string
  title: string
  url: string
  description: string
  category: string
  sortOrder: number
  enabled: boolean
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

async function listPublic(user: { cookie: string }): Promise<LinkDTO[]> {
  const res = await fetchSelf(authRequest(user, "/api/fun-links"))
  expect(res.status).toBe(200)
  return (await res.json<{ links: LinkDTO[] }>()).links
}

async function listAdmin(admin: { cookie: string }): Promise<LinkDTO[]> {
  const res = await fetchSelf(authRequest(admin, "/api/admin/fun-links"))
  expect(res.status).toBe(200)
  return (await res.json<{ links: LinkDTO[] }>()).links
}

async function create(admin: { cookie: string }, body: Record<string, unknown>) {
  return fetchSelf(authRequest(admin, "/api/admin/fun-links", json("POST", body)))
}

describe("GET /api/fun-links —— 只回上架的", () => {
  it("未登录 → 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/fun-links"))
    expect(res.status).toBe(401)
  })

  it("普通用户看不到已下架的，管理员能看到全部", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()

    const a = await (await create(admin, { title: "上架的", url: "https://a.example.com" })).json<{
      link: LinkDTO
    }>()
    const b = await (
      await create(admin, { title: "下架的", url: "https://b.example.com", enabled: false })
    ).json<{ link: LinkDTO }>()

    const pub = await listPublic(user)
    expect(pub.some((l) => l.id === a.link.id)).toBe(true)
    expect(pub.some((l) => l.id === b.link.id)).toBe(false)

    const all = await listAdmin(admin)
    expect(all.some((l) => l.id === a.link.id)).toBe(true)
    expect(all.some((l) => l.id === b.link.id)).toBe(true)
  })

  it("按 sort_order 升序返回", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await create(admin, { title: "后", url: "https://later.example.com", sortOrder: 20 })
    await create(admin, { title: "先", url: "https://first.example.com", sortOrder: 10 })

    const pub = await listPublic(user)
    const iFirst = pub.findIndex((l) => l.title === "先")
    const iLater = pub.findIndex((l) => l.title === "后")
    expect(iFirst).toBeGreaterThanOrEqual(0)
    expect(iFirst).toBeLessThan(iLater)
  })
})

describe("POST /api/admin/fun-links —— 校验与权限", () => {
  it("创建成功并回传完整对象", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await create(admin, {
      title: " 有意思的站 ",
      url: "https://fun.example.com",
      description: "  一句话  ",
      sortOrder: 5,
    })
    expect(res.status).toBe(200)
    const { link } = await res.json<{ link: LinkDTO }>()
    expect(link.title).toBe("有意思的站") // 前后空格被裁掉
    expect(link.description).toBe("一句话")
    expect(link.sortOrder).toBe(5)
    expect(link.enabled).toBe(true)
  })

  it("非管理员 → 403", async () => {
    const user = await makeUser()
    const res = await create(user, { title: "x", url: "https://x.example.com" })
    expect(res.status).toBe(403)
  })

  it("缺名称 / 缺链接 → 400", async () => {
    const admin = await makeUser({ role: "admin" })
    expect((await create(admin, { url: "https://x.example.com" })).status).toBe(400)
    expect((await create(admin, { title: "x" })).status).toBe(400)
    expect((await create(admin, { title: "x", url: "   " })).status).toBe(400)
  })

  it("非 http/https 或非法 URL → 400（挡 javascript: 注入）", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://a.example.com", "不是网址"]) {
      const res = await create(admin, { title: "x", url: bad })
      expect(res.status).toBe(400)
    }
  })
})

describe("PUT / DELETE /api/admin/fun-links/:id", () => {
  it("局部更新：只传 enabled 不会清掉其它字段", async () => {
    const admin = await makeUser({ role: "admin" })
    const { link } = await (
      await create(admin, { title: "原名", url: "https://keep.example.com", description: "原说明" })
    ).json<{ link: LinkDTO }>()

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/fun-links/${link.id}`, json("PUT", { enabled: false }))
    )
    expect(res.status).toBe(200)
    const { link: updated } = await res.json<{ link: LinkDTO }>()
    expect(updated.enabled).toBe(false)
    expect(updated.title).toBe("原名")
    // ⚠️ 链接会被 `new URL()` 归一化（裸域名补末尾斜杠、host 转小写），存的是归一化后的值
    expect(updated.url).toBe("https://keep.example.com/")
    expect(updated.description).toBe("原说明")
  })

  it("改不存在的 id → 404", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/fun-links/nope", json("PUT", { title: "x" }))
    )
    expect(res.status).toBe(404)
  })

  it("删除后公开列表里就没了", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const { link } = await (
      await create(admin, { title: "待删", url: "https://del.example.com" })
    ).json<{ link: LinkDTO }>()

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/fun-links/${link.id}`, { method: "DELETE" })
    )
    expect(res.status).toBe(200)
    expect((await listPublic(user)).some((l) => l.id === link.id)).toBe(false)
  })

  it("非管理员不能删", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const { link } = await (
      await create(admin, { title: "别删我", url: "https://keep2.example.com" })
    ).json<{ link: LinkDTO }>()

    const res = await fetchSelf(
      authRequest(user, `/api/admin/fun-links/${link.id}`, { method: "DELETE" })
    )
    expect(res.status).toBe(403)

    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM fun_links WHERE id = ?")
      .bind(link.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(1)
  })
})

describe("分类（唯美 / 工具）", () => {
  it("不传分类时默认「工具」", async () => {
    const admin = await makeUser({ role: "admin" })
    const { link } = await (
      await create(admin, { title: "没写分类", url: "https://cat-default.example.com" })
    ).json<{ link: LinkDTO }>()
    expect(link.category).toBe("tool")
  })

  it("可以指定「唯美」", async () => {
    const admin = await makeUser({ role: "admin" })
    const { link } = await (
      await create(admin, {
        title: "唯美站",
        url: "https://cat-aes.example.com",
        category: "aesthetic",
      })
    ).json<{ link: LinkDTO }>()
    expect(link.category).toBe("aesthetic")
  })

  it("可以指定「娱乐」", async () => {
    const admin = await makeUser({ role: "admin" })
    const { link } = await (
      await create(admin, {
        title: "娱乐站",
        url: "https://cat-ent.example.com",
        category: "ent",
      })
    ).json<{ link: LinkDTO }>()
    expect(link.category).toBe("ent")
  })

  it("分类不在白名单里 → 400", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await create(admin, {
      title: "x",
      url: "https://cat-bad.example.com",
      category: "游戏",
    })
    expect(res.status).toBe(400)
  })

  it("只改分类不会动其它字段", async () => {
    const admin = await makeUser({ role: "admin" })
    const { link } = await (
      await create(admin, {
        title: "要改分类",
        url: "https://cat-upd.example.com",
        description: "原说明",
      })
    ).json<{ link: LinkDTO }>()

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/fun-links/${link.id}`, json("PUT", { category: "aesthetic" }))
    )
    expect(res.status).toBe(200)
    const { link: updated } = await res.json<{ link: LinkDTO }>()
    expect(updated.category).toBe("aesthetic")
    expect(updated.title).toBe("要改分类")
    expect(updated.description).toBe("原说明")
    expect(updated.enabled).toBe(true)
  })

  it("公开列表带着分类返回", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await create(admin, {
      title: "唯美甲",
      url: "https://cat-list-a.example.com",
      category: "aesthetic",
    })
    await create(admin, { title: "工具乙", url: "https://cat-list-t.example.com", category: "tool" })
    await create(admin, { title: "娱乐丙", url: "https://cat-list-e.example.com", category: "ent" })

    const pub = await listPublic(user)
    expect(pub.find((l) => l.title === "唯美甲")?.category).toBe("aesthetic")
    expect(pub.find((l) => l.title === "工具乙")?.category).toBe("tool")
    expect(pub.find((l) => l.title === "娱乐丙")?.category).toBe("ent")
  })

  it("库里的历史脏值一律按「工具」回给前端", async () => {
    const user = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO fun_links (id, title, url, description, category, sort_order, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind("dirty-row-1", "脏值条目", "https://dirty.example.com/", "", "whatever", 0, 1, now, now)
      .run()

    const pub = await listPublic(user)
    expect(pub.find((l) => l.id === "dirty-row-1")?.category).toBe("tool")
  })
})
