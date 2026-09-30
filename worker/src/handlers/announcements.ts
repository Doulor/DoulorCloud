import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import { sendMail, renderMail, type MailTransport } from "../mailer"
import { broadcastMessage } from "../user-messages"
import { getSetting } from "../settings"
import type { Env } from "../env"

/**
 * 网站公告 / 动态。
 *
 * 用于概览页「网站动态」卡片：管理员发布（新增渠道、新模型、新节点、维护通知等），
 * 登录用户在概览页看到最近几条，pinned 优先。
 *
 * 不预建记录；管理员通过 POST /api/admin/announcements 创建。
 */

export const ANNOUNCEMENT_CATEGORIES = [
  "general",
  "frp",
  "ai",
  "proxy",
  "storage",
  "profile",
] as const

/**
 * 公告状态：草稿 / 定时 / 已发布。
 *
 * 只存三态、不存「已过期」之类派生状态 —— 可见性由 status 决定，
 * 到点发布由 cron 把 scheduled 改写成 published（见 publishAnnouncementNow）。
 */
export const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "published"] as const
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number]

interface AnnouncementRow {
  id: string
  title: string
  body: string
  category: string
  pinned: number
  popup_mode: string
  status: string
  publish_at: string | null
  published_at: string | null
  notify_email: number
  created_at: string
  mail_status: string
  mail_total: number
  mail_sent: number
  mail_failed: number
  mail_finished_at: string | null
}

function toAnnouncement(r: AnnouncementRow) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    category: r.category,
    pinned: r.pinned === 1,
    popupMode: r.popup_mode ?? "none",
    status: (r.status ?? "published") as AnnouncementStatus,
    publishAt: r.publish_at,
    publishedAt: r.published_at,
    /** 是否群发邮件（持久化字段：定时发布时 cron 靠它决定发不发） */
    notifyEmail: r.notify_email === 1,
    createdAt: r.created_at,
    mailStatus: r.mail_status ?? "none",
    mailTotal: r.mail_total ?? 0,
    mailSent: r.mail_sent ?? 0,
    mailFailed: r.mail_failed ?? 0,
    mailFinishedAt: r.mail_finished_at,
  }
}

/**
 * GET /api/announcements —— 登录用户拉取最近公告（pinned 优先，按时间倒序）。
 *
 * ⚠️ 只返回 `status = 'published'` 的：草稿与「还没到点的定时公告」都不能泄露给用户。
 * 旧数据没有 status 列时会被 ALTER 的 DEFAULT 'published' 填上，行为与改动前一致。
 */
export async function listAnnouncements(
  env: Env,
  request: Request
): Promise<Response> {
  await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT * FROM announcements
      WHERE status = 'published'
     ORDER BY pinned DESC, created_at DESC
     LIMIT 5`
  ).all<AnnouncementRow>()
  return json({ announcements: (rows.results ?? []).map(toAnnouncement) })
}

/**
 * 计算公告群发实际使用的通道链。
 *
 * 规则：以 `mail_transport_order`（管理员配的全局顺序）为底，把首选通道提到
 * 最前面；**当首选是 brevo 时，把 posta 从回退链里摘掉**。
 *
 * 为什么必须摘掉 posta：posta 是异步队列，HTTP 200 只代表「已排队」，上游
 * （个人 QQ SMTP）的真实失败对调用方完全不可见 —— 混在回退链里会把「没发出去」
 * 记成「已发送」。2026-09-28 实测：某批 99 封里 46 封静默失败，worker 侧全部
 * 显示成功，只能去 posta 后台核对才发现。
 * 公告最怕的就是「以为发了、其实没发」：宁可如实记 failed 让管理员点重发，
 * 也不要留一个假的成功。首选 posta 时保持完整回退（那是管理员明确的选择）。
 */
async function announcementChain(env: Env, prefer: MailTransport): Promise<MailTransport[]> {
  const configured = (await getSetting(env, "mail_transport_order"))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((t): t is MailTransport => t === "posta" || t === "brevo" || t === "cf")
  const base: MailTransport[] =
    configured.length > 0 ? configured : ["posta", "brevo", "cf"]
  const ordered = [prefer, ...base.filter((t) => t !== prefer)]
  return prefer === "brevo" ? ordered.filter((t) => t !== "posta") : ordered
}

/**
 * 分批参数（按首选通道自适应）。
 *
 * 为什么要分批：一次请求里发 200+ 封邮件会撞上 Worker 的子请求数量上限，
 * 越靠后的收件人越容易静默失败。小批投递也能让每批之间落一次库（进程被回收
 * 可续跑），并给收件方一个更"像人"的投递节奏。
 *
 * Brevo：`POST /v3/smtp/email` 的限流是 1000 RPS，速率完全不是瓶颈 ——
 *   真正的约束是**免费版 300 封/天**。所以这里不追速度，而是把节奏放慢，
 *   降低「短时间内大量同主题投递」被收件方判定为群发的概率。
 * Posta：出口是个人的 QQ SMTP，突发流量必被风控，同样要慢。
 */
const MAIL_BATCH_PROFILE: Record<MailTransport, { size: number; delayMs: number }> = {
  brevo: { size: 10, delayMs: 2000 },
  posta: { size: 20, delayMs: 1000 },
  cf: { size: 20, delayMs: 1000 },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把收件人**快照**进队列，并把公告标记为「推送中」。
 *
 * 为什么快照而不是每次重查 users：公告一旦发布，收件人集合就该固定。
 * 若发送期间有人改了通知偏好或注销，重查会让「说好发 226 封」变成发 219 封，
 * 队列进度（sent/total）也会对不上。快照让进度可解释、可续跑。
 *
 * 用单条 INSERT ... SELECT 完成，避免「N 个用户 = N 个绑定参数」。
 */
async function enqueueAnnouncementMails(
  env: Env,
  announcementId: string
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO announcement_mail_queue
       (id, announcement_id, user_id, email, status, attempts, created_at)
     SELECT lower(hex(randomblob(16))), ?, u.id, u.email, 'pending', 0, ?
       FROM users u
      WHERE u.notify_announcements = 1
        AND u.status = 'active'
        AND u.email IS NOT NULL
        AND length(u.email) > 0`
  )
    .bind(announcementId, new Date().toISOString())
    .run()

  const total = res.meta?.changes ?? 0
  await env.DB.prepare(
    `UPDATE announcements
        SET mail_status = ?, mail_total = ?, mail_sent = 0, mail_failed = 0, mail_finished_at = NULL
      WHERE id = ?`
  )
    .bind(total > 0 ? "sending" : "done", total, announcementId)
    .run()
  return total
}

/**
 * 逐批发送某条公告的待发邮件，直到发完或达到本轮上限。
 *
 * 可重入：cron 的 resumeAnnouncementMails 会再调一次，只捞 status='pending' 的行，
 * 所以中途被回收/中断不会重复投递，也不会漏。
 *
 * 遇到「额度用尽」（MAIL_QUOTA_EXCEEDED）时**主动止损**：结束本轮、剩余收件人
 * 保持 pending，等下一个 cron 周期（跨天后 Brevo 免费额度恢复）继续 —— 而不是
 * 把还没轮到的人统统记成失败。
 *
 * @returns 本轮实际处理的封数
 */
export async function runAnnouncementMailJob(
  env: Env,
  announcementId: string,
  opts: { maxBatches?: number } = {}
): Promise<number> {
  const ann = await env.DB.prepare(
    "SELECT title, body, category, mail_status FROM announcements WHERE id = ?"
  )
    .bind(announcementId)
    .first<{ title: string; body: string; category: string; mail_status: string }>()
  if (!ann) return 0

  // 首选通道：管理员在设置里选的（posta / brevo）。非法值回落 posta。
  const preferRaw = (await getSetting(env, "announcement_mail_transport")).trim().toLowerCase()
  const prefer: MailTransport = preferRaw === "brevo" ? "brevo" : "posta"
  const chain = await announcementChain(env, prefer)
  const { size: batchSize, delayMs: batchDelayMs } = MAIL_BATCH_PROFILE[prefer]

  const { text: mailText, html } = renderMail(ann.title, [
    ann.body,
    `分类：${ANNOUNCEMENT_CATEGORY_LABELS[ann.category] ?? "公告"}`,
    "详见 Doulor Cloud 消息中心「网站动态」。",
  ])
  const subject = `【Doulor Cloud】${ann.title}`

  // maxBatches 用于 cron 续跑时限制单次时长，避免一个 cron 跑太久
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY
  let processed = 0
  let quotaHit = false

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await env.DB.prepare(
      `SELECT id, email FROM announcement_mail_queue
        WHERE announcement_id = ? AND status = 'pending'
        ORDER BY created_at LIMIT ?`
    )
      .bind(announcementId, batchSize)
      .all<{ id: string; email: string }>()

    const items = rows.results ?? []
    if (items.length === 0) break

    let sent = 0
    let failed = 0
    for (const item of items) {
      try {
        await sendMail(
          env,
          { to: item.email, subject, text: mailText, html },
          { prefer, chain }
        )
        await env.DB.prepare(
          "UPDATE announcement_mail_queue SET status='sent', attempts=attempts+1, sent_at=?, error=NULL WHERE id=?"
        )
          .bind(new Date().toISOString(), item.id)
          .run()
        sent++
      } catch (err) {
        // 额度用尽：剩余的人没做错任何事，保持 pending 等下一轮，不计入失败
        if (err instanceof ApiError && err.code === "MAIL_QUOTA_EXCEEDED") {
          console.error("公告邮件额度用尽，本轮提前结束:", announcementId, err.message)
          quotaHit = true
          break
        }
        const msg = err instanceof Error ? err.message : String(err)
        await env.DB.prepare(
          "UPDATE announcement_mail_queue SET status='failed', attempts=attempts+1, error=? WHERE id=?"
        )
          .bind(msg.slice(0, 300), item.id)
          .run()
        failed++
      }
    }
    processed += sent + failed

    // 累计进度（用相对累加，避免与其它写入竞争时丢计数）
    if (sent > 0 || failed > 0) {
      await env.DB.prepare(
        `UPDATE announcements
            SET mail_sent = mail_sent + ?, mail_failed = mail_failed + ?
          WHERE id = ?`
      )
        .bind(sent, failed, announcementId)
        .run()
    }

    if (quotaHit) break
    // 还有下一批时停一下，保护送达率
    if (items.length === batchSize) await sleep(batchDelayMs)
  }

  // 队列里已无 pending → 收尾（额度用尽时不收尾，等 cron 续跑）
  if (!quotaHit) {
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM announcement_mail_queue WHERE announcement_id = ? AND status = 'pending'"
    )
      .bind(announcementId)
      .first<{ c: number }>()
    if ((left?.c ?? 0) === 0) {
      await env.DB.prepare(
        "UPDATE announcements SET mail_status='done', mail_finished_at=? WHERE id = ? AND mail_status='sending'"
      )
        .bind(new Date().toISOString(), announcementId)
        .run()
    }
  }

  return processed
}

/**
 * 兜底续跑：把所有「推送中」的公告继续发完。
 *
 * 为什么必须有：ctx.waitUntil 的后台任务不保证跑完 —— Worker 可能因为
 * 部署、超时、实例回收而中断，此时队列里还留着 pending 行。靠 cron 每小时
 * 捞一次，保证「管理员点了发布，邮件最终一定会发出去」。
 */
export async function resumeAnnouncementMails(
  env: Env,
  opts: { maxBatchesPerAnnouncement?: number } = {}
): Promise<{ announcements: number; processed: number }> {
  const rows = await env.DB.prepare(
    "SELECT id FROM announcements WHERE mail_status = 'sending' ORDER BY created_at LIMIT 10"
  ).all<{ id: string }>()

  let processed = 0
  const list = rows.results ?? []
  for (const r of list) {
    try {
      processed += await runAnnouncementMailJob(env, r.id, {
        // 每个 cron 周期最多 5 批（100 封），避免一次 cron 跑太久
        maxBatches: opts.maxBatchesPerAnnouncement ?? 5,
      })
    } catch (err) {
      console.error("公告邮件续跑失败:", r.id, err)
    }
  }
  return { announcements: list.length, processed }
}

const ANNOUNCEMENT_CATEGORY_LABELS: Record<string, string> = {
  general: "公告",
  frp: "内网穿透",
  ai: "AI 中转站",
  proxy: "代理节点",
  storage: "网盘",
  profile: "名片",
}

// ---- 管理端（需 admin） ----

async function loadOne(env: Env, id: string): Promise<AnnouncementRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?"
  )
    .bind(id)
    .first<AnnouncementRow>()
  if (!row) throw new ApiError(404, "公告不存在", "NOT_FOUND")
  return row
}

/** 归一化发布时间：空 → null；非法 → 抛错（不静默丢弃，否则定时会变成「立刻发」） */
function normalizeTime(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    throw new ApiError(400, "发布时间格式不正确", "INVALID_INPUT")
  }
  return new Date(v).toISOString()
}

/**
 * 归一化「状态 + 发布时间」组合，服务端说了算（不信前端）。
 *
 *   - 状态缺省 published（向后兼容：老请求不带 status）
 *   - 非 draft 且发布时间在未来 → 一律算 scheduled（堵掉「published + 未来时间」
 *     这种会提前把内容泄露给用户的组合）
 *   - scheduled 但时间已到 / 为空 → 降级 published（立即发布）
 *   - draft 忽略发布时间（草稿没有发布时间）
 */
function resolveStatusAndPublishAt(
  rawStatus: unknown,
  rawPublishAt: unknown
): { status: AnnouncementStatus; publishAt: string | null } {
  const status: AnnouncementStatus =
    typeof rawStatus === "string" &&
    (ANNOUNCEMENT_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as AnnouncementStatus)
      : "published"
  const publishAt = normalizeTime(rawPublishAt)

  if (status === "draft") return { status, publishAt: null }
  if (!publishAt) {
    if (status === "scheduled") {
      throw new ApiError(400, "定时发布需要设置发布时间", "INVALID_INPUT")
    }
    return { status: "published", publishAt: null }
  }
  if (Date.parse(publishAt) > Date.now()) return { status: "scheduled", publishAt }
  return { status: "published", publishAt }
}

/**
 * 把一条公告**真正发布出去**：广播消息中心 + （可选）群发邮件 + 落 published 标记。
 *
 * 幂等：唯一判据是 `published_at` 是否为空。cron 每分钟会扫一遍**同时**管理员也可能
 * 手动点发布，两条路径撞上时只有一条真正执行（广播本身还有 dedupKey `ann:<id>` 兜底）。
 * 所以「立即发布」也走这里 —— 不要另写一套。
 */
export async function publishAnnouncementNow(
  env: Env,
  id: string,
  ctx?: ExecutionContext
): Promise<number> {
  const row = await loadOne(env, id)
  if (row.published_at) return 0 // 已发布过，幂等

  // 广播到站内消息中心「网站动态」
  try {
    await broadcastMessage(
      env,
      {
        category: "site",
        type: "announcement",
        title: row.title,
        body: row.body,
        // 深链到消息中心的「网站动态」tab（消息中心每个分类都有自己的 URL）
        link: "/dashboard/messages/site",
      },
      { dedupKey: `ann:${id}` }
    )
  } catch (err) {
    console.error("公告消息广播失败:", id, err)
  }

  // 邮件群发：入队（快照收件人）+ 后台分批发送，不阻塞调用方。
  // mail_total > 0 说明以前已经推过（编辑后再改状态不该重发全站邮件）。
  let queued = 0
  if (row.notify_email === 1 && row.mail_total === 0) {
    queued = await enqueueAnnouncementMails(env, id)
    const job = runAnnouncementMailJob(env, id)
    if (ctx) ctx.waitUntil(job.catch((err) => console.error("公告邮件群发失败:", id, err)))
    else void job.catch((err) => console.error("公告邮件群发失败:", id, err))
  }

  const nowIso = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE announcements
        SET status = 'published', published_at = ?, publish_at = COALESCE(publish_at, ?)
      WHERE id = ?`
  )
    .bind(nowIso, nowIso, id)
    .run()

  return queued
}

/** POST /api/admin/announcements —— 新建 */
export async function createAnnouncement(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  await requireAdmin(env, request)
  const body = (await request.json()) as {
    title?: string
    body?: string
    category?: string
    pinned?: boolean
    popupMode?: string
    notifyByEmail?: boolean
    status?: string
    publishAt?: string | null
  }
  const title = (body.title ?? "").trim().slice(0, 100)
  const text = (body.body ?? "").trim().slice(0, 1000)
  if (!title || !text) {
    throw new ApiError(400, "标题和正文不能为空", "INVALID_INPUT")
  }
  const category =
    typeof body.category === "string" &&
    (ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(body.category)
      ? body.category
      : "general"
  const popupMode =
    body.popupMode === "once" || body.popupMode === "every" ? body.popupMode : "none"
  const { status, publishAt } = resolveStatusAndPublishAt(body.status, body.publishAt)
  const notifyEmail = body.notifyByEmail ? 1 : 0
  const id = uuid()
  const now = new Date().toISOString()
  // published_at 故意留空：由 publishAnnouncementNow 落 —— 它以此判重，
  // 「立即发布」和「cron 到点发布」共用同一条路径。
  await env.DB.prepare(
    `INSERT INTO announcements
       (id, title, body, category, pinned, popup_mode, status, publish_at, notify_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, title, text, category, body.pinned ? 1 : 0, popupMode, status, publishAt, notifyEmail, now)
    .run()

  // 只有「立即发布」在这里发；draft / scheduled 什么都不做，
  // scheduled 由 cron（scheduled-publish.ts）到点调用 publishAnnouncementNow。
  let mailTotal = 0
  if (status === "published") {
    try {
      mailTotal = await publishAnnouncementNow(env, id, ctx)
    } catch (err) {
      // 公告已落库、用户端也能看到，不该因为广播/入队失败就返回 500。
      // published_at 仍为空 ⇒ 后续 cron 会重试（广播有 dedup，不会重复投递）。
      console.error("公告发布失败:", id, err)
    }
  }

  return json(
    {
      announcement: toAnnouncement(await loadOne(env, id)),
      // queued 而不是 sent：邮件已入队、后台正在分批发。真实进度看 announcement 的
      // mailSent/mailTotal 字段（管理端列表会刷新）。
      queued: mailTotal,
    },
    201
  )
}

/** PUT /api/admin/announcements/:id —— 更新 */
export async function updateAnnouncement(
  env: Env,
  request: Request,
  id: string,
  ctx?: ExecutionContext
): Promise<Response> {
  await requireAdmin(env, request)
  const existing = await loadOne(env, id)
  const body = (await request.json()) as {
    title?: string
    body?: string
    category?: string
    pinned?: boolean
    popupMode?: string
    notifyByEmail?: boolean
    status?: string
    publishAt?: string | null
  }
  const title =
    body.title !== undefined ? (body.title as string).trim().slice(0, 100) : existing.title
  const text =
    body.body !== undefined ? (body.body as string).trim().slice(0, 1000) : existing.body
  const category =
    typeof body.category === "string" &&
    (ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(body.category)
      ? body.category
      : existing.category
  const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : existing.pinned
  const popupMode =
    body.popupMode === "once" || body.popupMode === "every" || body.popupMode === "none"
      ? body.popupMode
      : existing.popup_mode
  // 状态/发布时间：没传就沿用旧值，一并交给 resolveStatusAndPublishAt 归一化
  const { status, publishAt } = resolveStatusAndPublishAt(
    body.status ?? existing.status,
    body.publishAt !== undefined ? body.publishAt : existing.publish_at
  )
  const notifyEmail =
    body.notifyByEmail !== undefined ? (body.notifyByEmail ? 1 : 0) : existing.notify_email
  // 改成 draft / scheduled 时清掉 published_at（重新变成「未发布」，
  // scheduled 到点后会重新走一次发布）；保持 published 则沿用原值，避免重复广播。
  const publishedAt = status === "published" ? existing.published_at : null

  await env.DB.prepare(
    `UPDATE announcements
        SET title = ?, body = ?, category = ?, pinned = ?, popup_mode = ?,
            status = ?, publish_at = ?, published_at = ?, notify_email = ?
      WHERE id = ?`
  )
    .bind(title, text, category, pinned, popupMode, status, publishAt, publishedAt, notifyEmail, id)
    .run()

  // 只有「编辑后应当立即发布、且此前从未发布过」才触发；
  // 已经发布过的公告改标题不会重发（广播 dedup + published_at 双重拦）。
  let mailTotal = 0
  if (status === "published" && !existing.published_at) {
    try {
      mailTotal = await publishAnnouncementNow(env, id, ctx)
    } catch (err) {
      console.error("公告发布失败:", id, err)
    }
  }

  return json({ announcement: toAnnouncement(await loadOne(env, id)), queued: mailTotal })
}

/**
 * POST /api/admin/announcements/:id/resend —— 重发该公告「失败」的邮件。
 *
 * 为什么要有独立入口：`announcement_mail_queue` 里 `status='failed'` 的行
 * **不会被 cron 自动重试**（resumeAnnouncementMails 只捞 pending），这是刻意的 ——
 * 失败通常来自通道额度或临时故障，无脑重试只会反复撞同一堵墙。所以给管理员一个
 * 显式按钮：把 failed 重置为 pending，再跑一轮。
 *
 * 请求体可选 `{ emails: string[] }`：**强制**重发这些地址（哪怕当前是 sent）。
 * 用于「worker 记成成功、其实没送到」的情况 —— posta 是异步队列，上游失败对
 * 调用方不可见，只能靠事后核对 posta 后台发现（2026-09-28 实战：46 封被误记成功）。
 * 不带 emails 时默认只重发 failed。
 *
 * 计数校正：重置时把 mail_sent 回填成「队列里真实的 sent 行数」、mail_failed 同理，
 * 之后由 runAnnouncementMailJob 逐批累加。否则重发会让 mail_sent 冲到 mail_total
 * 之上，管理端的 x/y 就没法看了。
 *
 * ⚠️ 已知边界：后台发送用 ctx.waitUntil，若恰好与整点 cron 的 resumeAnnouncementMails
 *   撞上，两个任务会并发捞同一批 pending 行（SELECT 不占位），极小概率重复投递。
 *   概率 = 「重发时长」/1 小时，且重复的只是一封公告邮件，暂不为它引入行级占位状态
 *   （那会让进程被回收时留下永远发不出去的 'sending' 行，代价更大）。
 */
export async function resendAnnouncementMails(
  env: Env,
  request: Request,
  id: string,
  ctx?: ExecutionContext
): Promise<Response> {
  await requireAdmin(env, request)
  await loadOne(env, id)

  const body = (await request.json().catch(() => null)) as { emails?: unknown } | null
  const emails = Array.isArray(body?.emails)
    ? Array.from(
        new Set(
          body.emails
            .map((e) => String(e).trim().toLowerCase())
            .filter((e) => e.includes("@"))
        )
      )
    : []

  let requeued = 0
  if (emails.length > 0) {
    // 指定地址强制重发；按 50 一批是为了避开 D1 的绑定参数上限（默认 100 个）
    for (let i = 0; i < emails.length; i += 50) {
      const chunk = emails.slice(i, i + 50)
      const marks = chunk.map(() => "?").join(",")
      const res = await env.DB.prepare(
        `UPDATE announcement_mail_queue
            SET status = 'pending', error = NULL, sent_at = NULL
          WHERE announcement_id = ? AND status <> 'pending' AND lower(email) IN (${marks})`
      )
        .bind(id, ...chunk)
        .run()
      requeued += res.meta?.changes ?? 0
    }
  } else {
    const res = await env.DB.prepare(
      `UPDATE announcement_mail_queue
          SET status = 'pending', error = NULL, sent_at = NULL
        WHERE announcement_id = ? AND status = 'failed'`
    )
      .bind(id)
      .run()
    requeued = res.meta?.changes ?? 0
  }

  if (requeued === 0) return json({ requeued: 0 })

  // 计数回到「以队列现状为准」，再交给分批发送累加。
  // ⚠️ 必须以队列为准重算，而不是直接把 mail_failed 清零：只强制重发部分地址时
  // （带 emails 的调用）队列里可能仍有失败行，清零会让管理端看不到它们，
  // 「重发失败」按钮也会跟着消失（按钮以 mailFailed > 0 为显示条件）。
  await env.DB.prepare(
    `UPDATE announcements
        SET mail_status = 'sending',
            mail_sent = (SELECT COUNT(*) FROM announcement_mail_queue
                          WHERE announcement_id = ? AND status = 'sent'),
            mail_failed = (SELECT COUNT(*) FROM announcement_mail_queue
                            WHERE announcement_id = ? AND status = 'failed'),
            mail_finished_at = NULL
      WHERE id = ?`
  )
    .bind(id, id, id)
    .run()

  const job = runAnnouncementMailJob(env, id)
  if (ctx) ctx.waitUntil(job.catch((err) => console.error("公告邮件重发失败:", id, err)))
  else void job.catch((err) => console.error("公告邮件重发失败:", id, err))

  return json({ requeued })
}

/** DELETE /api/admin/announcements/:id —— 删除 */
export async function deleteAnnouncement(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  await loadOne(env, id)
  await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(id).run()
  return json({ ok: true })
}
/** GET /api/admin/announcements —— 管理端列表（全部，不限于 5 条） */
export async function listAllAnnouncements(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdmin(env, request)
  const rows = await env.DB.prepare(
    `SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT 100`
  ).all<AnnouncementRow>()
  return json({ announcements: (rows.results ?? []).map(toAnnouncement) })
}
