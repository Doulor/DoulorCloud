// 节点链接解析：协议覆盖与 base64 解码闸门。
//
// 背景：自动审核的判据是「能抓到订阅 + 能解析出至少一个节点」。曾经只认
// vless/vmess/trojan/ss 四种，导致 anytls / hysteria2 / tuic / ssr 的订阅
// 被整体误拒（用户实测：一份纯 anytls+hysteria2 的订阅被判「没有解析出节点」）。
// 同时解码闸门用裸子串匹配，会被 `obfs-password` 里的 `ss` 假阳性命中。
import { describe, it, expect } from "vitest"
import {
  parseNodeLink,
  parseSubscription,
  usableNodes,
  looksLikeNodeList,
  profileFromNodes,
} from "../src/handlers/proxy"

/**
 * base64 编码（UTF-8 语义）。
 *
 * 不能直接用 `btoa(text)`：btoa 只接受 Latin1，遇到中文会抛
 * `InvalidCharacterError`。而真实的 v2board 订阅是把 **UTF-8 字节**做 base64，
 * 所以这里先 TextEncoder 再逐字节喂给 btoa —— 与线上数据的编码方式一致。
 */
function b64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

describe("parseNodeLink —— 协议覆盖", () => {
  it("vless：带 ws/tls/sni 的完整链接", () => {
    const n = parseNodeLink(
      "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=tls&type=ws&sni=a.example.com&fp=chrome#台湾"
    )
    expect(n.protocol).toBe("vless")
    expect(n.server).toBe("1.2.3.4")
    expect(n.port).toBe(443)
    expect(n.details.uuid).toBe("11111111-2222-3333-4444-555555555555")
    expect(n.details.network).toBe("ws")
    expect(n.details.sni).toBe("a.example.com")
    expect(n.details.security).toBe("tls")
    expect(n.region).toBe("台湾")
  })

  it("hysteria2：userinfo 是口令，obfs 相关字段入库", () => {
    const n = parseNodeLink(
      "hysteria2://cd839b41-d000-45b9-abbc-f9c9f331f42f@52.14.129.82:65127" +
        "?security=tls&alpn=h3&sni=www.bing.com&obfs=salamander&obfs-password=xyz#us1"
    )
    expect(n.protocol).toBe("hysteria2")
    expect(n.server).toBe("52.14.129.82")
    expect(n.port).toBe(65127)
    expect(n.details.password).toBe("cd839b41-d000-45b9-abbc-f9c9f331f42f")
    expect(n.details.obfs).toBe("salamander")
    expect(n.details.obfsPassword).toBe("xyz")
    expect(n.details.sni).toBe("www.bing.com")
    expect(n.details.alpn).toBe("h3")
  })

  it("hy2 别名归一成 hysteria2（否则众数统计会被摊薄）", () => {
    const n = parseNodeLink("hy2://pass@1.2.3.4:443?sni=x.com#节点")
    expect(n.protocol).toBe("hysteria2")
    expect(n.server).toBe("1.2.3.4")
  })

  it("hysteria v1：没有 userinfo，认证在 query 的 auth 里", () => {
    const n = parseNodeLink(
      "hysteria://1.2.3.4:36712?protocol=udp&auth=mypass&peer=t.example.com&insecure=1#v1"
    )
    expect(n.protocol).toBe("hysteria")
    expect(n.server).toBe("1.2.3.4")
    expect(n.port).toBe(36712)
    expect(n.details.password).toBe("mypass")
    expect(n.details.sni).toBe("t.example.com")
  })

  it("anytls：userinfo 是口令", () => {
    const n = parseNodeLink(
      "anytls://1095c731-affa-4f85-a9c8-61e495e56aca@03-e0.abccba.top:51023?sni=gs.example.cn&insecure=1#熊云"
    )
    expect(n.protocol).toBe("anytls")
    expect(n.server).toBe("03-e0.abccba.top")
    expect(n.port).toBe(51023)
    expect(n.details.password).toBe("1095c731-affa-4f85-a9c8-61e495e56aca")
    expect(n.details.sni).toBe("gs.example.cn")
  })

  it("tuic：userinfo 是 uuid:password", () => {
    const n = parseNodeLink(
      "tuic://11111111-2222-3333-4444-555555555555:pass@1.2.3.4:443?congestion_control=bbr&sni=x.com#tuic"
    )
    expect(n.protocol).toBe("tuic")
    expect(n.details.uuid).toBe("11111111-2222-3333-4444-555555555555")
    expect(n.details.password).toBe("pass")
    expect(n.details.congestion).toBe("bbr")
  })

  it("ss legacy：base64(method:password) 要解出来", () => {
    // base64("aes-256-gcm:pw123")
    const cred = b64("aes-256-gcm:pw123")
    const n = parseNodeLink(`ss://${cred}@9.9.9.9:8388#美国`)
    expect(n.protocol).toBe("ss")
    expect(n.server).toBe("9.9.9.9")
    expect(n.port).toBe(8388)
    expect(n.details.method).toBe("aes-256-gcm")
    expect(n.details.password).toBe("pw123")
  })

  it("ss 明文形态：method:password 直接写在 userinfo", () => {
    const n = parseNodeLink("ss://aes-128-gcm:pw@9.9.9.9:8388#节点")
    expect(n.details.method).toBe("aes-128-gcm")
    expect(n.details.password).toBe("pw")
  })

  it("ssr：嵌套 base64，密码与备注各解一层", () => {
    const inner = [
      "1.2.3.4",
      "1234",
      "auth_aes128_md5",
      "aes-256-cfb",
      "tls1.2_ticket_auth",
      b64("mypassword"),
    ].join(":")
    const query = `obfsparam=${b64("cloud.example.com")}&remarks=${b64("香港SSR")}`
    const n = parseNodeLink(`ssr://${b64(`${inner}/?${query}`)}`)
    expect(n.protocol).toBe("ssr")
    expect(n.server).toBe("1.2.3.4")
    expect(n.port).toBe(1234)
    expect(n.details.method).toBe("aes-256-cfb")
    expect(n.details.password).toBe("mypassword")
    expect(n.details.name).toBe("香港SSR")
    expect(n.details.obfsParam).toBe("cloud.example.com")
    expect(n.region).toBe("香港")
  })

  it("vmess：base64(JSON) 形态保持原有行为", () => {
    const cfg = b64(
      JSON.stringify({ v: "2", ps: "日本节点", add: "1.2.3.4", port: "443", id: "abc", aid: "0", net: "ws", tls: "tls" })
    )
    const n = parseNodeLink(`vmess://${cfg}`)
    expect(n.protocol).toBe("vmess")
    expect(n.server).toBe("1.2.3.4")
    expect(n.port).toBe(443)
    expect(n.region).toBe("日本")
  })

  it("IPv6 字面量：host 用 [] 包裹时不能被冒号切坏", () => {
    const n = parseNodeLink("trojan://pw@[2001:db8::1]:443?sni=x.com#v6")
    expect(n.protocol).toBe("trojan")
    expect(n.server).toBe("[2001:db8::1]")
    expect(n.port).toBe(443)
  })

  it("不认识的 scheme → unknown（不会被当成已知协议放行）", () => {
    expect(parseNodeLink("wireguard://x@1.2.3.4:51820").protocol).toBe("unknown")
    expect(parseNodeLink("ftp://1.2.3.4:21").protocol).toBe("unknown")
  })

  it("端口缺失 / 非法 → port 为 null，但协议仍识别", () => {
    const n = parseNodeLink("vless://uuid@1.2.3.4?sni=x.com#无名")
    expect(n.protocol).toBe("vless")
    expect(n.server).toBe("1.2.3.4")
    expect(n.port).toBeNull()
  })
})

describe("looksLikeNodeList —— base64 解码闸门", () => {
  it("按 scheme:// 判定，真实节点列表命中", () => {
    expect(looksLikeNodeList("anytls://a@1.2.3.4:443#x")).toBe(true)
    expect(looksLikeNodeList("hysteria2://a@1.2.3.4:443#x")).toBe(true)
    expect(looksLikeNodeList("第一行\nvless://a@1.2.3.4:443#x")).toBe(true)
  })

  it("裸子串不再误判 —— obfs-password 里的 ss 不算节点", () => {
    // 这正是用户那份 anytls 订阅踩到的假阳性
    const text = "anytls://a@1.2.3.4:443?obfs-password=cBN0Z7iu"
    // 该文本本身含 anytls:// 所以为 true；关键是下面这个纯文本
    expect(looksLikeNodeList(text)).toBe(true)
    expect(looksLikeNodeList("&obfs-password=abc&mport=51024-5102")).toBe(false)
    expect(looksLikeNodeList("这是一个 ss 字样的普通网页")).toBe(false)
    expect(looksLikeNodeList("<html><body>class=\"mission\"</body></html>")).toBe(false)
  })
})

describe("parseSubscription —— 整体 base64 与逐行", () => {
  it("纯 anytls + hysteria2 的 base64 订阅能被完整解析（用户实际案例）", () => {
    const body = [
      "anytls://1095c731@03-e0.abccba.top:51023?sni=gs.example.cn&insecure=1#熊云1",
      "anytls://1095c731@03-e1.abccba.top:51023?sni=gs.example.cn&insecure=1#熊云2",
      "hysteria2://cd839b41@52.14.129.82:65127?security=tls&sni=www.bing.com#us1",
    ].join("\n")
    const nodes = usableNodes(parseSubscription(b64(body)))
    expect(nodes).toHaveLength(3)
    expect(nodes.filter((n) => n.protocol === "anytls")).toHaveLength(2)
    expect(nodes.filter((n) => n.protocol === "hysteria2")).toHaveLength(1)
    // 众数取 anytls（2 > 1）
    expect(profileFromNodes(nodes, "https://x.example.com/sub").protocol).toBe("anytls")
  })

  it("明文（未编码）订阅同样能解析", () => {
    const nodes = usableNodes(
      parseSubscription("tuic://uuid:pass@1.2.3.4:443?sni=x.com#韩国\n")
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0].protocol).toBe("tuic")
  })

  it("HTML 页面不会被当成节点列表", () => {
    const nodes = usableNodes(
      parseSubscription("<!DOCTYPE html><html><body>hello</body></html>")
    )
    expect(nodes).toHaveLength(0)
  })

  it("含 obfs-password 的普通文本不会被误当订阅解码", () => {
    // 这段若被 base64 解码成功且闸门宽松，就会产出垃圾节点
    const junk = b64("普通的说明文字 &obfs-password=abc 与 ss 字样")
    expect(usableNodes(parseSubscription(junk))).toHaveLength(0)
  })
})
