// DNS 合规规则引擎（worker/src/dns-audit.ts 的 assessRecord）。
//
// 为什么单独测这一层：它是**纯函数**，也是整个「DNS 审核」功能唯一的判断依据 ——
// 一旦某条规则写错（阈值反了、后缀匹配漏了子域、私网段少写一段），
// 表现出来是「明明有问题的记录显示成无问题」，而这**不会有任何报错**。
// 扫描器/界面/数据库都只是它的搬运工，所以把边界压在这里最划算。
//
// 这里只测规则判定，不碰 D1（scanDns 的落库逻辑需要真库，属集成范围）。
import { describe, it, expect } from "vitest"
import { assessRecord, type DnsRecordLike } from "../src/dns-audit"

/** 造一条记录，只写关心的字段 */
function rec(over: Partial<DnsRecordLike>): DnsRecordLike {
  return {
    id: "rec-1",
    domain_id: "dom-1",
    subdomain_id: null,
    cf_id: "cf-1",
    name: "blog",
    fqdn: "blog.alice.doulor.cn",
    type: "A",
    content: "203.0.113.9",
    ttl: 1,
    proxied: 0,
    priority: null,
    srv_weight: null,
    srv_port: null,
    srv_target: null,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    username: "alice",
    ...over,
  }
}

const rules = (r: DnsRecordLike) => assessRecord(r, { zoneSuffix: "doulor.cn" }).map((f) => f.rule)
const topSev = (r: DnsRecordLike) => assessRecord(r, { zoneSuffix: "doulor.cn" })[0]?.severity ?? null

describe("DNS 合规规则 · 地址类", () => {
  it("内网地址判高风险", () => {
    expect(rules(rec({ content: "192.168.55.154" }))).toContain("private-ip")
    expect(rules(rec({ content: "10.0.0.1" }))).toContain("private-ip")
    expect(rules(rec({ content: "172.20.1.1" }))).toContain("private-ip")
  })

  it("172.32.x 不属于私网段（边界不能写成 /16 一刀切）", () => {
    expect(rules(rec({ content: "172.32.1.1" }))).not.toContain("private-ip")
    expect(rules(rec({ content: "172.15.1.1" }))).not.toContain("private-ip")
  })

  it("回环 / 链路本地 / 保留段都判高风险", () => {
    expect(rules(rec({ content: "127.0.0.1" }))).toContain("loopback-ip")
    expect(rules(rec({ content: "169.254.1.1" }))).toContain("linklocal-ip")
    expect(rules(rec({ content: "0.0.0.0" }))).toContain("reserved-ip")
  })

  it("测试网段与公共解析器只判中风险（是占位/填错，不是滥用）", () => {
    expect(topSev(rec({ content: "192.0.2.10", proxied: 1 }))).toBe("medium")
    expect(rules(rec({ content: "192.0.2.10" }))).toContain("test-net-ip")
    expect(rules(rec({ content: "8.8.8.8" }))).toContain("resolver-ip")
  })

  it("指向 Cloudflare 自己的 IP 判高风险（解析自环）", () => {
    expect(rules(rec({ content: "104.16.0.1" }))).toContain("cf-ip-selfref")
  })

  it("内容不是合法 IP 判风险（CF 会拒，本地却是脏数据）", () => {
    // ⚠️ 是 medium 不是 high：这类记录在 CF 侧根本没建成，零滥用可能。
    // 定成 high 会让一批「A a / A b」式的垃圾记录把真正要紧的几条淹没
    // （线上实测：一个用户 22 条非法记录把高风险计数从 6 抬到 27）。
    expect(rules(rec({ content: "a" }))).toContain("invalid-content")
    expect(assessRecord(rec({ content: "a" }), { zoneSuffix: "doulor.cn" })[0].severity).toBe("medium")
    expect(rules(rec({ content: "999.1.1.1" }))).toContain("invalid-content")
  })

  it("AAAA 覆盖 IPv6 私网/回环/非法", () => {
    expect(rules(rec({ type: "AAAA", content: "fc00::1" }))).toContain("private-ip")
    expect(rules(rec({ type: "AAAA", content: "::1" }))).toContain("loopback-ip")
    expect(rules(rec({ type: "AAAA", content: "not-an-ip" }))).toContain("invalid-content")
  })
})

describe("DNS 合规规则 · 第三方托管与域名转发", () => {
  it("CNAME 指向 Pages 判高风险（拿平台域名做信誉背书）", () => {
    const r = rec({ type: "CNAME", content: "cf-yg-8s2.pages.dev", proxied: 1, name: "cf" })
    expect(rules(r)).toContain("third-party-hosting")
    expect(topSev(r)).toBe("high")
  })

  it("子域形态的第三方托管也能命中（后缀匹配必须支持子域）", () => {
    expect(rules(rec({ type: "CNAME", content: "foo.bar.vercel.app" }))).toContain("third-party-hosting")
  })

  it("CNAME 指向 forwarddomain.net 判高风险", () => {
    expect(rules(rec({ type: "CNAME", content: "r.forwarddomain.net" }))).toContain("forward-domain")
  })

  it("TXT 里的 forward-domain 声明同样判高风险（转发是 CNAME+TXT 两件套）", () => {
    const r = rec({ type: "TXT", content: "forward-domain=https://nos.nl/*", name: "fwd" })
    expect(rules(r)).toContain("forward-domain")
  })

  it("CNAME 指向自己判高风险（解析环）", () => {
    const r = rec({ type: "CNAME", content: "blog.alice.doulor.cn" })
    expect(rules(r)).toContain("cname-self")
  })

  it("CNAME 指向平台自身命名空间判中风险（注销后会悬空）", () => {
    const r = rec({ type: "CNAME", content: "bob.doulor.cn", proxied: 1, name: "data" })
    expect(rules(r)).toContain("platform-namespace-cname")
  })

  it("不是主机名的 CNAME/MX/SRV 目标判非法", () => {
    expect(rules(rec({ type: "CNAME", content: "has space.com" }))).toContain("invalid-content")
    expect(rules(rec({ type: "MX", content: "" }))).toContain("invalid-content")
    expect(rules(rec({ type: "SRV", content: "10 0 13300 ok.example.com" }))).not.toContain("invalid-content")
  })

  it("SPF 出现在本站域名上判风险（邮件伪造面）", () => {
    expect(rules(rec({ type: "TXT", content: "v=spf1 include:_spf.google.com ~all" }))).toContain("spf-on-platform")
  })
})

describe("DNS 合规规则 · 名字与状态", () => {
  it("泛解析判高风险（等于开了无限个可用主机名）", () => {
    expect(rules(rec({ name: "*", fqdn: "*.alice.doulor.cn" }))).toContain("wildcard-record")
    expect(rules(rec({ name: "*.x", fqdn: "*.x.alice.doulor.cn" }))).toContain("wildcard-record")
  })

  it("随机名判提示；随机名 + 开代理升到中风险", () => {
    // 用公网 IP：否则会额外命中 test-net-ip（中风险），把 topSeverity 抬高，
    // 这条断言就测不到「随机名本身有多严重」了。
    const plain = rec({
      name: "qrxdxfvghbjn",
      fqdn: "qrxdxfvghbjn.alice.doulor.cn",
      content: "120.227.201.25",
      proxied: 0,
    })
    expect(rules(plain)).toContain("random-name")
    expect(topSev(plain)).toBe("low")

    const proxied = rec({
      name: "qrxdxfvghbjn",
      fqdn: "qrxdxfvghbjn.alice.doulor.cn",
      content: "120.227.201.25",
      proxied: 1,
    })
    expect(topSev(proxied)).toBe("medium")
  })

  it("正常拼音/英文名不算随机（避免误报刷屏）", () => {
    expect(rules(rec({ name: "blog" }))).not.toContain("random-name")
    expect(rules(rec({ name: "chenshui" }))).not.toContain("random-name")
    expect(rules(rec({ name: "linjian" }))).not.toContain("random-name")
  })

  it("钓鱼常用名只判中风险（不拦截，只提示）", () => {
    expect(rules(rec({ name: "login", fqdn: "login.alice.doulor.cn" }))).toContain("phishing-name")
    expect(topSev(rec({ name: "login", fqdn: "login.alice.doulor.cn" }))).toBe("medium")
  })

  it("status=error 判提示（CF 拒绝了，本地还留着）", () => {
    expect(rules(rec({ status: "error" }))).toContain("sync-error")
  })

  it("active 但没有 cf_id 判提示（台账与实际不一致）", () => {
    expect(rules(rec({ cf_id: null, status: "active" }))).toContain("missing-cf-id")
  })

  it("重复记录判提示（同名同类型同内容）", () => {
    const dup = new Map<string, number>()
    dup.set("p.liuli.doulor.cn|A|p", 2)
    const r = rec({ name: "p", fqdn: "p.liuli.doulor.cn", content: "p" })
    const found = assessRecord(r, { zoneSuffix: "doulor.cn", duplicateKey: dup })
    expect(found.map((f) => f.rule)).toContain("duplicate-record")
  })
})

describe("DNS 合规规则 · 深度探测结果", () => {
  it("悬空 CNAME 判高风险（可被抢注接管）", () => {
    const r = rec({ type: "CNAME", content: "gone.example.com" })
    const found = assessRecord(r, {
      zoneSuffix: "doulor.cn",
      resolution: { addresses: ["gone.example.com"], targetDangling: true },
    })
    expect(found.map((f) => f.rule)).toContain("dangling-cname")
  })

  it("解析不出来只判中风险，且探测自身失败只算提示（不冤判记录）", () => {
    const noAddr = assessRecord(rec({}), { zoneSuffix: "doulor.cn", resolution: { addresses: [] } })
    expect(noAddr.map((f) => f.rule)).toContain("no-address")
    expect(noAddr.find((f) => f.rule === "no-address")?.severity).toBe("medium")

    const errored = assessRecord(rec({}), {
      zoneSuffix: "doulor.cn",
      resolution: { addresses: [], error: "DoH timeout" },
    })
    expect(errored.map((f) => f.rule)).toContain("resolve-failed")
    expect(errored.find((f) => f.rule === "resolve-failed")?.severity).toBe("low")
  })
})

describe("DNS 合规规则 · 结果排序与降噪", () => {
  it("高风险排在中/低之前", () => {
    const found = assessRecord(
      rec({ content: "192.168.1.1", name: "login", fqdn: "login.alice.doulor.cn" }),
      { zoneSuffix: "doulor.cn" }
    )
    expect(found[0].severity).toBe("high")
    // 严重度必须是单调不降的
    for (let i = 1; i < found.length; i++) {
      const order = { high: 0, medium: 1, low: 2 } as const
      expect(order[found[i].severity]).toBeGreaterThanOrEqual(order[found[i - 1].severity])
    }
  })

  it("干净的记录只给「未开代理」这一条提示，不当风险报", () => {
    const found = assessRecord(
      rec({ content: "120.227.201.25", name: "linjian", fqdn: "linjian.doulor.cn" }),
      { zoneSuffix: "doulor.cn" }
    )
    expect(found.map((f) => f.rule)).toEqual(["origin-unproxied"])
  })

  it("开了代理的干净记录没有任何发现项", () => {
    const found = assessRecord(
      rec({ content: "120.227.201.25", name: "linjian", fqdn: "linjian.doulor.cn", proxied: 1 }),
      { zoneSuffix: "doulor.cn" }
    )
    expect(found).toEqual([])
  })
})
