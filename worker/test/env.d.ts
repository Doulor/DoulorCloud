declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[]
    TEST_SCHEMA_STATEMENTS: string[]
    // NewAPI 测试用假绑定（见 vitest.config.ts）
    NEWAPI_BASE_URL: string
    NEWAPI_ADMIN_TOKEN: string
    NEWAPI_ADMIN_USER_ID: string
    SESSION_SECRET: string
  }
}
