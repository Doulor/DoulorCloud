/**
 * 测试用的 TCP 握手桩。
 *
 * 背景：单测沙箱**没有真实出网 TCP**（`cloudflare:sockets` 的 `connect()` 被挡），
 * 而捐献自动审核那条路径会真去握手订阅里的节点。结果：
 *   · 期望 `approved` 的用例全部拿到 `pending`（误命中「连不上 → 转人工」闸门）
 *   · 每条还要空等 5 秒握手超时，四个文件加起来白跑 20 多秒
 *
 * 这里通过 `setTcpConnectorForTest`（挂在 `globalThis` 上，因此能跨 Worker 的
 * 模块注册表生效）把探活结论变成测试的**输入**。
 *
 * 用法：
 *   beforeEach(installOkTcpStub)
 *   afterEach(restoreTcpStub)
 * 单独某条要测「一个都连不上 → 转人工」时，在该用例内改调 `installFailTcpStub()`。
 */
import { setTcpConnectorForTest } from "../src/proxy-latency"

/** 握手一定成功（节点「可连」） */
export function installOkTcpStub(): void {
  setTcpConnectorForTest(() => ({
    opened: Promise.resolve(),
    close: async () => {},
  }))
}

/** 握手一定失败（节点「连不上」） */
export function installFailTcpStub(): void {
  setTcpConnectorForTest(() => ({
    // 会被 measureTcpHandshake 的 Promise.race 捕获，不会变成 unhandled rejection
    opened: Promise.reject(new Error("tcp-stub: unreachable")),
    close: async () => {},
  }))
}

/** 还原成真实 `connect()` */
export function restoreTcpStub(): void {
  setTcpConnectorForTest(null)
}
