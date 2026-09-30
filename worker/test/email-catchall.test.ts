// Email Routing：catch-all 由本 Worker 接管（2026-09-26 定稿）
//
// 背景：Cloudflare Email Routing 的 catch-all 已改成「Send to a Worker」
// （`wrangler email routing rules get doulor.cn catch-all` 实测确认），
// 所有 *@doulor.cn 的信都会进本 Worker，由代码查 mailboxes 表决定去处。
// 因此**不再需要**逐地址建路由规则 —— 那套规则还占「每域 200 条」的硬上限。
//
// 本文件钉住两件事：
//   1. 建普通邮箱 / 临时邮箱**完全不调 Cloudflare**（连「建规则」的动作都不该有）；
//   2. 删邮箱时**仍要摘掉历史遗留的规则** —— 它们曾经被真实建出来过（线上尚存数十条），
//      不摘就会变成永久孤儿，一直占配额。
//
// 用打桩出站 fetch 断言「有没有发请求」这个事实，而不看请求成功与否 ——
// 测试环境里真实的 CF 调用恒失败，只看成败根本测不出行为。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

const CF_BASE = "https://api.cloudflare.com"
const RULES_PATH = "/email/routing/rules"

let cfCalls: string[] = []
let restore: (() => void) | null = null

/**
 * 打桩出站 fetch：只接管发往 Cloudflare API 的请求，其余（含 SELF.fetch 内部调用）透传。
 * 记录每次调用的「方法 + URL」，用于断言代码有没有真的去调 Cloudflare。
 */
function stubCloudflare(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(CF_BASE)) {
      cfCalls.push(`${init?.method ?? "GET"} ${url}`)
      // 删规则只关心请求发出与否；这里恒给一个成功响应
      return new Response(
        JSON.stringify({ result: { id: "stub-rule-id" }, success: true, errors: [], messages: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 只统计真正「写路由规则」的调用，排除 destination 之类的噪音 */
function ruleWrites(): string[] {
  return cfCalls.filter((c) => c.includes(RULES_PATH) && !c.includes("catch_all"))
}

type TestUser = Awaited<ReturnType<typeof makeUser>>

function addMailbox(user: TestUser, localPart: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart }),
    })
  )
}

function addTempMailbox(user: TestUser): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/mailbox/temp", { method: "POST" }))
}

describe("Email Routing 不再逐条建规则", () => {
  beforeEach(() => {
    cfCalls = []
    stubCloudflare()
  })

  afterEach(() => {
    restore?.()
    restore = null
  })

  it("建普通邮箱不调 Cloudflare，rule_id 恒为 NULL", async () => {
    const user = await makeUser()
    const res = await addMailbox(user, "nocloud")
    expect(res.status).toBe(201)
    const { mailbox } = await res.json<{ mailbox: { id: string } }>()

    expect(ruleWrites()).toHaveLength(0)

    const row = await env.DB.prepare("SELECT rule_id FROM mailboxes WHERE id = ?")
      .bind(mailbox.id)
      .first<{ rule_id: string | null }>()
    expect(row?.rule_id).toBeNull()
  })

  it("建临时邮箱也不调 Cloudflare，rule_id 恒为 NULL", async () => {
    const user = await makeUser()
    const res = await addTempMailbox(user)
    expect(res.status).toBe(201)
    const { mailbox } = await res.json<{ mailbox: { id: string } }>()

    expect(ruleWrites()).toHaveLength(0)

    const row = await env.DB.prepare("SELECT rule_id FROM mailboxes WHERE id = ?")
      .bind(mailbox.id)
      .first<{ rule_id: string | null }>()
    expect(row?.rule_id).toBeNull()
  })

  it("删除邮箱仍会摘掉它历史遗留的 Cloudflare 规则", async () => {
    // 「历史遗留」现在不会再由代码产生，所以手工写一个 rule_id 来模拟存量数据
    const user = await makeUser()
    const created = await addMailbox(user, "legacy")
    const mb = (await created.json<{ mailbox: { id: string } }>()).mailbox
    await env.DB.prepare("UPDATE mailboxes SET rule_id = ? WHERE id = ?")
      .bind("stub-rule-id", mb.id)
      .run()
    cfCalls = []

    const del = await fetchSelf(authRequest(user, `/api/mailbox/${mb.id}`, { method: "DELETE" }))
    expect(del.status).toBe(204)

    // 关键：不能让这些历史规则变成永久孤儿 —— 线上还挂着数十条
    const deletes = ruleWrites().filter((c) => c.startsWith("DELETE"))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toContain("/email/routing/rules/stub-rule-id")
  })
})
