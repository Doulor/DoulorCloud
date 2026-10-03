// 管理员维护 Brevo 多 Key（额度叠加）的回归测试。
//
// 三个必须守住的点：
//   1. 多把 Key 不能被「通用设置项截断到 100 字符」的兜底砍掉（单把就有 89 字符）；
//   2. 回包里不能出现密钥明文（GET 早已脱敏，PUT 曾是泄漏口）；
//   3. 审计日志里也不能落明文（审计日志会展示给管理员看）。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

const KEY_A = "xkeysib-" + "a".repeat(64) + "-AAAAAAAAAAAAAAAA"
const KEY_B = "xkeysib-" + "b".repeat(64) + "-BBBBBBBBBBBBBBBB"

async function putSettings(admin: Awaited<ReturnType<typeof makeUser>>, payload: object) {
  return fetchSelf(
    authRequest(admin, "/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  )
}

async function readStored(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'brevo_api_key'"
  ).first<{ value: string }>()
  return row?.value ?? ""
}

describe("管理员维护 Brevo 多 Key", () => {
  it("两把 Key 原样落库（不被截断到 100 字符）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await putSettings(admin, { brevo_api_key: `${KEY_A},${KEY_B}` })
    expect(res.status).toBe(200)

    const stored = await readStored()
    expect(stored).toBe(`${KEY_A},${KEY_B}`)
    expect(stored.length).toBeGreaterThan(100) // 正是旧实现在这里被砍断
    expect(stored).toContain(KEY_A)
    expect(stored).toContain(KEY_B)
  })

  it("换行 / 空格分隔也会被规范化成逗号，并去重", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await putSettings(admin, {
      brevo_api_key: `${KEY_A}\n  ${KEY_B} ${KEY_A}`,
    })
    expect(res.status).toBe(200)
    expect(await readStored()).toBe(`${KEY_A},${KEY_B}`)
  })

  it("PUT 响应不回显密钥明文", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await putSettings(admin, { brevo_api_key: KEY_A })
    const body = (await res.json()) as { settings: Record<string, string> }
    expect(body.settings.brevo_api_key).toBe("")
    // 整个响应体里都不该出现密钥
    expect(JSON.stringify(body)).not.toContain(KEY_A)
  })

  it("GET 响应也不回显密钥明文，但给出 Key 把数", async () => {
    const admin = await makeUser({ role: "admin" })
    await putSettings(admin, { brevo_api_key: `${KEY_A},${KEY_B}` })

    const res = await fetchSelf(authRequest(admin, "/api/admin/settings"))
    const body = (await res.json()) as {
      settings: Record<string, string>
      mailSecrets: { brevoConfigured: boolean; brevoKeyCount: number }
    }
    expect(body.settings.brevo_api_key).toBe("")
    expect(JSON.stringify(body)).not.toContain(KEY_A)
    expect(body.mailSecrets.brevoConfigured).toBe(true)
    expect(body.mailSecrets.brevoKeyCount).toBe(2)
  })

  it("审计日志不落密钥明文", async () => {
    const admin = await makeUser({ role: "admin" })
    await putSettings(admin, { brevo_api_key: KEY_A })

    const row = await env.DB.prepare(
      `SELECT detail FROM audit_logs
        WHERE action = 'admin.settings.update' AND user_id = ?
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(admin.id)
      .first<{ detail: string }>()

    expect(row?.detail).toContain("brevo_api_key=***")
    expect(row?.detail).not.toContain(KEY_A)
  })

  // ---- 「列表 + 打码」改版后的新增协议 ----
  //
  // 管理面板现在展示的是**打码后的 Key 列表**，前端拿不到明文，因此增删不能
  // 直接回传原文，而是提交 keep:<n>（保留第 n 把）+ 新 Key 原文的协议串。

  it("keep:<n> 协议：保留指定的那一把 + 追加新 Key", async () => {
    const admin = await makeUser({ role: "admin" })
    await putSettings(admin, { brevo_api_key: `${KEY_A},${KEY_B}` })

    const KEY_C = "xkeysib-" + "c".repeat(64) + "-CCCCCCCCCCCCCCCC"
    const res = await putSettings(admin, { brevo_api_key: `keep:2,${KEY_C}` })
    expect(res.status).toBe(200)
    // 第 1 把被丢弃、第 2 把保留、新 Key 追加在后面
    expect(await readStored()).toBe(`${KEY_B},${KEY_C}`)
  })

  it("keep: 指向不存在的序号 → 忽略，不影响其余提交", async () => {
    const admin = await makeUser({ role: "admin" })
    await putSettings(admin, { brevo_api_key: KEY_A })

    const res = await putSettings(admin, { brevo_api_key: "keep:1,keep:9" })
    expect(res.status).toBe(200)
    expect(await readStored()).toBe(KEY_A)
  })

  it("提交空串 = 清空全部（管理员把 Key 全删了）", async () => {
    const admin = await makeUser({ role: "admin" })
    await putSettings(admin, { brevo_api_key: `${KEY_A},${KEY_B}` })

    const res = await putSettings(admin, { brevo_api_key: "" })
    expect(res.status).toBe(200)
    expect(await readStored()).toBe("")
  })

  it("GET 返回打码后的 Key 列表：顺序一致、可分辨、不含明文", async () => {
    const admin = await makeUser({ role: "admin" })
    await putSettings(admin, { brevo_api_key: `${KEY_A},${KEY_B}` })

    const res = await fetchSelf(authRequest(admin, "/api/admin/settings"))
    const body = (await res.json()) as { mailSecrets: { brevoKeys: string[] } }
    const list = body.mailSecrets.brevoKeys
    expect(list.length).toBe(2)
    for (const m of list) {
      expect(m).toContain("****")
      expect(m.length).toBeLessThan(KEY_A.length)
    }
    // 两把 Key 的尾部不同 ⇒ 打码后仍能分辨，不是两条一样的串
    expect(list[0]).not.toBe(list[1])
    expect(JSON.stringify(body)).not.toContain(KEY_A)
  })

  it("PUT 响应同样带上打码列表（前端改完就地刷新，不必整页重载）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await putSettings(admin, { brevo_api_key: `${KEY_A},${KEY_B}` })
    const body = (await res.json()) as { mailSecrets: { brevoKeys: string[] } }
    expect(body.mailSecrets.brevoKeys.length).toBe(2)
    expect(JSON.stringify(body)).not.toContain(KEY_A)
  })
})
