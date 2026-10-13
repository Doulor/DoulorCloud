/**
 * 回归测试：过期清理**真的挂上了定时运维**（任务 A —— 审计 H13 的收尾）。
 *
 * 背景（`check-unused-exports.mjs` 的 ALLOW 里挂了很久的那两条）：
 *   - `handlers/analytics.ts::purgeExpiredAnalytics`（90 天）
 *   - `link-preview.ts::purgeExpiredPreviews`（7 天）
 * 两个函数早就写好了，但**全仓没有调用点** —— analytics_events 是「匿名每浏览
 * 写一行」、link_previews 是「每条外链一行」，于是两张表无界增长，而文档还写着
 * 这两件事已经做了。现在它们挂在 `maintenance.ts` 4c 段，由 cron `17 * * * *`
 * 驱动（见 index.ts 的 scheduled 处理器）。
 *
 * 本文件测「接线是通的」，不测那两个函数各自的 SQL —— 那属于它们自己的单元测试：
 *   1. 过期行被删、未过期行保留，且报告里的数字与实际删除一致；
 *   2. dryRun 只统计不删除（这个分支在 maintenance.ts 里**独立算截止时间**，
 *      所以两处保留期常量不一致时会在这里暴露）；
 *   3. 这次运行确实落进了 maintenance_runs（运维侧唯一能看到「cron 还活着」的地方）。
 *
 * ⚠️ 只读 `worker/test/helpers.ts` 里已有的导出，不依赖别人正在加的东西；
 *    本文件是新建文件，不改动任何既有测试（`worker/test/` 属另一任务的范围）。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { runMaintenance } from "../src/maintenance"

const DAY = 24 * 60 * 60 * 1000

/** 3 倍于 analytics 保留期（90 天）⇒ 必然过期 */
const AGE_EXPIRED_DAYS = 300
/** 1 天 ⇒ 两张表都必然没过期 */
const AGE_FRESH_DAYS = 1

/** 唯一标记：即使测试库里有别的用例留下的行，也只断言自己这几条 */
function mark(kind: string): string {
  return `${kind}-${uuid().slice(0, 8)}`
}

async function seedAnalytics(ageDays: number): Promise<string> {
  const path = `/${mark("dcwa")}`
  await env.DB.prepare(
    `INSERT INTO analytics_events (id, visitor_id, path, referrer, ua, created_at)
     VALUES (?, ?, ?, 'direct', NULL, ?)`
  )
    .bind(uuid(), `v_${path}`, path, new Date(Date.now() - ageDays * DAY).toISOString())
    .run()
  return path
}

async function seedPreview(ageDays: number): Promise<string> {
  const url = `https://${mark("dcwa")}.example.com/`
  await env.DB.prepare(
    `INSERT INTO link_previews (url, title, description, image, site_name, fetched_at)
     VALUES (?, ?, NULL, NULL, NULL, ?)`
  )
    .bind(url, url, new Date(Date.now() - ageDays * DAY).toISOString())
    .run()
  return url
}

async function analyticsExists(path: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM analytics_events WHERE path = ?")
    .bind(path)
    .first()
  return Boolean(r)
}

async function previewExists(url: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM link_previews WHERE url = ?")
    .bind(url)
    .first()
  return Boolean(r)
}

/** 已经落库、且带 analyticsEvents 字段的运维运行记录数（= 接线真的跑到的证据） */
async function recordedRuns(): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM maintenance_runs WHERE stats LIKE '%"analyticsEvents"%'`
  ).first<{ c: number }>()
  return r?.c ?? 0
}

describe("定时运维：过期统计事件 / 链接预览缓存清理（任务 A）", () => {
  it("过期行被删、未过期行保留，且报告的数字与实删一致", async () => {
    const oldPath = await seedAnalytics(AGE_EXPIRED_DAYS)
    const newPath = await seedAnalytics(AGE_FRESH_DAYS)
    const oldUrl = await seedPreview(AGE_EXPIRED_DAYS)
    const newUrl = await seedPreview(AGE_FRESH_DAYS)

    const report = await runMaintenance(env, { dryRun: false })

    // 两个函数各自返回的删除行数进了报告
    expect(report.expiredPurged.analyticsEvents).toBeGreaterThanOrEqual(1)
    expect(report.expiredPurged.linkPreviews).toBeGreaterThanOrEqual(1)

    // 过期的那条没了……
    expect(await analyticsExists(oldPath)).toBe(false)
    expect(await previewExists(oldUrl)).toBe(false)
    // ……没过期的那条一根汗毛都没动
    expect(await analyticsExists(newPath)).toBe(true)
    expect(await previewExists(newUrl)).toBe(true)
  })

  it("dryRun 只统计不删除（两处保留期常量不一致会在这里暴露）", async () => {
    const oldPath = await seedAnalytics(AGE_EXPIRED_DAYS)
    const oldUrl = await seedPreview(AGE_EXPIRED_DAYS)

    const report = await runMaintenance(env, { dryRun: true })

    // 预演必须能看到「有东西该清」
    expect(report.expiredPurged.analyticsEvents).toBeGreaterThanOrEqual(1)
    expect(report.expiredPurged.linkPreviews).toBeGreaterThanOrEqual(1)
    // 但一行都不能真删
    expect(await analyticsExists(oldPath)).toBe(true)
    expect(await previewExists(oldUrl)).toBe(true)
  })

  it("运行结果落进 maintenance_runs（运维侧唯一能确认 cron 还活着的地方）", async () => {
    const before = await recordedRuns()

    await runMaintenance(env, { dryRun: false })

    expect(await recordedRuns()).toBe(before + 1)
  })
})
