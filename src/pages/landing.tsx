import * as React from "react"
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
  Zap,
  Wifi,
  ShieldCheck,
  Server,
  Lock,
  HeartHandshake,
  MonitorSmartphone,
  Smartphone,
  Monitor,
  Download,
  Loader2,
  Users,
  Send,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { GitHubMark } from "@/components/github-mark"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useAuth } from "@/hooks/use-auth"
import { useInstallPrompt } from "@/hooks/use-install-prompt"
import { useT } from "@/i18n"
import { QQ_GROUP_URL, REPO_URL, TELEGRAM_URL } from "@/lib/site-links"

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

/** 9 个功能模块（3×3 正好铺满），每个含能力点 bullet，强调「能做什么」。文案在词典里（landing.f1.* ~ landing.f10.*，f5 临时分享箱已下架）。 */
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

/** 落地页「下载」区：网页 PWA + 安卓 APK + Windows EXE（安卓/Windows 链接在管理后台配） */
function DownloadSection() {
  const { t } = useT()
  const { canInstall, install } = useInstallPrompt()
  const [busy, setBusy] = React.useState(false)
  const [guideOpen, setGuideOpen] = React.useState(false)
  const [links, setLinks] = React.useState<{ android: string | null; windows: string | null }>({
    android: null,
    windows: null,
  })

  React.useEffect(() => {
    fetch("/api/downloads")
      .then((r) => (r.ok ? r.json() : { android: null, windows: null }))
      .then((d) => setLinks({ android: d.android ?? null, windows: d.windows ?? null }))
      .catch(() => {})
  }, [])

  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  const isIOS = /iphone|ipad|ipod/i.test(ua)
  const isAndroid = /android/i.test(ua)

  /**
   * PWA 的「安装」按钮永远可点：
   *   - 浏览器放行了一键安装（桌面 Chrome/Edge、安卓 Chrome）→ 弹系统安装框；
   *   - 没放行（iOS、已安装、未满足条件）→ 弹手动教程。
   * 这样它和安卓/Windows 的下载按钮观感一致，不会出现「一块死文字」。
   */
  const onPwaClick = async () => {
    if (canInstall) {
      setBusy(true)
      try {
        await install()
      } finally {
        setBusy(false)
      }
    } else {
      setGuideOpen(true)
    }
  }

  const guideSteps = isIOS
    ? [t("pwa.iosStep1"), t("pwa.iosStep2"), t("pwa.iosStep3")]
    : isAndroid
      ? [t("pwa.guideAndroid1"), t("pwa.guideAndroid2")]
      : [t("pwa.guideDesktop1"), t("pwa.guideDesktop2")]

  const cardCls =
    "group flex w-full flex-col items-center rounded-2xl border bg-card/70 p-8 text-center backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl sm:w-[19rem]"
  const iconWrap =
    "mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border bg-background shadow-sm transition-colors group-hover:bg-accent"

  return (
    <section id="download" className="py-12 sm:py-16">
      <div className="mb-10 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t("landing.downloadTitle")}
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">{t("landing.downloadSub")}</p>
      </div>

      <div className="flex flex-wrap justify-center gap-5">
        {/* 网页版 PWA */}
        <div className={cardCls}>
          <div className={iconWrap}>
            <MonitorSmartphone className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="mb-2 text-lg font-semibold">{t("landing.dl.pwa")}</h3>
          <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
            {t("landing.dl.pwaDesc")}
          </p>
          <Button
            className="mt-auto w-full"
            size="lg"
            onClick={() => void onPwaClick()}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {t("landing.dl.pwaInstall")}
          </Button>
        </div>

        {/* 安卓 */}
        {links.android ? (
          <div className={cardCls}>
            <div className={iconWrap}>
              <Smartphone className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">{t("landing.dl.android")}</h3>
            <p className="mb-2 text-sm leading-relaxed text-muted-foreground">
              {t("landing.dl.androidDesc")}
            </p>
            <p className="mb-6 text-xs text-muted-foreground">
              {t("landing.dl.creditProject")}{" "}
              <a
                href="https://github.com/shiaho777/web-to-app"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
              >
                web-to-app
              </a>{" "}
              {t("landing.dl.creditSuffix")}
            </p>
            <Button asChild className="mt-auto w-full" size="lg" variant="outline">
              <a href={links.android} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4" />
                {t("landing.dl.download")}
              </a>
            </Button>
          </div>
        ) : null}

        {/* Windows */}
        {links.windows ? (
          <div className={cardCls}>
            <div className={iconWrap}>
              <Monitor className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">{t("landing.dl.windows")}</h3>
            <p className="mb-2 text-sm leading-relaxed text-muted-foreground">
              {t("landing.dl.windowsDesc")}
            </p>
            <p className="mb-6 text-xs text-muted-foreground">
              {t("landing.dl.creditContributor")}{" "}
              <a
                href="https://github.com/twz-hub"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
              >
                twz-hub
              </a>{" "}
              {t("landing.dl.creditSuffix")}
            </p>
            <Button asChild className="mt-auto w-full" size="lg" variant="outline">
              <a href={links.windows} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4" />
                {t("landing.dl.download")}
              </a>
            </Button>
          </div>
        ) : null}
      </div>

      {/* 一键安装不可用（iOS / 未就绪）时的手动教程 */}
      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("pwa.guideTitle")}</DialogTitle>
            <DialogDescription>{t("pwa.guideDesc")}</DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {guideSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>
    </section>
  )
}

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
              className="rounded-2xl border bg-card/70 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl"
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
            <div key={keyBase} className="rounded-2xl border bg-card/70 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl">
              <div className="mb-3 inline-flex h-7 w-7 items-center justify-center rounded-full border bg-background text-sm font-medium text-muted-foreground">
                {i + 1}
              </div>
              <h3 className="mb-1.5 font-medium">{t(`${keyBase}.title`)}</h3>
              <p className="text-sm text-muted-foreground">{t(`${keyBase}.desc`)}</p>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-6 flex max-w-2xl items-start gap-3 rounded-2xl border bg-muted/40 p-4">
          <HeartHandshake className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("landing.whyContribute")}</p>
        </div>
      </section>

      {/* 更新日志 */}
      <section id="updates" className="py-12 sm:py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.updatesTitle")}
          </h2>
          <ul className="space-y-3">
            {["landing.upd1", "landing.upd2", "landing.upd3", "landing.upd4"].map((k) => (
              <li key={k} className="flex items-start gap-3 rounded-2xl border bg-card/70 p-4 backdrop-blur-sm transition-colors hover:border-foreground/20">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                <span className="text-sm text-muted-foreground">{t(k)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 下载：网页 PWA + 安卓 + Windows */}
      <DownloadSection />

      {/* 卖点：为什么选 Doulor Cloud */}
      <section className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.whyTitle")}
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border bg-card/70 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl">
            <Server className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">{t("landing.why1.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("landing.why1.desc")}</p>
          </div>
          <div className="rounded-2xl border bg-card/70 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl">
            <Lock className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">{t("landing.why2.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("landing.why2.desc")}</p>
          </div>
          <div className="rounded-2xl border bg-card/70 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl">
            <Zap className="mb-3 h-5 w-5 text-muted-foreground" />
            <h3 className="mb-1.5 font-medium">{t("landing.why3.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("landing.why3.desc")}</p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-12 sm:py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.faq")}
          </h2>
          <div className="divide-y rounded-2xl border bg-card/70 backdrop-blur-sm">
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

      {/* 联系社区：QQ 群 + Telegram */}
      <section id="contact" className="py-12 sm:py-16">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.contactTitle")}
          </h2>
          <p className="mb-8 text-muted-foreground">{t("landing.contactSub")}</p>
          <div className="flex flex-wrap justify-center gap-4">
            <a
              href={QQ_GROUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 rounded-2xl border bg-card/70 px-6 py-4 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border bg-background transition-colors group-hover:bg-accent">
                <Users className="h-5 w-5 text-muted-foreground" />
              </span>
              <span className="font-medium">{t("landing.contact.qq")}</span>
            </a>
            <a
              href={TELEGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 rounded-2xl border bg-card/70 px-6 py-4 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border bg-background transition-colors group-hover:bg-accent">
                <Send className="h-5 w-5 text-muted-foreground" />
              </span>
              <span className="font-medium">{t("landing.contact.tg")}</span>
            </a>
            {/* 开源仓库：与上面两个社区入口并列，访客能直接去看源码 / 提 issue */}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 rounded-2xl border bg-card/70 px-6 py-4 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border bg-background transition-colors group-hover:bg-accent">
                <GitHubMark className="h-5 w-5 text-muted-foreground" />
              </span>
              <span className="font-medium">{t("landing.contact.gh")}</span>
            </a>
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

      {/* 页脚：版权 + 开源仓库入口。
          开源项目里访客/贡献者最常找的就是这里，放页脚是最不打扰、也最符合直觉的位置。 */}
      <footer className="mt-8 flex flex-col items-center justify-between gap-3 border-t py-8 text-sm text-muted-foreground sm:flex-row">
        <p className="text-center sm:text-left">
          © {new Date().getFullYear()} Doulor Cloud
          <span className="mx-2 hidden sm:inline">·</span>
          <span className="block sm:inline">{t("landing.footer.builtWith")}</span>
        </p>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-2 rounded-md px-2 py-1 underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          <GitHubMark className="h-4 w-4" />
          {t("landing.footer.repo")}
        </a>
      </footer>
    </div>
  )
}
