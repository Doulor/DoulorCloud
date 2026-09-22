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
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/hooks/use-auth"

/** 9 个功能模块，覆盖当前实际能力。强调「能做什么」而非原理。 */
const features = [
  {
    icon: Globe,
    title: "个人子域名",
    description: "注册即拥有 example.doulor.cn，可继续添加 blog、api 等子域名，支持多级嵌套。",
  },
  {
    icon: Mail,
    title: "域名邮箱",
    description: "example@doulor.cn 自动开通，还能添加 hello、contact 等地址，可转发到常用邮箱。",
  },
  {
    icon: Inbox,
    title: "网页收件箱",
    description: "邮件直接在网页内阅读，支持标记已读、转发、删除，无需邮件客户端。",
  },
  {
    icon: HardDrive,
    title: "直链网盘",
    description: "上传文件即得公开直链，可绑定自己的子域名做图床或资源托管。",
  },
  {
    icon: Sparkles,
    title: "AI 中转站",
    description: "开箱即用的 API Key，兼容主流客户端与模型，实时查看用量与额度。",
  },
  {
    icon: Network,
    title: "DNS 管理",
    description: "A / AAAA / CNAME / TXT / MX 记录全可控，代理状态与 TTL 自由配置。",
  },
  {
    icon: Zap,
    title: "内网穿透",
    description: "把本地服务暴露到公网，支持申请端口与隧道，自定义域名直达内网。",
  },
  {
    icon: Package,
    title: "临时分享箱",
    description: "生成临时取件码，文件或文本限时分享，过期自动清理，支持匿名上传。",
  },
  {
    icon: Contact,
    title: "个人名片",
    description: "对外展示的个人主页，多种主题、动效与排版混搭，可绑自定义域名。",
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
          Doulor Cloud · 内测版
        </Badge>
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          一站式
          <br />
          云端的域名与服务
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

      {/* 功能网格 */}
      <section id="features" className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            九大能力，开箱即用
          </h2>
          <p className="mt-2 text-muted-foreground">
            注册一个账号，拥有全套云端工具，全部在网页里完成。
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
              <h3 className="mb-1.5 font-medium">{f.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="flex flex-col items-center gap-4 py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          准备好了吗？
        </h2>
        <p className="max-w-xl text-muted-foreground">
          需要邀请码注册。已有账号直接登录，进入控制台管理你的全部资源。
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
