/**
 * 回归测试：L19 —— OIDC issuer 不能由请求的 Host 头决定。
 *
 * 缺陷原状（2026-09-25 审计）：`handlers/oauth.ts` 的 `oauthBase()` 直接取
 * `new URL(request.url).origin`，于是同一个部署通过 `*.workers.dev` 访问时，
 * `/.well-known/openid-configuration` 会宣告一个**完全不同的 issuer**。
 * OIDC 客户端会把 discovery 的 issuer 与它校验的值严格比对，
 * 多 issuer 会让「自动发现」时好时坏，而且把请求方可控的 Host
 * 变成了协议元数据的一部分。
 *
 * 测试手段：`SELF.fetch` 的 URL 决定 Host，所以直接换 host 就能复现。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"

const PATH = "/api/.well-known/openid-configuration"

/** SELF 只能从 cloudflare:test 动态取（与 helpers.ts 的 fetchSelf 同一做法） */
async function fetchUrl(url: string): Promise<Response> {
  const SELF = (await import("cloudflare:test")).SELF
  return SELF.fetch(url)
}

async function issuerFor(origin: string): Promise<string> {
  const res = await fetchUrl(`${origin}${PATH}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { issuer: string }
  return body.issuer
}

describe("OIDC issuer 不跟随 Host（L19）", () => {
  it("通过 *.workers.dev 访问时宣告正式域名，而不是预览域名", async () => {
    const iss = await issuerFor("https://doulor-mail-api.some-account.workers.dev")
    expect(iss).toBe(`https://cloud.${env.ROOT_DOMAIN}/api`)
    expect(iss).not.toContain("workers.dev")
  })

  it("通过正式自定义域名访问时用该域名（多域名/自建部署不受影响）", async () => {
    expect(await issuerFor("https://cloud.doulor.cn")).toBe("https://cloud.doulor.cn/api")
  })

  it("本机调试地址保持原样（wrangler dev 要能自测）", async () => {
    const iss = await issuerFor("http://localhost:8787")
    // ⚠️ 测试运行时会把 scheme 规范成 https（miniflare 的 SELF.fetch 行为），
    // 所以这里断言的是真正的不变量：**主机没有被换成正式域名**。
    // 真实的 wrangler dev 里 scheme 保持 http。
    expect(new URL(iss).host).toBe("localhost:8787")
    expect(iss).not.toContain(env.ROOT_DOMAIN)
  })

  it("endpoint 三件套与 issuer 同源（不能只改 issuer 而漏掉其余）", async () => {
    const res = await fetchUrl(
      "https://doulor-mail-api.some-account.workers.dev" + PATH
    )
    const doc = (await res.json()) as Record<string, string>
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "userinfo_endpoint",
    ]) {
      expect(doc[key]).toContain("https://cloud.")
      expect(doc[key]).not.toContain("workers.dev")
    }
  })
})
