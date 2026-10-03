// 出站地址守卫（SSRF 面的唯一闸口）。
//
// 所有「服务端去请求用户填的地址」的功能都过它：AI 渠道探测、代理订阅校验、
// 链接卡片预览、网页分享自动识别、商汤 Key 巡检。
// 这里锁住的是「哪些算内网 / 保留地址」——判错了就是把内网暴露出去。
import { describe, it, expect } from "vitest"
import { assertPublicHttpUrl, isPrivateOrLocalHost } from "../src/url-guard"

describe("isPrivateOrLocalHost —— 该拦的", () => {
  it("本机 / 私有网段 / 保留段 / 特殊域名 / IPv6 字面量", () => {
    for (const h of [
      "",
      " ",
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // 云元数据端点，最经典的 SSRF 目标
      "0.0.0.0",
      "100.64.0.1", // CGNAT 起点
      "100.127.255.254", // CGNAT 终点
      "224.0.0.1",
      "239.255.255.250",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "nas.local",
      "router.internal",
      "printer.home.arpa",
    ]) {
      expect(isPrivateOrLocalHost(h), h).toBe(true)
    }
  })
})

describe("isPrivateOrLocalHost —— 该放的", () => {
  it("公网域名与公网 IP", () => {
    for (const h of [
      "example.com",
      "www.qq.com",
      "1.1.1.1",
      "8.8.8.8",
      "172.15.0.1", // 172.16 的前一段
      "172.32.0.1", // 172.31 的后一段
      "100.63.0.1", // CGNAT 的前一段
      "100.128.0.1", // CGNAT 的后一段
      "notlocal.com", // 别把 .local 后缀误伤到域名中间
      "mylocal.cn",
      "223.5.5.5", // 223 是最后一个公网可用 /8 的邻居（224 起才是多播）
    ]) {
      expect(isPrivateOrLocalHost(h), h).toBe(false)
    }
  })
})

describe("assertPublicHttpUrl", () => {
  it("放行 http / https 的公网地址", () => {
    expect(assertPublicHttpUrl("https://example.com/x", "链接").host).toBe("example.com")
    expect(assertPublicHttpUrl("  http://example.com/  ", "链接").href).toBe(
      "http://example.com/"
    )
  })

  it("空 / 非法 / 非 http 协议 / 内网 → 抛错", () => {
    for (const bad of [
      "",
      "   ",
      "不是网址",
      "ftp://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "http://127.0.0.1/",
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(() => assertPublicHttpUrl(bad, "链接"), bad).toThrow()
    }
  })

  it("报错信息里带上传入的名词，便于前端直接展示", () => {
    expect(() => assertPublicHttpUrl("", "订阅链接")).toThrow(/订阅链接/)
    expect(() => assertPublicHttpUrl("http://10.0.0.1/", "上游地址")).toThrow(/上游地址/)
    expect(() => assertPublicHttpUrl("ftp://x.com", "图标地址")).toThrow(/图标地址/)
  })
})
