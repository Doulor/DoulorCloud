// 公告邮件群发队列（0071）。
//
// 原先 createAnnouncement 里逐封 await sendMail，226 个收件人堵在发布请求里，
// 且越靠后的越容易撞子请求上限而静默失败。现在改为：发布时把收件人快照入队，
// 请求立刻返回，实际发送由 runAnnouncementMailJob 分批跑，cron 兜底续跑。
//
// ⚠️ 测试隔离：同一文件的用例共享同一个 D1（只有 app_settings 被 setup 清空），
// users 会跨用例累积。所以：
//   · 断言「发了多少封」的用例，用 seedSendingAnnouncement 直接把收件人钉死，
//     不经 API（API 会触发后台任务，且收件人是当时全库的用户）；
//   · beforeEach 把上一轮可能还在 'sending' 的公告标记为 done，
//     否则它们会被 resumeAnnouncementMails 捞起来发信，污染后续断言。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"
import { runAnnouncementMailJob, resumeAnnouncementMails } from "../src/handlers/announcements"
import { uuid } from "../src/crypto"

/** 打桩出站 fetch：记录发往 Posta / Brevo 的发信请求；failFor 里的地址两个通道都失败 */
let mailCalls: { channel: string; to: string }[] = []
let failFor = new Set<string>()
/** quotaFor 里的地址 → Posta 返回「今日额度用尽」（HTTP 400 + max_emails 报码） */
let quotaFor = new Set<string>()
let restoreFetch: (() => void) | null = null

function stubMail(): void {
  const original = globalThis.fetch
  mailCalls = []
  failFor = new Set()
  quotaFor = new Set()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body = (() => {
      try {
        return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      } catch {
        return {}
      }
    })()

    if (url.includes("posta.test")) {
      // Posta 契约：to 是收件人地址数组（见 mailer-posta.test.ts）
      const to = String((body.to as string[] | undefined)?.[0] ?? "")
      if (quotaFor.has(to)) {
        return new Response('{"code":"max_emails_per_day_exceeded"}', { status: 400 })
      }
      if (failFor.has(to)) return new Response("boom", { status: 500 })
      mailCalls.push({ channel: "posta", to })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.includes("api.brevo.com")) {
      const to = ((body.to as { email: string }[] | undefined)?.[0]?.email) ?? ""
      if (quotaFor.has(to)) {
        return new Response('{"code":"max_emails_per_day_exceeded"}', { status: 400 })
      }
      if (failFor.has(to)) return new Response("boom", { status: 500 })
      mailCalls.push({ channel: "brevo", to })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
}

beforeEach(async () => {
  stubMail()
  await setSetting("posta_url", "https://posta.test/api/send")
  await setSetting("posta_key", "test-key")
  // 只留 posta：brevo 未配置时回退会直接 503，让「失败」用例的语义更清楚
  await setSetting("mail_transport_order", "posta")
  // 把上一轮遗留的「推送中」公告收尾，避免被 resumeAnnouncementMails 捞起来干扰
  await env.DB.prepare(
    "UPDATE announcements SET mail_status='done' WHERE mail_status='sending'"
  ).run()
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

async function makeAdmin() {
  return makeUser({ role: "admin" })
}

/**
 * 直接建一条「已在推送中」的公告 + 队列行，收件人由调用方钉死。
 * 绕过 API 是为了避开 createAnnouncement 触发的后台任务（它会和其它用例抢 pending 行）。
 */
async function seedSendingAnnouncement(emails: string[]): Promise<string> {
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO announcements
       (id, title, body, category, pinned, popup_mode, created_at,
        mail_status, mail_total, mail_sent, mail_failed)
     VALUES (?, '测试公告', '正文', 'general', 0, 'none', ?, 'sending', ?, 0, 0)`
  )
    .bind(id, now, emails.length)
    .run()

  for (const email of emails) {
    await env.DB.prepare(
      `INSERT INTO announcement_mail_queue
         (id, announcement_id, user_id, email, status, attempts, created_at)
       VALUES (?, ?, NULL, ?, 'pending', 0, ?)`
    )
      .bind(uuid(), id, email, now)
      .run()
  }
  return id
}

async function readMailState(annId: string) {
  return await env.DB.prepare(
    `SELECT mail_status, mail_total, mail_sent, mail_failed, mail_finished_at
       FROM announcements WHERE id = ?`
  )
    .bind(annId)
    .first<{
      mail_status: string
      mail_total: number
      mail_sent: number
      mail_failed: number
      mail_finished_at: string | null
    }>()
}

/**
 * 只挑出「本用例这几封」的发信记录。
 *
 * 为什么必须过滤：走 API 的用例会触发 ctx.waitUntil 的后台群发任务，它带 1 秒
 * 批间延迟，可能在本用例断言之后才跑完，把无关收件人混进 mailCalls。
 * 断言各自关心的收件人集合，用例之间就不互相干扰。
 */
function sentTo(emails: string[]): string[] {
  const wanted = new Set(emails)
  return mailCalls.filter((c) => wanted.has(c.to)).map((c) => c.to).sort()
}

describe("公告邮件队列：入队口径", () => {
  it("勾选邮件 → 返回 queued，且队列行数与之一致", async () => {
    const admin = await makeAdmin()
    await makeUser()
    await makeUser()

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "公告A", body: "正文", notifyByEmail: true }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json<{ queued: number; announcement: { id: string; mailTotal: number } }>()

    // 至少 admin 自己 + 两个新用户
    expect(body.queued).toBeGreaterThanOrEqual(3)
    expect(body.announcement.mailTotal).toBe(body.queued)

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM announcement_mail_queue WHERE announcement_id = ?"
    )
      .bind(body.announcement.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(body.queued)
  })

  it("不勾选邮件 → 不入队", async () => {
    const admin = await makeAdmin()
    await makeUser()
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "公告B", body: "正文" }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json<{ queued: number; announcement: { id: string } }>()
    expect(body.queued).toBe(0)

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM announcement_mail_queue WHERE announcement_id = ?"
    )
      .bind(body.announcement.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(0)
  })

  it("关闭通知偏好的用户不入队", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    await env.DB.prepare("UPDATE users SET notify_announcements = 0 WHERE id = ?").bind(u.id).run()

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "公告H", body: "正文", notifyByEmail: true }),
      })
    )
    const annId = (await res.json<{ announcement: { id: string } }>()).announcement.id

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM announcement_mail_queue WHERE announcement_id = ? AND user_id = ?"
    )
      .bind(annId, u.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(0)
  })
})

describe("公告邮件队列：分批发送", () => {
  it("分批发完并累计进度、状态置 done", async () => {
    const emails = ["a@example.com", "b@example.com", "c@example.com"]
    const annId = await seedSendingAnnouncement(emails)

    await runAnnouncementMailJob(env, annId)

    const row = await readMailState(annId)
    expect(row?.mail_status).toBe("done")
    expect(row?.mail_total).toBe(3)
    expect(row?.mail_sent).toBe(3)
    expect(row?.mail_failed).toBe(0)
    expect(row?.mail_finished_at).toBeTruthy()
    expect(sentTo(emails)).toEqual([...emails].sort())
  })

  it("单个收件人失败 → 记 failed 并计入 mail_failed，不影响其它人", async () => {
    const emails = ["ok1@example.com", "bad@example.com", "ok2@example.com"]
    failFor.add("bad@example.com")
    const annId = await seedSendingAnnouncement(emails)

    await runAnnouncementMailJob(env, annId)

    const row = await readMailState(annId)
    expect(row?.mail_failed).toBe(1)
    expect(row?.mail_sent).toBe(2)
    expect(row?.mail_status).toBe("done")

    const failedRow = await env.DB.prepare(
      "SELECT error, attempts FROM announcement_mail_queue WHERE announcement_id = ? AND status = 'failed'"
    )
      .bind(annId)
      .first<{ error: string; attempts: number }>()
    expect(failedRow?.attempts).toBe(1)
    expect(failedRow?.error).toBeTruthy()
  })

  it("幂等：已发完再跑不发第二遍", async () => {
    const emails = ["x@example.com", "y@example.com"]
    const annId = await seedSendingAnnouncement(emails)
    await runAnnouncementMailJob(env, annId)
    const afterFirst = sentTo(emails).length
    expect(afterFirst).toBe(2)

    await runAnnouncementMailJob(env, annId)
    expect(sentTo(emails).length).toBe(afterFirst)
  })

  it("只捞 pending：已发送的记录不会重复投递", async () => {
    const emails = ["m@example.com", "n@example.com"]
    const annId = await seedSendingAnnouncement(emails)
    await runAnnouncementMailJob(env, annId)
    // 手动把一条 sent 改回 pending → 只有它会被重发
    await env.DB.prepare(
      "UPDATE announcement_mail_queue SET status='pending', sent_at=NULL WHERE announcement_id = ? AND email = 'm@example.com'"
    )
      .bind(annId)
      .run()
    mailCalls = []

    await runAnnouncementMailJob(env, annId)
    expect(sentTo(emails)).toEqual(["m@example.com"])
  })
})

describe("公告邮件队列：cron 续跑", () => {
  it("resumeAnnouncementMails 把「推送中」的公告发完", async () => {
    const emails = ["p@example.com", "q@example.com", "r@example.com"]
    const annId = await seedSendingAnnouncement(emails)

    const r = await resumeAnnouncementMails(env, { maxBatchesPerAnnouncement: 10 })
    expect(r.processed).toBeGreaterThanOrEqual(3)

    const row = await readMailState(annId)
    expect(row?.mail_status).toBe("done")
    expect(row?.mail_sent).toBe(3)
  })

  it("已完成（done）的公告不会被续跑重复发送", async () => {
    const emails = ["s@example.com"]
    const annId = await seedSendingAnnouncement(emails)
    await runAnnouncementMailJob(env, annId)

    await resumeAnnouncementMails(env, { maxBatchesPerAnnouncement: 10 })
    // 仍只有第一次那封，没有第二封
    expect(sentTo(emails)).toEqual(["s@example.com"])
  })

  it("maxBatchesPerAnnouncement 限制单次处理量，剩余留给下次", async () => {
    // 25 个收件人、每批 20 → 至少 2 批；限制 1 批则只发 20 封
    const emails = Array.from({ length: 25 }, (_, i) => `batch${i}@example.com`)
    const annId = await seedSendingAnnouncement(emails)

    const r = await resumeAnnouncementMails(env, { maxBatchesPerAnnouncement: 1 })
    expect(r.processed).toBe(20)

    const mid = await readMailState(annId)
    expect(mid?.mail_status).toBe("sending")
    expect(mid?.mail_sent).toBe(20)

    // 再跑一次收尾
    await resumeAnnouncementMails(env, { maxBatchesPerAnnouncement: 10 })
    const done = await readMailState(annId)
    expect(done?.mail_status).toBe("done")
    expect(done?.mail_sent).toBe(25)
  })
})

describe("公告邮件队列：编辑不重发", () => {
  it("已有推送记录的公告再保存，不会重新入队", async () => {
    const admin = await makeAdmin()
    const annId = await seedSendingAnnouncement(["edit@example.com"])
    await runAnnouncementMailJob(env, annId)

    const upd = await fetchSelf(
      authRequest(admin, `/api/admin/announcements/${annId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "测试公告（改错别字）", notifyByEmail: true }),
      })
    )
    expect(upd.status).toBe(200)
    expect((await upd.json<{ queued: number }>()).queued).toBe(0)

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM announcement_mail_queue WHERE announcement_id = ?"
    )
      .bind(annId)
      .first<{ c: number }>()
    expect(row?.c).toBe(1)
  })
})

describe("公告邮件队列：重发失败", () => {
  /**
   * 重发端点在响应返回后仍会用 ctx.waitUntil 后台发送。
   * 先等它跑完；只有它没跑（或没跑完）才手动补一次 —— 直接无条件补跑会和
   * 后台任务并发抢同一批 pending 行，造成同一封信发两遍（mail_sent 虚高）。
   */
  async function settleResend(annId: string): Promise<void> {
    const t0 = Date.now()
    while (Date.now() - t0 < 2000) {
      if ((await readMailState(annId))?.mail_status === "done") return
      await new Promise((res) => setTimeout(res, 40))
    }
    await runAnnouncementMailJob(env, annId)
  }

  it("重发后 failed 归零，且确实补投到收件人", async () => {
    const admin = await makeAdmin()
    const emails = ["ok@example.com", "bad@example.com"]
    failFor.add("bad@example.com")
    const annId = await seedSendingAnnouncement(emails)
    await runAnnouncementMailJob(env, annId)

    expect((await readMailState(annId))?.mail_failed).toBe(1)

    // 故障排除后管理员点「重发失败」
    failFor.clear()
    const res = await fetchSelf(
      authRequest(admin, `/api/admin/announcements/${annId}/resend`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    expect((await res.json<{ requeued: number }>()).requeued).toBe(1)

    await settleResend(annId)

    const row = await readMailState(annId)
    expect(row?.mail_failed).toBe(0)
    expect(row?.mail_status).toBe("done")
    expect(new Set(sentTo(emails))).toEqual(new Set(emails))
  })

  it("没有失败记录时重发是空操作（requeued=0）", async () => {
    const admin = await makeAdmin()
    const emails = ["fine@example.com"]
    const annId = await seedSendingAnnouncement(emails)
    await runAnnouncementMailJob(env, annId)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/announcements/${annId}/resend`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    expect((await res.json<{ requeued: number }>()).requeued).toBe(0)

    const row = await readMailState(annId)
    expect(row?.mail_status).toBe("done")
  })

  it("非管理员不能重发（鉴权）", async () => {
    const user = await makeUser()
    const annId = await seedSendingAnnouncement(["x@example.com"])
    const res = await fetchSelf(
      authRequest(user, `/api/admin/announcements/${annId}/resend`, { method: "POST" })
    )
    expect([401, 403]).toContain(res.status)
  })

  it("按名单强制重发：名单外的失败行仍计入 mailFailed（按钮不会消失）", async () => {
    const admin = await makeAdmin()
    const emails = ["k1@example.com", "k2@example.com"]
    failFor.add("k1@example.com")
    failFor.add("k2@example.com")
    const annId = await seedSendingAnnouncement(emails)
    await runAnnouncementMailJob(env, annId)
    expect((await readMailState(annId))?.mail_failed).toBe(2)

    // 只有 k1 修好了 → 强制重发 k1；k2 仍在名单外、还是失败状态
    failFor.delete("k1@example.com")
    const res = await fetchSelf(
      authRequest(admin, `/api/admin/announcements/${annId}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: ["k1@example.com"] }),
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json<{ requeued: number }>()).requeued).toBe(1)

    await settleResend(annId)
    const row = await readMailState(annId)
    expect(row?.mail_sent).toBe(1)
    expect(row?.mail_failed).toBe(1)
  })
})

describe("公告邮件队列：额度用尽", () => {
  it("额度用尽 → 暂停本轮、剩余保持 pending 且不计入失败；额度恢复后续跑成功", async () => {
    const emails = ["q1@example.com", "q2@example.com", "q3@example.com"]
    const annId = await seedSendingAnnouncement(emails)
    // 第 2 封开始额度用尽
    quotaFor.add("q2@example.com")
    quotaFor.add("q3@example.com")

    await runAnnouncementMailJob(env, annId)

    let row = await readMailState(annId)
    expect(row?.mail_sent).toBe(1)
    // 关键：额度问题不是收件人的问题，不能记成 failed
    expect(row?.mail_failed).toBe(0)
    // 不能收尾成 done，否则剩下的永远不会被续跑
    expect(row?.mail_status).toBe("sending")

    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM announcement_mail_queue WHERE announcement_id = ? AND status = 'pending'"
    )
      .bind(annId)
      .first<{ c: number }>()
    expect(pending?.c).toBe(2)

    // 额度恢复（次日）→ cron 续跑把剩下的发完
    quotaFor.clear()
    await resumeAnnouncementMails(env, { maxBatchesPerAnnouncement: 10 })

    row = await readMailState(annId)
    expect(row?.mail_status).toBe("done")
    expect(row?.mail_sent).toBe(3)
    expect(row?.mail_failed).toBe(0)
    expect(new Set(sentTo(emails))).toEqual(new Set(emails))
  })
})
