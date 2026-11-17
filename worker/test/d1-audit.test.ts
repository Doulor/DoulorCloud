import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"

import {
  createCollector,
  invalidateD1AuditCache,
  normalizeSqlForAudit,
  sqlTagOf,
  wrapD1,
} from "../src/d1-audit"
import { authRequest, fetchSelf, makeUser, setSetting } from "./helpers"

describe("normalizeSqlForAudit", () => {
  it("压缩空白、去首尾", () => {
    expect(normalizeSqlForAudit("  SELECT\n  a,\t b FROM t  ")).toBe("SELECT a, b FROM t")
  })

  it("截断到 300 字符", () => {
    const long = "SELECT " + "x".repeat(500)
    expect(normalizeSqlForAudit(long).length).toBe(300)
  })
})

describe("sqlTagOf", () => {
  it("同一类 SQL（仅空白不同）指纹相同", () => {
    const a = sqlTagOf("SELECT a FROM t WHERE id = ?")
    const b = sqlTagOf("SELECT  a\nFROM t\n WHERE id = ?")
    expect(a).toBe(b)
  })

  it("不同 SQL 指纹不同", () => {
    expect(sqlTagOf("SELECT a FROM t")).not.toBe(sqlTagOf("SELECT b FROM t"))
  })
})

/** 造一个假 D1：按调用顺序返回给定的 meta */
function fakeDb(metas: { rows_read: number; rows_written: number }[]) {
  let i = 0
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [], meta: metas[i++] }),
    run: async () => ({ results: [], meta: metas[i++] }),
    first: async () => ({ c: 1 }),
  }
  return {
    prepare: () => stmt,
    batch: async () => metas.slice(i).map((m) => ({ results: [], meta: m })),
    exec: async () => ({ count: 0, duration: 0, meta: metas[i++] }),
  } as unknown as D1Database
}

describe("wrapD1 采集", () => {
  it("聚合 all/run 的行读行写，并记住最贵的一条 SQL", () => {
    const c = createCollector("/api/test", "GET")
    const db = wrapD1(
      fakeDb([
        { rows_read: 10, rows_written: 0 },
        { rows_read: 250, rows_written: 2 },
      ]),
      c
    )
    void db.prepare("SELECT 1").all()
    void db.prepare("SELECT * FROM big_table WHERE x = ?").bind(1).run()
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(c.queries).toBe(2)
        expect(c.rowsRead).toBe(260)
        expect(c.rowsWritten).toBe(2)
        expect(c.slowRows).toBe(250)
        expect(c.slowSql).toContain("big_table")
        resolve()
      }, 10)
    )
  })

  it("first() 只计调用次数（拿不到 meta，不虚增行读）", async () => {
    const c = createCollector("/api/test", "GET")
    const db = wrapD1(fakeDb([{ rows_read: 999, rows_written: 0 }]), c)
    await db.prepare("SELECT COUNT(*) FROM t").first()
    expect(c.queries).toBe(1)
    expect(c.rowsRead).toBe(0)
  })
})

describe("端到端：开启审计后请求会落一条样本", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM d1_audit_samples").run()
    await setSetting("d1_audit_enabled", "1")
    await setSetting("d1_audit_sample_percent", "100")
    invalidateD1AuditCache()
  })

  it("GET /api/leaderboard 产生一条 d1_audit_samples 记录", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/leaderboard"))
    expect(res.status).toBe(200)

    let row: { route: string; queries: number } | null = null
    for (let i = 0; i < 20 && !row; i++) {
      row = await env.DB.prepare(
        "SELECT route, queries FROM d1_audit_samples WHERE route = '/api/leaderboard' ORDER BY created_at DESC LIMIT 1"
      ).first<{ route: string; queries: number }>()
      if (!row) await new Promise((r) => setTimeout(r, 50))
    }
    expect(row?.route).toBe("/api/leaderboard")
    expect(Number(row?.queries ?? 0)).toBeGreaterThan(0)
  })
})
