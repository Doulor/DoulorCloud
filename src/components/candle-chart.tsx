import * as React from "react"
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react"

import { useT } from "@/i18n"
import { cn } from "@/lib/utils"
import type { GameCandle } from "@/services/api"

/**
 * 自绘 K 线图（Canvas）—— 支持**拖动平移 / 滚轮缩放 / 复位**。
 *
 * 为什么不用图表库：这个项目的依赖清单很克制（见 package.json），而这里需要的功能
 * 很有限 —— K 线 + 均线 + 几条价位线 + 十字光标 + 平移缩放。为此引入几十 KB 的
 * lightweight-charts 不划算，而且「开仓价 / 爆仓价」是业务语义，用通用库反而要绕。
 *
 * ---------------------------------------------------------------------------
 * 交互模型（2026-10-11 站长要求补全）
 * ---------------------------------------------------------------------------
 * 两个状态就够了：
 *   · `visible` —— 一屏显示多少根 K 线（滚轮 / ± 按钮改它）；
 *   · `endIndex` —— 视窗右边缘对着第几根；`null` 表示「跟随最新」。
 *
 * 关键行为（都是「用起来像真图表」的那些细节）：
 *   · **滚轮缩放锚定在光标下的那根 K 线上**，而不是缩放后跳回最新 —— 否则
 *     「放大看看刚才那波」会永远看到最新一根，等于不能缩放。
 *   · **拖动查看历史**（往右拖 = 看更早的），松手后不自动回弹；点「回到最新」
 *     或双击恢复跟随。
 *   · 跟随状态下有新 K 线进来会自动右移；一旦手动拖走就不再打扰你。
 *   · 触摸屏走 Pointer Events + `touch-action: pan-y`：横向滑动平移图表，
 *     **纵向滑动仍然能滚页面**（否则手机上滑到图表就滚不动了）。
 *
 * ⚠️ 变量名不要用 `window`（下面要用 `window.devicePixelRatio`），
 *    用局部变量遮蔽它会让高清屏适配直接编译不过。这里统一叫 `view`。
 */

export interface ChartPositionLine {
  /** long / short —— 决定颜色 */
  side: string
  entryPrice: number
  liqPrice: number
}

interface Props {
  /** 已封闭的历史 K 线（正序：旧 → 新） */
  candles: GameCandle[]
  /** 正在走的那根（拼在最后）。没有就只画历史 */
  live?: GameCandle | null
  /** 我的持仓价位线 */
  positions?: ChartPositionLine[]
  className?: string
  /** 一屏默认显示多少根 K 线 */
  defaultVisible?: number
  /** 空状态文案（行情还没开始时显示） */
  emptyText?: string
  /** 价格展示精度 */
  digits?: number
}

const UP = "#10b981"
const DOWN = "#f43f5e"
const MA5 = "#f59e0b"
const MA20 = "#6366f1"

/**
 * 缩放上下限。
 *
 * ⚠️ `MIN_VISIBLE` 不能太大：它是「最多放大到只剩几根」。之前取 12，
 *    而游戏刚上线时历史往往只有几根 —— 于是用户滚轮/点按钮**完全没反应**，
 *    看起来像坏了（2026-10-11 站长反馈「能不能放大缩小」时实测到）。
 *    取 4：既能放大到看清单根，又不会放进「一根占半个屏幕」的荒唐状态。
 */
const MIN_VISIBLE = 4
const MAX_VISIBLE = 400
/** 每次滚轮 / 点按钮的缩放倍率 */
const ZOOM_STEP = 1.2
/** 空均线（复用同一个数组，避免每帧新建） */
const EMPTY_MA: (number | null)[] = []

/** 价格轴缩放上下限（Shift+滚轮）：能放到 8 倍、也能压到 1/8，够用且不会迷失 */
const MIN_PRICE_ZOOM = 0.125
const MAX_PRICE_ZOOM = 8

/** 简单移动平均；不足窗口的位置返回 null（不画） */
function movingAverage(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    out.push(i >= window - 1 ? sum / window : null)
  }
  return out
}

function clampNum(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function fmtPrice(v: number, digits: number): string {
  if (v >= 1000) return v.toFixed(Math.max(0, digits - 2))
  if (v >= 1) return v.toFixed(digits)
  return v.toFixed(digits + 2)
}

function fmtTime(iso: string, withDate: boolean): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  if (!withDate) return `${hh}:${mm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

export function CandleChart({
  candles,
  live,
  positions = [],
  className,
  defaultVisible = 80,
  emptyText = "",
  digits = 2,
}: Props) {
  const { t } = useT()
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = React.useState({ w: 0, h: 0 })

  /**
   * ⚠️⚠️ **所有「视窗状态」都放在 ref 里，不进 React state** —— 这是性能的关键。
   *
   * 站长 2026-10-11 反馈「性能问题很严重」。实测（CDP Performance domain、204 次鼠标移动）：
   *   鼠标在图上移动 → 脚本 175ms / 206 次样式重算（= 206 次 React 渲染）
   *   鼠标在图外移动 → 脚本  12ms /   2 次样式重算（几乎为零）
   * 原因就是原来的 `hover` 是 React state：**每一次 mousemove 都重渲染整个组件**，
   * 拖拽时每像素还要再改一次 `endIndex`。在慢机器/大画布上这就是肉眼可见的卡顿。
   *
   * 现在：mousemove 只改 ref + 排一次 rAF 重画 ⇒ **0 次 React 渲染**；
   * 视窗（根数 / 右边缘 / 价格平移缩放）也走 ref，只有「界面上要看的东西」
   * （是否跟随最新、当前几根、是否手动动过价格轴）才同步回 state，而且
   * 值没变时返回同一个对象引用，React 会直接跳过渲染。
   */
  const viewRef = React.useRef({
    /** 一屏显示多少根 */
    visible: defaultVisible,
    /** 视窗右边缘对应的下标；null = 跟随最新 */
    endIndex: null as number | null,
    /** 价格轴手动平移量（单位：一个视窗高度） */
    pricePan: 0,
    /** 价格轴缩放倍数（1 = 自适应） */
    priceZoom: 1,
  })
  /** 十字光标位置（相对画布的 CSS 像素）；不悬停时为 null */
  /**
   * 指针位置与十字光标状态。
   *
   * ⚠️ 全部**预先分配**：拖拽时每秒上千个 pointermove、上百帧重画，
   *    任何「每事件/每帧新建一个对象」都会变成 GC 压力，而 GC 停顿
   *    在 longtask 里正是那种**没有脚本归属**的长任务（站长实测的形状）。
   */
  const pointerRef = React.useRef({ x: 0, y: 0, lx: 0, ly: 0, inside: false })
  const hoverRef = React.useRef({ x: 0, y: 0, on: false })
  /** rAF 句柄：把「一帧内多次事件」合并成一次重画 */
  const rafRef = React.useRef<number | null>(null)
  /** 指向最新的 draw（rAF 回调要通过它调用，避免闭包捕获旧版本） */
  const drawRef = React.useRef<(() => void) | null>(null)
  /** 当前后备缓冲的像素尺寸（避免每帧重建，见 draw 里的说明） */
  const backingRef = React.useRef({ w: 0, h: 0 })

  /** 界面上需要跟着视窗变的东西（低频，且值不变就不触发渲染） */
  const [ui, setUi] = React.useState({ candles: 0, follow: true, manual: false })

  /**
   * 上一次绘制时的几何信息。滚轮缩放要「锚定光标下的那根 K 线」，
   * 就必须知道当时的 x0 / 每根宽度 / 起止下标 —— 这些只有 draw() 里算得出来，
   * 所以画完存一份给事件处理用。
   */
  /** 均线缓存（见 draw 里的说明：每帧重算会制造大量垃圾） */
  const maCacheRef = React.useRef<{
    key: string
    ma5: (number | null)[]
    ma20: (number | null)[]
  }>({ key: "", ma5: [], ma20: [] })
  const layoutRef = React.useRef({
    x0: 0,
    slot: 1,
    start: 0,
    count: 0,
    total: 0,
    padTop: 10,
    padBottom: 22,
    plotH: 0,
  })

  /** 拖动起点（时间轴用 x/end，价格轴用 y/pan） */
  const dragRef = React.useRef<{
    x: number
    y: number
    end: number
    pan: number
    moved: boolean
  } | null>(null)

  /** 历史 + 正在走的那根 = 完整序列 */
  const series = React.useMemo(() => {
    const list = candles.slice()
    if (live) {
      const last = list[list.length - 1]
      // 同一根不重复放（轮询期间 live 与历史可能指同一时刻）
      if (!last || last.openAt !== live.openAt) list.push(live)
      else list[list.length - 1] = live
    }
    return list
  }, [candles, live])

  const total = series.length

  /** 视窗（右边缘 + 根数），全部收口在这里，免得 draw 与事件处理各算一套 */
  const winOf = React.useCallback(
    (tot: number) => {
      const v = viewRef.current
      const count = Math.max(1, Math.min(v.visible, Math.max(1, tot)))
      const follow = v.endIndex === null
      const end = follow
        ? Math.max(0, tot - 1)
        : clampNum(Math.round(v.endIndex as number), count - 1, Math.max(count - 1, tot - 1))
      const start = Math.max(0, end - count + 1)
      return { count, start, end, follow }
    },
    []
  )

  // 容器尺寸跟踪（含侧边栏折叠、窗口缩放）
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(0, Math.round(r.width)), h: Math.max(0, Math.round(r.height)) })
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 画布的文字颜色 / 字体 / 背景色。
   *
   * ⚠️ **绝对不能在 draw() 里调 `getComputedStyle`**：那会强制浏览器同步重算样式，
   *    而 draw 每帧都可能跑 —— 实测「鼠标在图上划过」204 次重画 ⇒ **206 次样式重算**，
   *    正是这里来的（站长 2026-10-11 反馈「性能问题很严重」的重要一环）。
   *    现在只在挂载时、以及 `<html>` 的 class 变化（深浅色切换）时读一次。
   */
  const styleRef = React.useRef({ color: "#888", fontFamily: "sans-serif", bg: "#ffffff" })
  /** 供上面的 effect 用：读样式发生在挂载后，那时 scheduleDraw 已经定义好了 */
  const scheduleDrawRef = React.useRef<(() => void) | null>(null)
  /** rAF 回调要先结算指针位置（rAF 定义在前，用 ref 拿最新版本） */
  const applyPointerRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const read = () => {
      const s = getComputedStyle(canvas)
      styleRef.current = {
        color: s.color || "#888",
        fontFamily: s.fontFamily || "sans-serif",
        bg:
          s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)"
            ? s.backgroundColor
            : "#ffffff",
      }
      scheduleDrawRef.current?.()
    }
    read()
    // 站点切深浅色是改 <html> 的 class ⇒ 观察它，变了再读一次
    if (typeof MutationObserver === "undefined") return
    const mo = new MutationObserver(read)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
  }, [])

  /**
   * 把「这一帧里发生的多次事件」合并成**一次**重画。
   *
   * 鼠标一秒能产生上百个 mousemove；不合并的话就是一秒上百次 canvas 全量重画。
   * rAF 合并之后最多每帧一次（60fps 上限），而且**完全不碰 React**。
   */
  const scheduleDraw = React.useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      applyPointerRef.current?.()
      drawRef.current?.()
    })
  }, [])

  // 让「读样式」的那个 effect 也能触发重画
  scheduleDrawRef.current = scheduleDraw

  /** 待清理的 rAF（组件卸载时取消，避免对已卸载的画布重画） */
  React.useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    },
    []
  )

  /**
   * 把「界面上需要跟着视窗变的东西」同步回 React state。
   *
   * ⚠️ 两件事必须同时做到，否则会退化成渲染死循环：
   *   1. 只在值**真的变了**的时候 setState；
   *   2. 没变时返回**同一个对象引用** —— React 对 `setState(prev => prev)`
   *      会直接 bail out，一次渲染都不做。
   */
  const syncUi = React.useCallback(() => {
    const win = winOf(total)
    const v = viewRef.current
    const manual = v.pricePan !== 0 || v.priceZoom !== 1
    setUi((prev) =>
      prev.candles === win.count && prev.follow === win.follow && prev.manual === manual
        ? prev
        : { ...prev, candles: win.count, follow: win.follow, manual }
    )
  }, [total, winOf])
  const resetView = React.useCallback(() => {
    viewRef.current.endIndex = null
    viewRef.current.visible = defaultVisible
    viewRef.current.pricePan = 0
    viewRef.current.priceZoom = 1
    scheduleDraw()
  }, [defaultVisible, scheduleDraw])

  /**
   * 滚轮：**默认缩放时间轴**，按住 Shift（或 Ctrl）缩放**价格轴**（锚定光标价位）。
   *
   * 必须 `passive: false` 才能 `preventDefault` —— 否则在图表上滚动会连带把页面滚走。
   * 代价是这个区域内页面不能靠滚轮滚动，所以只在指针确实落在图上时拦截。
   */
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const { x0, slot, start, count, total: tot } = layoutRef.current
      if (tot <= 0 || slot <= 0) return
      const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP

      // ---- 价格轴缩放（Shift / Ctrl + 滚轮）----
      if (e.shiftKey || e.ctrlKey) {
        const v = viewRef.current
        const next = clampNum(v.priceZoom * factor, MIN_PRICE_ZOOM, MAX_PRICE_ZOOM)
        if (next === v.priceZoom) return
        // 锚定光标所在的价位：缩放前后那个价位的屏幕位置尽量不动
        const g = layoutRef.current
        const plotH = size.h - g.padTop - g.padBottom
        const rel = plotH > 0 ? clampNum((y - g.padTop) / plotH, 0, 1) : 0.5
        // rel 是「从上往下」的比例；价格平移量按同一方向补偿
        v.pricePan += (v.priceZoom - next) * (0.5 - rel)
        v.priceZoom = next
        scheduleDraw()
        return
      }

      // ---- 时间轴缩放 ----
      const nextCount = clampNum(
        Math.round(count * factor),
        MIN_VISIBLE,
        Math.min(MAX_VISIBLE, Math.max(MIN_VISIBLE, tot))
      )
      if (nextCount === count) return

      // 光标下方那根 K 线在视窗里的相对位置（0 = 最左，1 = 最右）
      const rel = clampNum((x - x0) / (slot * count), 0, 1)
      const anchorIdx = start + rel * (count - 1)

      // 让 anchorIdx 在新视窗里保持同样的相对位置 ⇒ 视觉上「以光标为中心缩放」
      let newStart = anchorIdx - rel * (nextCount - 1)
      newStart = clampNum(newStart, 0, Math.max(0, tot - nextCount))
      viewRef.current.visible = nextCount
      viewRef.current.endIndex = newStart + nextCount - 1
      scheduleDraw()
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [scheduleDraw, size.h])

  /**
   * 拖动 = **全方位平移**：左右看更早/更晚的行情，上下挪价格轴。
   *
   * ⚠️ 这里**一次 React state 都不改**（除了开始/结束拖拽时切换一下光标样式）：
   *    改 ref + 排一次 rAF 重画。之前每像素改一次 state，拖起来会明显掉帧。
   */
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      end: winOf(total).end,
      pan: viewRef.current.pricePan,
      moved: false,
    }
    // 光标用 style 直接改 —— 不走 React，拖拽全程 0 次渲染
    e.currentTarget.style.cursor = "grabbing"
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    /**
     * ⚠️⚠️ **这个函数必须做到「什么都不算」**。
     *
     * 站长实测：只有拖这个图表会卡，longTask 5 个 ~100ms 且**没有脚本归属**（只有 @window），
     * 屏幕还是 165Hz。没有脚本归属的长任务最典型的就是 **GC 停顿**，而 GC 压力来自分配。
     *
     * 真实鼠标（尤其 1000Hz 游戏鼠标）一秒能发上千个 pointermove；
     * 原来每个事件都要：读 layoutRef、调 `winOf()`（**每次都新建一个对象**）、
     * 算 `Math.round`/`clampNum`、算价格平移量。一秒上千次分配 + 上千次计算。
     *
     * 现在这里**只把坐标写进一个预先分配好的对象**（零分配），
     * 全部换算挪到 rAF 里**每帧只做一次**（见 applyPointer）。
     */
    const p = pointerRef.current
    p.x = e.clientX // 用于拖拽位移（只看差值，坐标系无所谓）
    p.y = e.clientY
    p.lx = e.nativeEvent.offsetX // 用于十字光标（画布本地坐标，不调 getBoundingClientRect）
    p.ly = e.nativeEvent.offsetY
    p.inside = true
    scheduleDraw()
  }

  /**
   * 把「上一帧之后攒下的指针位置」结算成视窗变化 —— **每帧只调用一次**。
   * 由 rAF 回调在 draw 之前调用。
   */
  const applyPointer = React.useCallback(() => {
    const p = pointerRef.current
    const drag = dragRef.current
    if (!drag) {
      // 不拖拽：只更新十字光标位置（同一个对象复用，不新建）
      hoverRef.current.x = p.lx
      hoverRef.current.y = p.ly
      hoverRef.current.on = p.inside
      return
    }
    const dx = p.x - drag.x
    const dy = p.y - drag.y
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
    const { slot, plotH } = layoutRef.current
    if (slot > 0) {
      // 往右拖 = 看更早的（右边缘下标变小）
      const win = winOf(total)
      const next = clampNum(
        drag.end - Math.round(dx / slot),
        win.count - 1,
        Math.max(win.count - 1, total - 1)
      )
      viewRef.current.endIndex = next
    }
    if (plotH > 0) {
      // 往下拖 = 价格轴整体下移（看到更高的价位）
      viewRef.current.pricePan = drag.pan + dy / plotH
    }
  }, [total, winOf])

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* 指针已经释放（如触摸抬起）：忽略 */
      }
    }
    dragRef.current = null
    e.currentTarget.style.cursor = ""
    scheduleDraw()
  }

  const zoomBy = (dir: 1 | -1) => {
    const v = viewRef.current
    const base = Math.min(v.visible, Math.max(1, total)) || v.visible
    v.visible = clampNum(
      Math.round(base * (dir === 1 ? 1 / ZOOM_STEP : ZOOM_STEP)),
      MIN_VISIBLE,
      Math.min(MAX_VISIBLE, Math.max(MIN_VISIBLE, total))
    )
    scheduleDraw()
  }

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w === 0 || size.h === 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    /**
     * ⚠️ **只在尺寸真的变了**时才改 `canvas.width/height`。
     * 给它们赋任何值（哪怕是同一个数）都会**重建整块后备缓冲**并清空画布 ——
     * 一块 1600×400 的图在 DPR 2 下是 3200×800 ≈ 256 万像素，
     * 每帧重建一次就是白扔的时间（松手那一帧尤其明显：要一次性重画 + 重建）。
     */
    const bw = Math.round(size.w * dpr)
    const bh = Math.round(size.h * dpr)
    if (backingRef.current.w !== bw || backingRef.current.h !== bh) {
      canvas.width = bw
      canvas.height = bh
      backingRef.current = { w: bw, h: bh }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    // 缓存值（见 styleRef 的说明：每帧读 getComputedStyle 会强制样式重算）
    const { color: textColor, fontFamily, bg: canvasBg } = styleRef.current

    const padTop = 10
    const padBottom = 22
    const padRight = 62
    const padLeft = 6
    const plotW = size.w - padLeft - padRight
    const plotH = size.h - padTop - padBottom
    if (plotW <= 10 || plotH <= 10) return

    const win = winOf(total)
    const view = series.slice(win.start, win.end + 1)
    if (view.length === 0) return

    // 把几何存给事件处理（滚轮锚定 / 拖动换算 / 价格轴缩放都要用）
    layoutRef.current = {
      x0: padLeft,
      slot: plotW / view.length,
      start: win.start,
      count: view.length,
      total,
      padTop,
      padBottom,
      plotH,
    }
    syncUi()

    /**
     * ---- 价格范围：**以 K 线为主** ----
     *
     * ⚠️ 站长 2026-10-11 反馈：「爆仓价很远的话会导致现在的 K 线变得很细，看不清楚走势」。
     *    原因是原来把持仓线（开仓价 / 爆仓价）**无条件**并进了价格范围 ——
     *    一个 20 倍多单的爆仓价可能在 −10% 以外，行情只波动 0.5%，
     *    于是 11% 的高度里 K 线只占 0.5%，被压成一条几乎看不出的细线。
     *
     * 现在的规则：
     *   1. 先用 K 线自己算出上下界（这是唯一必须看清的东西）；
     *   2. 持仓线**只有落在行情附近**（半个行情高度以内）才参与扩大范围；
     *   3. 离得太远的线不再影响尺度，改画成**边缘提示条**（见下面画线那段），
     *      信息不丢，但不再牺牲走势的可读性。
     */
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const c of view) {
      lo = Math.min(lo, c.lowPrice)
      hi = Math.max(hi, c.highPrice)
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return
    if (hi === lo) {
      // 完全平盘（默认噪声为 0 时就是这样）：给一个 ±1% 的窗口，
      // 否则价格范围是 0，除下来全是 NaN，什么都画不出来。
      hi += Math.abs(hi) * 0.01 || 1
      lo -= Math.abs(lo) * 0.01 || 1
    }
    /** 行情自身的高度 —— 也是「多远算远」的判据 */
    const candleSpan = hi - lo
    const nearMargin = candleSpan * 0.5
    for (const p of positions) {
      for (const v of [p.entryPrice, p.liqPrice]) {
        if (!Number.isFinite(v) || v <= 0) continue
        // 只让「附近」的持仓线参与撑开范围；远处的走边缘提示
        if (v >= lo - nearMargin && v <= hi + nearMargin) {
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
      }
    }
    const span = hi - lo
    lo -= span * 0.06
    hi += span * 0.06

    /**
     * ---- 手动价格轴缩放 / 平移（「全方位」操作）----
     *
     * priceZoom 从视窗中心缩放（不会因为缩放把行情顶出画面）；
     * pricePan 的量纲就是**一个视窗高度**，所以上下拖动 1 个图高 = 平移 1 屏。
     * 两者都是 0/1 时完全等价于「自适应」，所以默认什么都不做。
     */
    const v0 = viewRef.current
    if (v0.priceZoom !== 1 || v0.pricePan !== 0) {
      const center = (lo + hi) / 2
      const half = ((hi - lo) / 2) * v0.priceZoom
      const shifted = center + v0.pricePan * (hi - lo)
      lo = shifted - half
      hi = shifted + half
    }

    const x0 = padLeft
    const y0 = padTop
    const yOf = (price: number) => y0 + plotH - ((price - lo) / (hi - lo)) * plotH
    const slot = plotW / view.length
    const xOf = (i: number) => x0 + slot * (i + 0.5)
    /**
     * 蜡烛实体宽度 —— **紧贴、连续**（站长 2026-10-11 要求，参考币圈而不是股票）。
     *
     * 原来是 `slot × 0.62`：蜡烛之间留了 38% 的缝，看起来是一根根断开的柱子；
     * 而「价格没变」的那一分钟（开=收）实体只有 1px 高，配上窄实体就更像
     * 「什么都没画」。现在实体**直接占满一个 slot**：
     *   · 平盘时相邻蜡烛连成一条**连续的水平细线**；
     *   · 有行情时是一整片连续的山形，没有背景色的缝。
     *
     * ⚠️ 曾经想「slot 很宽（放得很大）时收窄一点更好看」，结果那正是缝隙的来源
     *    （18 根时 slot ≈ 37px，收窄到 20px ⇒ 每两根之间漏出 17px 背景色）。
     *    站长的要求是「完全连接」，所以不再收窄 —— 放得很大时实体就是很宽，
     *    这是「紧贴」的必然代价。
     */
    const bodyW = slot
    /** 相邻蜡烛多画 0.5px 盖住亚像素缝（否则会出现一条条背景色的发丝线） */
    const bodyPad = 0.5

    // ---- 网格与价格刻度 ----
    ctx.font = `11px ${fontFamily}`
    ctx.textBaseline = "middle"
    ctx.textAlign = "left"
    const ticks = 5
    for (let i = 0; i <= ticks; i++) {
      const price = lo + ((hi - lo) * i) / ticks
      const y = yOf(price)
      ctx.globalAlpha = 0.1
      ctx.strokeStyle = textColor
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.lineTo(x0 + plotW, y)
      ctx.stroke()

      ctx.globalAlpha = 0.55
      ctx.fillStyle = textColor
      ctx.fillText(fmtPrice(price, digits), x0 + plotW + 6, y)
    }

    // ---- 时间刻度（最多 6 个）----
    ctx.textAlign = "center"
    ctx.globalAlpha = 0.55
    const labelStep = Math.max(1, Math.ceil(view.length / 6))
    const showDate =
      view.length > 0 &&
      Date.parse(view[view.length - 1].openAt) - Date.parse(view[0].openAt) > 12 * 3600_000
    for (let i = 0; i < view.length; i += labelStep) {
      ctx.fillStyle = textColor
      ctx.fillText(fmtTime(view[i].openAt, showDate), xOf(i), size.h - 11)
    }

    // ---- 均线（只对可见窗口算，和盘面看到的形状一致）----
    /**
     * ⚠️ 均线结果**按（序列, 窗口范围）缓存**。
     *
     * 原来每帧都要 `view.map(...)` + 两条 `movingAverage()` —— 三个长度 ~80 的数组，
     * 165Hz 屏幕下就是每秒 500+ 次数组分配。站长实测的长任务**没有脚本归属**
     * （只有 @window），这正是 GC 停顿的典型形状，而分配就是 GC 的唯一来源。
     * 拖动时窗口每跨过一根才需要重算，绝大多数帧直接命中缓存。
     */
    const closes = view.map((c) => c.closePrice)
    const maKey = `${win.start}:${win.end}:${series.length}`
    const maCache = maCacheRef.current
    if (maCache.key !== maKey) {
      maCache.key = maKey
      maCache.ma5 = view.length >= 5 ? movingAverage(closes, 5) : EMPTY_MA
      maCache.ma20 = view.length >= 20 ? movingAverage(closes, 20) : EMPTY_MA
    }
    const drawMa = (values: (number | null)[], color: string) => {
      ctx.globalAlpha = 0.85
      ctx.strokeStyle = color
      ctx.lineWidth = 1.2
      ctx.beginPath()
      let started = false
      values.forEach((v, i) => {
        if (v === null) return
        const x = xOf(i)
        const y = yOf(v)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else {
          ctx.lineTo(x, y)
        }
      })
      if (started) ctx.stroke()
    }
    if (view.length >= 5) drawMa(maCache.ma5, MA5)
    if (view.length >= 20) drawMa(maCache.ma20, MA20)

    /**
     * ---- 持仓价位线（开仓价实线、爆仓价虚线）----
     *
     * ⚠️ 越界的线**不能按真实价位画**（会画到框外去），也不能反过来去改价格范围
     *    （那会把 K 线压成细线，正是站长反馈的问题）。所以：
     *    · 在可视范围内的 ⇒ 照常画虚线/实线；
     *    · 越界的 ⇒ 贴在上/下边缘画一条**半透明色带 + 三角箭头 + 价位**，
     *      一眼能看出「爆仓价在下面很远」，但完全不占用走势的空间。
     */
    for (const p of positions) {
      const isLong = p.side === "long"
      const color = isLong ? UP : DOWN
      const lines: { price: number; dashed: boolean }[] = [
        { price: p.entryPrice, dashed: false },
      ]
      if (p.liqPrice > 0) lines.push({ price: p.liqPrice, dashed: true })

      for (const line of lines) {
        const v = line.price
        if (!Number.isFinite(v) || v <= 0) continue
        const y = yOf(v)

        if (y >= y0 - 0.5 && y <= y0 + plotH + 0.5) {
          // 在范围内：正常画线
          ctx.globalAlpha = line.dashed ? 0.55 : 0.8
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.setLineDash(line.dashed ? [4, 4] : [])
          ctx.beginPath()
          ctx.moveTo(x0, y)
          ctx.lineTo(x0 + plotW, y)
          ctx.stroke()
          ctx.setLineDash([])
          continue
        }

        // 越界：贴边提示（箭头方向 = 真实价位在那边）
        const above = y < y0
        const edgeY = above ? y0 + 0.5 : y0 + plotH - 0.5
        ctx.globalAlpha = 0.75
        ctx.fillStyle = color
        ctx.beginPath()
        if (above) {
          ctx.moveTo(x0 + plotW - 16, edgeY + 7)
          ctx.lineTo(x0 + plotW - 8, edgeY + 7)
          ctx.lineTo(x0 + plotW - 12, edgeY + 1)
        } else {
          ctx.moveTo(x0 + plotW - 16, edgeY - 7)
          ctx.lineTo(x0 + plotW - 8, edgeY - 7)
          ctx.lineTo(x0 + plotW - 12, edgeY - 1)
        }
        ctx.closePath()
        ctx.fill()

        ctx.globalAlpha = 0.95
        ctx.textAlign = "right"
        ctx.fillText(
          `${line.dashed ? t("chart.liqShort") : t("chart.entryShort")} ${fmtPrice(v, digits)}`,
          x0 + plotW - 20,
          edgeY + (above ? 10 : -4)
        )
      }
    }
    ctx.globalAlpha = 1

    // ---- K 线本体 ----
    for (let i = 0; i < view.length; i++) {
      const c = view[i]
      const up = c.closePrice >= c.openPrice
      const color = up ? UP : DOWN
      const x = xOf(i)
      const isLive = live ? c.openAt === live.openAt : false

      ctx.globalAlpha = isLive ? 0.75 : 1
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 1

      // 影线
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, yOf(c.highPrice))
      ctx.lineTo(Math.round(x) + 0.5, yOf(c.lowPrice))
      ctx.stroke()

      // 实体。
      // ⚠️ 开=收（价格没变）时必须**仍然**画出一条看得见的细线：
      //    高度取 1px、宽度占满 slot —— 平盘的那一段于是连成一条连续的水平线。
      //    早先「实体窄 + 只有 1px 高」的组合看起来就像什么都没画（站长反馈）。
      const yo = yOf(c.openPrice)
      const yc = yOf(c.closePrice)
      const top = Math.min(yo, yc)
      const h = Math.max(1.4, Math.abs(yc - yo))
      ctx.fillRect(x - bodyW / 2, top, bodyW + bodyPad, h)
    }

    // ---- 最新价（右侧标签）----
    const lastC = view[view.length - 1]
    const lastY = yOf(lastC.closePrice)
    ctx.globalAlpha = 1
    ctx.fillStyle = lastC.closePrice >= lastC.openPrice ? UP : DOWN
    ctx.fillRect(x0 + plotW + 1, lastY - 8, padRight - 3, 16)
    ctx.fillStyle = "#ffffff"
    ctx.textAlign = "left"
    ctx.fillText(fmtPrice(lastC.closePrice, digits), x0 + plotW + 5, lastY)

    // ---- 十字光标（拖动时不画，免得和"抓着图表"的手感打架）----
    if (
      hoverRef.current.on &&
      !dragRef.current &&
      hoverRef.current.x >= x0 &&
      hoverRef.current.x <= x0 + plotW &&
      hoverRef.current.y >= y0 &&
      hoverRef.current.y <= y0 + plotH
    ) {
      const hv = hoverRef.current
      const idx = clampNum(Math.floor((hv.x - x0) / slot), 0, view.length - 1)
      const c = view[idx]
      const hx = xOf(idx)

      ctx.globalAlpha = 0.35
      ctx.strokeStyle = textColor
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(hx, y0)
      ctx.lineTo(hx, y0 + plotH)
      ctx.moveTo(x0, hv.y)
      ctx.lineTo(x0 + plotW, hv.y)
      ctx.stroke()
      ctx.setLineDash([])

      const price = lo + ((y0 + plotH - hv.y) / plotH) * (hi - lo)

      // 悬停价标签
      ctx.globalAlpha = 1
      ctx.fillStyle = textColor
      ctx.fillRect(x0 + plotW + 1, hv.y - 8, padRight - 3, 16)
      const bg = canvasBg
      ctx.fillStyle = bg
      ctx.fillText(fmtPrice(price, digits), x0 + plotW + 5, hv.y)

      // OHLC 信息条（左上角，位置固定所以不会跟着鼠标乱跳）
      ctx.globalAlpha = 0.75
      ctx.fillStyle = textColor
      ctx.textAlign = "left"
      ctx.fillText(
        `${fmtTime(c.openAt, true)}  O ${fmtPrice(c.openPrice, digits)}  ` +
          `H ${fmtPrice(c.highPrice, digits)}  L ${fmtPrice(c.lowPrice, digits)}  ` +
          `C ${fmtPrice(c.closePrice, digits)}`,
        x0 + 2,
        y0 + 4
      )
    }

    ctx.globalAlpha = 1
    // ⚠️ t 必须进依赖：越界持仓线的文字标签是 canvas 里画的，
  //    **不会**因为换语言自动重画，漏了就一直是旧语言的文字。
  // ⚠️ 依赖里**没有** hover/dragging —— 它们是 ref，不进依赖；
  //    这正是「鼠标移动不再触发 React 渲染」的关键。
}, [series, positions, size, total, digits, live, t, winOf, syncUi])

  // rAF 回调通过 ref 调最新版本（否则会一直调用首次渲染时的闭包）
  // ⚠️ applyPointer 必须在这里（它定义之后）挂载：写在 scheduleDraw 后面会撞 TDZ。
  applyPointerRef.current = applyPointer
  drawRef.current = draw

  React.useEffect(() => {
    draw()
  }, [draw])

  return (
    <div
      ref={wrapRef}
      // contain: layout paint —— 图表重画被限制在这块区域里，
      // 不会因为「背后还有玻璃卡片的 backdrop-filter」而牵动整页重新合成
      style={{ contain: "layout paint" }}
      className={cn("relative h-full w-full overflow-hidden", className)}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-crosshair"
        // pan-y：横向滑动归图表（平移），纵向滑动仍然滚页面 —— 手机上必须这样，
        // 否则手指落在图表上就再也滚不动了。
        style={{ width: size.w || undefined, height: size.h || undefined, touchAction: "pan-y" }}
        /**
         * 给端到端验证用的观测点（`scripts/_verify-invest-chart.cjs` 读它们）。
         *
         * 为什么要暴露：蜡烛现在是**紧贴**的（实体占满一个 slot），
         * 相邻蜡烛在像素上连成一片 —— 靠「数出几根柱子」已经无法验证缩放是否生效。
         * 直接把当前的可见根数 / 总数 / 是否跟随最新挂成 data 属性，
         * 验证脚本读数字比猜像素可靠得多。对界面零影响。
         */
        data-candles={ui.candles}
        data-total={total}
        data-follow={ui.follow ? "1" : "0"}
        data-manual={ui.manual ? "1" : "0"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(e) => {
          // ⚠️ 拖动中（已 setPointerCapture）不能当成「离开」：那会在拖到画布外时
          //    把平移悄悄中断，表现为「拖到一半就不动了」。只有非拖动状态才清十字光标。
          if (dragRef.current) return
          pointerRef.current.inside = false
          hoverRef.current.on = false
          scheduleDraw()
          endDrag(e)
        }}
        onDoubleClick={resetView}
      />

      {series.length === 0 && emptyText && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      )}

      {/* 缩放控件：不依赖键盘/滚轮也能操作（触屏与「不知道能滚」的人） */}
      {series.length > 0 && (
        <div className="absolute right-[68px] top-1.5 flex items-center gap-0.5">
          <IconButton label={t("chart.zoomIn")} onClick={() => zoomBy(1)}>
            <ZoomIn className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label={t("chart.zoomOut")} onClick={() => zoomBy(-1)}>
            <ZoomOut className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label={t("chart.reset")} onClick={resetView} active={!ui.follow || ui.manual}>
            <Maximize2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}

      {/* 「拖走看历史 / 挪过价格轴」时给一个明显的回位入口，否则用户容易以为自己卡住了 */}
      {/*
        「回到最新」常驻在 DOM 里，用透明度切换显隐。
        ⚠️ 两个原因都必须这样写：
          1. 原来写的是「满足条件才渲染」—— **插入/移除**一个带 `backdrop-filter` 的元素
             会让浏览器重新栅格化它背后的整片内容（图表正好是一大块 canvas）；
          2. 去掉 `backdrop-blur`：这一层本来就在玻璃卡片里，再叠一层模糊既是多余的，
             又是实打实的合成开销。
      */}
      <button
        type="button"
        onClick={resetView}
        tabIndex={ui.follow && !ui.manual ? -1 : 0}
        aria-hidden={ui.follow && !ui.manual}
        className={cn(
          "absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm transition-opacity hover:text-foreground",
          ui.follow && !ui.manual ? "pointer-events-none opacity-0" : "opacity-100"
        )}
      >
        {t("chart.backToLatest")}
      </button>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md border bg-background/80 text-muted-foreground transition-colors hover:text-foreground",
        active && "border-foreground/30 text-foreground"
      )}
    >
      {children}
    </button>
  )
}
