/**
 * 主动探针（2026-10-26）：由 cron 写入 D1 的 probe_latest，
 * /状态 指令只读这张表 —— 绝不在 webhook 里做外部 fetch（会被 QQ 判定超时）。
 */
import type { Env } from "../env"
import { sendGroupText } from "./qq"

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
const PROBE_MODELS = ["donation-agents-a1-free", "MiMo-V2.6-Flash", "donation-gemini-3.7-flash"]

async function probeModel(
  env: Env,
  model: string
): Promise<{ name: string; ok: boolean; detail: string; ms: number }> {
  const t0 = Date.now()
  const name = `模型 ${model.replace(/^donation-/, "")}`
  try {
    const r = await fetch("https://api.doulor.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PROBE_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    })
    const ms = Date.now() - t0
    if (r.ok) return { name, ok: true, detail: "可用", ms }
    // 读一点响应体便于判断是限流还是模型下线
    const t = (await r.text().catch(() => "")).slice(0, 60)
    return { name, ok: false, detail: `HTTP ${r.status}${t ? " " + t.replace(/\s+/g, " ") : ""}`, ms }
  } catch (e) {
    return { name, ok: false, detail: String((e as Error)?.message ?? e).slice(0, 50), ms: Date.now() - t0 }
  }
}

/** 模型探活：每 10 分钟一轮（由 cron 取模调用） */
export async function probeModels(env: Env): Promise<void> {
  if (!env.PROBE_API_KEY) return
  const now = Math.floor(Date.now() / 1000)
  const results = await Promise.all(PROBE_MODELS.map((m) => probeModel(env, m)))
  await env.DB.batch(
    results.map((r) =>
      env.DB.prepare(
        `INSERT INTO probe_latest (name, ok, detail, ms, checked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ok=excluded.ok, detail=excluded.detail, ms=excluded.ms, checked_at=excluded.checked_at`
      ).bind(r.name, r.ok ? 1 : 0, r.detail, r.ms, now)
    )
  )
}
