// 名片音乐：搜索 / 保存 / 公开播放 的完整链路。
//
// 这里跑的是真实 HTTP 流程（SELF.fetch → route() → handler → D1），因为这段代码
// 的真实风险不在某个纯函数算错，而在「接线接错了」：
//   - 新加的路由有没有真正注册进 dispatch（没注册会被静态兜底成 200 + 首页 HTML，
//     只看状态码根本发现不了）
//   - music_source / music_lyrics 有没有真的写进库、读得回来
//   - 公开资源路径 `/p/<用户名>/music` 有没有优先走实时解析、且带 no-store
//   - 未发布的名片**不能**因为新加的解析分支而漏出资源（原有安全边界不能被打开）
//
// 出网请求全部打桩：第三方接口随时会挂（本项目已经历过一次），测试不能依赖它们活着。
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

const MP3 = "https://m701.music.126.net/20260925213236/xxx.mp3?vuutv=token"

let restores: Array<() => void> = []
let outbound: string[] = []

/** 只接管音乐相关的第三方主机，其余请求（包括测试框架自己的）原样放行 */
function stubOutbound(handler: (url: string) => Response | undefined): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (/^https:\/\/(api\.vkeys\.cn|api\.injahow\.cn|lrclib\.net)\//.test(url)) {
      outbound.push(url)
      const res = handler(url)
      if (res) return res
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 造一个带 url 的响应（构造出来的 Response 的 url 永远是空串，必须显式覆盖） */
function audioRes(contentType: string, url: string): Response {
  const res = new Response(null, { status: 200, headers: { "Content-Type": contentType } })
  Object.defineProperty(res, "url", { value: url })
  return res
}

const jsonHeaders = { "Content-Type": "application/json" }

/**
 * 构造一个「匿名访客访问公开路径」的请求。
 *
 * ⚠️ 必须显式 `redirect: "manual"`。踩坑记录：
 *   workerd 的 `SELF.fetch` 会**自动跟随 302**，而且跟随过程**不走 globalThis.fetch**
 *   —— 它把 Location 里的地址重新投递回本 Worker（而不是真的出网）。
 *   于是请求以一个陌生的 Host（如 api.injahow.cn）再次进入 route()，
 *   匹配不到任何路由，返回 `{"error":"接口不存在"}` 的 404。
 *   表现就是「明明返回了 302，测试却看到 404」。
 *   禁掉跟随才能看到真实的 302。
 */
function publicRequest(path: string): Request {
  return new Request(`https://cloud.doulor.cn${path}`, { redirect: "manual" })
}

/** 开通名片 → 写入字段 → 按需发布 */
async function setupProfile(
  user: TestUser,
  patch: Record<string, unknown>,
  publish = true
): Promise<void> {
  await fetchSelf(authRequest(user, "/api/profile/enable", { method: "POST" }))
  const put = await fetchSelf(
    authRequest(user, "/api/profile", {
      method: "PUT",
      headers: jsonHeaders,
      // 昵称是公开页的显示名；不填会回落到用户名，这里统一兜一个默认值
      body: JSON.stringify({ displayName: "测试名片", ...patch }),
    })
  )
  if (put.status !== 200) throw new Error(`保存名片失败：${put.status}`)
  if (publish) {
    const pub = await fetchSelf(
      authRequest(user, "/api/profile/publish", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ published: true }),
      })
    )
    if (pub.status !== 200) throw new Error(`发布名片失败：${pub.status}`)
    // 发布成功但库里没置位的话，后面所有公开路径都会 404，且原因很难看出来
    const check = await fetchSelf(authRequest(user, "/api/profile"))
    const profile = ((await check.json()) as { profile: { published: boolean } }).profile
    if (!profile.published) throw new Error("发布后 published 仍为 false")
  }
}

beforeEach(() => {
  outbound = []
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
})

describe("GET /api/profile/music/search", () => {
  it("未登录一律 401（这是对第三方服务的代理调用，不能给匿名用户白用）", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/profile/music/search?q=x")
    )
    expect(res.status).toBe(401)
    expect(outbound).toHaveLength(0)
  })

  it("返回候选列表，且**不含任何播放地址**（地址带时效签名，只能实时解析）", async () => {
    const user = await makeUser()
    stubOutbound(() =>
      jsonRes({
        code: 200,
        data: [
          {
            id: 1330348068,
            song: "起风了",
            singer: "买辣椒也用券",
            album: "起风了",
            cover: "http://p4.music.126.net/a/b.jpg",
          },
        ],
      })
    )

    const res = await fetchSelf(
      authRequest(user, `/api/profile/music/search?q=${encodeURIComponent("起风了")}`)
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tracks: Array<Record<string, unknown>> }
    expect(body.tracks).toHaveLength(1)
    expect(body.tracks[0].source).toBe("netease:1330348068")
    expect(body.tracks[0].cover).toBe("https://p4.music.126.net/a/b.jpg?param=500y500")
    // 关键：响应里不该出现任何 mp3 / 带签名的地址
    expect(JSON.stringify(body)).not.toContain(".mp3")
  })

  it("搜索服务挂掉 → 502（前端要能区分「没搜到」和「服务挂了」）", async () => {
    const user = await makeUser()
    stubOutbound(() => new Response("boom", { status: 500 }))
    const res = await fetchSelf(authRequest(user, "/api/profile/music/search?q=x"))
    expect(res.status).toBe(502)
  })
})

describe("music_source / music_lyrics 入库", () => {
  it("合法来源与歌词写进库并能读回", async () => {
    const user = await makeUser()
    await setupProfile(user, {
      musicSource: "netease:1330348068",
      musicLyrics: "[00:01.00] 第一句",
      musicTitle: "起风了",
    })

    const res = await fetchSelf(authRequest(user, "/api/profile"))
    const body = (await res.json()) as { profile: Record<string, unknown> }
    expect(body.profile.musicSource).toBe("netease:1330348068")
    expect(body.profile.musicLyrics).toBe("[00:01.00] 第一句")
  })

  it("非法来源被清成 null，而不是原样入库（它会被拼进第三方请求）", async () => {
    const user = await makeUser()
    await fetchSelf(authRequest(user, "/api/profile/enable", { method: "POST" }))
    // tencent 不在白名单；第二种是想往 URL 里塞参数
    for (const bad of ["tencent:202371397", "netease:123&server=tencent", "不是来源"]) {
      await fetchSelf(
        authRequest(user, "/api/profile", {
          method: "PUT",
          headers: jsonHeaders,
          body: JSON.stringify({ musicSource: bad }),
        })
      )
      const res = await fetchSelf(authRequest(user, "/api/profile"))
      const body = (await res.json()) as { profile: Record<string, unknown> }
      expect(body.profile.musicSource).toBeNull()
    }
  })

  it("传空串能清掉搜索来源（回到自定义音频）", async () => {
    const user = await makeUser()
    await setupProfile(user, { musicSource: "netease:42" }, false)
    let res = await fetchSelf(authRequest(user, "/api/profile"))
    expect(((await res.json()) as { profile: Record<string, unknown> }).profile.musicSource).toBe(
      "netease:42"
    )

    await fetchSelf(
      authRequest(user, "/api/profile", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ musicSource: "" }),
      })
    )
    res = await fetchSelf(authRequest(user, "/api/profile"))
    expect(((await res.json()) as { profile: Record<string, unknown> }).profile.musicSource).toBeNull()
  })
})

describe("公开资源路径 /p/<用户名>/music", () => {
  it("设了搜索来源 → 302 到实时解析出的地址，且禁止缓存", async () => {
    const user = await makeUser()
    await setupProfile(user, { musicSource: "netease:1330348068" })
    stubOutbound(() => audioRes("audio/mpeg", MP3))

    const res = await fetchSelf(publicRequest(`/p/${user.username}/music`))
    // 先确认「实时解析」这一步真的发生了（否则 404 的原因就在可见性或来源读取上）
    expect(outbound).toHaveLength(1)
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe(MP3)
    // 地址约 20 分钟失效，绝不能让它被缓存下来
    expect(res.headers.get("Cache-Control")).toContain("no-store")
  })

  it("解析失败且没有上传文件 → 404，而不是把空响应当音乐返回", async () => {
    const user = await makeUser()
    // ⚠️ 每首用例用**不同的歌曲 id**：解析结果有 5 分钟内存缓存，
    // 上面那条用例已经把这一个来源解析成功并写进了缓存，
    // 复用同一个 id 会直接命中缓存、根本走不到解析失败这条路。
    await setupProfile(user, { musicSource: "netease:1330348069" })
    // 上游挂掉的真实形态：200 + 空 HTML（实测 QQ 音乐就是这样）
    stubOutbound(
      () =>
        new Response("", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        })
    )

    const res = await fetchSelf(publicRequest(`/p/${user.username}/music`))
    expect(res.status).toBe(404)
    // 这个 404 必须来自资源端点本身（纯文本 "Not Found"），
    // 而不是 route() 兜底的 `{"error":"接口不存在"}`。
    // 两者状态码相同、含义完全不同，不区分的话测试会在「路由没接上」时假通过。
    expect(await res.text()).toBe("Not Found")
  })

  it("未发布的名片不提供资源（新加的解析分支不能打开原有边界）", async () => {
    const user = await makeUser()
    // 同样换一个 id，避免命中上面的解析缓存而绕过可见性检查
    await setupProfile(user, { musicSource: "netease:1330348070" }, false)

    const res = await fetchSelf(publicRequest(`/p/${user.username}/music`))
    expect(res.status).toBe(404)
    // 连第三方请求都不该发出去
    expect(outbound).toHaveLength(0)
  })
})
