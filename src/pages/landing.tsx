import { Link } from "react-router-dom"
import {
  ArrowRight,
  Globe,
  Mail,
  Network,
  Inbox,
  HardDrive,
  Sparkles,
  GitBranch,
  TerminalSquare,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/hooks/use-auth"

const features = [
  {
    icon: Globe,
    title: "个人子域名",
    description:
      "注册即获得 example.doulor.cn，可继续添加 blog、api 等子域名。",
  },
  {
    icon: Mail,
    title: "域名邮箱",
    description:
      "example@doulor.cn 自动开通，还可以添加 hello、contact 等地址。",
  },
  {
    icon: Inbox,
    title: "网页收件箱",
    description:
      "邮件直接在网页内阅读，也可以转发到你的常用邮箱。",
  },
  {
    icon: HardDrive,
    title: "直链网盘",
    description:
      "上传文件即可获得公开直链，也可以绑定自己的子域名。",
  },
  {
    icon: Sparkles,
    title: "AI 中转站",
    description:
      "开箱即用的 API Key，兼容常见客户端，随时查看用量。",
  },
  {
    icon: Network,
    title: "DNS 管理",
    description:
      "A、AAAA、CNAME、TXT、MX 记录，代理与 TTL 全部可控。",
  },
]

const demoRecords = [
  { name: "example", type: "域名", content: "example.doulor.cn", note: "你的子域名" },
  { name: "blog", type: "A", content: "192.0.2.10", note: "博客" },
  { name: "mail", type: "收件箱", content: "example@doulor.cn", note: "域名邮箱" },
  { name: "img", type: "直链", content: "img.example.doulor.cn/a.png", note: "网盘文件" },
]

export default function LandingPage() {
  const { user } = useAuth()

  return (
    <div className="mx-auto w-full max-w-6xl px-4 lg:px-8">
      {/* Hero */}
      <section className="flex flex-col items-center gap-6 py-20 text-center sm:py-28">
        <Badge variant="secondary" className="gap-1.5 px-3 py-1">
          <GitBranch className="h-3 w-3" />
          私有 · 邀请制
        </Badge>
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          给朋友的一份
          <br />
          域名与云端服务
        </h1>
        <p className="max-w-xl text-balance text-base text-muted-foreground sm:text-lg">
          注册即拥有 example.doulor.cn 和 example@doulor.cn，
          子域名、域名邮箱、直链网盘与 AI API，一站式管理。
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Button asChild size="lg">
            <Link to={user ? "/dashboard" : "/register"}>
              开始使用
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/login">登录</Link>
          </Button>
        </div>
      </section>

      {/* Terminal demo */}
      <section className="mx-auto w-full max-w-2xl pb-20">
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="flex items-center gap-1.5 border-b bg-muted/50 px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-border" />
            <span className="h-2.5 w-2.5 rounded-full bg-border" />
            <span className="h-2.5 w-2.5 rounded-full bg-border" />
            <span className="ml-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <TerminalSquare className="h-3.5 w-3.5" />
              doulor.cn
            </span>
          </div>
          <div className="space-y-1 p-5 font-mono text-sm">
            <p>
              <span className="text-muted-foreground">$</span>{" "}
              <span className="text-emerald-600 dark:text-emerald-400">
                example.doulor.cn
              </span>
            </p>
            <p className="text-muted-foreground">├─ blog.example.doulor.cn</p>
            <p className="text-muted-foreground">├─ api.example.doulor.cn</p>
            <p className="text-muted-foreground">├─ example@doulor.cn</p>
            <p className="text-muted-foreground">└─ img.example.doulor.cn/photo.png</p>
            <p className="pt-3 text-muted-foreground">
              <span className="text-muted-foreground">$</span> 收件箱（1 封未读）
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-16">
        <div className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            简单、够用
          </h2>
          <p className="mt-2 text-muted-foreground">
            域名、邮箱、存储与 AI，登录即用。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-lg border bg-card p-6 transition-colors hover:bg-accent/40"
            >
              <f.icon className="mb-4 h-5 w-5 text-muted-foreground" />
              <h3 className="mb-1 font-medium">{f.title}</h3>
              <p className="text-sm text-muted-foreground">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Example */}
      <section id="how" className="py-16">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              注册后你会得到
            </h2>
            <p className="mt-4 text-muted-foreground">
              一个属于你的子域名，一个能收信的域名邮箱，
              以及直链网盘与 AI API。全部在网页里完成。
            </p>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="border-b px-5 py-3 text-sm font-medium">
              示例
            </div>
            <div className="divide-y">
              {demoRecords.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-mono">{r.name}</span>
                    <span className="text-muted-foreground">.doulor.cn</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.note}
                    </span>
                  </div>
                  <Badge variant="outline">{r.type}</Badge>
                  <span className="hidden truncate font-mono text-xs text-muted-foreground sm:block">
                    {r.content}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}