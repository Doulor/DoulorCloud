import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"

// Apply baseline schema.sql first (contains users, sessions, etc. that
// migrations 0002+ depend on but don't re-create). The statements were
// pre-split in vitest.config.ts using wrangler's unstable_splitSqlQuery.
for (const stmt of env.TEST_SCHEMA_STATEMENTS) {
  await env.DB.prepare(stmt).run()
}

// migration 0002 references email_aliases (a table that existed in the
// original pre-migration baseline but was dropped by 0002 itself and is
// absent from the current schema.sql). Create an empty placeholder so the
// migration's UPDATE/DROP don't error.
await env.DB.prepare(
  "CREATE TABLE IF NOT EXISTS email_aliases (id TEXT, user_id TEXT, forwarding_to TEXT, created_at TEXT)"
).run()

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
