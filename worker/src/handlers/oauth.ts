/**
 * OAuth 2.0 授权服务器：HTTP 层。
 *
 * 协议端点（给第三方站点用）：
 *   GET  /oauth/authorize            浏览器导航入口（授权码流程起点）
 *   POST /oauth/token                服务器间：code 换 access_token
 *   GET  /oauth/userinfo             服务器间：access_token 换用户信息
 *   GET  /.well-known/openid-configuration   OIDC 发现文档
 *
 * 站内端点（给本站 SPA 用，需登录）：
 *   GET  /api/oauth/authorize/context   同意页展示信息（应用名 / scope）
 *   POST /api/oauth/authorize/decision  同意或拒绝
 *   GET  /api/oauth/grants              我授权过的应用
 *   DELETE /api/oauth/grants/:clientId  撤销授权
 *
 * 管理端点（需管理员）：
 *   /api/admin/oauth/clients 系列
 */
import { ApiError, json, SAFE_JSON_HEADERS } from "../http"
import { requireUser } from "../auth"
import { guardRateLimit, clientIp } from "../ratelimit"
import { requireAdmin } from "./admin"
import {
  createClient,
  deleteClient,
  discoveryDocument,
  getClientByInternalId,
  hasGrant,
  isRedirectUriAllowed,
  issueAccessToken,
  issueCode,
  listClients,
  loadClientByClientId,
  normalizeScopes,
  rememberGrant,
  resetClientSecret,
  revokeGrant,
  toPublicClient,
  updateClient,
  verifyAccessToken,
  verifyClientSecret,
  buildUserInfo,
  redeemCode,
  assertScopesAllowed,
  type OAuthClientRow,
} from "../oauth-provider"
import type { Env } from "../env"

// ---- 通用小工具 ----

function originOf(request: Request): string {
  return new URL(request.url).origin
}

/**
 * OIDC **协议元数据**的规范来源（issuer、picture 用它；重定向不用）。
 *
 * ⚠️ 2026-09-25 审计（L19）：原先 issuer / picture 直接取
 * `new URL(request.url).origin`，也就是**由 Host 头决定**。于是同一个部署
 * 通过 `*.workers.dev` 访问时，发现文档会宣告一个**完全不同的 issuer**：
 *   · OIDC 客户端把 discovery 的 issuer 与它缓存/校验的值做严格比对，
 *     多 issuer 会让「自动发现」时好时坏，且极难排查；
 *   · 更根本的是，它把**请求方可控的 Host** 变成了协议元数据的一部分 ——
 *     协议层不该信任 Host。
 *
 * 优先级：
 *   1. `OAUTH_ISSUER_ORIGIN`（显式配置，最优先，去掉尾部斜杠）；
 *   2. 本机调试（localhost / 127.0.0.1 / [::1] / *.localhost）→ 用请求本身，
 *      否则 `wrangler dev` 上根本没法自测；
 *   3. `*.workers.dev` → 回落到正式站点 `https://cloud.<ROOT_DOMAIN>`，
 *      不让预览域名污染协议元数据；
 *   4. 其余（自定义域名）→ 用请求 origin，兼容多域名/自建部署。
 *
 * 注意**重定向**（`/login?next=`、`/oauth/consent`）仍然用 `originOf(request)`：
 * 用户此刻确实在浏览那个 origin，把他跳到另一个域名上是错的。
 * 只有「对外宣告的协议元数据」才必须收敛到规范来源。
 */
function canonicalOrigin(env: Env, request: Request): string {
  const configured = env.OAUTH_ISSUER_ORIGIN?.trim()
  if (configured) return configured.replace(/\/+$/, "")

  const url = new URL(request.url)
  const host = url.hostname.toLowerCase()
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost")
  if (isLocal) return url.origin

  if (host.endsWith(".workers.dev")) return `https://cloud.${env.ROOT_DOMAIN}`

  return url.origin
}

/**
 * OAuth 端点的根地址。
 *
 * ⚠️ 必须带 `/api` —— 见 index.ts 路由表里的长注释：本站的 API Worker 只被挂了
 * `api/* dl/* p/* u/* c/* profile/*` 这些 Route，根级的 /oauth/* 会落到静态 Worker
 * 被 SPA 兜底成 index.html。所以整套协议端点都在 /api 之下，
 * OIDC 规范允许 issuer 带路径，issuer 就是这里返回的值。
 */
function oauthBase(env: Env, request: Request): string {
  return `${canonicalOrigin(env, request)}/api`
}

/** 给回调地址追加查询参数。用 URL 对象而不是字符串拼接，避免踩到已有参数/编码。 */
function appendQuery(uri: string, params: Record<string, string>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

/** 无法安全回跳时的错误页（例如 client 不存在 / redirect_uri 未注册） */
function htmlError(message: string, status = 400): Response {
  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权失败</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#fafafa;color:#18181b;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.card{max-width:420px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{color:#71717a;font-size:14px;margin:0;line-height:1.6}</style></head>
<body><div class="card"><h1>授权失败</h1><p>${escapeHtml(message)}</p></div></body></html>`
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // ⚠️ 2026-09-25 审计（L20）：这是全站唯一一处 Worker 直接渲染 HTML 的响应，
      // 而它**没有带任何安全头**（JSON 响应走 `json()` 会自动带 SAFE_JSON_HEADERS）。
      // 虽然页面本身已经对 message 做了转义，但少一层纵深防御没有理由 ——
      // 补上 nosniff（防止按内容嗅探类型）与 no-referrer（防止把带参数的
      // 授权 URL 通过 Referer 泄漏给第三方）。
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** OAuth 规范定义的错误响应（token / 授权回跳都用这个形状） */
function oauthError(
  error: string,
  status = 400,
  description?: string
): Response {
  return json(
    description ? { error, error_description: description } : { error },
    status
  )
}

// ---- 发现文档 ----

/**
 * `/.well-known/openid-configuration`
 *
 * ⚠️ 必须带 CORS 响应头。NewAPI 的「自动发现」是在**浏览器**里 fetch 这个文档的
 * （管理页点「自动发现」按钮）。没有 CORS 头时浏览器会拦掉响应，
 * 界面报「获取 OIDC 配置失败。请检查 URL 和网络状态」——
 * 而 curl / 服务端请求都完全正常，极易被误判成网络或防火墙问题。
 *
 * 这是公开文档、不含任何隐私，用 `*` 即可。
 * 用 `json()` 不行 —— 它不接受自定义响应头，所以这里手写 Response。
 *
 * 注：本端点是协议里唯一会被浏览器直接 fetch 的，token / userinfo 都是
 * 服务端之间调用（且我们只支持 client_secret_post 的机密客户端），故不给它们开 CORS。
 */
export async function openidConfiguration(
  env: Env,
  request: Request
): Promise<Response> {
  return new Response(JSON.stringify(discoveryDocument(oauthBase(env, request))), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...SAFE_JSON_HEADERS,
    },
  })
}

// ---- 授权入口 ----

export async function authorize(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const q = url.searchParams
  const origin = originOf(request)

  const clientId = q.get("client_id") ?? ""
  const redirectUri = q.get("redirect_uri") ?? ""
  const responseType = q.get("response_type") ?? "code"
  const state = q.get("state") ?? ""
  const scope = normalizeScopes(q.get("scope"))
  const codeChallenge = q.get("code_challenge")
  const codeChallengeMethod = q.get("code_challenge_method")

  if (!clientId) return htmlError("缺少 client_id")
  if (!redirectUri) return htmlError("缺少 redirect_uri")

  // ① client 必须存在且启用。此时还不能回跳 —— 我们尚不知道 redirect_uri 是否可信。
  const client = await loadClientByClientId(env, clientId)
  if (!client) return htmlError("应用不存在，请检查 client_id")
  if (client.disabled === 1) return htmlError("该应用已被停用")

  // ② 回调地址必须精确匹配。**只有通过这一步之后才允许往回跳**，
  //    否则会把错误信息（乃至授权码）发到攻击者控制的地址。
  if (!isRedirectUriAllowed(client, redirectUri)) {
    return htmlError("回调地址未在该应用注册，已拒绝授权")
  }

  // ③ 从这一步开始，错误可以按规范带 state 回跳给对方
  if (responseType !== "code") {
    return Response.redirect(
      appendQuery(redirectUri, { error: "unsupported_response_type", state }),
      302
    )
  }
  try {
    assertScopesAllowed(scope)
  } catch {
    return Response.redirect(
      appendQuery(redirectUri, {
        error: "invalid_scope",
        error_description: `不支持的 scope：${scope}`,
        state,
      }),
      302
    )
  }
  // PKCE：只支持 S256，且 challenge / method 必须成对出现（L15）
  // 与同意页共用 validatePkce()，避免两处规则漂移 —— 这里只是把
  // 抛出的 ApiError 换成按规范「带 error 回跳」的响应形式。
  let pkceChallenge: string | null
  try {
    pkceChallenge = validatePkce(codeChallenge, codeChallengeMethod)
  } catch (err) {
    const description = err instanceof ApiError ? err.message : "PKCE 参数不合法"
    return Response.redirect(
      appendQuery(redirectUri, {
        error: "invalid_request",
        error_description: description,
        state,
      }),
      302
    )
  }

  // ④ 必须已登录本站。未登录则先去登录，登录后自动回到本页面继续授权
  let userId: string
  try {
    const user = await requireUser(env, request)
    userId = user.id
  } catch {
    const back = encodeURIComponent(url.pathname + url.search)
    return Response.redirect(`${origin}/login?next=${back}`, 302)
  }

  // ⑤ 已经同意过且 scope 未扩大 → 直接发码，不再打扰用户
  if (await hasGrant(env, userId, client.client_id, scope)) {
    const code = await issueCode(env, {
      clientId: client.client_id,
      userId,
      redirectUri,
      scopes: scope,
      // 用校验过的值，保证与同意页路径完全一致
      codeChallenge: pkceChallenge,
      codeChallengeMethod: pkceChallenge ? codeChallengeMethod : null,
    })
    return Response.redirect(appendQuery(redirectUri, { code, state }), 302)
  }

  // ⑥ 需要用户确认 → 交给 SPA 的同意页
  return Response.redirect(`${origin}/oauth/consent?${q.toString()}`, 302)
}

// ---- 同意页用到的两个站内接口 ----

/**
 * PKCE 参数校验（2026-09-25 审计 L15）—— **两个授权入口必须共用这一份**。
 *
 * 原状况：校验只写在 `authorize()` 里，而 `authorizeDecision()`（同意页提交）
 * 直接把 `params.get("code_challenge_method")` 原样透传给 `issueCode`。
 * 于是走同意页这条路时：
 *   - `code_challenge_method=plain` 会被照单全收入库；
 *   - 而兑换端只认 S256 → 这个 code **永远兑换不成功**（用户看到的是「授权失败」，
 *     排查时完全想不到是同意页少了一次校验）；
 *   - 同时 `code_challenge_method` 带了、`code_challenge` 没带也会被放行，
 *     等于把 PKCE 静默降级成「无 PKCE」—— 拦截到 code 的人可以直接兑换。
 *
 * RFC 7636：`code_challenge` 与 `code_challenge_method` 必须成对出现；
 * 本站只支持 S256。返回 null 表示「本次不使用 PKCE」。
 */
function validatePkce(
  codeChallenge: string | null,
  codeChallengeMethod: string | null
): string | null {
  if (!codeChallenge && !codeChallengeMethod) return null
  if (codeChallengeMethod !== "S256") {
    throw new ApiError(
      400,
      "code_challenge_method 只支持 S256",
      "INVALID_REQUEST"
    )
  }
  if (!codeChallenge) {
    throw new ApiError(
      400,
      "code_challenge_method 与 code_challenge 必须同时提供",
      "INVALID_REQUEST"
    )
  }
  return codeChallenge
}

async function parseAuthorizeRequest(
  env: Env,
  params: URLSearchParams
): Promise<{
  client: OAuthClientRow
  redirectUri: string
  scope: string
  state: string
  codeChallenge: string | null
  codeChallengeMethod: string | null
}> {
  const clientId = params.get("client_id") ?? ""
  const redirectUri = params.get("redirect_uri") ?? ""
  const state = params.get("state") ?? ""
  const scope = normalizeScopes(params.get("scope"))
  const codeChallengeMethod = params.get("code_challenge_method")
  // 校验在**这里**做，而不是在各调用点 —— 这是本次修复的要点
  const codeChallenge = validatePkce(
    params.get("code_challenge"),
    codeChallengeMethod
  )

  if (!clientId || !redirectUri) {
    throw new ApiError(400, "缺少 client_id 或 redirect_uri", "INVALID_REQUEST")
  }

  const client = await loadClientByClientId(env, clientId)
  if (!client) throw new ApiError(404, "应用不存在", "NOT_FOUND")
  if (client.disabled === 1) throw new ApiError(403, "该应用已被停用", "FORBIDDEN")
  if (!isRedirectUriAllowed(client, redirectUri)) {
    throw new ApiError(400, "回调地址未注册", "INVALID_REDIRECT_URI")
  }
  assertScopesAllowed(scope)

  return {
    client,
    redirectUri,
    scope,
    state,
    codeChallenge,
    codeChallengeMethod: codeChallenge ? codeChallengeMethod : null,
  }
}

/** GET /api/oauth/authorize/context —— 同意页展示「谁在申请什么」 */
export async function authorizeContext(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const { client, scope } = await parseAuthorizeRequest(env, url.searchParams)

  // 已经授权过就直接告诉前端「无需确认」，由前端回调 authorize 走快捷路径
  const granted = await hasGrant(env, user.id, client.client_id, scope)

  return json({
    clientName: client.name,
    clientId: client.client_id,
    scopes: scope.split(/\s+/).filter(Boolean),
    alreadyGranted: granted,
  })
}

/**
 * POST /api/oauth/authorize/decision —— 同意 / 拒绝。
 * 返回 `{ redirectTo }` 让前端自己跳（而不是这里 302），
 * 这样 SPA 能在跳走前先清理自己的临时状态。
 */
export async function authorizeDecision(
  env: Env,
  request: Request
): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as Record<string, unknown>

  // 从 body 重建参数（前端会把原样的授权请求参数带回来）
  const params = new URLSearchParams()
  for (const key of [
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "response_type",
  ]) {
    const v = body[key]
    if (typeof v === "string" && v) params.set(key, v)
  }

  const { client, redirectUri, scope, state, codeChallenge, codeChallengeMethod } =
    await parseAuthorizeRequest(env, params)

  // 拒绝：按规范带 error 回跳，不发任何令牌
  if (body.approve !== true) {
    return json({
      redirectTo: appendQuery(redirectUri, { error: "access_denied", state }),
    })
  }

  // 记住这次同意（下次同 scope 不再弹窗）
  await rememberGrant(env, user.id, client.client_id, scope)

  const code = await issueCode(env, {
    clientId: client.client_id,
    userId: user.id,
    redirectUri,
    scopes: scope,
    // ⚠️ L15：必须用 parseAuthorizeRequest **校验过**的值，
    // 不能再从原始 params 里取（那样等于绕过校验）
    codeChallenge,
    codeChallengeMethod,
  })

  return json({ redirectTo: appendQuery(redirectUri, { code, state }) })
}

// ---- Token 端点 ----

/** token 端点限流：同一 IP 10 分钟 60 次（防爆破 code / client_secret） */
const TOKEN_IP_LIMIT = 60
const TOKEN_WINDOW_SECONDS = 600

export async function token(env: Env, request: Request): Promise<Response> {
  await guardRateLimit(
    env,
    `oauth:token:ip:${clientIp(request)}`,
    TOKEN_IP_LIMIT,
    TOKEN_WINDOW_SECONDS,
    "令牌请求过于频繁"
  )

  // NewAPI 发的是 application/x-www-form-urlencoded；同时兼容 JSON 便于自测
  let params: URLSearchParams
  const contentType = request.headers.get("Content-Type") ?? ""
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>
    params = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) params.set(k, String(v))
    }
  } else {
    params = new URLSearchParams(await request.text())
  }

  const grantType = params.get("grant_type") ?? ""
  const clientId = params.get("client_id") ?? ""
  const clientSecret = params.get("client_secret") ?? ""
  const code = params.get("code") ?? ""
  const redirectUri = params.get("redirect_uri") ?? ""
  const codeVerifier = params.get("code_verifier")

  if (grantType !== "authorization_code") {
    return oauthError("unsupported_grant_type", 400, "只支持 authorization_code")
  }
  if (!clientId || !clientSecret) {
    return oauthError("invalid_client", 401, "缺少 client_id 或 client_secret")
  }

  const client = await loadClientByClientId(env, clientId)
  // client 不存在与密钥错误返回同一个错误，避免泄露哪些 client_id 有效
  if (!client || client.disabled === 1) return oauthError("invalid_client", 401)
  if (!(await verifyClientSecret(client, clientSecret))) {
    return oauthError("invalid_client", 401)
  }

  if (!code) return oauthError("invalid_request", 400, "缺少 code")

  let redeemed: { userId: string; scopes: string }
  try {
    redeemed = await redeemCode(env, {
      code,
      client,
      redirectUri,
      codeVerifier,
    })
  } catch {
    // 不区分「码不存在 / 已用 / 过期 / redirect_uri 不符」——
    // 细分只会给攻击者提供探测信息
    return oauthError("invalid_grant", 400, "授权码无效或已过期")
  }

  // 用户可能在此期间被停用
  const user = await env.DB.prepare("SELECT status FROM users WHERE id = ? LIMIT 1")
    .bind(redeemed.userId)
    .first<{ status: string }>()
  if (!user || user.status !== "active") {
    return oauthError("invalid_grant", 400, "账号不可用")
  }

  const { accessToken, expiresIn } = await issueAccessToken(env, {
    clientId: client.client_id,
    userId: redeemed.userId,
    scopes: redeemed.scopes,
  })

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: redeemed.scopes,
  })
}

// ---- UserInfo 端点 ----

/** 带 WWW-Authenticate 的 401。json() 不支持自定义头，所以这里手写 Response。 */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Bearer realm="doulor", error="invalid_token"',
    },
  })
}

export async function userinfo(env: Env, request: Request): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return unauthorized()

  const info = await verifyAccessToken(env, m[1].trim())
  if (!info) return unauthorized()

  // L19：picture 用**规范来源**而不是请求 origin —— 头像地址一旦跟着 Host 变，
  // 同一个用户在客户端侧就会被当成两个不同的人（缓存与去重都会出问题）。
  const payload = await buildUserInfo(
    env,
    info.userId,
    info.scopes,
    canonicalOrigin(env, request)
  )
  if (!payload) return unauthorized()

  return json(payload)
}

// ---- 用户自助：查看 / 撤销已授权应用 ----

export async function listMyGrants(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const res = await env.DB.prepare(
    `SELECT g.client_id, g.scopes, g.created_at, c.name
       FROM oauth_grants g
       LEFT JOIN oauth_clients c ON c.client_id = g.client_id
      WHERE g.user_id = ?
      ORDER BY g.created_at DESC`
  )
    .bind(user.id)
    .all<{ client_id: string; scopes: string; created_at: string; name: string | null }>()

  return json({
    grants: (res.results ?? []).map((r) => ({
      clientId: r.client_id,
      // 应用被删除后名字会缺失，退回显示 client_id 便于用户辨认
      name: r.name ?? r.client_id,
      scopes: r.scopes.split(/\s+/).filter(Boolean),
      createdAt: r.created_at,
    })),
  })
}

export async function revokeMyGrant(
  env: Env,
  request: Request,
  clientId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  await revokeGrant(env, user.id, decodeURIComponent(clientId))
  return json({ ok: true })
}

// ---- 管理端：应用管理 ----

export async function adminListClients(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  return json({ clients: await listClients(env) })
}

export async function adminCreateClient(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as {
    name?: string
    redirectUris?: string[]
    scopes?: string
    allowHttp?: boolean
  }

  const result = await createClient(env, {
    name: body.name ?? "",
    redirectUris: Array.isArray(body.redirectUris)
      ? body.redirectUris.map((s) => String(s).trim()).filter(Boolean)
      : [],
    scopes: body.scopes,
    ownerUserId: admin.id,
    allowHttp: body.allowHttp === true,
  })

  // ⚠️ clientSecret 明文只在这里返回一次
  return json({ client: result.client, clientSecret: result.clientSecret }, 201)
}

export async function adminUpdateClient(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  const body = (await request.json()) as {
    name?: string
    redirectUris?: string[]
    scopes?: string
    disabled?: boolean
    allowHttp?: boolean
  }

  await updateClient(env, decodeURIComponent(id), {
    name: body.name,
    redirectUris: Array.isArray(body.redirectUris)
      ? body.redirectUris.map((s) => String(s).trim()).filter(Boolean)
      : undefined,
    scopes: body.scopes,
    disabled: typeof body.disabled === "boolean" ? body.disabled : undefined,
    allowHttp: body.allowHttp === true,
  })

  const row = await getClientByInternalId(env, decodeURIComponent(id))
  return json({ client: row ? toPublicClient(row) : null })
}

export async function adminResetClientSecret(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  const clientSecret = await resetClientSecret(env, decodeURIComponent(id))
  return json({ clientSecret })
}

export async function adminDeleteClient(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  await deleteClient(env, decodeURIComponent(id))
  return json({ ok: true })
}
