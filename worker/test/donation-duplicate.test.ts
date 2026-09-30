// 捐献防重复校验（`hasDuplicateUpstream`）—— 内网穿透这一路。
//
// 背景见 `donations.ts` 的 `hasDuplicateUpstream` 注释：原实现是
// `payload LIKE '%"serverAddr":"<地址>"%'`，而 **D1 的 LIKE 模式上限只有 50 字符**，
// 固定前缀 `%"serverAddr":"` + `"%` 占 17 个 ⇒ **主机名超过 33 字符就报
// `LIKE or GLOB pattern too complex`，整个提交 500**（且校验在 INSERT 之前，
// 单子进不了库、管理端看不到）。
//
// ⚠️ 诚实说明本文件能证明什么：D1 那个 50 字符上限**本地 miniflare 复现不了**
//   （它用的是标准 SQLite，上限 50000）。所以这里真正守住的是「改写成
//   `json_extract(payload, '$.serverAddr')` 之后**语义没变**」——
//   路径写错（例如写成 `$.server`）会让校验恒不生效、静默放过所有重复提交，
//   那比 500 更难发现。长度护栏由 `sql-like.test.ts` 单独覆盖。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"

/** frp 捐献的合法载荷（与 frp-config.test.ts 的样例同源） */
function frpPayload(serverAddr: string) {
  const configSample = [
    `serverAddr = "${serverAddr}"`,
    "serverPort = 7000",
    "",
    'auth.token = "shared-secret"',
    "",
    'user = "demo"',
    "",
    "[[proxies]]",
    'name = "demo-ssh"',
    'type = "tcp"',
    "localPort = 22",
    "remotePort = 6000",
    "",
  ].join("\n")
  return {
    nodeName: "测试节点",
    region: "香港",
    serverAddr,
    serverPort: 7000,
    portMin: 6000,
    portMax: 6100,
    maxPorts: 5,
    authMode: "token",
    authToken: "shared-secret",
    configSample,
    note: "",
  }
}

async function makeDonor(): Promise<TestUser> {
  const user = await makeUser()
  // 提交要求「已验证的真实邮箱」（不能是本站域名邮箱）
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
    .bind(`${user.username}@example.net`, user.id)
    .run()
  await setPermissions(user.id, JSON.stringify({ frp: false }))
  return user
}

async function submitFrp(user: TestUser, serverAddr: string) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "frp", payload: frpPayload(serverAddr) }),
    })
  )
  return { res, body: (await res.json()) as { error?: string; code?: string; id?: string } }
}

describe("frp 捐献：同一台服务器不允许重复提交", () => {
  it("第一次 201 入库；第二次以 DUPLICATE_UPSTREAM 拒绝（不是「待审核」那条 409）", async () => {
    const user = await makeDonor()

    // 长主机名（40 字符）：旧的 LIKE 写法在这里必然线上 500，正好当回归样本
    const addr = "frp.donation-test-longhost.example.com"

    const first = await submitFrp(user, addr)
    expect(first.res.status).toBe(201)
    expect(first.body.id).toBeTruthy()

    const second = await submitFrp(user, addr)
    expect(second.res.status).toBe(409)
    // 关键：必须是「上游重复」，不能是后面那条「你已有一个该类型的申请待审核」——
    // 后者说明防重复短路失效、退化成了更宽松的拦截
    expect(second.body.code).toBe("DUPLICATE_UPSTREAM")

    // 且确实只落了一条
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM donations WHERE user_id = ? AND type = 'frp'"
    )
      .bind(user.id)
      .first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it("主机名不同则不算重复（精确比对，不做模糊匹配）", async () => {
    const user = await makeDonor()

    const a = await submitFrp(user, "frp.aaa.example.com")
    expect(a.res.status).toBe(201)

    // 若用 LIKE 前缀/包含匹配，这条会被误判成重复
    const b = await submitFrp(user, "frp.bbb.example.com")
    expect(b.body.code).not.toBe("DUPLICATE_UPSTREAM")
  })
})
