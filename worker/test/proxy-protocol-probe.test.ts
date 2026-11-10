// 协议级探活：TCP 通不等于代理可用；WS 握手也必须通过。
import { describe, it, expect } from "vitest"
import { measureWebsocketHandshake, type WsProbeConnector } from "../src/proxy-latency"

function fakeConnector(response: string, delayMs = 0): WsProbeConnector {
  return () => ({
    opened: Promise.resolve(),
    close: async () => undefined,
    writable: new WritableStream({ write: async () => undefined, close: async () => undefined }),
    readable: new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(response))
          controller.close()
        }, delayMs)
      },
    }),
  })
}

describe("measureWebsocketHandshake", () => {
  it("SNI 使用 servername，HTTP Host 使用优选域名，二者不能混用", async () => {
    let seenHost = ""
    const connector: WsProbeConnector = (address, options) => {
      seenHost = options?.secureTransport ?? ""
      return fakeConnector("HTTP/1.1 101 Switching Protocols\r\n\r\n")(address, options)
    }
    await measureWebsocketHandshake(
      { protocol: "vless", server: "198.51.100.8", port: 443, servername: "origin.example.com", host: "cdn.example.com", path: "/" },
      { connector },
    )
    expect(seenHost).toBe("off")
  })

  it("TLS + WebSocket 返回 101 → 判定可用", async () => {
    const result = await measureWebsocketHandshake(
      { protocol: "vless", server: "example.com", port: 443, path: "/", host: "example.com" },
      { connector: fakeConnector("HTTP/1.1 101 Switching Protocols\r\n\r\n") },
    )
    expect(result.ok).toBe(true)
    expect(result.latencyMs).not.toBeNull()
  })

  it("TCP/TLS 能连但返回 200 网页 → 不能误判为可用", async () => {
    const result = await measureWebsocketHandshake(
      { protocol: "vless", server: "example.com", port: 443, path: "/", host: "example.com" },
      { connector: fakeConnector("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>") },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("200")
  })

  it("超时必须返回失败，不悬挂审核请求", async () => {
    const result = await measureWebsocketHandshake(
      { protocol: "vless", server: "example.com", port: 443, path: "/" },
      { timeoutMs: 5, connector: fakeConnector("HTTP/1.1 101 Switching Protocols", 100) },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("超时")
  })
})
