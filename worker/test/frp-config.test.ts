// frp-config 纯函数：样例解析 / 参数化 / 渲染 / 表单校验。
import { describe, it, expect } from "vitest"
import {
  buildTemplateFromSample,
  DEFAULT_FRP_TEMPLATE,
  detectAuthMode,
  normalizeFrpDonationPayload,
  parseFrpcSample,
  renderFrpcConfig,
} from "../src/frp-config"

const SAMPLE = [
  'serverAddr = "frp.example.com"',
  "serverPort = 7000",
  "",
  'auth.token = "shared-secret"',
  "",
  'user = "demo"',
  "[metadatas]",
  'token = "demo-pass"',
  "",
  "[[proxies]]",
  'name = "web"',
  'type = "tcp"',
  'localIP = "127.0.0.1"',
  "localPort = 8080",
  'remotePort = 8080',
].join("\n")

describe("parseFrpcSample", () => {
  it("提取 serverAddr / serverPort / 个人凭据", () => {
    const info = parseFrpcSample(SAMPLE)
    expect(info.serverAddr).toBe("frp.example.com")
    expect(info.serverPort).toBe(7000)
    expect(info.authToken).toBe("shared-secret")
    expect(info.user).toBe("demo")
    expect(info.password).toBe("demo-pass")
    expect(info.keys.has("metadatas.token")).toBe(true)
  })

  it("忽略 proxies 段里的字段", () => {
    const info = parseFrpcSample(SAMPLE)
    // proxies 段没有 serverAddr / token 之类的键
    expect([...info.keys].some((k) => k.startsWith("proxies"))).toBe(false)
  })
})

describe("detectAuthMode", () => {
  it("有 metadatas.token → token_user", () => {
    expect(detectAuthMode(SAMPLE)).toBe("token_user")
  })
  it("只有 auth.token → token", () => {
    const s = 'serverAddr = "x.com"\nserverPort = 7000\nauth.token = "abc"\n'
    expect(detectAuthMode(s)).toBe("token")
  })
  it("什么都没有 → none", () => {
    expect(detectAuthMode('serverAddr = "x.com"\nserverPort = 7000\n')).toBe("none")
  })
})

describe("buildTemplateFromSample", () => {
  it("参数化个人凭据，剥掉 proxies 段", () => {
    const tpl = buildTemplateFromSample(SAMPLE, "token_user")
    expect(tpl).toContain("{serverAddr}")
    expect(tpl).toContain("{authToken}")
    expect(tpl).toContain("{user}")
    expect(tpl).toContain("{password}")
    // 捐献者自己的凭据被剥掉
    expect(tpl).not.toContain("demo-pass")
    expect(tpl).not.toContain('"demo"')
    expect(tpl).not.toContain("shared-secret")
    // proxies 段被删掉
    expect(tpl).not.toContain("[[proxies]]")
    expect(tpl).not.toContain("remotePort")
  })

  it("保留不认识的插件字段", () => {
    const s =
      'serverAddr = "x.com"\nserverPort = 7000\nauth.token = "abc"\n[plugin]\noidc_issuer = "https://auth.example.com"\n'
    const tpl = buildTemplateFromSample(s, "token")
    expect(tpl).toContain("[plugin]")
    expect(tpl).toContain('oidc_issuer = "https://auth.example.com"')
  })

  it("token_user 缺 metadatas.token 时补齐", () => {
    const s = 'serverAddr = "x.com"\nserverPort = 7000\nauth.token = "abc"\nuser = "u"\n'
    const tpl = buildTemplateFromSample(s, "token_user")
    expect(tpl).toContain("{password}")
    expect(tpl).toContain("{user}")
  })
})

describe("renderFrpcConfig", () => {
  const ctx = {
    serverAddr: "frp.example.com",
    serverPort: 7000,
    authToken: "real-secret",
    user: "alice",
    password: "alice-pass",
    proxies: '[[proxies]]\nname = "web"\ntype = "tcp"\nlocalPort = 8080\nremotePort = 8080',
  }

  it("按模板渲染，填入真实凭据", () => {
    const tpl = buildTemplateFromSample(SAMPLE, "token_user")
    const out = renderFrpcConfig(tpl, ctx)
    expect(out).toContain('serverAddr = "frp.example.com"')
    expect(out).toContain('auth.token = "real-secret"')
    expect(out).toContain('user = "alice"')
    expect(out).toContain('token = "alice-pass"')
    expect(out).toContain("remotePort = 8080")
  })

  it("值为空的占位符 → 整行删掉", () => {
    const tpl = buildTemplateFromSample(SAMPLE, "token_user")
    const out = renderFrpcConfig(tpl, { ...ctx, authToken: "" })
    expect(out).not.toContain("auth.token")
  })

  it("无模板 → 用内置生成器，行为与改版前一致", () => {
    const out = renderFrpcConfig(null, ctx)
    expect(out).toContain('serverAddr = "frp.example.com"')
    expect(out).toContain('auth.token = "real-secret"')
    expect(out).toContain('user = "alice"')
    expect(out).toContain('token = "alice-pass"')
  })

  it("DEFAULT_FRP_TEMPLATE 与内置生成器一致（含占位符）", () => {
    expect(DEFAULT_FRP_TEMPLATE).toContain("{serverAddr}")
    expect(DEFAULT_FRP_TEMPLATE).toContain("{password}")
  })
})

describe("normalizeFrpDonationPayload", () => {
  const valid = {
    nodeName: "节点",
    serverAddr: "frp.example.com",
    serverPort: 7000,
    portMin: 20000,
    portMax: 50000,
    maxPorts: 5,
    authMode: "token_user",
    authToken: "secret",
    configSample: SAMPLE,
  }

  it("合法输入 → ok", () => {
    const r = normalizeFrpDonationPayload(valid)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.serverPort).toBe(7000)
  })

  it("缺 serverAddr → 拒绝", () => {
    const r = normalizeFrpDonationPayload({ ...valid, serverAddr: "" })
    expect(r.ok).toBe(false)
  })

  it("serverAddr 带协议/端口 → 拒绝", () => {
    const r = normalizeFrpDonationPayload({ ...valid, serverAddr: "https://frp.example.com:7000" })
    expect(r.ok).toBe(false)
  })

  it("内网地址 → 拒绝", () => {
    expect(normalizeFrpDonationPayload({ ...valid, serverAddr: "10.0.0.1" }).ok).toBe(false)
    expect(normalizeFrpDonationPayload({ ...valid, serverAddr: "localhost" }).ok).toBe(false)
    expect(normalizeFrpDonationPayload({ ...valid, serverAddr: "192.168.0.1" }).ok).toBe(false)
  })

  it("端口范围起 ≥ 止 → 拒绝", () => {
    const r = normalizeFrpDonationPayload({ ...valid, portMin: 50000, portMax: 20000 })
    expect(r.ok).toBe(false)
  })

  it("示例 serverAddr 与表单不一致 → 拒绝", () => {
    const r = normalizeFrpDonationPayload({
      ...valid,
      serverAddr: "other.example.com",
      configSample: SAMPLE, // 里面对应的是 frp.example.com
    })
    expect(r.ok).toBe(false)
  })

  it("token_user 没填 token → 拒绝", () => {
    const r = normalizeFrpDonationPayload({ ...valid, authToken: "" })
    expect(r.ok).toBe(false)
  })

  it("示例缺 serverAddr → 拒绝", () => {
    const r = normalizeFrpDonationPayload({
      ...valid,
      configSample: 'serverPort = 7000\nauth.token = "x"\n',
    })
    expect(r.ok).toBe(false)
  })
})
