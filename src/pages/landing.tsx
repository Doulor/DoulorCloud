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
  Wifi,
  ShieldCheck,
  Server,
  Lock,
  HeartHandshake,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"

/**
 * 功能模块的开放档位。
 *
 *   - `free`：注册即用，不需要任何权限，也不消耗站长的资源。
 *   - `contribute`：需要「贡献换权限」—— 贡献一份资源（AI 渠道 / 代理订阅 /
 *     穿透配置）经审核通过后解锁。
 *
 * 文案一律走词典（landing.f1.* / landing.step1.* / landing.faq1.* 等），
 * 组件里用 t() 取，中英两版各写一份。
 *
 * ⚠️ 这个标记必须与服务端的权限模型保持一致：服务端只有 r2 / ai / frp / proxy
 * 四个模块过 `requireFeatureUser`（见 worker/src/permissions.ts 的 FEATURES）。
 * 改动这里之前先确认服务端，否则落地页会再次出现「承诺了却用不了」的落差。
 */
type FeatureTier = "free" | "contribute"

const TIER_META: Record<FeatureTier, { labelKey: string; variant: "success" | "secondary" }> = {
  free: { labelKey: "landing.tierFree", variant: "success" },
  contribute: { labelKey: "landing.tierContribute", variant: "secondary" },
}

/** 10 个功能模块，每个含能力点 bullet，强调「能做什么」。文案在词典里（landing.f1.* ~ landing.f10.*）。 */
const features: {
  icon: typeof Globe
  keyBase: string
  tier: FeatureTier
  points: number
}[] = [
  { icon: Globe, keyBase: "landing.f1", tier: "free", points: 3 },
  { icon: Mail, keyBase: "landing.f2", tier: "free", points: 3 },
  { icon: Inbox, keyBase: "landing.f3", tier: "free", points: 3 },
  { icon: Network, keyBase: "landing.f4", tier: "free", points: 3 },
  { icon: Package, keyBase: "landing.f5", tier: "free", points: 3 },
  { icon: Contact, keyBase: "landing.f6", tier: "free", points: 3 },
  { icon: HardDrive, keyBase: "landing.f7", tier: "contribute", points: 3 },
  { icon: Sparkles, keyBase: "landing.f8", tier: "contribute", points: 3 },
  { icon: Zap, keyBase: "landing.f9", tier: "contribute", points: 3 },
  { icon: Wifi, keyBase: "landing.f10", tier: "contribute", points: 3 },
]

/** 「如何开始」三步 —— 也修掉了导航里 /#how 的死链。 */
const steps = ["landing.step1", "landing.step2", "landing.step3"]

const faqs = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
  qKey: `landing.faq${n}.q`,
  aKey: `landing.faq${n}.a`,
}))

export default function LandingPage() {
  const { user } = useAuth()
  const { t } = useT()

  return (
    <div className="mx-auto w-full max-w-6xl px-4 lg:px-8">
      {/* Hero */}
      <section className="flex flex-col items-center gap-6 py-20 text-center sm:py-28">
        <Badge variant="secondary" className="gap-1.5 px-3 py-1">
          <ShieldCheck className="h-3 w-3" />
          Doulor Cloud
        </Badge>
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          {t("landing.heroLine1")}
          <br />
          {t("landing.heroLine2")}
        </h1>
        <p className="max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
          {t("landing.heroSub")}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Button asChild size="lg">
            <Link to={user ? "/dashboard" : "/register"}>
              {user ? t("landing.enterDashboard") : t("landing.getStarted")}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          {!user && (
            <Button asChild size="lg" variant="outline">
              <Link to="/login">{t("nav.login")}</Link>
            </Button>
          )}
        </div>
      </section>

      {/* 功能网格：每个含能力点 bullet + 开放档位标记 */}
      <section id="features" className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.featuresTitle")}
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">
            {t("landing.featuresSub")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.keyBase}
              className="rounded-lg border bg-card p-6 transition-colors hover:bg-accent/40"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="inline-flex rounded-md border bg-background p-2">
                  <f.icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <Badge variant={TIER_META[f.tier].variant}>
                  {t(TIER_META[f.tier].labelKey)}
                </Badge>
              </div>
              <h3 className="mb-2 font-medium">{t(`${f.keyBase}.title`)}</h3>
              <ul className="space-y-1.5">
                {Array.from({ length: f.points }, (_, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-muted-foreground"
                  >
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                    {t(`${f.keyBase}.p${i + 1}`)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* 如何开始：三步说明贡献解锁模型（导航栏 /#how 指向这里） */}
      <section id="how" className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.howTitle")}
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">
            {t("landing.howSub")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {steps.map((keyBase, i) => (
            <div key={keyBase} className="rounded-lg border bg-card p-6">
              <div className="mb-3 inline-flex h-7 w-7 items-center justify-center rounded-full border bg-background text-sm font-medium text-muted-foreground">
                {i + 1}
              </div>
              <h3 className="mb-1.5 font-medium">{t(`${keyBase}.title`)}</h3>
              <p className="text-sm text-muted-foreground">{t(`${keyBase}.desc`)}</p>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-6 flex max-w-2xl items-start gap-3 rounded-lg border bg-muted/40 p-4">
          <HeartHandshake className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("landing.whyContribute")}</p>
        </div>
      </section>

      {/* 卖点：为什么选 Doulor Cloud */}
      <section className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.whyTitle")}
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-6">
            <Server className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">{t("landing.why1.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("landing.why1.desc")}</p>
          </div>
          <div className="rounded-lg border bg-card p-6">
            <Lock className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">{t("landing.why2.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("landing.why2.desc")}</p>
          </div>
          <div className="rounded-lg border bg-card p-6">
            <Zap className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">{t("landing.why3.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("landing.why3.desc")}</p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.faq")}
          </h2>
          <div className="divide-y rounded-lg border bg-card">
            {faqs.map((f) => (
              <details key={f.qKey} className="group px-5">
                <summary className="flex cursor-pointer list-none items-center justify-between py-4 text-sm font-medium transition-colors hover:bg-accent/40 [&::-webkit-details-indicator]:hidden">
                  {t(f.qKey)}
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                </summary>
                <p className="pb-4 text-sm text-muted-foreground">{t(f.aKey)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="flex flex-col items-center gap-4 py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t("landing.ctaTitle")}
        </h2>
        <p className="max-w-xl text-muted-foreground">{t("landing.ctaDesc")}</p>
        <div className="flex items-center gap-3">
          <Button asChild size="lg">
            <Link to={user ? "/dashboard" : "/register"}>
              {user ? t("landing.enterDashboard") : t("landing.signUp")}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          {!user && (
            <Button asChild size="lg" variant="outline">
              <Link to="/login">{t("nav.login")}</Link>
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}
