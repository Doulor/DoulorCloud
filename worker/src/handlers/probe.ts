/**
 * 主动探针（2026-10-26）：由 cron 写入 D1 的 probe_latest，
 * /状态 指令只读这张表 —— 绝不在 webhook 里做外部 fetch（会被 QQ 判定超时）。
 */
import type { Env } from "../env"
import { sendGroupText } from "./qq"

/** 最近一次取渠道清单的失败原因（用于诊断） */
let channelDebug = ""

type Target = { name: string; url: string; expect: number[] }

const TARGETS: Target[] = [
  { name: "主站 cloud.doulor.cn", url: "https://cloud.doulor.cn/health", expect: [200] },
  { name: "中转站 api.doulor.cn", url: "https://api.doulor.cn/v1/models", expect: [401] },
  { name: "号池 agent2api", url: "https://agent2api.doulor.cn/v1/models", expect: [200, 401] },
]

async function probeOne(t: Target): Promise<{ name: string; ok: boolean; detail: string; ms: number }> {
  const t0 = Date.now()
  try {
    const r = await fetch(t.url, { method: "GET", redirect: "manual" })
    const ms = Date.now() - t0
    const ok = t.expect.includes(r.status)
    return { name: t.name, ok, detail: `HTTP ${r.status}`, ms }
  } catch (e) {
    const ms = Date.now() - t0
    return { name: t.name, ok: false, detail: String((e as Error)?.message ?? e).slice(0, 40), ms }
  }
}

/** 每分钟跑一次；模型探活按 10 分钟节奏（promises 串行，别打爆上游）。 */
export async function runProbes(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  // 先读旧状态，用于判断「挂了 / 恢复了」（模型行不参与告警，避免上游抖动刷屏）
  const prevRows = await env.DB.prepare("SELECT name, ok FROM probe_latest").all<{ name: string; ok: number }>()
  const prev = new Map((prevRows.results ?? []).map((r) => [r.name, r.ok === 1]))
  const results = await Promise.all(TARGETS.map((t) => probeOne(t)))
  const stmts = results.map((r) =>
    env.DB.prepare(
      `INSERT INTO probe_latest (name, ok, detail, ms, checked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ok=excluded.ok, detail=excluded.detail, ms=excluded.ms, checked_at=excluded.checked_at`
    ).bind(r.name, r.ok ? 1 : 0, r.detail, r.ms, now)
  )
  if (env.PROBE_API_KEY) {
    const t0 = Date.now()
    try {
      const r = await fetch("https://api.doulor.cn/v1/models", {
        headers: { authorization: `Bearer ${env.PROBE_API_KEY}` },
      })
      const ms = Date.now() - t0
      stmts.push(
        env.DB.prepare(
          `INSERT INTO probe_latest (name, ok, detail, ms, checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET ok=excluded.ok, detail=excluded.detail, ms=excluded.ms, checked_at=excluded.checked_at`
        ).bind("中转站鉴权（带 key）", r.status === 200 ? 1 : 0, r.status === 200 ? "HTTP 200" : `HTTP ${r.status}`, ms, now)
      )
    } catch {
      /* 忽略：主链路已覆盖 */
    }
  }
  await env.DB.batch(stmts)
  await alertTransition(env, prev, results)
}

/** 状态翻转才告警：正常→异常、异常→正常。首次探测（无旧记录）不告警。 */
async function alertTransition(
  env: Env,
  prev: Map<string, boolean>,
  results: { name: string; ok: boolean; detail: string; ms: number }[]
): Promise<void> {
  const lines: string[] = []
  for (const r of results) {
    const was = prev.get(r.name)
    if (was === undefined) continue
    if (was && !r.ok) lines.push(`🔴 ${r.name} 挂了 — ${r.detail} · ${r.ms}ms`)
    else if (!was && r.ok) lines.push(`🟢 ${r.name} 恢复 — ${r.detail} · ${r.ms}ms`)
  }
  if (!lines.length) return
  const ch = await env.DB.prepare(
    "SELECT group_openid FROM qq_channels WHERE enabled = 1 ORDER BY created_at DESC LIMIT 1"
  ).first<{ group_openid: string }>()
  if (!ch?.group_openid) return
  const text = `【Doulor 告警】\n${lines.join("\n")}\n\n${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
  try {
    await sendGroupText(env, ch.group_openid, text, undefined)
  } catch (e) {
    console.warn("告警推送失败:", e instanceof Error ? e.message : e)
  }
}

/** 模型可用性探针用的模型（挑免费/低价的，避免烧额度） */
// 2026-10-27 实测可用（其余免费模型上游"分组无可用渠道"）：
/**
 * 模型探活的候选清单：NewAPI「已启用渠道」里的模型，排除 donation-*。
 *
 * 为什么不直接用 /v1/models：那会把只挂在停用渠道上的模型也列出来，
 * 那些永远探不通，纯噪音。站长要的是「现在真能用哪些」。
 */
export async function enabledChannelModels(env: Env): Promise<string[]> {
  const base = (env.NEWAPI_BASE_URL || "https://api.doulor.cn").replace(/\/$/, "")
  if (!env.NEWAPI_ADMIN_TOKEN) return []
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.NEWAPI_ADMIN_TOKEN}`,
    "new-api-user": String(env.NEWAPI_ADMIN_USER_ID || "1"),
  }
  const out = new Set<string>()
  channelDebug = ""
  for (let page = 1; page <= 3; page++) {
    let arr: { status?: number | string; models?: string }[] = []
    try {
      const r = await fetch(`${base}/api/channel/?p=${page}&page_size=100`, { headers })
      if (!r.ok) {
        channelDebug = `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`
        break
      }
      const j = (await r.json()) as { data?: unknown }
      const d = j.data
      const items = Array.isArray(d) ? d : (d as { items?: unknown[] } | undefined)?.items
      arr = (items ?? []) as typeof arr
    } catch (e) {
      channelDebug = String((e as Error)?.message ?? e).slice(0, 120)
      break
    }
    if (!arr.length) {
      channelDebug = channelDebug || "empty data"
      break
    }
    for (const c of arr) {
      if (Number(c.status) !== 1) continue
      for (const m of String(c.models || "").split(",")) {
        const name = m.trim()
        if (!name || name.toLowerCase().startsWith("donation-")) continue
        out.add(name)
      }
    }
    if (arr.length < 100) break
  }
  return [...out].slice(0, 36)
}

async function probeOneModel(
  env: Env,
  model: string
): Promise<{ model: string; ok: boolean; detail: string; ms: number }> {
  const t0 = Date.now()
  try {
    const r = await fetch("https://api.doulor.cn/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.PROBE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    })
    const ms = Date.now() - t0
    if (r.ok) return { model, ok: true, detail: "可用", ms }
    const t = (await r.text().catch(() => "")).slice(0, 50).replace(/\s+/g, " ")
    return { model, ok: false, detail: `HTTP ${r.status}${t ? " " + t : ""}`, ms }
  } catch (e) {
    return { model, ok: false, detail: String((e as Error)?.message ?? e).slice(0, 40), ms: Date.now() - t0 }
  }
}

/** 模型探活：每 10 分钟一轮，结果写 probe_model_latest（与服务探针分表） */
export async function probeModels(env: Env): Promise<void> {
  if (!env.PROBE_API_KEY) return

  // 1) 候选清单：先问管理接口（已启用渠道），401/失败则回退 /v1/models 排除 donation-*
  let models = await enabledChannelModels(env)
  let source = "channel"
  if (!models.length) {
    try {
      await env.DB.prepare(
        `INSERT INTO probe_latest (name, ok, detail, ms, checked_at) VALUES ('dbg:chan', 0, ?, 0, ?)
         ON CONFLICT(name) DO UPDATE SET detail=excluded.detail, checked_at=excluded.checked_at`
      )
        .bind(String(channelDebug || "unknown").slice(0, 200), Math.floor(Date.now() / 1000))
        .run()
    } catch {
      /* ignore */
    }
    try {
      const r = await fetch("https://api.doulor.cn/v1/models", {
        headers: { authorization: `Bearer ${env.PROBE_API_KEY}` },
      })
      const j = (await r.json()) as { data?: { id?: string }[] }
      // 大小写不同的同名模型（DeepSeek-V4-Flash / deepseek-v4-flash）只留一个
      const seen = new Set<string>()
      models = (j.data ?? [])
        .map((m) => String(m.id ?? ""))
        .filter((id) => {
          if (!id || id.toLowerCase().startsWith("donation-")) return false
          const k = id.toLowerCase()
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        .slice(0, 48)
      source = "v1models"
    } catch {
      /* ignore */
    }
  }
  if (!models.length) return

  const now = Math.floor(Date.now() / 1000)
  await env.DB.batch(
    models.map((m) =>
      env.DB.prepare(
        `INSERT INTO probe_model_list (model, source, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET source=excluded.source, updated_at=excluded.updated_at`
      ).bind(m, source, now)
    )
  )

  // 管理接口可用时，清掉回退期抓进来的旧清单（只保留真正已启用渠道的模型）
  if (source === "channel") {
    await env.DB.prepare("DELETE FROM probe_model_list WHERE source <> 'channel'").run().catch(() => undefined)
    await env.DB.prepare(
      `DELETE FROM probe_model_latest WHERE model NOT IN (SELECT model FROM probe_model_list)`
    ).run().catch(() => undefined)
  }

  // 2) 每轮只探最久没探过的 8 个（一次探几十个会被后台执行预算掐断）
  const due = await env.DB.prepare(
    `SELECT l.model AS model FROM probe_model_list l
     LEFT JOIN probe_model_latest p ON p.model = l.model
     ORDER BY COALESCE(p.checked_at, 0) ASC LIMIT 8`
  ).all<{ model: string }>()
  const batch = (due.results ?? []).map((r) => r.model)
  if (!batch.length) return

  const results = await Promise.all(batch.map((m) => probeOneModel(env, m)))
  await env.DB.batch(
    results.map((r) =>
      env.DB.prepare(
        `INSERT INTO probe_model_latest (model, ok, detail, ms, checked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET ok=excluded.ok, detail=excluded.detail, ms=excluded.ms, checked_at=excluded.checked_at`
      ).bind(r.model, r.ok ? 1 : 0, r.detail, r.ms, now)
    )
  )
}
