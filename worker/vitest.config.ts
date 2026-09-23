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
          bindings: { TEST_MIGRATIONS: migrations, TEST_SCHEMA_STATEMENTS: schemaStatements },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  }
})
