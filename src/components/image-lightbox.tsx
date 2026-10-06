/**
 * 通用图片灯箱（2026-10-06）。
 *
 * 原先有 4 处各写了一份几乎一样的遮罩（反馈图片 / 社区帖子图片 / markdown 正文图 /
 * 表情包），都只能看、不能缩放 —— 用户反馈「点开大图想看清细节，没法放大」。
 * 这里收成一个组件，统一带上：
 *   · 滚轮**以指针为中心**缩放（1x ~ 6x）；
 *   · 放大后可按住拖动平移；
 *   · 双击在「放大 2x / 还原」之间切换；
 *   · Esc / 点背景关闭。
 *
 * ⚠️ 为什么用原生 addEventListener 而不是 React 的 onWheel：
 *   React 17+ 把 `wheel` 注册成 **passive** 监听，在回调里调 preventDefault() 无效，
 *   结果是「一边缩放、一边把背后的页面也滚走了」。必须自己 addEventListener 并显式
 *   `{ passive: false }`。
 *
 * ⚠️ 缩放中心算法：屏幕上的点 = 平移量 + 图像坐标 × 缩放倍率。要让**指针下的那个点**
 *   在缩放前后停在原地，平移量就得按 `o' = m - (m - o) * k` 反算（m = 指针相对屏幕中心）。
 *   这样手感是「放大哪里就往哪里钻」，而不是永远从图片正中心放大。
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { X, Maximize2 } from "lucide-react"

/** 最小 1x（不缩小，避免缩成一粒看不见）；最大 6x 够看细节了 */
const MIN_SCALE = 1
const MAX_SCALE = 6
/** 滚轮灵敏度：deltaY 一格约 100，配这个系数刚好「滚一格变一点」 */
const WHEEL_SENSITIVITY = 0.0015

const clampScale = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))

export function ImageLightbox({
  src,
  alt,
  onClose,
  dialogLabel,
  closeLabel,
  zoomHint,
  resizeLabel,
}: {
  src: string
  alt: string
  onClose: () => void
  /** 给屏幕阅读器的对话框名称 */
  dialogLabel: string
  closeLabel: string
  /** 底部操作提示；不传则不显示提示条 */
  zoomHint?: string
  /** 右下角「调整大小」手柄的无障碍名称 */
  resizeLabel: string
}) {
  const [scale, setScale] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  // 事件回调里必须读到**最新**倍率/位移，只靠 state 会拿到闭包里的旧值
  const scaleRef = React.useRef(1)
  const offsetRef = React.useRef({ x: 0, y: 0 })
  const dragRef = React.useRef<{
    startX: number
    startY: number
    baseX: number
    baseY: number
  } | null>(null)
  /** 右下角「调整大小」手柄的拖动起点 */
  const resizeRef = React.useRef<{
    startX: number
    startY: number
    baseScale: number
  } | null>(null)
  const movedRef = React.useRef(false)
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)
  // onClose 多为内联箭头函数，每次 render 都是新引用。若直接进 effect 依赖，
  // 缩放/拖动引发重渲染时 effect 会重跑 —— 每次都重新 focus 关闭按钮，焦点被反复抢走。
  // 存进 ref，让「挂载时绑定一次 Esc + 聚焦一次」。
  const onCloseRef = React.useRef(onClose)
  React.useEffect(() => {
    onCloseRef.current = onClose
  })

  /** 统一的写入口：缩回 1x 时顺手把平移清零，免得下次打开还是偏的 */
  const apply = React.useCallback((s: number, o: { x: number; y: number }) => {
    const next = s <= MIN_SCALE ? { x: 0, y: 0 } : o
    scaleRef.current = s
    offsetRef.current = next
    setScale(s)
    setOffset(next)
  }, [])

  // Esc 关闭；打开时把焦点交给关闭按钮（只跑一次，见上面 onCloseRef 的说明）
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current()
    }
    document.addEventListener("keydown", onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  // 滚轮缩放（原生监听，理由见文件头注释）
  React.useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = scaleRef.current
      const o = offsetRef.current
      // 先算出「本次实际生效的倍率」（受上下限夹取），再据此反推位移
      const next = clampScale(s * Math.exp(-e.deltaY * WHEEL_SENSITIVITY))
      const k = next / s
      const mx = e.clientX - window.innerWidth / 2
      const my = e.clientY - window.innerHeight / 2
      apply(next, { x: mx - (mx - o.x) * k, y: my - (my - o.y) * k })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [apply])

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (scaleRef.current <= MIN_SCALE) return // 没放大就没什么可拖的
    e.preventDefault()
    movedRef.current = false
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: offsetRef.current.x,
      baseY: offsetRef.current.y,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > 2) movedRef.current = true
    apply(scaleRef.current, { x: d.baseX + dx, y: d.baseY + dy })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    const el = e.currentTarget
    // ⚠️ 对**没捕获过**的 pointerId 调 releasePointerCapture 会抛 NotFoundError，
    // 先问一句 hasPointerCapture 再放
    if (dragRef.current && el.hasPointerCapture?.(e.pointerId)) {
      el.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
  }

  // ---- 右下角手柄：用鼠标拖着调整大小（用户 2026-10-06 追加要求）----

  const onResizeDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    e.preventDefault()
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseScale: scaleRef.current,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onResizeMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = resizeRef.current
    if (!r) return
    // 往右下拖变大、往左上拖变小。取两个轴的均值：斜着拖和横竖拖的手感一致。
    // 用 exp 而不是线性，是因为倍率本身是乘性变化的（1→2 和 4→8 幅度应该相同）。
    const delta = (e.clientX - r.startX + (e.clientY - r.startY)) / 2
    apply(clampScale(r.baseScale * Math.exp(delta / 220)), offsetRef.current)
  }

  const onResizeUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const el = e.currentTarget
    if (resizeRef.current && el.hasPointerCapture?.(e.pointerId)) {
      el.releasePointerCapture(e.pointerId)
    }
    resizeRef.current = null
  }

  const zoomed = scale > MIN_SCALE + 0.001

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      className={
        // pointer-events-auto：Radix Dialog 的 modal 模式会给 body 设 pointer-events:none，
        // 而本灯箱是 Portal 到 body 的兄弟节点，会继承它 ⇒ 出现在弹窗里时「点不开也关不掉」。
        "pointer-events-auto fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/80 p-4 " +
        (zoomed ? "cursor-grab" : "cursor-zoom-out")
      }
      onClick={(e) => {
        // ⚠️ React 的 portal 事件按**组件树**冒泡，不是 DOM 树 —— 社区概览页的帖子卡片
        //    整体可点（跳详情），不在这里截断的话，点灯箱里的任何地方都会连带跳转。
        e.stopPropagation()
        // 只认「点在背景上」——点在图片上不关，拖动松手也不会误关
        if (e.target === e.currentTarget && !movedRef.current) onClose()
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (scaleRef.current > MIN_SCALE) apply(1, { x: 0, y: 0 })
          else apply(2, { x: 0, y: 0 })
        }}
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
          // 不加 transition：滚轮/拖动要即时跟手，加了反而拖沓
          touchAction: "none",
        }}
        className="max-h-full max-w-full select-none rounded-lg object-contain"
      />

      <button
        ref={closeRef}
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
        aria-label={closeLabel}
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>

      {/* 右下角手柄：按住拖动即可调整大小；键盘用方向键（↑→ 放大，↓← 缩小） */}
      <button
        type="button"
        aria-label={resizeLabel}
        title={resizeLabel}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onKeyDown={(e) => {
          const step = 1.15
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            e.preventDefault()
            e.stopPropagation()
            apply(clampScale(scaleRef.current * step), offsetRef.current)
          } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            e.preventDefault()
            e.stopPropagation()
            apply(clampScale(scaleRef.current / step), offsetRef.current)
          }
        }}
        className="absolute bottom-4 right-4 flex h-10 w-10 cursor-nwse-resize touch-none items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
      >
        <Maximize2 className="h-4 w-4" aria-hidden="true" />
      </button>

      {zoomHint && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-white/10 px-3 py-1 text-center text-xs text-white/80">
          {zoomed ? `${Math.round(scale * 100)}% · ${zoomHint}` : zoomHint}
        </div>
      )}
    </div>,
    document.body
  )
}
