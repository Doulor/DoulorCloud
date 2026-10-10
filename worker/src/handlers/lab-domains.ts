/**
 * 把 AI 实验室的**作品绑到用户自己的域名**上（2026-10-10 站长要求）。
 *
 * 机制**照抄直链网盘那一套**，不另造轮子：
 *   · 建 DNS 记录（AAAA 100:: + **开代理**）—— doulor.cn 没有泛解析，
 *     只加 Worker Route 不建解析，域名根本到不了 Cloudflare；
 *   · 给这个 fqdn 加一条 Worker Route（`<fqdn>/*`）指到本站 Worker；
 *   · Worker 的 `hostedDirectLink()` 按 Host 分流，命中本表就吐作品内容。
 *
 * 相关函数直接复用 `handlers/storage.ts` 的 `createWorkerRoute` / `removeWorkerRoute`，
 * 保证两边行为一致（否则一处修了另一处没修，迟早出事）。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { rootDomainFor, zoneIdForFqdn } from "../root-domains"
import { cfCreateDnsRecord, cfListDnsRecords } from "../cloudflare"
import { createWorkerRoute, removeWorkerRoute } from "./storage"
import { readFiles, type LabProjectRow } from "./lab"
import type { Env } from "../env"

/** 每个用户最多绑几个域名（跟直链网盘一个量级，别让人拿来刷域名） */
const MAX_DOMAINS_PER_USER = 5

/** 归一化并校验域名：只收「本站根域名之下的子域名」 */
function cleanFqdn(raw: unknown): string {
  const fqdn = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : ""
  if (
    !fqdn ||
    fqdn.length > 253 ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(fqdn)
  ) {
    throw new ApiError(400, "域名格式不对，只要子域名部分（例如 blog.doulor.cn）", "INVALID_FQDN")
  }
  return fqdn
}

/** 按扩展名给 Content-Type（托管的是用户写的静态页，够用就行） */
function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    woff2: "font/woff2",
    txt: "text/plain; charset=utf-8",
  }
  return map[ext] ?? "text/plain; charset=utf-8"
}

/** 取作品（校验归属） */
async function loadOwnedProject(env: Env, projectId: string, userId: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM lab_projects WHERE id = ? AND user_id = ?"
  )
    .bind(projectId, userId)
    .first<LabProjectRow>()
  if (!row) throw new ApiError(404, "作品不存在", "NOT_FOUND")
  return row
}

/** 读某个作品当前绑的域名（没有就 null） */
export async function getBoundDomain(env: Env, projectId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT fqdn FROM lab_project_domains WHERE project_id = ? LIMIT 1"
  )
    .bind(projectId)
    .first<{ fqdn: string }>()
  return row?.fqdn ?? null
}

/**
 * GET /api/lab/projects/:id/domain —— 当前绑的域名（没绑回 null）。
 * 单独一个接口而不是塞进作品详情里：详情接口的返回结构很多地方在用，
 * 为了一个字段去动它不划算。
 */
export async function getProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  await loadOwnedProject(env, projectId, user.id)
  return json({ fqdn: await getBoundDomain(env, projectId) })
}

/**
 * PUT /api/lab/projects/:id/domain —— body: { fqdn }
 * 绑定（或改绑）域名。
 */
export async function setProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => null)) as { fqdn?: unknown } | null
  const fqdn = cleanFqdn(body?.fqdn)

  const project = await loadOwnedProject(env, projectId, user.id)
  // 只有**公开**的作品才对外供；私密作品绑域名没有意义（也避免被当成绕过审核的后门）
  if (project.visibility !== "public") {
    throw new ApiError(400, "先把作品设为公开，才能绑定域名", "NOT_PUBLIC")
  }
  // 只允许本站根域名之下的子域名 —— 否则会去给别人家的域名建 DNS 记录
  if (!(await rootDomainFor(env, fqdn))) {
    throw new ApiError(400, "只能绑定本站根域名下的子域名", "INVALID_FQDN")
  }

  // 域名全局唯一：被别人占了就报错，不静默抢
  const taken = await env.DB.prepare(
    "SELECT project_id FROM lab_project_domains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(fqdn)
    .first<{ project_id: string }>()
  if (taken && taken.project_id !== projectId) {
    throw new ApiError(409, "这个域名已经绑给另一个作品了", "FQDN_TAKEN")
  }

  // 数量上限（换绑自己已有的不算新增）
  const cnt =
    (await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM lab_project_domains WHERE user_id = ? AND project_id != ?"
    )
      .bind(user.id, projectId)
      .first<{ c: number }>())?.c ?? 0
  if (cnt >= MAX_DOMAINS_PER_USER) {
    throw new ApiError(400, `最多绑定 ${MAX_DOMAINS_PER_USER} 个域名`, "TOO_MANY_DOMAINS")
  }

  // 1) DNS 记录：AAAA 100:: + 开代理（与直链网盘同一口径）
  //    zone 按 fqdn 解析，不能写死 —— 记录可能属于 tyu.me 而不是 doulor.cn
  const zoneId = await zoneIdForFqdn(env, fqdn)
  const existing = await cfListDnsRecords(env, zoneId, fqdn)
  if (!existing.length) {
    try {
      await cfCreateDnsRecord(env, zoneId, {
        type: "AAAA",
        name: fqdn,
        content: "100::",
        ttl: 1,
        proxied: true,
      })
    } catch (err) {
      console.error("作品域名 DNS 记录创建失败:", fqdn, err)
      throw new ApiError(502, "无法为该域名创建解析记录，请稍后再试", "CF_ERROR")
    }
  }

  // 2) Worker 路由
  await createWorkerRoute(env, fqdn)

  // 3) 落库（同一作品换域名 = 先删旧行再加新行；旧域名的路由**不动** ——
  //    删它要动 DNS，风险大于收益，留着也不会有流量进来）
  await env.DB.prepare("DELETE FROM lab_project_domains WHERE project_id = ?")
    .bind(projectId)
    .run()
  await env.DB.prepare(
    "INSERT INTO lab_project_domains (id, project_id, user_id, fqdn, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(uuid(), projectId, user.id, fqdn, new Date().toISOString())
    .run()

  return json({ fqdn })
}

/** DELETE /api/lab/projects/:id/domain —— 解绑 */
export async function clearProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  await loadOwnedProject(env, projectId, user.id)
  const bound = await getBoundDomain(env, projectId)
  if (bound) {
    await env.DB.prepare("DELETE FROM lab_project_domains WHERE project_id = ?")
      .bind(projectId)
      .run()
    // 路由删掉；DNS 记录留着（可能是用户自己域名下别处在用的解析）
    try {
      await removeWorkerRoute(env, bound)
    } catch (err) {
      console.error("删除作品域名路由失败（已解绑，忽略）:", bound, err)
    }
  }
  return json({ fqdn: null })
}

/* ------------------------------------------------------------------ */
/* 按域名出内容（由 index.ts 的分发器调用）                            */
/* ------------------------------------------------------------------ */

/** 这个 Host 有没有绑作品 */
export async function isHostedLabHost(env: Env, host: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM lab_project_domains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(host)
    .first()
  return Boolean(row)
}

/**
 * 把作品内容按请求路径吐出去。
 * 请求 `/`（或空）取 `index.html`；多文件作品按路径取对应文件。
 */
export async function serveHostedLab(
  env: Env,
  request: Request,
  host: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT p.* FROM lab_project_domains d
       JOIN lab_projects p ON p.id = d.project_id
      WHERE d.fqdn = ? COLLATE NOCASE LIMIT 1`
  )
    .bind(host)
    .first<LabProjectRow>()

  // ⚠️ 取消公开 / 重新设为私密后，域名要**立刻**失效 ——
  //    否则「先公开骗过审核、再改回私密」就成了绕过审核的通道。
  if (!row || row.visibility !== "public") {
    return new Response("Not Found", { status: 404 })
  }

  const files = await readFiles(env, row)
  const raw = new URL(request.url).pathname.replace(/^\/+/, "")
  const path = raw || "index.html"
  const content = files[path] ?? (path === "index.html" ? "" : files["index.html"])
  if (!content) {
    return new Response("Not Found", { status: 404 })
  }

  return new Response(content, {
    headers: {
      "Content-Type": contentTypeFor(path),
      // 用户随时会改作品，别让边缘缓存把旧版本留太久
      "Cache-Control": "public, max-age=60",
    },
  })
}
