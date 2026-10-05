/**
 * 名片音乐：按歌名搜索 + 运行时解析播放地址。
 *
 * 分成两件事，是因为**搜索与播放必须解耦**：
 *   - `searchMusic()`  输入歌名，输出候选列表（歌名/歌手/专辑/封面 + 稳定的来源标记）
 *   - `resolveAudioUrl()` 输入来源标记，输出**当下可播放**的音频地址
 *
 * ⚠️ 本文件最重要的一条纪律：**`resolveAudioUrl()` 的返回值绝不允许入库。**
 *
 * 音频源返回的是带时效签名的地址，形如
 *   https://m701.music.126.net/20260925213236/.../xxx.mp3?vuutv=<长令牌>
 * 路径里含时间戳、query 里含令牌，**大约 20 分钟后就失效**。
 * 一旦把解析结果落库，几小时后所有名片的背景音乐全部变成死链。
 * 所以库里只存 `provider:song_id`（见迁移 0053），播放地址每次实时解析。
 *
 * 同类事故参考：名片 QQ 按钮曾硬编码第三方 `res.abeim.cn`，该域名后来全线失联，
 * 线上所有用户的 QQ 按钮都点不开。别把第三方产物当数据存下来。
 *
 * ────────────────────────────────────────────────────────────────
 * 实测记录（2026-09-25，逐个 curl 验证，勿凭印象改动）
 *
 * ✅ 可用
 *   - 搜索  `api.vkeys.cn/v2/music/netease?word=<歌名>` → {id,song,singer,album,cover}
 *   - 解析  `api.injahow.cn/meting/?server=netease&type=url&id=<id>`
 *           → 302 到网易云 CDN 真实 mp3（audio/mpeg，支持 Range）
 *
 * ❌ 已失效 / 不可用（别再试）
 *   - `music.163.com/api/search/get`、`/api/cloudsearch/pc` → 恒返回 songCount:0（官方已封）
 *   - `api.i-meto.com/meting/api` 的 type=url → 404（type=song 能返回，但它给的 url 打不开）
 *   - `api.deezer.com` → 本机连不上（443 超时）
 *   - `music-api.gdstudio.xyz/api.php` → 空响应
 *   - `api.lolimi.cn`、`api.vvhan.com` → 域名已不存在（DNS 解析失败）
 *   - Vkeys 的 `kuwo` / `kugou` 子接口 → 404
 *   - **QQ 音乐（server=tencent）**：Vkeys 能搜到，但 injahow 解析返回 200 + 空 HTML
 *     → 搜出来也放不了，所以**不纳入可选平台**，免得用户选中后播不出来
 *
 * ⚠️ 因此搜索与解析目前**各只有一个可用主机**，「多源回退」只是结构上留了位置，
 *    并没有第二个真实可用的源。主机挂掉时的应对是：改下面两个常量 + 重新部署。
 *    好消息是**已经存好的名片不受影响** —— 库里只有 `netease:<id>`，
 *    换一个能解析的 Meting 兼容主机后，全部老名片立刻恢复播放。
 */

import { fetchWithTimeout } from "./async-utils"

/** 搜索超时（第三方接口，别让它拖住 Worker 请求） */
const SEARCH_TIMEOUT_MS = 8_000

/** 解析超时 */
const RESOLVE_TIMEOUT_MS = 8_000

/** 单次搜索最多返回多少条候选 */
const SEARCH_MAX_RESULTS = 12

/** 取歌词超时 */
const LYRICS_TIMEOUT_MS = 8_000

/**
 * 歌词接口（LRCLIB，免费公益项目，无需 key）。
 *
 * 官方要求带上能表明调用方的 UA，别用默认的 Cloudflare-Workers 值。
 */
const LYRICS_API = "https://lrclib.net/api/get"

const LYRICS_UA = "DoulorCloud/1.0 (https://cloud.doulor.cn)"

/**
 * 解析结果的内存短缓存。
 *
 * 为什么必须有：编辑器预览是**防抖后每 650ms 触发一次**的，选中搜索歌曲之后
 * 每改一个字（哪怕改的是签名）都会解析一遍；公开页每个访客每次播放也各解析一遍。
 * 不缓存的话，我们自己正常的用量就能把第三方接口打爆 —— 被对方按 IP 限流后
 * 表现为「整个功能突然全挂」。
 *
 * 为什么 TTL 只有 5 分钟：解析出来的地址约 20 分钟后失效，缓存时间必须**显著短于**
 * 地址本身的有效期，否则会把一个快要过期的地址发出去，表现为
 * 「别人能播、就我播不了」这种极难排查的故障。
 *
 * 只存在 isolate 内存里、不落库 —— 这是「播放地址不入库」那条纪律的延伸。
 */
const resolveCache = new Map<string, { url: string; at: number }>()

const RESOLVE_CACHE_TTL_MS = 5 * 60_000

/** 缓存条数上限，防止内存无限增长（超出后淘汰最旧的一条） */
const RESOLVE_CACHE_MAX = 200

/**
 * 搜索接口基地址（含平台路径段，调用时拼 `/<platform>?word=...`）。
 *
 * 目前只实测出这一个可用主机。要换源时改这里即可；
 * 建议换成自己部署的、或另一家 **格式相同** 的服务，避免同时改解析逻辑。
 */
const SEARCH_API_BASE = "https://api.vkeys.cn/v2/music"

/**
 * 解析接口基地址（Meting 兼容协议）。
 *
 * 协议：`<base>?server=<platform>&type=url&id=<songId>`
 *   - 常见实现会 302 到真实音频地址
 *   - 也有实现直接 200 流式返回音频
 * 两种都由 `resolveAudioUrl()` 兼容处理。
 */
const RESOLVE_API_BASE = "https://api.injahow.cn/meting/"

/**
 * 伪装成浏览器 UA。
 * 这类第三方接口与上游 CDN 常对默认的 `Cloudflare-Workers` UA 有风控，
 * 不带头会拿到 403 或空 body。
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

/**
 * 支持的平台白名单。
 *
 * 只收录「**搜索结果能被解析成音频**」的平台 —— 加进来之前必须两端都实测过，
 * 否则用户搜到了却播不出来，比搜不到更糟（实测 QQ 音乐就是这种情况）。
 */
const PLATFORMS = ["netease"] as const
type Platform = (typeof PLATFORMS)[number]

/** 一条可展示的搜索结果 */
export interface MusicTrack {
  /**
   * 稳定的来源标记，形如 `netease:1330348068`。
   * **这是唯一允许写入数据库的播放标识** —— 播放地址由它实时解析得到。
   */
  source: string
  title: string
  artist: string
  album: string
  /** https 封面地址；取不到时为 null。这个地址是长期的，可以入库。 */
  cover: string | null
}

/** 拆解 `netease:123` 形式的来源标记；格式不合法一律返回 null */
export function parseSource(
  source: string
): { platform: Platform; songId: string } | null {
  const idx = source.indexOf(":")
  if (idx <= 0) return null
  const platform = source.slice(0, idx)
  const songId = source.slice(idx + 1)
  if (!(PLATFORMS as readonly string[]).includes(platform)) return null
  if (!/^\d{1,20}$/.test(songId)) return null
  return { platform: platform as Platform, songId }
}

/** `netease:123` 是否是可识别的来源标记（供 handler 做入参校验） */
export function isValidSource(source: string): boolean {
  return parseSource(source) !== null
}

/**
 * 把上游返回的封面地址修成可安全入库/直接展示的形式。
 *
 * 上游给的是 `http://`（部分浏览器在 https 页面里会拦混合内容），
 * 且默认尺寸很小。网易云 CDN 支持用 `param=<w>y<h>` 取指定尺寸。
 */
function normalizeCover(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null
  let url = raw.trim().replace(/^http:\/\//i, "https://")
  if (!/^https:\/\//i.test(url)) return null
  // 已经带了 query 的就不再追加，避免拼出两个 ?
  if (url.includes("?")) return url
  return `${url}?param=500y500`
}

/** Vkeys 搜索响应的最小结构（第三方，一切字段都按可选处理） */
interface VkeysSearchResponse {
  code?: number
  message?: string
  data?: Array<Record<string, unknown>>
}

/** 把一条原始结果映射成 MusicTrack；缺关键字段的丢弃 */
function toTrack(raw: Record<string, unknown>): MusicTrack | null {
  const id = raw.id
  const songId = typeof id === "number" || typeof id === "string" ? String(id) : ""
  if (!/^\d{1,20}$/.test(songId)) return null

  // 歌名是必须的；歌手/专辑允许缺失，回落到占位文案而不是丢弃整条结果
  const title = typeof raw.song === "string" ? raw.song.trim() : ""
  if (!title) return null

  return {
    source: `netease:${songId}`,
    title,
    artist: typeof raw.singer === "string" ? raw.singer.trim() : "",
    album: typeof raw.album === "string" ? raw.album.trim() : "",
    cover: normalizeCover(raw.cover),
  }
}

/**
 * 按歌名搜索。
 *
 * 抛错而不是返回空数组，是为了让调用方能区分「没搜到」和「服务挂了」——
 * 两者给用户的提示完全不同（前者改关键词，后者走自定义上传/外链那条路）。
 */
export async function searchMusic(query: string): Promise<MusicTrack[]> {
  const word = query.trim()
  if (!word) return []

  const url =
    `${SEARCH_API_BASE}/netease?word=${encodeURIComponent(word)}` +
    `&page=1&num=${SEARCH_MAX_RESULTS}`

  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: "application/json", "User-Agent": UA } },
    SEARCH_TIMEOUT_MS
  )
  if (!res.ok) {
    throw new Error(`搜索服务返回 HTTP ${res.status}`)
  }

  let data: VkeysSearchResponse
  try {
    data = (await res.json()) as VkeysSearchResponse
  } catch {
    throw new Error("搜索服务返回的不是合法 JSON")
  }

  if (data.code !== 200 || !Array.isArray(data.data)) {
    throw new Error(data.message || "搜索服务返回异常")
  }

  const out: MusicTrack[] = []
  for (const item of data.data) {
    if (!item || typeof item !== "object") continue
    const track = toTrack(item as Record<string, unknown>)
    if (track) out.push(track)
  }
  return out
}

/**
 * 把来源标记解析成**当下可播放**的音频地址。
 *
 * 解析不出来一律返回 null（调用方给 404），不抛错 —— 这是给浏览器 `<audio>`
 * 用的，抛错没有意义，而且失败原因（服务挂了 / 那首歌下架了）对访客没区别。
 *
 * ⚠️ 返回值带时效签名，**只能直接用于本次响应，不可持久化**。
 */
export async function resolveAudioUrl(source: string): Promise<string | null> {
  const parsed = parseSource(source)
  if (!parsed) return null

  const cached = resolveCache.get(source)
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL_MS) {
    return cached.url
  }

  const url =
    `${RESOLVE_API_BASE}?server=${parsed.platform}` +
    `&type=url&id=${encodeURIComponent(parsed.songId)}`

  try {
    // follow 而不是 manual：不同 Meting 部署有的 302 跳转、有的直接流式返回，
    // 跟随重定向后 `res.url` 两种情况都能拿到最终地址。
    const res = await fetchWithTimeout(
      url,
      { redirect: "follow", headers: { Accept: "*/*", "User-Agent": UA } },
      RESOLVE_TIMEOUT_MS
    )

    if (!res.ok) {
      void res.body?.cancel()
      return null
    }

    // 关键校验：必须是音频。
    // 上游失败时会返回 200 + 空 HTML（实测 QQ 音乐就是如此），
    // 只看状态码会把一个空页面当成音乐地址交给播放器，表现为「点了没反应」。
    //
    // ⚠️ 2026-10-05（用户 masters 反馈「名片音乐显示 0 秒」）：网易云 CDN 的**部分
    //    边缘节点**会把 mp3 标成 `application/octet-stream;charset=UTF-8`（不是
    //    audio/mpeg），只认 `audio/*` 会把这些**好用的**地址判死 → 静默 404 →
    //    播放器时长读到 0。不同节点/不同歌时好时坏，所以表现为「间歇性」。
    //    放行 octet-stream，但要求最终地址确实指向音频文件（挡住「200 + 错误页」）。
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
    const isAudioType = /^audio\//i.test(contentType)
    const isOctetStream = contentType.startsWith("application/octet-stream")
    const finalUrl = res.url || url
    const looksLikeAudioFile = /\.(mp3|m4a|flac|aac|ogg|opus|wav)([?#]|$)/i.test(finalUrl)
    if (!isAudioType && !(isOctetStream && looksLikeAudioFile)) {
      void res.body?.cancel()
      return null
    }

    // 不消费 body：这里只要地址，把连接还回去
    void res.body?.cancel()

    if (!/^https:\/\//i.test(finalUrl)) return null

    // 写缓存。超出上限时淘汰最旧的一条（Map 保持插入顺序，第一个就是最旧的）
    if (resolveCache.size >= RESOLVE_CACHE_MAX) {
      const oldest = resolveCache.keys().next().value
      if (oldest !== undefined) resolveCache.delete(oldest)
    }
    resolveCache.set(source, { url: finalUrl, at: Date.now() })

    return finalUrl
  } catch {
    return null
  }
}

/**
 * 按「歌名 + 歌手」取歌词，返回 LRC 文本（带 `[mm:ss.xx]` 时间轴）。
 *
 * 实测（2026-09-25）：`lrclib.net/api/get?track_name=&artist_name=` 返回
 * `{ syncedLyrics, plainLyrics, ... }`，其中 `syncedLyrics` 正好就是名片页
 * 滚动歌词要的格式，命中率高且完全免费。
 *
 * ⚠️ 刻意只用 `/api/get`（精确匹配），**不用 `/api/search`**：
 *   同名翻唱、live 版、纯伴奏版满天飞，自动从一堆结果里挑「最像的」，
 *   很可能挑到一首完全不相干的歌词 —— 而这种错误用户几乎不会发现
 *   （没人会逐字核对背景音乐的歌词）。宁可留空让他自己填，
 *   也别把错的歌词当成对的存进库。
 *
 * 取不到返回 null（包括服务不可用），不抛错 —— 歌词是锦上添花，
 * 绝不能因为它挂掉而阻断「选歌」这个主流程。
 */
export async function fetchLyrics(
  title: string,
  artist: string
): Promise<string | null> {
  const trackName = title.trim()
  if (!trackName) return null

  const url =
    `${LYRICS_API}?track_name=${encodeURIComponent(trackName)}` +
    `&artist_name=${encodeURIComponent(artist.trim())}`

  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: "application/json", "User-Agent": LYRICS_UA } },
      LYRICS_TIMEOUT_MS
    )
    if (!res.ok) return null

    const data = (await res.json()) as {
      syncedLyrics?: unknown
      plainLyrics?: unknown
    }
    const synced =
      typeof data.syncedLyrics === "string" ? data.syncedLyrics.trim() : ""
    if (synced) return synced

    // 没有时间轴时退回纯文本：名片页会渲染成静态歌词（不滚动、不报错）
    const plain =
      typeof data.plainLyrics === "string" ? data.plainLyrics.trim() : ""
    return plain || null
  } catch {
    return null
  }
}
