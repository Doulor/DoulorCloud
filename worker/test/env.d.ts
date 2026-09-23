declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[]
    TEST_SCHEMA_STATEMENTS: string[]
  }
}
