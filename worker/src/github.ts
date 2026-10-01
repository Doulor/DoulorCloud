/**
 * GitHub 只读查询（目前只有一件事：判断某人有没有给仓库点过 star）。
 *
 * 用在哪：活动参与条件 `github_star` —— 用户填自己的 GitHub 用户名，
 * 我们核对它是否出现在目标仓库的 stargazers 列表里，是则允许领取奖励。
 *
 * ⚠️ **必须缓存整个 stargazers 列表**，不能「一个人一次请求」：
 *   GitHub 对**未鉴权**请求只给 60 次/小时，而且是按**出口 IP** 算的。
 *   Cloudflare Worker 的出口 IP 是共享的，几十个用户同时领就把额度打光，
 *   表现成「活动突然所有人都领不了」。列表缓存 5 分钟后，
 *   无论多少人来领都只消耗 1 次请求。
 *
 * 可选增强：给 Worker 配 `GITHUB_TOKEN` 环境变量（Setting → Variables and Secrets）。
 * 有 token 时限额提到 5000 次/小时，且**私有仓库**也读得到（没有 token 时私有仓库一律 404）。
 */
import type { Env } from "./env"

/** stargazers 列表缓存时长：够短（新点的 star 最多 5 分钟后生效）、够长（省限额） */
const CACHE_TTL_MS = 5 * 60 * 1000
/** 单次最多翻多少页（每页 100）—— 超出这个规模的仓库，后面的 star 认不出来 */
const MAX_PAGES = 10

interface CachedStargazers {
  repo: string
  at: number
  /** 小写的 GitHub 用户名集合（GitHub 用户名大小写不敏感） */
  logins: Set<string>
  /** 是否被上限截断（截断时后面的 star 认不出来，要如实告诉管理员） */
  truncated: boolean
}

let cache: CachedStargazers | null = null

/**
 * 最近一次读取失败的原因（人类可读）。
 *
 * 为什么要留这个：失败有两大类，处理方式完全不同 ——
 *   ① Token 权限不足（GitHub 会在 403 里用 `x-accepted-github-permissions`
 *      写明它要什么权限，比如 star 名单要 `contents=write`）；
 *   ② 仓库不存在 / 是私有仓库（404）。
 * 只回一句「无法核验」，管理员会以为是仓库或网络问题，根本想不到是 Token 权限。
 */
let lastError: string | null = null

/** 判断 `owner/repo` 是否像个合法仓库名 */
export function isRepoSlug(v: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.trim())
}

/**
 * 拉取一个仓库的全部 stargazers（带缓存）。
 *
 * 失败（404 仓库不存在/私有、403 限额打光、网络错误）一律返回 null ——
 * 调用方按「核验不了」处理，**不要**当成「没点 star」：那会误伤真实用户。
 */
async function loadStargazers(
  env: Env,
  repo: string
): Promise<CachedStargazers | null> {
  const now = Date.now()
  if (cache && cache.repo === repo && now - cache.at < CACHE_TTL_MS) return cache

  const token = (env as unknown as { GITHUB_TOKEN?: string }).GITHUB_TOKEN
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "doulor-cloud-event-check",
    "x-github-api-version": "2022-11-28",
  }
  if (token) headers.authorization = `Bearer ${token}`

  const logins = new Set<string>()
  let truncated = false
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/stargazers?per_page=100&page=${page}`,
        { headers }
      )
      if (!res.ok) {
        // GitHub 在 403 里回一个 "需要的权限" 头，直接照抄给管理员最省事
        const need = res.headers.get("x-accepted-github-permissions")
        if (res.status === 403 && need) {
          lastError =
            `GitHub 拒绝了读取：当前 Token 缺少权限（它要求 ${need}）。` +
            `请在 GitHub 上编辑这个 Token，把「Contents」设为 Read and write，` +
            `或改用 classic token 并勾上 public_repo。`
        } else if (res.status === 404) {
          lastError = `仓库 ${repo} 不存在，或者它是私有仓库（私有仓库读不到 star 名单）`
        } else {
          lastError = `GitHub 返回 ${res.status}`
        }
        console.error("读取 GitHub stargazers 失败:", repo, res.status, need ?? "")
        return null
      }
      const list = (await res.json()) as { login?: string }[]
      if (!Array.isArray(list)) return null
      for (const u of list) if (u?.login) logins.add(u.login.toLowerCase())
      if (list.length < 100) break
      if (page === MAX_PAGES) truncated = true
    }
  } catch (err) {
    console.error("读取 GitHub stargazers 异常:", repo, err)
    return null
  }

  lastError = null
  cache = { repo, at: now, logins, truncated }
  return cache
}

/**
 * 备用路径：看「这个人 star 过哪些仓库」（`GET /users/{name}/starred`）。
 *
 * 为什么需要它：star 名单接口（`/repos/{o}/{r}/stargazers`）从 2026 年起要求 Token
 * 具备 `contents=write`。而**这个**接口只要 `starring=read`（多数 Token 本来就有），
 * 于是「名单读不了」不等于「活动没法用」—— 换条路照样能核验。
 *
 * ⚠️ 局限（会在返回的 error 里说清）：
 *   - 用户在 GitHub 上把自己的 star 列表设为**私密**时读不到（返回空列表）；
 *   - 该用户的 star 很多时要多翻几页（最多 MAX_PAGES 页，按 starred 时间倒序，
 *     刚点的一般在首页，所以实际很少翻页）。
 */
const userStarCache = new Map<string, { at: number; repos: Set<string> | null }>()
/** 缓存上限：防止被大量不同用户名的请求撑爆内存（Workers 实例会被回收，够用） */
const USER_STAR_CACHE_MAX = 300
/**
 * 「**没查到**」只缓存这么久。
 *
 * 为什么不能跟命中一样缓存 5 分钟：用户点完 star 立刻来领是**最常见的路径**，
 * 而他的 star 列表在点之前就已经被查过一次（上一次失败的尝试）的话，
 * 5 分钟内都会拿着旧结果说「没查到」，用户会觉得「我明明点了」。
 * 命中的结果不会变坏，可以放心缓存久一点。
 */
const MISS_CACHE_TTL_MS = 60 * 1000

async function isStarredViaUserList(
  env: Env,
  repo: string,
  username: string
): Promise<StarCheck> {
  const key = username.toLowerCase()
  const hit = userStarCache.get(key)
  // 命中（repos 非空）缓存 5 分钟；「没查到」（repos 为空）只缓存 1 分钟
  const hitTtl = hit?.repos ? CACHE_TTL_MS : MISS_CACHE_TTL_MS
  if (hit && Date.now() - hit.at < hitTtl) {
    if (!hit.repos) {
      return { ok: false, error: `读不到 ${username} 的 star 列表（可能被设为私密），请把它设为公开后重试` }
    }
    return { ok: hit.repos.has(repo.toLowerCase()) }
  }

  const token = (env as unknown as { GITHUB_TOKEN?: string }).GITHUB_TOKEN
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "doulor-cloud-event-check",
    "x-github-api-version": "2022-11-28",
  }
  if (token) headers.authorization = `Bearer ${token}`

  const repos = new Set<string>()
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.github.com/users/${encodeURIComponent(username)}/starred?per_page=100&page=${page}`,
        { headers }
      )
      if (res.status === 404) {
        return { ok: false, error: `GitHub 上找不到用户 ${username}` }
      }
      if (!res.ok) {
        return { ok: false, error: `读取 ${username} 的 star 列表失败（GitHub 返回 ${res.status}）` }
      }
      const list = (await res.json()) as { full_name?: string }[]
      if (!Array.isArray(list)) break
      for (const r of list) if (r?.full_name) repos.add(r.full_name.toLowerCase())
      if (list.length < 100) break
    }
  } catch (err) {
    console.error("读取用户 star 列表异常:", username, err)
    return { ok: false, error: "读取 GitHub star 列表时网络异常，请稍后再试" }
  }

  if (userStarCache.size >= USER_STAR_CACHE_MAX) userStarCache.clear()
  userStarCache.set(key, { at: Date.now(), repos: repos.size ? repos : null })
  if (repos.size === 0) {
    return {
      ok: false,
      error: `读不到 ${username} 的 star 列表（要么没 star 过任何仓库，要么把 star 列表设为私密了）`,
    }
  }
  return { ok: repos.has(repo.toLowerCase()) }
}

/** 核验结果：`ok` 是结论，`error` 非空表示「查不了」（与「没点 star」区分开） */
export interface StarCheck {
  ok: boolean
  /** 查不了时的原因（会显示给用户/管理员） */
  error?: string
  /** 是否因为仓库 star 太多、只核对了前 MAX_PAGES*100 个人 */
  truncated?: boolean
}

/**
 * 判断 `username` 是否给 `repo` 点过 star。
 *
 * 返回 `error` 的三种情况（都会让活动方给出「稍后再试」而不是「你没点 star」）：
 *   - 仓库地址不合法
 *   - 仓库不存在或**是私有仓库**（未鉴权时 GitHub 一律 404）—— 私有仓库无法做 star 活动
 *   - 限额打光 / 网络异常
 */
export async function checkStarred(
  env: Env,
  repo: string,
  username: string
): Promise<StarCheck> {
  const slug = repo.trim()
  const who = username.trim().replace(/^@/, "").toLowerCase()
  if (!isRepoSlug(slug)) {
    return { ok: false, error: "活动配置的仓库地址不合法（应形如 owner/repo）" }
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(who)) {
    return { ok: false, error: "GitHub 用户名不合法（只能包含字母、数字和连字符）" }
  }

  const hasToken = Boolean((env as unknown as { GITHUB_TOKEN?: string }).GITHUB_TOKEN)
  // ① 首选：读仓库的 star 名单（一次请求、与用户隐私设置无关，但要求 contents=write）
  const data = await loadStargazers(env, slug)
  // ② 名单读不了（多半是 Token 权限不够）→ 换成读「这个人的 star 列表」，
  //    它只要 starring=read，能让活动在权限不齐的情况下照样跑起来。
  if (!data) {
    const fallback = await isStarredViaUserList(env, slug, who)
    if (!fallback.error) return fallback
    // 两条路都不通：把**首选路径**的原因一并带上 —— 否则管理员只看到
    // 「读某人的 star 列表失败 403」，根本想不到要去补 Token 权限。
    const why = hasToken
      ? (lastError ?? "读不到仓库的 star 名单")
      : "站点未配置 GitHub Token（GitHub 要求鉴权才返回 star 名单）"
    return { ok: false, error: `${why}；备用方式（读 ${username} 的 star 列表）也没成功：${fallback.error}` }
  }
  return { ok: data.logins.has(who), truncated: data.truncated }
}
