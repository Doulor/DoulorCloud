/**
 * AI 实验室：**截图自检**（2026-10-12）。
 *
 * 为什么需要它：agent 做的是网页，但它**看不见自己的成品** —— 只能靠"读自己写的代码"
 * 猜视觉效果。这是它产出"能跑但错位/难看"页面的根本原因。有了这个接口，模型可以
 * 「做完 → 截图 → 看图 → 改样式」，闭环才成立。
 *
 * 实现走 Cloudflare Browser Run（原 Browser Rendering）的 **Quick Actions**：
 *   · 支持直接传 `html`（不必先把作品发布到公网）✅
 *   · 用 Workers 绑定 `env.BROWSER.quickAction(...)`，**不需要 API token** ✅
 *   · Quick Actions **只按浏览器时长计费**，不收并发费；**失败/超时不计费**
 *
 * 🔴 额度闸（站长 2026-10-12 明确要求「不要超过额度然后按量付费」）：
 *   · 官方额度：免费档 **10 分钟/天**；付费档 **10 小时/月**（含），超出 $0.09/小时
 *   · 我们**自己记账**（每次响应带 `X-Browser-Ms-Used`，精确到毫秒），
 *     在**请求发出之前**就拦住 ⇒ 账单侧永远进不到按量付费
 *   · 默认「双闸」：日 ≤ 8 分钟 **且** 月 ≤ 9 小时 —— 无论账号是免费还是付费档，
 *     两道闸都在包含额度以内（免费档留 2 分钟余量、付费档留 1 小时余量）
 *   · 顺带识别档位：真撞上 CF 的「今日浏览器时长已用尽」429 ⇒ 说明是免费档，
 *     记进 `lab_shot_plan` 供管理面板显示
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { getSetting, updateSettings, type SettingKey } from "../settings"
import type { Env } from "../env"

/** 单次截图最多等多久（CF 的浏览器超时是 60 秒，我们更保守一点） */
const SHOT_TIMEOUT_MS = 25_000
/** 单次请求体上限（内联后的单文件 HTML 通常几十到几百 KB） */
const MAX_HTML_CHARS = 1_500_000
/** 默认日闸：8 分钟（免费档 10 分钟/天，留 2 分钟余量） */
const DEFAULT_DAILY_MS = 8 * 60 * 1000
/** 默认月闸：9 小时（付费档含 10 小时/月，留 1 小时余量 ⇒ 不会按量付费） */
const DEFAULT_MONTHLY_MS = 9 * 60 * 60 * 1000

/** 读一个数值设置（拿不到/非法就用默认值） */
async function numSetting(env: Env, key: SettingKey, fallback: number): Promise<number> {
  const raw = await getSetting(env, key).catch(() => null)
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 今天 / 本月（UTC，和 CF 的计费周期口径一致） */
function periods(now = new Date()): { day: string; month: string } {
  const iso = now.toISOString()
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) }
}

/** 读用量（日 + 月两行） */
async function readUsage(
  env: Env,
  day: string,
  month: string
): Promise<{ dayMs: number; dayCalls: number; monthMs: number; monthCalls: number }> {
  const rows = await env.DB.prepare(
    "SELECT period, ms, calls FROM lab_shot_usage WHERE period IN (?, ?)"
  )
    .bind(day, month)
    .all<{ period: string; ms: number; calls: number }>()
  const list = rows.results ?? []
  const d = list.find((r) => r.period === day)
  const m = list.find((r) => r.period === month)
  return {
    dayMs: d?.ms ?? 0,
    dayCalls: d?.calls ?? 0,
    monthMs: m?.ms ?? 0,
    monthCalls: m?.calls ?? 0,
  }
}

/** 累加用量（两个周期各加一次；D1 的 upsert 语法） */
async function addUsage(env: Env, period: string, ms: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO lab_shot_usage (period, ms, calls, updated_at) VALUES (?, ?, 1, ?) " +
      "ON CONFLICT(period) DO UPDATE SET ms = ms + ?, calls = calls + 1, updated_at = ?"
  )
    .bind(period, ms, new Date().toISOString(), ms, new Date().toISOString())
    .run()
}

/**
 * GET /api/lab/screenshot —— 额度状态（给前端用量面板/管理面板看）。
 * 截图前前端也会拉它一次，好把「还能截几次」显示出来。
 */
export async function labShotStatus(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)
  const { day, month } = periods()
  const [dailyLimit, monthlyLimit, mode, usage] = await Promise.all([
    numSetting(env, "lab_shot_daily_ms", DEFAULT_DAILY_MS),
    numSetting(env, "lab_shot_monthly_ms", DEFAULT_MONTHLY_MS),
    getSetting(env, "lab_shot_mode").catch(() => null),
    readUsage(env, day, month),
  ])
  const plan = mode === "free" || mode === "paid" ? mode : "auto"
  return json({
    plan,
    /** 检测到的档位（撞过免费档的日限才会写死） */
    detected: (await getSetting(env, "lab_shot_plan").catch(() => null)) ?? null,
    dailyLimitMs: dailyLimit,
    monthlyLimitMs: monthlyLimit,
    dayMs: usage.dayMs,
    dayCalls: usage.dayCalls,
    monthMs: usage.monthMs,
    monthCalls: usage.monthCalls,
    /** 还能不能用（两道闸任一触顶就停） */
    blocked: usage.dayMs >= dailyLimit || usage.monthMs >= monthlyLimit,
  })
}

/**
 * POST /api/lab/screenshot —— body: { html, width?, height?, fullPage?, selector? }
 * 返回 `{ dataUrl, msUsed, ...额度 }`：dataUrl 直接能当图片 part 喂给模型。
 */
export async function labScreenshot(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)

  if ((await getSetting(env, "lab_shot_enabled")) === "0") {
    throw new ApiError(403, "站点已关闭「截图自检」功能", "SHOT_DISABLED")
  }
  if (!env.BROWSER) {
    throw new ApiError(503, "服务端没绑定浏览器（[browser] binding）", "SHOT_NO_BROWSER")
  }

  const body = (await request.json().catch(() => null)) as {
    html?: unknown
    width?: unknown
    height?: unknown
    fullPage?: unknown
    selector?: unknown
  } | null
  const html = typeof body?.html === "string" ? body.html : ""
  if (!html.trim()) throw new ApiError(400, "缺少 html", "INVALID_HTML")
  if (html.length > MAX_HTML_CHARS) {
    throw new ApiError(413, "页面太大，无法截图", "HTML_TOO_LARGE")
  }

  // ---- 额度闸：**在请求发出之前**拦，绝不进按量付费 ----
  const { day, month } = periods()
  const [dailyLimit, monthlyLimit] = await Promise.all([
    numSetting(env, "lab_shot_daily_ms", DEFAULT_DAILY_MS),
    numSetting(env, "lab_shot_monthly_ms", DEFAULT_MONTHLY_MS),
  ])
  const usage = await readUsage(env, day, month)
  if (usage.dayMs >= dailyLimit) {
    throw new ApiError(
      429,
      `今天的截图额度用完了（${Math.round(dailyLimit / 60000)} 分钟/天，已用 ` +
        `${Math.round(usage.dayMs / 1000)} 秒）。明天恢复；急用可在后台调高上限。`,
      "SHOT_DAILY_LIMIT"
    )
  }
  if (usage.monthMs >= monthlyLimit) {
    throw new ApiError(
      429,
      `本月截图额度用完了（${Math.round(monthlyLimit / 3600000)} 小时/月，已用 ` +
        `${(usage.monthMs / 3600000).toFixed(1)} 小时）。下月恢复；急用可在后台调高上限。`,
      "SHOT_MONTHLY_LIMIT"
    )
  }

  const width = Math.min(Math.max(Number(body?.width) || 1280, 320), 2560)
  const height = Math.min(Math.max(Number(body?.height) || 800, 240), 2000)
  const selector = typeof body?.selector === "string" && body.selector.trim() ? body.selector : undefined

  let res: Response
  try {
    res = await env.BROWSER.quickAction("screenshot", {
      html,
      viewport: { width, height },
      screenshotOptions: {
        // JPEG 比 PNG 小得多（回喂给模型省 token），质量 70 够看布局
        type: "jpeg",
        quality: 70,
        fullPage: body?.fullPage === true,
      },
      ...(selector ? { selector } : {}),
      gotoOptions: { waitUntil: "networkidle0", timeout: SHOT_TIMEOUT_MS },
    })
  } catch (err) {
    // 失败/超时 CF **不计费**，所以这里不记账；但要把"免费档"这个信号捞出来
    const text = String((err as Error)?.message ?? err)
    if (/Browser time limit exceeded for today/i.test(text)) {
      await updateSettings(env, { lab_shot_plan: "free" }).catch(() => undefined)
      throw new ApiError(
        429,
        "Cloudflare 今日浏览器时长已用尽（免费档 10 分钟/天），明天恢复。",
        "SHOT_CF_DAILY_LIMIT"
      )
    }
    throw new ApiError(502, `截图失败：${text.slice(0, 200)}`, "SHOT_FAILED")
  }
  if (!res.ok) {
    throw new ApiError(502, `截图失败（HTTP ${res.status}）`, "SHOT_FAILED")
  }

  const msUsed = Number(res.headers.get("X-Browser-Ms-Used") ?? "") || 0
  // 只记成功的调用（失败不计费，记了会虚高）
  if (msUsed > 0) {
    await Promise.all([addUsage(env, day, msUsed), addUsage(env, month, msUsed)]).catch(
      () => undefined
    )
  }

  const buf = await res.arrayBuffer()
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
  return json({
    dataUrl: `data:image/jpeg;base64,${b64}`,
    msUsed,
    dayMs: usage.dayMs + msUsed,
    dayLimitMs: dailyLimit,
    monthMs: usage.monthMs + msUsed,
    monthLimitMs: monthlyLimit,
  })
}

/**
 * POST /api/lab/inspect —— **文字版体检**（2026-10-13）。
 *
 * 和截图互补：截图给"眼睛看"，这里给**可读的量化结论** ——
 * 横向溢出了多少像素、哪些元素溢出、图片有没有 404、console 报了什么错。
 * 对"改样式"这件事，文字诊断往往比看图更直接（模型能照着数字改）。
 *
 * 走 Browser **Sessions**（Puppeteer）：只有会话模式能收 `console` / `pageerror` 事件。
 * 🔴 会话**必须在 finally 里 close()** —— 官方明确说"没关会话"是用量虚高的头号原因
 *    （默认会挂到 60 秒超时才释放，等于白烧 60 秒额度）。
 * 计费与截图共用同一个浏览器时长池，所以额度闸复用同一套（日 8 分钟 / 月 9 小时）。
 */
export async function labInspect(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)
  if ((await getSetting(env, "lab_shot_enabled")) === "0") {
    throw new ApiError(403, "站点已关闭「截图自检」功能", "SHOT_DISABLED")
  }
  if (!env.BROWSER) {
    throw new ApiError(503, "服务端没绑定浏览器（[browser] binding）", "SHOT_NO_BROWSER")
  }
  const body = (await request.json().catch(() => null)) as {
    html?: unknown
    width?: unknown
    height?: unknown
  } | null
  const html = typeof body?.html === "string" ? body.html : ""
  if (!html.trim()) throw new ApiError(400, "缺少 html", "INVALID_HTML")
  if (html.length > MAX_HTML_CHARS) {
    throw new ApiError(413, "页面太大，无法体检", "HTML_TOO_LARGE")
  }

  const { day, month } = periods()
  const [dailyLimit, monthlyLimit] = await Promise.all([
    numSetting(env, "lab_shot_daily_ms", DEFAULT_DAILY_MS),
    numSetting(env, "lab_shot_monthly_ms", DEFAULT_MONTHLY_MS),
  ])
  const usage = await readUsage(env, day, month)
  if (usage.dayMs >= dailyLimit || usage.monthMs >= monthlyLimit) {
    throw new ApiError(
      429,
      "今天的截图/体检额度用完了（浏览器时长共享同一个额度池），明天恢复。",
      "SHOT_DAILY_LIMIT"
    )
  }

  const width = Math.min(Math.max(Number(body?.width) || 1280, 320), 2560)
  const height = Math.min(Math.max(Number(body?.height) || 800, 240), 2000)

  const puppeteer = (await import("@cloudflare/puppeteer")).default
  const started = Date.now()
  let browser: { close: () => Promise<void> } | null = null
  try {
    browser = (await puppeteer.launch(env.BROWSER as never)) as unknown as {
      close: () => Promise<void>
    }
    const b = browser as unknown as {
      newPage: () => Promise<{
        on: (ev: string, cb: (a: unknown) => void) => void
        setViewport: (v: { width: number; height: number }) => Promise<void>
        setContent: (h: string, o: Record<string, unknown>) => Promise<void>
        evaluate: <T>(fn: () => T) => Promise<T>
      }>
    }
    const page = await b.newPage()
    const logs: string[] = []
    const push = (line: string) => {
      if (logs.length < 30) logs.push(line.slice(0, 160))
    }
    page.on("console", (m) => {
      const msg = m as { type: () => string; text: () => string }
      const t = msg.type()
      if (t === "error" || t === "warning") push(`[console.${t}] ${msg.text()}`)
    })
    page.on("pageerror", (e) => push(`[JS 异常] ${(e as Error)?.message ?? String(e)}`))
    page.on("requestfailed", (r) => {
      const req = r as { url: () => string }
      push(`[资源加载失败] ${req.url().slice(0, 120)}`)
    })
    await page.setViewport({ width, height })
    await page.setContent(html, { waitUntil: "networkidle0", timeout: SHOT_TIMEOUT_MS })

    /**
     * ⚠️ 这段代码**跑在浏览器里**，但类型检查发生在 worker 侧 ——
     * worker 的 tsconfig 没有 DOM lib，所以 `document`/`window` 要自己声明最小类型。
     * （用 any 会被 lint 拦，所以老老实实写形状。）
     */
    const m = await page.evaluate(() => {
      type El = {
        tagName: string
        id: string
        className: unknown
        clientWidth: number
        scrollWidth: number
      }
      type Img = { complete: boolean; naturalWidth: number; getAttribute: (n: string) => string | null }
      const g = globalThis as unknown as {
        document: {
          documentElement: { scrollWidth: number; clientWidth: number; scrollHeight: number }
          querySelectorAll: (sel: string) => { forEach: (cb: (el: El) => void) => void }
          images: { length: number; [n: number]: Img }
          body: { innerText: string } | null
          title: string
        }
        window: { innerWidth: number; innerHeight: number }
      }
      const de = g.document.documentElement
      const overflowing: string[] = []
      g.document.querySelectorAll("*").forEach((el) => {
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && overflowing.length < 12) {
          const cls =
            typeof el.className === "string" && el.className.trim()
              ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
              : ""
          overflowing.push(
            `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls}（内容 ${el.scrollWidth}px > 容器 ${el.clientWidth}px）`
          )
        }
      })
      const broken: string[] = []
      const imgs = g.document.images
      for (let k = 0; k < imgs.length && broken.length < 6; k++) {
        const im = imgs[k]
        if (!im.complete || im.naturalWidth === 0) broken.push(im.getAttribute("src")?.slice(0, 100) ?? "")
      }
      return {
        viewport: `${g.window.innerWidth}×${g.window.innerHeight}`,
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        pageHeight: de.scrollHeight,
        overflowing,
        broken,
        textLen: (g.document.body?.innerText ?? "").length,
        title: g.document.title,
      }
    })

    const lines: string[] = []
    lines.push(`页面体检（视口 ${m.viewport}）`)
    const over = m.scrollWidth - m.clientWidth
    lines.push(
      over > 2
        ? `· 🔴 **横向溢出 ${over}px**（内容宽 ${m.scrollWidth}px > 视口 ${m.clientWidth}px）—— 会出现左右滚动条`
        : "· ✅ 没有横向溢出"
    )
    if (m.overflowing.length) {
      lines.push("· 溢出的元素：")
      m.overflowing.slice(0, 8).forEach((x) => lines.push(`   - ${x}`))
    }
    lines.push(`· 页面总高 ${m.pageHeight}px，正文约 ${m.textLen} 字${m.title ? `，标题「${m.title}」` : ""}`)
    if (m.broken.length) {
      lines.push(`· 🔴 ${m.broken.length} 个图片没加载出来：${m.broken.join(" / ")}`)
    }
    if (logs.length) {
      lines.push(`· 🔴 控制台/运行时 ${logs.length} 条：`)
      logs.slice(0, 12).forEach((x) => lines.push(`   - ${x}`))
    } else {
      lines.push("· ✅ 控制台没有报错")
    }
    const text = lines.join("\n")

    const msUsed = Date.now() - started
    await Promise.all([addUsage(env, day, msUsed), addUsage(env, month, msUsed)]).catch(
      () => undefined
    )
    return json({
      text,
      msUsed,
      dayMs: usage.dayMs + msUsed,
      dayLimitMs: dailyLimit,
      monthMs: usage.monthMs + msUsed,
      monthLimitMs: monthlyLimit,
    })
  } catch (err) {
    const t = String((err as Error)?.message ?? err)
    if (/Browser time limit exceeded for today/i.test(t)) {
      await updateSettings(env, { lab_shot_plan: "free" }).catch(() => undefined)
      throw new ApiError(429, "Cloudflare 今日浏览器时长已用尽（免费档 10 分钟/天）。", "SHOT_CF_DAILY_LIMIT")
    }
    throw new ApiError(502, `页面体检失败：${t.slice(0, 200)}`, "INSPECT_FAILED")
  } finally {
    // 🔴 必须关（见函数头注释）：不关会一直计费到 60 秒超时
    if (browser) await browser.close().catch(() => undefined)
  }
}
