/**
 * 前端诊断日志记录器（环形缓冲）。
 *
 * 目的：用户提文字反馈时，站长拿不到「设备 / 网络 / 操作序列」，没法 1:1 复现。
 * 这里的记录器在用户浏览期间持续记一份**低开销**的运行日志（路由切换、
 * JS 报错、接口失败、长任务、页面加载指标），提交反馈时可勾选「附上诊断日志」
 * 并选时间窗（5 / 15 / 60 分钟），把窗口内的条目打包上传。
 *
 * 开关：站点设置 diag_log_enabled（管理面板可开关）。关=完全不记录（默认）；
 * 开=也只记在**内存 + sessionStorage 摘要**里，除了用户主动上传，不出设备。
 *
 * 性能纪律（这是「诊断不能拖慢被诊断的人」）：
 *   · 所有记录走 push()：一条数组赋值 + 偶尔一次 splice，无字符串拼接、无 DOM、
 *     无同步存储 —— 单条开销纳秒级；
 *   · sessionStorage 只在 pagehide / 每 30 秒兜底时写一次（恢复页面刷新前的记录），
 *     且 try-catch 包死（隐私模式写不进就算了）；
 *   · 长任务 / 错误监听都是被动回调，不用轮询；记录条数封顶（BUFFER_MAX），
 *     满了丢最旧的 —— 内存占用有上界（~1MB 以内）；
 *   · 上传是用户点「提交反馈」时才发生的一次性动作，不在这条热路径上。
 */

export interface DiagEntry {
  /** 事件时刻（epoch ms） */
  t: number
  /** 事件类别 */
  k: "route" | "err" | "api" | "longtask" | "perf" | "mark"
  /** 主信息（路径 / 错误消息 / 接口路径 / 自定义文本），已截断 */
  p: string
  /** 附加数据（状态码 / 耗时 ms 等），可选 */
  d?: number
  /** 附加短文本（错误堆栈首行等），可选 */
  s?: string
}

/** 缓冲上限：500 条 × 平均 ~150B ≈ 75KB，60 分钟窗口内一般打不满 */
const BUFFER_MAX = 500
/** 单条文本字段上限（错误堆栈只留首行 + 截断） */
const FIELD_MAX = 160
const SESSION_KEY = "doulor:diag-buffer"

/** 时间窗选项（分钟）。与服务端 ALLOWED_WINDOWS 保持一致；顺序即 UI 顺序。 */
export const DIAG_WINDOWS = [5, 15, 60] as const
export type DiagWindow = (typeof DIAG_WINDOWS)[number]

let buffer: DiagEntry[] = []
let enabled = false

function push(entry: DiagEntry): void {
  if (!enabled) return
  try {
    buffer.push(entry)
    if (buffer.length > BUFFER_MAX) {
      // 批量丢最旧的 10%：比逐条 shift 省（splice 一次挪一块）
      buffer.splice(0, Math.floor(BUFFER_MAX / 10))
    }
  } catch {
    // 记录失败绝不能影响页面
  }
}

function clip(v: unknown): string {
  return String(v ?? "").slice(0, FIELD_MAX)
}

// ---- 各类事件 ----

export function diagRoute(path: string): void {
  push({ t: Date.now(), k: "route", p: clip(path) })
}

/** 最近一次 JS 错误的时间（反馈页「最近报错」提示用）；0 = 会话内没有 */
let lastErrorAt = 0
export function lastErrorTime(): number {
  return lastErrorAt
}

export function diagError(message: string, stack?: string): void {
  lastErrorAt = Date.now()
  push({
    t: lastErrorAt,
    k: "err",
    p: clip(message),
    s: stack ? clip(stack.split("\n").slice(0, 2).join(" | ")) : undefined,
  })
}

export function diagApi(path: string, status: number, ms?: number): void {
  push({ t: Date.now(), k: "api", p: clip(path), d: status, s: ms !== undefined ? `${ms}` : undefined })
}

export function diagLongTask(durationMs: number): void {
  push({ t: Date.now(), k: "longtask", p: clip(`${Math.round(durationMs)}ms`) })
}

export function diagPerf(label: string, valueMs: number): void {
  push({ t: Date.now(), k: "perf", p: clip(label), d: Math.round(valueMs) })
}

/** 手动打点（业务代码在关键节点标记，如「开始上传」） */
export function diagMark(label: string): void {
  push({ t: Date.now(), k: "mark", p: clip(label) })
}

// ---- 启停与持久化 ----

/** 从 sessionStorage 恢复（页面刷新后接着记，时间窗才跨刷新有意义） */
function restore(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      buffer = parsed.filter(
        (e): e is DiagEntry =>
          !!e && typeof e === "object" && typeof (e as DiagEntry).t === "number"
      )
      // 只留最近 30 分钟内的（更老的恢复回来也没人选它）
      const cutoff = Date.now() - 30 * 60_000
      buffer = buffer.filter((e) => e.t >= cutoff)
    }
  } catch {
    // 恢复失败从空开始
  }
}

let persistTimer: number | null = null
function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    persistNow()
  }, 30_000)
}

function persistNow(): void {
  try {
    // 只留最近 30 分钟的（与 restore 的窗口一致），避免 session 存储越积越大
    const cutoff = Date.now() - 30 * 60_000
    const recent = buffer.filter((e) => e.t >= cutoff)
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(recent))
  } catch {
    // sessionStorage 满 / 隐私模式：放弃持久化（内存里的还在）
  }
}

/**
 * 启用记录器（站点开关打开后由 perf-collect 的启动入口调用一次）。
 * 幂等：重复调用只挂一次监听。
 */
let started = false
export function startDiagLog(): void {
  if (started) return
  started = true
  enabled = true
  restore()

  // 长任务：>50ms 的主线程任务（PerformanceObserver，被动）
  try {
    const po = new PerformanceObserver((list) => {
      for (const item of list.getEntries()) {
        diagLongTask(item.duration)
      }
    })
    po.observe({ entryTypes: ["longtask"] })
  } catch {
    // 浏览器不支持 longtask（Safari 老版本等）：跳过，不影响其余记录
  }

  // 页面隐藏 / 卸载时持久化一次
  window.addEventListener("pagehide", persistNow)
}

/** 站点开关关闭时停用：不再记录，也不清已有内容（用户可能正要上传） */
export function stopDiagLog(): void {
  enabled = false
}

/** 当前是否启用（反馈页用它决定显示不显示「附诊断日志」） */
export function isDiagLogEnabled(): boolean {
  return enabled
}

/**
 * 导出时间窗内的条目（上传用）。
 * 超过体积上限时丢**最旧的**条目（保留最近的，问题通常发生在临提交前），
 * 并标 truncated=true 让管理员知道这份日志不完整。
 */
export function exportWindow(windowMinutes: DiagWindow, maxChars = 60_000): {
  windowMinutes: number
  entries: DiagEntry[]
  truncated: boolean
} {
  const cutoff = Date.now() - windowMinutes * 60_000
  let entries = buffer.filter((e) => e.t >= cutoff)
  let truncated = false
  // 估算体积（每条序列化后 ~150B 上限），超出就从头丢
  while (entries.length > 0 && JSON.stringify(entries).length > maxChars) {
    entries = entries.slice(Math.ceil(entries.length / 10))
    truncated = true
  }
  schedulePersist()
  return { windowMinutes, entries, truncated }
}

/** 立即持久化（上传成功后调一次，把 mark 也存住） */
export function persistDiag(): void {
  persistNow()
}
