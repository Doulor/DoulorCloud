// 真实订阅样本回归：一份纯 anytls + hysteria2 的订阅（用户实际提交、被误拒的那份）。
//
// 修复前这份订阅会被自动审核整体拒绝（报「没有解析出任何节点」），因为解析器
// 只认 vless/vmess/trojan/ss。样本按真实结构固化在测试里，防止以后改动解析
// 逻辑时又把它拒掉。
//
// ⚠️ 样本已脱敏：地址/口令换成文档保留字（example.top / aaaa…），
// 但**协议、参数名、参数形态、中文节点名**与线上那份完全一致 ——
// 这几点才是解析逻辑真正依赖的东西。
import { describe, it, expect } from "vitest"
import { parseSubscription, usableNodes, profileFromNodes } from "../src/handlers/proxy"

/** percent-encode 一个节点名（与订阅站的做法一致） */
const enc = (s: string) => encodeURIComponent(s)

/** 12 个 anytls + 2 个 hysteria2，参数形态照抄真实订阅 */
const REAL_SHAPED_SUB = [
  // anytls：userinfo 是口令，参数只有 sni + insecure
  "anytls://aaaaaaaa-0000-0000-0000-000000000000@node0.example.top:51023?sni=cdn0.example.com&insecure=1#" +
    enc("🧸 熊云.boo [中文网址]"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000001@node1.example.top:51033?sni=cdn1.example.com&insecure=1#" +
    enc("🇸🇬 新加坡 1"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000002@node2.example.top:51043?sni=cdn2.example.com&insecure=1#" +
    enc("🇯🇵 日本 -1"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000003@node3.example.top:51053?sni=cdn3.example.com&insecure=1#" +
    enc("🇺🇸 美国 -2"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000004@node4.example.top:51063?sni=cdn4.example.com&insecure=1#" +
    enc("🇭🇰 香港 1"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000005@node5.example.top:51073?sni=cdn5.example.com&insecure=1#" +
    enc("🇹🇼 台湾"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000006@node6.example.top:51083?sni=cdn6.example.com&insecure=1#" +
    enc("🇩🇪 德国"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000007@node7.example.top:51093?sni=cdn7.example.com&insecure=1#" +
    enc("🇯🇵 日本 2"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000008@node8.example.top:51103?sni=cdn8.example.com&insecure=1#" +
    enc("🇸🇬 新加坡 2"),
  "anytls://aaaaaaaa-0000-0000-0000-000000000009@node9.example.top:51113?sni=cdn9.example.com&insecure=1#" +
    enc("🇺🇸 美国 1"),
  "anytls://aaaaaaaa-0000-0000-0000-00000000000a@nodea.example.top:51123?sni=cdna.example.com&insecure=1#" +
    enc("🇭🇰 香港 2"),
  "anytls://aaaaaaaa-0000-0000-0000-00000000000b@nodeb.example.top:51133?sni=cdnb.example.com&insecure=1#" +
    enc("🇸🇬 新加坡 3"),
  // hysteria2：带 obfs / obfs-password / mport（`obfs-password` 里的 "ss"
  // 正是旧解码闸门假阳性命中的那处）
  "hysteria2://bbbbbbbb-0000-0000-0000-000000000000@hy0.example.net:65127?sni=www.example.com&insecure=1&obfs=salamander&obfs-password=secret0&mport=51024-51029#" +
    enc("🇯🇵 日本 -3"),
  "hysteria2://bbbbbbbb-0000-0000-0000-000000000001@hy1.example.net:65128?sni=www.example.com&insecure=1&obfs=salamander&obfs-password=secret1&mport=51024-51029#" +
    enc("🇸🇬 新加坡 4"),
].join("\n")

describe("真实订阅样本：anytls + hysteria2", () => {
  it("14 个节点全部解析出来，协议分布为 anytls 12 / hysteria2 2", () => {
    const nodes = usableNodes(parseSubscription(REAL_SHAPED_SUB))
    expect(nodes).toHaveLength(14)

    const byProto: Record<string, number> = {}
    for (const n of nodes) byProto[n.protocol] = (byProto[n.protocol] ?? 0) + 1
    expect(byProto.anytls).toBe(12)
    expect(byProto.hysteria2).toBe(2)

    // 众数取 anytls（12 > 2），订阅源协议会被标成 anytls
    expect(profileFromNodes(nodes, "https://x.example.com/sub").protocol).toBe("anytls")
  })

  it("节点名里的中文与 emoji 能正确还原（percent-decode 不抛）", () => {
    const nodes = usableNodes(parseSubscription(REAL_SHAPED_SUB))
    const names = nodes.map((n) => n.name)
    expect(names.some((n) => n.includes("熊云"))).toBe(true)
    expect(names.some((n) => n.includes("新加坡"))).toBe(true)
    // 地区识别吃的是节点名，中文还原不了这里就会全是 null
    const regions = new Set(nodes.map((n) => n.region).filter(Boolean))
    expect(regions.size).toBeGreaterThan(1)
  })

  it("server / port / sni / 口令都解析出来", () => {
    const nodes = usableNodes(parseSubscription(REAL_SHAPED_SUB))
    for (const n of nodes) {
      expect(n.server).toBeTruthy()
      expect(n.port).toBeGreaterThan(0)
      expect(n.details.sni).toBeTruthy()
      expect(n.details.password).toBeTruthy()
    }
    const hy2 = nodes.find((n) => n.protocol === "hysteria2")!
    expect(hy2.details.obfs).toBe("salamander")
    expect(hy2.details.obfsPassword).toBe("secret0")
  })

  it("整包 base64 的形态同样能解析（订阅站常见）", () => {
    const bytes = new TextEncoder().encode(REAL_SHAPED_SUB)
    let bin = ""
    for (const b of bytes) bin += String.fromCharCode(b)
    const nodes = usableNodes(parseSubscription(btoa(bin)))
    expect(nodes).toHaveLength(14)
  })
})
