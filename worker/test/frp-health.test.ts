import { describe, expect, it } from "vitest"

import { decideNodeStatus, HEARTBEAT_STALE_MINUTES } from "../src/frp-health"

/**
 * frp 节点状态判定（2026-10-24）。
 *
 * 这些用例锁的是**判据本身**：端口不通 = offline；端口通但心跳过期 = degraded；
 * 都正常才是 online。写这段的起因是北京节点停机后后台仍显示 online
 * —— 那时候 frp_nodes.status 是 9 月手工写死的，没有任何任务在维护它。
 */
describe("frp 节点状态判定", () => {
  const now = Date.parse("2026-10-24T05:00:00Z")

  it("控制端口连不上 → offline", () => {
    const r = decideNodeStatus(false, "2026-10-24T04:59:00Z", now)
    expect(r.status).toBe("offline")
    expect(r.note).toContain("控制端口")
  })

  it("端口通 + 心跳新鲜 → online，且没有提示文案", () => {
    const r = decideNodeStatus(true, "2026-10-24T04:58:30Z", now)
    expect(r.status).toBe("online")
    expect(r.note).toBe("")
  })

  it("端口通但心跳超过阈值 → degraded，并带分钟数", () => {
    const r = decideNodeStatus(true, "2026-10-24T04:30:00Z", now)
    expect(r.status).toBe("degraded")
    expect(r.note).toContain("30 分钟")
  })

  it("心跳恰好等于阈值时仍算 online（边界不误杀）", () => {
    const seen = new Date(now - HEARTBEAT_STALE_MINUTES * 60000).toISOString()
    expect(decideNodeStatus(true, seen, now).status).toBe("online")
  })

  it("从未上报过心跳 → degraded（而不是 offline，端口是通的）", () => {
    expect(decideNodeStatus(true, null, now).status).toBe("degraded")
    expect(decideNodeStatus(true, "", now).status).toBe("degraded")
  })

  it("心跳时间格式坏掉 → degraded，不抛异常", () => {
    const r = decideNodeStatus(true, "not-a-date", now)
    expect(r.status).toBe("degraded")
    expect(r.note).toContain("无法解析")
  })

  it("自定义阈值生效", () => {
    const seen = new Date(now - 5 * 60000).toISOString()
    expect(decideNodeStatus(true, seen, now, 3).status).toBe("degraded")
    expect(decideNodeStatus(true, seen, now, 10).status).toBe("online")
  })
})
