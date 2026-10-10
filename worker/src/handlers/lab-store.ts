/**
 * AI 实验室：**作品的键值存储**（2026-10-10 站长要求）。
 *
 * 用途：让作品能「记住东西」。没有它，作品只是海报 ——
 * 游客打一个字、点一下按钮，刷新全没。有了它，留言板 / 计数器 / 待办 / 投票才成立。
 *
 * 🔴 这是本站唯一一个**对公网开放写入**的接口（作品挂在谁都能访问的域名上）。
 *    所以护栏是重点，不是附属品：
 *      · 只有**已公开**的作品能读写（私密作品不给入口）；
 *      · 每作品最多 200 个键、单值 ≤8KB、单键 ≤128 字符；
 *      · 每作品每分钟最多 60 次写 —— 落库计数，**不能放内存**
 *        （Worker 无状态，实例一换内存计数就没了）。
 *    ⚠️ 刻意用 `Access-Control-Allow-Origin: *` 且**不带凭据**：
 *       带凭据的话，任何网站都能借访客的 cookie 读本站数据（CSRF 面）。
 *       这里的数据本来就是公开的，不需要身份。
 */
import { ApiError } from "../http"
import type { Env } from "../env"

/** 单个作品最多存多少个键 */
const MAX_KEYS = 200
/** 单个值的字符上限（够存一段留言或一小段 JSON） */
const MAX_VALUE_CHARS = 8_000
/** 键名长度上限 */
const MAX_KEY_CHARS = 128
/** 每作品每分钟的写入次数上限 */
const WRITE_PER_MINUTE = 60

/** CORS：作品在自己的域名下调本站接口，必须带这些头 */
function corsHeaders(): Record<string, string> {
  return {
    // ⚠️ 不用 `*` 之外的东西、也**绝不带** Allow-Credentials
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  }
}

/** 带 CORS 的 JSON 响应 */
function corsJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  })
}

/** 预检请求：浏览器发 PUT + application/json 之前会先问一次 */
export function storePreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

function cleanKey(raw: string): string {
  const key = decodeURIComponent(raw).trim()
  if (!key || key.length > MAX_KEY_CHARS) {
    throw new ApiError(400, `键名要在 1~${MAX_KEY_CHARS} 个字符之间`, "INVALID_KEY")
  }
  return key
}

/**
 * 取作品并确认它**已公开**。
 * 私密作品不给存储入口 —— 没发布的东西没有访客，放行只会变成免费的私有数据库。
 */
async function assertPublicProject(env: Env, projectId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT visibility FROM lab_projects WHERE id = ?")
    .bind(projectId)
    .first<{ visibility: string }>()
  if (!row || row.visibility !== "public") {
    throw new ApiError(404, "作品不存在或未公开", "NOT_FOUND")
  }
}

/** 写入节流：每项目每分钟一个桶 */
async function assertWriteRate(env: Env, projectId: string): Promise<void> {
  const now = Date.now()
  const bucket = Math.floor(now / 60_000) * 60_000
  const row = await env.DB.prepare(
    "SELECT window_start, count FROM lab_store_quota WHERE project_id = ?"
  )
    .bind(projectId)
    .first<{ window_start: number; count: number }>()

  if (!row || row.window_start !== bucket) {
    // 新的一分钟：直接重置成 1
    await env.DB.prepare(
      `INSERT INTO lab_store_quota (project_id, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(project_id) DO UPDATE SET window_start = excluded.window_start,
                                             count = excluded.count`
    )
      .bind(projectId, bucket)
      .run()
    return
  }
  if (row.count >= WRITE_PER_MINUTE) {
    throw new ApiError(
      429,
      "这个作品写入太频繁了，稍等一下再试",
      "RATE_LIMITED"
    )
  }
  await env.DB.prepare(
    "UPDATE lab_store_quota SET count = count + 1 WHERE project_id = ? AND window_start = ?"
  )
    .bind(projectId, bucket)
    .run()
}

/** GET /api/lab-store/:id/:key —— 读一个键 */
export async function getValue(
  env: Env,
  _request: Request,
  projectId: string,
  rawKey: string
): Promise<Response> {
  await assertPublicProject(env, projectId)
  const key = cleanKey(rawKey)
  const row = await env.DB.prepare(
    "SELECT value FROM lab_project_kv WHERE project_id = ? AND key = ?"
  )
    .bind(projectId, key)
    .first<{ value: string }>()
  // 不存在的键回 null 而不是 404：作品里 `if (v === null)` 比 catch 404 好写
  return corsJson({ value: row?.value ?? null })
}

/** GET /api/lab-store/:id —— 列出全部（一次给完，键上限本来就只有 200） */
export async function listValues(
  env: Env,
  _request: Request,
  projectId: string
): Promise<Response> {
  await assertPublicProject(env, projectId)
  const rows = await env.DB.prepare(
    "SELECT key, value FROM lab_project_kv WHERE project_id = ? ORDER BY key LIMIT ?"
  )
    .bind(projectId, MAX_KEYS)
    .all<{ key: string; value: string }>()
  const items: Record<string, string> = {}
  for (const r of rows.results ?? []) items[r.key] = r.value
  return corsJson({ items })
}

/** PUT /api/lab-store/:id/:key —— body: { value } */
export async function setValue(
  env: Env,
  _request: Request,
  projectId: string,
  rawKey: string
): Promise<Response> {
  await assertPublicProject(env, projectId)
  const key = cleanKey(rawKey)
  const body = (await _request.json().catch(() => null)) as { value?: unknown } | null
  // 值统一按字符串存 —— 作品那边自己 JSON.stringify，接口不做类型猜测
  const value = typeof body?.value === "string" ? body.value : ""
  if (value.length > MAX_VALUE_CHARS) {
    throw new ApiError(413, `单个值不能超过 ${MAX_VALUE_CHARS} 个字符`, "VALUE_TOO_LARGE")
  }

  // 键数上限：只在**新增**时检查（覆盖已有键不该被上限挡住）
  const exists = await env.DB.prepare(
    "SELECT 1 AS x FROM lab_project_kv WHERE project_id = ? AND key = ?"
  )
    .bind(projectId, key)
    .first()
  if (!exists) {
    const cnt =
      (await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM lab_project_kv WHERE project_id = ?"
      )
        .bind(projectId)
        .first<{ c: number }>())?.c ?? 0
    if (cnt >= MAX_KEYS) {
      throw new ApiError(
        413,
        `这个作品最多存 ${MAX_KEYS} 条数据，已经满了`,
        "TOO_MANY_KEYS"
      )
    }
  }

  await assertWriteRate(env, projectId)
  await env.DB.prepare(
    `INSERT INTO lab_project_kv (project_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value,
                                                updated_at = excluded.updated_at`
  )
    .bind(projectId, key, value, new Date().toISOString())
    .run()
  return corsJson({ ok: true })
}

/** DELETE /api/lab-store/:id/:key */
export async function deleteValue(
  env: Env,
  _request: Request,
  projectId: string,
  rawKey: string
): Promise<Response> {
  await assertPublicProject(env, projectId)
  const key = cleanKey(rawKey)
  await assertWriteRate(env, projectId)
  await env.DB.prepare("DELETE FROM lab_project_kv WHERE project_id = ? AND key = ?")
    .bind(projectId, key)
    .run()
  return corsJson({ ok: true })
}

/**
 * 注入给作品的 SDK 源码。
 *
 * ⚠️ **内联进 HTML**（不是外链一个 js）：作品挂在用户自己的域名下，
 *    外链要依赖另一个域名可达 + 多一次请求；内联进去最省事也最稳。
 * ⚠️ API 地址由服务端按 `ROOT_DOMAIN` 算好传进来，不写死 ——
 *    写死的话换域名就全废了。
 */
export function buildSdk(projectId: string, apiBase: string): string {
  // 注意：这里拼的是要放进 HTML 的字符串，**不能含 `</script>`**
  return `<script>
(function(){
  var PID = ${JSON.stringify(projectId)};
  var BASE = ${JSON.stringify(apiBase)} + "/api/lab-store/" + PID;
  function fail(res){
    return res.text().then(function(t){
      var m = t;
      try { m = JSON.parse(t).error || t } catch (e) {}
      throw new Error(m || ("HTTP " + res.status));
    });
  }
  function ok(res){ return res.ok ? res.json() : fail(res) }
  window.LabStore = {
    /** 读一条；不存在返回 null */
    get: function(k){ return fetch(BASE + "/" + encodeURIComponent(k)).then(ok).then(function(d){ return d.value }) },
    /** 写一条（值按字符串存，存对象自己 JSON.stringify） */
    set: function(k, v){ return fetch(BASE + "/" + encodeURIComponent(k), {
      method: "PUT", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ value: String(v) })
    }).then(ok) },
    /** 删一条 */
    del: function(k){ return fetch(BASE + "/" + encodeURIComponent(k), { method: "DELETE" }).then(ok) },
    /** 一次取全部（对象：键 → 值） */
    all: function(){ return fetch(BASE).then(ok).then(function(d){ return d.items }) }
  };
})();
</script>`
}
