import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"
import path from "node:path"
import fs from "node:fs"

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"))
  const schemaSql = fs.readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8")
  // Split schema.sql into individual statements the same way wrangler does,
  // so we can apply them one-by-one in the test environment.
  const { unstable_splitSqlQuery } = await import("wrangler")
  const schemaStatements = unstable_splitSqlQuery(schemaSql)
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SCHEMA_STATEMENTS: schemaStatements,
            // NewAPI 相关测试所需的最小绑定：
            //   - BASE_URL：否则 config() 直接因缺地址短路
            //   - ADMIN_TOKEN / ADMIN_USER_ID：模拟「凭据来自 Worker Secret」，用于验证
            //     「库内无行时回落 env」这条路径
            //   - SESSION_SECRET：加密入库的管理员凭据要它派生 AES-GCM 密钥
            // 值均为假值；测试里所有发往 NewAPI 的出站请求都被打桩接管。
            // Cloudflare 管理 API：额度面板要它才不短路（resolveApiToken）。
            // 值必须是假的 —— 测试里所有发往 api.cloudflare.com 的请求都被打桩。
            ACCOUNT_ID: "test-account-id",
            CLOUDFLARE_API_TOKEN: "test-cf-api-token-1234",
            NEWAPI_BASE_URL: "https://api.doulor.cn",
            NEWAPI_ADMIN_TOKEN: "test-env-admin-token-1234",
            NEWAPI_ADMIN_USER_ID: "1",
            SESSION_SECRET: "test-session-secret-for-unit-tests",
            // 内网穿透 agent 通道的共享密钥（见 handlers/frp-agent.ts）。
            // 那条通道不走会话鉴权而是靠 HMAC 签名，所以测试里必须真的绑一个值 ——
            // 否则所有 agent 端点都会走「未配置 → 503」那一支，签名校验逻辑根本测不到。
            FRP_AGENT_SECRET: "test-frp-agent-secret-1234",
            // WorkBuddy 反代网关：模拟「密钥来自 Worker Secret」的回落路径
            // （库内无行时用 env）。地址取 app_settings.wb2api_base_url 的默认值，
            // 测试按该前缀打桩出站请求。
            WB2API_API_KEY: "test-env-wb2api-key-1234",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      /**
       * 🔴 2026-10-13：从 vitest 默认的 5 秒提到 20 秒。
       *
       * 这是一个**重型集成套件**：153 个测试文件并行跑，每个都经 `SELF.fetch()`
       * 打真实 Worker 入口 + 共享一个本地 D1。其中的长用例（造十几笔捐献、跑两轮
       * 全量巡检、四轮撤销重批）在负载高时会明显超过 5 秒 ——
       * 表现为 `Test timed out in 5000ms`，看着像「逻辑坏了」，其实是**超时太紧**。
       * 实测：同一批用例单独跑全过、全量跑偶发超时，且每次红的用例都不一样。
       *
       * 仍然会在 20 秒处失败 —— 真正卡死（死锁、无限重试）的用例照样红，
       * 只是不再把「机器忙」误判成「代码坏」。
       */
      testTimeout: 20_000,
    },
  }
})
