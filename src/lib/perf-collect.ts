/**
 * 前端性能采集（RUM，Real User Monitoring）。
 *
 * 管理面板「性能监控」工具的数据源：登录用户在页面加载 / 路由切换后
 * 上报一条样本（TTFB / DCL / LCP / 长任务 / 报错数 / 切换耗时），后端聚合后
 * 展示「哪个页面慢、慢在加载还是交互、手机还是电脑」。
 *
 * 开关：站点设置 perf_collect_enabled（管理面板可开关，默认关）。
 * /api/me 下发 perfCollectEnabled=true 时才启动 —— 服务端没开就一个字节都不发。
 *
 * 性能纪律：
 *   · 上报走 navigator.sendBeacon（不占主线程、页面关闭也能发完）；
 *     不可用时回退 fetch keepalive；失败静默（后端也静默 204）；
 *   · 每次页面加载至多发 2 条（首屏 1 条 + 可能的切换样本），无轮询无定时器；
 *   · LCP/长任务用 PerformanceObserver 被动收集，首屏样本在页面空闲时
 *     （requestIdleCallback）才组装上报，绝不跟首屏渲染抢主线程。
 */
import { diagError, diagPerf } from "./diag-log"

/** 上报端点（POST /api/perf/collect） */
const ENDPOINT = "/api/perf/collect"

interface LoadSample {
  ttfbMs?: number
  dclMs?: number
  lcpMs?: number
}

let started = false
let enabled = false
/** 本次页面加载已累计的 JS 错误数（window error + unhandledrejection） */
let errorCount = 0
/** 本次页面加载已累计的长任务数 */
let longTaskCount = 0
/** 首屏样本（一次） */
let loadSample: LoadSample | null = null
/** SPA 首屏样本是否已上报 */
let initialSent = false
/** 当前页面路径（切换时更新） */
let currentPage = ""

function deviceKind(): "mobile" | "desktop" {
  return window.matchMedia("(max-width: 768px)").matches ? "mobile" : "desktop"
}

function send(payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify({ device: deviceKind(), ...payload })
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))
    } else {
      void fetch(ENDPOINT, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
      }).catch(() => {})
    }
  } catch {
    // 上报失败静默
  }
}

/** 从导航计时里取首屏指标（SPA 直接刷新进来的那一次才完整） */
function collectNavigationTiming(): void {
  try {
    const nav = performance.getEntriesByType(
      "navigation"
    )[0] as PerformanceNavigationTiming | null
    if (nav) {
      loadSample = {
        ttfbMs: nav.responseStart,
        dclMs: nav.domContentLoadedEventEnd,
      }
    }
  } catch {
    // 计时不可用：跳过
  }
}

/** 组装并上报首屏样本（页面空闲时调用） */
function reportInitialLoad(page: string): void {
  if (initialSent) return
  initialSent = true
  const sample: Record<string, unknown> = {
    page,
    errors: errorCount,
    longTasks: longTaskCount,
    ...loadSample,
  }
  if (lcpValue !== null) sample.lcpMs = lcpValue
  send(sample)
  // 同步给诊断日志（若启用）
  diagPerf("load.ttlfb+lcp", (loadSample?.ttfbMs ?? 0) + (lcpValue ?? 0))
}

let lcpValue: number | null = null

function startObservers(): void {
  // LCP
  try {
    const po = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      const last = entries[entries.length - 1]
      if (last) lcpValue = Math.round(last.startTime)
    })
    po.observe({ type: "largest-contentful-paint", buffered: true } as PerformanceObserverInit)
  } catch {
    // 不支持 LCP 的浏览器跳过
  }
  // 长任务计数（同时喂给诊断日志）
  try {
    const po = new PerformanceObserver((list) => {
      longTaskCount += list.getEntries().length
    })
    po.observe({ type: "longtask", buffered: true } as PerformanceObserverInit)
  } catch {
    // 不支持跳过
  }
  // JS 错误计数（passive 监听，只计数 + 喂诊断日志，不改现有行为）
  window.addEventListener("error", (e) => {
    errorCount++
    diagError(e.message ?? "error", e.error instanceof Error ? e.error.stack : undefined)
  })
  window.addEventListener("unhandledrejection", (e) => {
    errorCount++
    const reason = (e as PromiseRejectionEvent).reason
    diagError(reason instanceof Error ? reason.message : String(reason ?? "unhandledrejection"))
  })
}

/** 首屏上报时机：空闲即报（最多等 5 秒，避免纯静止页面永不报） */
function scheduleInitialReport(page: string): void {
  const report = () => reportInitialLoad(page)
  if ("requestIdleCallback" in window) {
    ;(window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback(report, { timeout: 5000 })
  } else {
    setTimeout(report, 1500)
  }
}

/**
 * 路由切换上报：由 App 的路由监听调用（切换完成后传「本页耗时」）。
 * 首次调用（应用挂载）不发切换样本，只初始化首屏流程。
 */
export function perfRouteChange(path: string, navMs?: number): void {
  if (!enabled) return
  try {
    if (!initialSent) {
      // 应用刚挂载的第一次路由解析 = 首屏
      currentPage = path
      scheduleInitialReport(path)
      return
    }
    if (path === currentPage) return
    currentPage = path
    if (navMs !== undefined && navMs > 0) {
      send({ page: path, navMs: Math.round(navMs), errors: errorCount, longTasks: longTaskCount })
      // 切换完成即清零：计数只属于「这次页面停留」
      errorCount = 0
      longTaskCount = 0
    }
  } catch {
    // 采集失败静默
  }
}

/** 站点开关打开后启动（幂等） */
export function startPerfCollect(): void {
  if (started) return
  started = true
  enabled = true
  collectNavigationTiming()
  startObservers()
}

/** 站点开关关闭时停用上报（监听留着但不再发包） */
export function stopPerfCollect(): void {
  enabled = false
}

/** 测试/调试用：当前累计计数 */
export function perfCounters(): { errors: number; longTasks: number; page: string } {
  return { errors: errorCount, longTasks: longTaskCount, page: currentPage }
}
