// 结构化订阅（Clash YAML / sing-box JSON / sspanel JSON）的解析回归。
//
// 背景（2026-09-25，线上实测）：代理捐献的自动审核判据是「能解析出至少一个节点」，
// 而解析器**只认「明文/base64 的 URI 列表」**。于是机场最常见的 Clash 订阅
// （`?target=clash` → text/yaml）与 sing-box 订阅（JSON）一律被解析成 0 个可用节点，
// 被判「没有解析出任何节点」并**自动拒绝**。
//
// 线上真实样本核对结果：
//   - 一份 119 KB 的 Clash YAML（top-level `proxies:`）→ 修复前可用 0，修复后 153；
//   - 一份 `text/html` 但实际是 base64 节点列表的订阅 → 修复前 0（因 403 被误判）；
//   - 9 笔自动拒绝里 4 笔的原始原因是 `HTTP 403`（订阅站拦 UA / 风控），
//     而这些链接现在从别的网络拉取完全正常 —— 属「没能验证」被当成「不可用」。
//
// 本文件的样本都按真实结构脱敏（地址/口令换成文档保留字），但**格式、键名、
// 值形态、缩进方式**与线上一致 —— 这些才是解析逻辑依赖的东西。
import { describe, it, expect } from "vitest"
import { parseSubscription, usableNodes, profileFromNodes } from "../src/handlers/proxy"

/** 一份 Clash 订阅：同时含 flow 与 block 两种写法，以及嵌套的 ws-opts */
const CLASH_YAML = `mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
proxies:
  - {name: "🇭🇰 香港 01", type: vless, server: hk1.example.com, port: 443, uuid: aaaaaaaa-0000-0000-0000-000000000001, tls: true, servername: edge.example.com, network: ws, ws-opts: {path: /ray, headers: {Host: edge.example.com}}, client-fingerprint: chrome}
  - name: "🇸🇬 新加坡 01"
    type: trojan
    server: sg1.example.com
    port: 443
    password: pass-sg
    sni: sg.example.com
    skip-cert-verify: true
  - name: "🇯🇵 日本 01"
    type: vmess
    server: jp1.example.com
    port: 443
    uuid: aaaaaaaa-0000-0000-0000-000000000003
    alterId: 0
    cipher: auto
    tls: true
    servername: jp.example.com
    network: ws
    ws-opts:
      path: /vm
      headers:
        Host: jp.example.com
  - name: "节点-ss"
    type: ss
    server: ss1.example.com
    port: 8388
    cipher: aes-256-gcm
    password: pass-ss
proxy-groups:
  - name: PROXY
    type: select
    proxies: ["🇭🇰 香港 01", "🇸🇬 新加坡 01"]
rules:
  - MATCH,PROXY
`

/** 一份 sing-box 订阅：含 selector（无 server，必须跳过）与 shadowsocks（type 名不同） */
const SINGBOX_JSON = JSON.stringify({
  log: { level: "info" },
  outbounds: [
    { type: "selector", tag: "proxy", outbounds: ["hk", "sg"] },
    {
      type: "vless",
      tag: "🇭🇰 香港 01",
      server: "hk1.example.com",
      server_port: 443,
      uuid: "aaaaaaaa-0000-0000-0000-000000000001",
      flow: "",
      tls: { enabled: true, server_name: "edge.example.com", insecure: false, alpn: ["h2", "http/1.1"] },
      transport: { type: "ws", path: "/ray", headers: { Host: "edge.example.com" } },
    },
    {
      type: "shadowsocks",
      tag: "🇯🇵 日本 01",
      server: "ss1.example.com",
      server_port: 8388,
      method: "aes-256-gcm",
      password: "pass-ss",
    },
    {
      type: "hysteria2",
      tag: "🇸🇬 新加坡 01",
      server: "hy1.example.net",
      server_port: 65127,
      password: "pass-hy",
      obfs: { type: "salamander", password: "obfs-pass" },
      tls: { enabled: true, server_name: "www.example.com", insecure: true },
    },
  ],
})

/** sspanel 的「节点列表」接口：只有 method/password，没有 type */
const SSPANEL_JSON = JSON.stringify({
  servers: [
    { id: 1, remarks: "🇺🇸 美国 01", server: "us1.example.com", server_port: 8388, method: "chacha20-ietf-poly1305", password: "pass-us" },
  ],
})

/** 只有我们不支持的协议（snell）—— 必须仍然解析出 0，不能因为「是 YAML」就放行 */
const CLASH_UNSUPPORTED = `proxies:
  - {name: "snell", type: snell, server: sn1.example.com, port: 443, psk: p}
`

describe("Clash YAML 订阅", () => {
  it("flow 与 block 两种写法、含嵌套 ws-opts 都能解析", () => {
    const nodes = usableNodes(parseSubscription(CLASH_YAML))
    const byProto: Record<string, number> = {}
    for (const n of nodes) byProto[n.protocol] = (byProto[n.protocol] ?? 0) + 1

    expect(nodes).toHaveLength(4)
    expect(byProto).toEqual({ vless: 1, trojan: 1, vmess: 1, ss: 1 })
  })

  it("字段正确落到节点上（server/port/口令/sni）", () => {
    const nodes = usableNodes(parseSubscription(CLASH_YAML))
    const vless = nodes.find((n) => n.protocol === "vless")!
    expect(vless.server).toBe("hk1.example.com")
    expect(vless.port).toBe(443)
    expect(vless.details.uuid).toBe("aaaaaaaa-0000-0000-0000-000000000001")
    expect(vless.details.sni).toBe("edge.example.com")
    expect(vless.details.network).toBe("ws")
    // 嵌套的 ws-opts.path 要能被取到（否则复制出去的链接缺 path，节点连不上）
    expect(vless.raw).toContain("path=%2Fray")
    expect(vless.raw).toContain("type=ws")

    const trojan = nodes.find((n) => n.protocol === "trojan")!
    expect(trojan.details.password).toBe("pass-sg")
    expect(trojan.details.sni).toBe("sg.example.com")

    const ss = nodes.find((n) => n.protocol === "ss")!
    expect(ss.details.method).toBe("aes-256-gcm")
    expect(ss.details.password).toBe("pass-ss")
  })

  it("raw 是可直接复制到客户端的链接，且能被重新解析（往返一致）", () => {
    const nodes = usableNodes(parseSubscription(CLASH_YAML))
    for (const n of nodes) {
      expect(n.raw).toMatch(/^[a-z0-9]+:\/\//i)
      const again = usableNodes(parseSubscription(n.raw))
      expect(again).toHaveLength(1)
      expect(again[0].server).toBe(n.server)
      expect(again[0].port).toBe(n.port)
    }
  })

  it("中文与 emoji 节点名能还原，地区识别可用", () => {
    const nodes = usableNodes(parseSubscription(CLASH_YAML))
    expect(nodes.some((n) => n.region === "HK")).toBe(true)
    const { protocol, region } = profileFromNodes(nodes, "https://x.com/sub")
    expect(protocol).toBeTruthy()
    expect(region).toBe("综合") // 香港/日本/新加坡多种 → 综合
  })
})

describe("sing-box / sspanel JSON 订阅", () => {
  it("outbounds 里的真实节点解析出来，selector 被跳过", () => {
    const nodes = usableNodes(parseSubscription(SINGBOX_JSON))
    const protos = nodes.map((n) => n.protocol).sort()
    // selector 没有 server → 不该产出节点；shadowsocks 归一成 ss
    expect(protos).toEqual(["hysteria2", "ss", "vless"])

    const vless = nodes.find((n) => n.protocol === "vless")!
    expect(vless.details.sni).toBe("edge.example.com")
    expect(vless.details.alpn).toBe("h2,http/1.1")
    expect(vless.raw).toContain("path=%2Fray")

    const hy2 = nodes.find((n) => n.protocol === "hysteria2")!
    expect(hy2.details.password).toBe("pass-hy")
    expect(hy2.details.obfs).toBe("salamander")
    expect(hy2.details.obfsPassword).toBe("obfs-pass")
  })

  it("sspanel 的 servers[]（只有 method，没有 type）按 ss 处理", () => {
    const nodes = usableNodes(parseSubscription(SSPANEL_JSON))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].protocol).toBe("ss")
    expect(nodes[0].server).toBe("us1.example.com")
    expect(nodes[0].details.method).toBe("chacha20-ietf-poly1305")
  })
})

describe("闸门没有被放宽", () => {
  it("HTML 页面仍然解析不出任何节点（这才是真正该拒的）", () => {
    const html = `<!DOCTYPE html><html><head><title>请使用客户端订阅</title></head><body><h1>404</h1></body></html>`
    expect(usableNodes(parseSubscription(html))).toHaveLength(0)
  })

  it("只有不支持的协议（snell）的 Clash 配置仍然解析出 0", () => {
    expect(usableNodes(parseSubscription(CLASH_UNSUPPORTED))).toHaveLength(0)
  })

  it("API 错误 JSON 解析出 0", () => {
    expect(usableNodes(parseSubscription(JSON.stringify({ error: "Not Found" })))).toHaveLength(0)
  })

  it("明文与整包 base64 的 URI 列表不受影响（原行为保持）", () => {
    const list = "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=tls#香港"
    expect(usableNodes(parseSubscription(list))).toHaveLength(1)
    // 订阅站是按 UTF-8 字节做 base64 的，裸 btoa 遇中文会抛
    const bytes = new TextEncoder().encode(list)
    let bin = ""
    for (const b of bytes) bin += String.fromCharCode(b)
    expect(usableNodes(parseSubscription(btoa(bin)))).toHaveLength(1)
  })
})
