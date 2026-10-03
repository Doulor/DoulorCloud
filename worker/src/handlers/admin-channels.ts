/**
 * 管理端：AI 中转站（NewAPI）渠道巡检 —— 列表 + 测试 + 失效禁用。
 *
 * 背景（2026-10-03 站长要求）：中转站里大量捐献/自有渠道已失效（400+ 模型
 * 实测只剩约 80 个能用），失效渠道在轮询时拖慢整体、抢占正常渠道流量，
 * 需要批量测出并禁用。
 *
 * 为什么只能走后端：NewAPI 管理员令牌只存在于 Worker Secret / 加密凭据表里，
 * CLI 拿不到，渠道测试与启停必须由 Worker 代劳。
 *
 * 两个接口：
 *   · GET  /admin/channels            —— 全量渠道列表（快，用于前端/脚本挑批次）
 *   · POST /admin/channels/sweep      —— 测给定 id（默认全部启用中），失效的按需禁用
 *
 * 边界：全部 requireAdmin；sweep 记审计。**禁用可逆**（status 1↔2），不做删除。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireAdmin } from "./admin"
import { audit as recordAudit } from "../settings"
import {
  listChannels,
  testChannel,
  setChannelStatus,
  CHANNEL_STATUS_ENABLED,
  CHANNEL_STATUS_MANUALLY_DISABLED,
} from "../newapi-client"
import type { Env } from "../env"

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const buf = await readBodyCapped(request, 64 * 1024, "请求体过大")
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError(400, "请求格式不正确", "INVALID_JSON")
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

/** GET /admin/channels —— 全量渠道列表（只读） */
export async function listChannelReport(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const channels = await listChannels(env)
  return json({
    total: channels.length,
    enabled: channels.filter((c) => c.status === CHANNEL_STATUS_ENABLED).length,
    disabled: channels.filter((c) => c.status !== CHANNEL_STATUS_ENABLED).length,
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      group: c.group,
      // 模型数（不把整段逗号列表塞进响应，避免体量失控）
      modelCount: c.models ? c.models.split(",").filter(Boolean).length : 0,
    })),
  })
}

/**
 * POST /admin/channels/sweep —— 测试并禁用失效渠道。
 * body: { ids?: number[], disable?: boolean, concurrency?, timeoutMs? }
 *   ids 缺省 = 全部「启用中」的渠道；disable 缺省 = true。
 * 返回每条的测试结果与是否被禁用。
 */
export async function sweepChannels(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = await readJson(request)
  const ids = Array.isArray(body.ids)
    ? (body.ids as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : null
  const disable = body.disable !== false
  const timeoutMs = clamp(Number(body.timeoutMs ?? 8000), 2000, 15000)
  const concurrency = clamp(Number(body.concurrency ?? 10), 1, 30)

  const all = await listChannels(env)
  const targets = ids
    ? all.filter((c) => ids.includes(c.id))
    : all.filter((c) => c.status === CHANNEL_STATUS_ENABLED)

  if (targets.length === 0) {
    return json({ tested: 0, dead: 0, disabled: 0, results: [] })
  }

  // 有界并发测试：坏渠道大多是秒失败（连接拒绝/401），只有少数会挂满超时
  const results: {
    id: number
    name: string
    group: string
    ok: boolean
    message: string
    disabled: boolean
  }[] = []
  let cursor = 0
  const run = async (): Promise<void> => {
    while (cursor < targets.length) {
      const c = targets[cursor++]
      let r: { ok: boolean; message: string; time: number }
      try {
        r = await testChannel(env, c.id, undefined, timeoutMs)
      } catch (err) {
        r = { ok: false, message: err instanceof Error ? err.message : String(err), time: 0 }
      }
      let disabled = false
      if (!r.ok && disable && c.status === CHANNEL_STATUS_ENABLED) {
        try {
          await setChannelStatus(env, c.id, CHANNEL_STATUS_MANUALLY_DISABLED)
          disabled = true
        } catch (err) {
          // 禁用失败不阻断整体，单独记录在 message 里
          r.message = `${r.message}｜禁用失败：${err instanceof Error ? err.message : String(err)}`
        }
      }
      results.push({
        id: c.id,
        name: c.name,
        group: c.group,
        ok: r.ok,
        message: r.message,
        disabled,
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, run))

  results.sort((a, b) => a.id - b.id)
  const dead = results.filter((r) => !r.ok)
  const disabled = results.filter((r) => r.disabled).length

  await recordAudit(
    env,
    admin.id,
    "admin.channels.sweep",
    `渠道巡检：测 ${targets.length} 个，失效 ${dead.length} 个，禁用 ${disabled} 个`
  )

  return json({ tested: targets.length, dead: dead.length, disabled, results })
}