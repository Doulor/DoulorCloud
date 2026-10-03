// 名片音乐：搜索 / 解析播放地址 / 取歌词。
//
// 这个模块的价值几乎全在「把会失效的东西挡在外面」，所以测试重点也是这些：
//   - 解析结果必须**真的是音频**（上游失败时会返回 200 + 空 HTML，
//     只看状态码会把它当成音乐地址交给播放器，表现为「点了没反应」）
//   - 搜索结果的封面必须被修成 https 并放大
//   - 来源标记格式非法时**一个网络请求都不该发出去**（它会被拼进 URL）
//
// 全部打桩 fetch，不碰真实网络：第三方接口随时会变（本项目已经历过一次
// res.abeim.cn 全线失联），测试不能依赖它们活着。
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import {
  parseSource,
  isValidSource,
  searchMusic,
  resolveAudioUrl,
  fetchLyrics,
} from "../src/music-api"

let calls: string[] = []
let restores: Array<() => void> = []

/** 打桩 fetch；handler 返回 undefined 时回落真实 fetch */
function stubFetch(handler: (url: string) => Response | undefined): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const res = handler(url)
    if (res) return res
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

/**
 * 造一个带指定 url 的响应。
 *
 * 构造出来的 Response，其 `url` 永远是空串 —— 而 `resolveAudioUrl()` 正是靠
 * `res.url` 拿「跟随重定向后的最终地址」，所以必须手动 defineProperty 才能覆盖到。
 */
function responseWithUrl(
  body: BodyInit | null,
  init: ResponseInit,
  url: string
): Response {
  const res = new Response(body, init)
  Object.defineProperty(res, "url", { value: url })
  return res
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
})

describe("来源标记解析", () => {
  it("合法：白名单平台 + 纯数字 id", () => {
    expect(parseSource("netease:1330348068")).toEqual({
      platform: "netease",
      songId: "1330348068",
    })
    expect(isValidSource("netease:1330348068")).toBe(true)
  })

  it("非法一律拒绝（这个值会被拼进第三方请求，是唯一防线）", () => {
    // 不在白名单的平台：QQ 音乐虽然搜得到，但解析不出音频，故意不收
    expect(isValidSource("tencent:202371397")).toBe(false)
    // id 不是纯数字 —— 防的是往 URL 里塞额外参数
    expect(isValidSource("netease:123&server=tencent")).toBe(false)
    expect(isValidSource("netease:abc")).toBe(false)
    expect(isValidSource("netease:")).toBe(false)
    expect(isValidSource(":123")).toBe(false)
    expect(isValidSource("netease")).toBe(false)
    expect(isValidSource("")).toBe(false)
  })
})

describe("按歌名搜索", () => {
  it("映射结果：封面 http 升级为 https 并放大到 500x500", async () => {
    stubFetch(() =>
      jsonRes({
        code: 200,
        data: [
          {
            id: 1330348068,
            song: "起风了",
            singer: "买辣椒也用券",
            album: "起风了",
            cover: "http://p4.music.126.net/xxx/123.jpg",
          },
        ],
      })
    )
    const tracks = await searchMusic("起风了")
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toEqual({
      source: "netease:1330348068",
      title: "起风了",
      artist: "买辣椒也用券",
      album: "起风了",
      cover: "https://p4.music.126.net/xxx/123.jpg?param=500y500",
    })
  })

  it("已经带 query 的封面不再追加 ?param（否则拼出两个问号）", async () => {
    stubFetch(() =>
      jsonRes({
        code: 200,
        data: [{ id: 1, song: "x", singer: "", album: "", cover: "https://a.com/c.jpg?x=1" }],
      })
    )
    const tracks = await searchMusic("x")
    expect(tracks[0].cover).toBe("https://a.com/c.jpg?x=1")
  })

  it("丢掉缺 id / 缺歌名的条目，而不是产出打不开的结果", async () => {
    stubFetch(() =>
      jsonRes({
        code: 200,
        data: [
          { id: "abc", song: "id 不是数字" },
          { id: 2, song: "   " },
          { id: 3, song: "正常" },
        ],
      })
    )
    const tracks = await searchMusic("q")
    expect(tracks.map((t) => t.title)).toEqual(["正常"])
  })

  it("业务 code 非 200 时抛错（让前端能区分「没搜到」和「服务挂了」）", async () => {
    stubFetch(() => jsonRes({ code: 500, message: "业务运行异常" }))
    await expect(searchMusic("q")).rejects.toThrow("业务运行异常")
  })

  it("上游不是 JSON 时抛错，而不是静默返回空列表", async () => {
    stubFetch(
      () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
    )
    await expect(searchMusic("q")).rejects.toThrow("不是合法 JSON")
  })

  it("HTTP 非 2xx 时抛错", async () => {
    stubFetch(() => new Response("nope", { status: 503 }))
    await expect(searchMusic("q")).rejects.toThrow("HTTP 503")
  })

  it("空关键词不发任何请求", async () => {
    stubFetch(() => {
      throw new Error("不该发请求")
    })
    expect(await searchMusic("   ")).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe("解析播放地址", () => {
  it("确认是音频才返回地址（取跟随重定向后的最终地址）", async () => {
    const mp3 = "https://m701.music.126.net/20260925213236/xxx.mp3?vuutv=token"
    stubFetch(() =>
      responseWithUrl(
        null,
        { status: 200, headers: { "Content-Type": "audio/mpeg" } },
        mp3
      )
    )
    expect(await resolveAudioUrl("netease:1330348068")).toBe(mp3)
  })

  it("200 + text/html 一律判失败 —— 上游挂掉时就是这个形态", async () => {
    // 实测 QQ 音乐（server=tencent）就是这样：状态码 200，body 是空 HTML。
    // 只看状态码会把它当成音乐地址交给播放器，用户看到的是「点了没反应」。
    stubFetch(
      () =>
        new Response("", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        })
    )
    expect(await resolveAudioUrl("netease:1")).toBeNull()
  })

  it("HTTP 非 2xx → null", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }))
    expect(await resolveAudioUrl("netease:1")).toBeNull()
  })

  it("网络异常 / 超时 → null，不把异常抛给调用方", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed")
    })
    expect(await resolveAudioUrl("netease:1")).toBeNull()
  })

  it("来源标记非法时一个请求都不发", async () => {
    stubFetch(() => {
      throw new Error("不该发请求")
    })
    expect(await resolveAudioUrl("netease:123&server=tencent")).toBeNull()
    expect(await resolveAudioUrl("evil:1")).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("拿到 http 地址一律拒绝（页面是 https，混合内容会被浏览器拦掉）", async () => {
    stubFetch(() =>
      responseWithUrl(
        null,
        { status: 200, headers: { "Content-Type": "audio/mpeg" } },
        "http://insecure.example.com/x.mp3"
      )
    )
    expect(await resolveAudioUrl("netease:1")).toBeNull()
  })
})

describe("解析结果的内存缓存", () => {
  // 编辑器预览是 650ms 防抖触发一次的，选中搜索歌曲后每次预览都会解析一遍；
  // 公开页每个访客每次播放也各解析一遍。没有缓存的话，我们自己正常的用量
  // 就能把第三方接口打爆（被限流后表现为「整个功能突然全挂」）。
  it("同一首歌第二次解析直接命中缓存，不再发请求", async () => {
    const mp3 = "https://m701.music.126.net/2026/cached.mp3?vuutv=t"
    stubFetch(() =>
      responseWithUrl(null, { status: 200, headers: { "Content-Type": "audio/mpeg" } }, mp3)
    )

    expect(await resolveAudioUrl("netease:777001")).toBe(mp3)
    expect(calls).toHaveLength(1)

    expect(await resolveAudioUrl("netease:777001")).toBe(mp3)
    expect(calls).toHaveLength(1) // 没有第二次请求
  })

  it("不同的歌各自缓存，互不串味", async () => {
    stubFetch((url) => {
      const id = /id=(\d+)/.exec(url)?.[1] ?? "0"
      return responseWithUrl(
        null,
        { status: 200, headers: { "Content-Type": "audio/mpeg" } },
        `https://cdn.example.com/${id}.mp3`
      )
    })

    expect(await resolveAudioUrl("netease:777002")).toBe("https://cdn.example.com/777002.mp3")
    expect(await resolveAudioUrl("netease:777003")).toBe("https://cdn.example.com/777003.mp3")
    expect(calls).toHaveLength(2)
  })

  it("解析失败**不写缓存**，下次还会重试（否则一次抖动会让这首歌永久哑掉）", async () => {
    let ok = false
    stubFetch(() =>
      ok
        ? responseWithUrl(
            null,
            { status: 200, headers: { "Content-Type": "audio/mpeg" } },
            "https://cdn.example.com/retry.mp3"
          )
        : new Response("", { status: 200, headers: { "Content-Type": "text/html" } })
    )

    expect(await resolveAudioUrl("netease:777004")).toBeNull()
    ok = true
    expect(await resolveAudioUrl("netease:777004")).toBe("https://cdn.example.com/retry.mp3")
    expect(calls).toHaveLength(2)
  })
})

describe("取歌词", () => {
  it("优先取带时间轴的 syncedLyrics", async () => {
    stubFetch(() =>
      jsonRes({
        syncedLyrics: "[00:25.94] 這一路上走走停停\n[00:29.39] 順著少年漂流的痕跡",
        plainLyrics: "這一路上走走停停\n順著少年漂流的痕跡",
      })
    )
    const lrc = await fetchLyrics("起风了", "买辣椒也用券")
    expect(lrc).toContain("[00:25.94]")
  })

  it("没有时间轴时退回纯文本（名片页会静态展示）", async () => {
    stubFetch(() => jsonRes({ syncedLyrics: null, plainLyrics: "只有纯文本" }))
    expect(await fetchLyrics("x", "y")).toBe("只有纯文本")
  })

  it("404（查不到这首歌）→ null，不抛错", async () => {
    stubFetch(() => new Response("", { status: 404 }))
    expect(await fetchLyrics("x", "y")).toBeNull()
  })

  it("歌词服务不可用 → null，绝不阻断「选歌」主流程", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed")
    })
    expect(await fetchLyrics("x", "y")).toBeNull()
  })

  it("歌名为空不发请求", async () => {
    stubFetch(() => {
      throw new Error("不该发请求")
    })
    expect(await fetchLyrics("  ", "y")).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
