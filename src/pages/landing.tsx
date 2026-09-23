import { Link } from "react-router-dom"
import {
  ArrowRight,
  Globe,
  Mail,
  Network,
  Inbox,
  HardDrive,
  Sparkles,
  Contact,
  Package,
  Zap,
  ShieldCheck,
  Server,
  Lock,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/hooks/use-auth"

/** 9 个功能模块，每个含能力点 bullet，强调「能做什么」。 */
const features = [
  {
    icon: Globe,
    title: "个人子域名",
    points: [
      "注册即得 yourname.doulor.cn",
      "可添加 blog、api 等子域名",
      "支持多级嵌套",
    ],
  },
  {
    icon: Mail,
    title: "域名邮箱",
    points: [
      "yourname@doulor.cn 自动开通",
      "可添加多个地址",
      "转发到常用邮箱",
    ],
  },
  {
    icon: Inbox,
    title: "网页收件箱",
    points: [
      "网页内直接阅读邮件",
      "标记已读、转发、删除",
      "一键全部已读",
    ],
  },
  {
    icon: HardDrive,
    title: "直链网盘",
    points: [
      "上传即得公开直链",
      "绑定自定义子域名",
      "配额可视、进度条",
    ],
  },
  {
    icon: Sparkles,
    title: "AI 中转站",
    points: [
      "开箱即用的 API Key",
      "兼容主流客户端与模型",
      "实时额度与用量",
    ],
  },
  {
    icon: Network,
    title: "DNS 管理",
    points: [
      "A / AAAA / CNAME / TXT / MX",
      "代理状态可控",
      "TTL 自由配置",
    ],
  },
  {
    icon: Zap,
    title: "内网穿透",
    points: [
      "本地服务暴露到公网",
      "端口与隧道申请",
      "自定义域名直达",
    ],
  },
  {
    icon: Package,
    title: "临时分享箱",
    points: [
      "生成临时取件码",
      "文件或文本限时分享",
      "过期自动清理",
    ],
  },
  {
    icon: Contact,
    title: "个人名片",
    points: [
      "对外展示的个人主页",
      "主题、动效、排版混搭",
      "绑定自定义域名",
    ],
  },
]

const faqs = [
  {
    q: "如何注册？",
    a: "需要邀请码。注册后即获得 yourname.doulor.cn 子域名与 yourname@doulor.cn 邮箱，登录控制台即可使用全部功能。",
  },
  {
    q: "支持哪些邮件客户端？",
    a: "收件箱可在网页内直接阅读，也支持转发到你的常用邮箱。AI 中转站的 API Key 兼容主流客户端（如 ChatGPT-Next-Web、LobeChat、OpenAI SDK 等）。",
  },
  {
    q: "数据安全如何保障？",
    a: "所有敏感凭证（Cloudflare Token、第三方凭据）仅存在于 Worker 环境变量，前端不信任任何身份字段，权限一律在服务端校验。用户输入经转义防 XSS。",
  },
  {
    q: "架构是什么样的？",
    a: "纯静态前端 + Cloudflare Workers 后端，数据存 D1，文件存 R2，邮件走 Cloudflare Email Routing。没有自建服务器，全球边缘加速。",
  },
  {
    q: "功能会持续扩展吗？",
    a: "会。目前已覆盖域名、邮箱、网盘、AI、内网穿透、代理节点、临时分享、个人名片等模块，后续会按需增加。",
  },
]

export default function LandingPage() {
  const { user } = useAuth()

  return (
    <div className="mx-auto w-full max-w-6xl px-4 lg:px-8">
      {/* Hero */}
      <section className="flex flex-col items-center gap-6 py-20 text-center sm:py-28">
        <Badge variant="secondary" className="gap-1.5 px-3 py-1">
          <ShieldCheck className="h-3 w-3" />
          Doulor Cloud
        </Badge>
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          一站式云端平台
          <br />
          域名与服务，开箱即用
        </h1>
        <p className="max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
          子域名、域名邮箱、网页收件箱、直链网盘、AI 中转站、DNS 管理、内网穿透、
          代理节点、临时分享箱、个人名片 —— 一个账号，全部就绪。
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Button asChild size="lg">
            <Link to={user ? "/dashboard" : "/register"}>
              {user ? "进入控制台" : "开始使用"}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          {!user && (
            <Button asChild size="lg" variant="outline">
              <Link to="/login">登录</Link>
            </Button>
          )}
        </div>
      </section>

      {/* 功能网格：每个含能力点 bullet */}
      <section id="features" className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            九大能力，开箱即用
          </h2>
          <p className="mt-2 text-muted-foreground">
            一个账号拥有全套云端工具，全部在网页里完成。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-lg border bg-card p-6 transition-colors hover:bg-accent/40"
            >
              <div className="mb-4 inline-flex rounded-md border bg-background p-2">
                <f.icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <h3 className="mb-2 font-medium">{f.title}</h3>
              <ul className="space-y-1.5">
                {f.points.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* 卖点：为什么选 Doulor Cloud */}
      <section className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            为什么选择 Doulor Cloud
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-6">
            <Server className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">一站式集成</h3>
            <p className="text-sm text-muted-foreground">
              域名、邮箱、存储、AI 等模块共用一套账号与界面，无需在多个服务间切换。
            </p>
          </div>
          <div className="rounded-lg border bg-card p-6">
            <Lock className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">安全为先</h3>
            <p className="text-sm text-muted-foreground">
              凭据仅在 Worker 环境变量，权限服务端校验，用户输入转义防注入。
            </p>
          </div>
          <div className="rounded-lg border bg-card p-6">
            <Zap className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">边缘加速</h3>
            <p className="text-sm text-muted-foreground">
              基于 Cloudflare 全球边缘网络，静态前端 + Serverless 后端，访问快。
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            常见问题
          </h2>
          <div className="divide-y rounded-lg border bg-card">
            {faqs.map((f) => (
              <details key={f.q} className="group px-5">
                <summary className="flex cursor-pointer list-none items-center justify-between py-4 text-sm font-medium transition-colors hover:bg-accent/40 [&::-webkit-details-indicator]:hidden">
                  {f.q}
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                </summary>
                <p className="pb-4 text-sm text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="flex flex-col items-center gap-4 py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          准备好了吗？
        </h2>
        <p className="max-w-xl text-muted-foreground">
          需要邀请码注册。已有账号直接登录，进入控制台管理全部资源。
        </p>
        <div className="flex items-center gap-3">
          <Button asChild size="lg">
            <Link to={user ? "/dashboard" : "/register"}>
              {user ? "进入控制台" : "立即注册"}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          {!user && (
            <Button asChild size="lg" variant="outline">
              <Link to="/login">登录</Link>
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}
