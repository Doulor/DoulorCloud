/**
 * designCss 的前端移植 —— 供编辑器的「设计参数本地即时预览」用。
 *
 * ⚠️ 与 `worker/src/profile-design.ts` 的 designCss 是同一份逻辑的**两份拷贝**：
 *   编辑器拖滑块时用本文件在浏览器里直接往预览 iframe 注入 CSS（零网络延迟），
 *   保存/公开页用 worker 那份在服务端渲染。两者输出必须一致，
 *   改任何一处（加参数、改派生规则）**两处必须同步**。
 *
 * 与 worker 版的唯一差异：数值夹取/白名单清洗不在此处做（编辑器滑块本身只产出
 * 合法值，加载自服务端的 design 也已 sanitize 过），本文件只管「design → CSS」。
 */
import { DESIGN_RANGES, designNum, designStr, designBool } from "./profile-design"

/** #rrggbb → "r,g,b"（给 rgba() 用） */
function rgbTriplet(hex: string): string {
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `${r},${g},${b}`
}

const AVATAR_SHAPE_CSS: Record<string, string> = {
  circle: "border-radius:50%",
  squircle: "border-radius:30%",
  rounded: "border-radius:22%",
  square: "border-radius:0",
  hex: "border-radius:0;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)",
  blob: "border-radius:62% 38% 46% 54%/49% 56% 44% 51%",
}

const GRAIN_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3"/></filter><rect width="140" height="140" filter="url(#n)" opacity="1"/></svg>`
  )

/**
 * 把 design 编译成 CSS（与 worker 的 designCss 输出一致）。
 * 入参是编辑器里的 design 状态对象（Record<string, unknown>）。
 */
export function designCss(design: Record<string, unknown>): string {
  if (!design || Object.keys(design).length === 0) return ""

  const vars: string[] = []
  const rules: string[] = []

  const fontScale = designNum(design, "fontScale")
  const nameScale = designNum(design, "nameScale")
  const nameWeight = designNum(design, "nameWeight")
  const nameSpacing = designNum(design, "nameSpacing")
  const lineHeight = designNum(design, "lineHeight")
  const titleSpacing = designNum(design, "titleSpacing")
  const density = designNum(design, "density")
  const maxWidth = designNum(design, "maxWidth")
  const radius = designNum(design, "radius")
  const avatarSize = designNum(design, "avatarSize")
  const avatarShape = designStr(design, "avatarShape")
  const borderWidth = designNum(design, "borderWidth")
  const surface = designStr(design, "surface")
  const surfaceOpacity = designNum(design, "surfaceOpacity")
  const accent2 = designStr(design, "accent2")
  const textColor = designStr(design, "textColor")
  const dimColor = designStr(design, "dimColor")
  const bgColor = designStr(design, "bgColor")
  const bgOverlay = designNum(design, "bgOverlay")
  const nameGradient = designBool(design, "nameGradient")
  const cols = designStr(design, "cols")
  const align = designStr(design, "align")
  const motion = designStr(design, "motion")
  const hoverLift = designNum(design, "hoverLift")
  const reveal = designStr(design, "reveal")
  const grain = designNum(design, "grain")
  const vignette = designNum(design, "vignette")

  if (fontScale != null) vars.push(`--pd-font-scale:${fontScale / 100}`)
  if (nameScale != null) vars.push(`--pd-name-scale:${nameScale / 100}`)
  if (nameWeight != null) vars.push(`--pd-name-weight:${nameWeight}`)
  if (nameSpacing != null) vars.push(`--pd-name-ls:${nameSpacing / 1000}em`)
  if (lineHeight != null) vars.push(`--pd-line-height:${lineHeight / 100}`)
  if (titleSpacing != null) vars.push(`--pd-title-ls:${titleSpacing / 100}em`)

  const titleStyle = designStr(design, "titleStyle")
  if (titleStyle === "normal") vars.push(`--pd-title-transform:none`)
  else if (titleStyle === "upper") vars.push(`--pd-title-transform:uppercase`)
  else if (titleStyle === "hidden") rules.push(`.mod-title{display:none}`)

  if (density != null) vars.push(`--pd-density:${density / 100}`)
  if (maxWidth != null) vars.push(`--pd-max-width:${maxWidth}px`)

  if (radius != null) {
    vars.push(`--pd-radius:${radius}px`)
    vars.push(`--pd-radius-sm:${Math.max(0, Math.round(radius * 0.7))}px`)
    vars.push(`--pd-radius-xs:${Math.max(0, Math.round(radius * 0.5))}px`)
  }
  if (avatarSize != null) vars.push(`--pd-avatar-size:${avatarSize}px`)
  if (avatarShape) {
    const shape = AVATAR_SHAPE_CSS[avatarShape]
    if (shape) rules.push(`.avatar,.avatar-fallback{${shape}}`)
  }

  if (borderWidth != null) vars.push(`--pd-border-width:${borderWidth}px`)
  if (surface) {
    const op = (surfaceOpacity ?? DESIGN_RANGES.surfaceOpacity.def) / 100
    const bw = borderWidth ?? 1
    const tint = `rgba(127,127,140,${(op * 0.14).toFixed(3)})`
    const line = `rgba(127,127,140,${(op * 0.3).toFixed(3)})`
    switch (surface) {
      case "none":
        rules.push(`.mod{background:none;border:0;box-shadow:none;padding:0;backdrop-filter:none;-webkit-backdrop-filter:none}`)
        break
      case "outline":
        rules.push(`.mod{background:none;border:${bw}px solid ${line};box-shadow:none;padding:var(--pd-pad,18px);backdrop-filter:none;-webkit-backdrop-filter:none}`)
        break
      case "solid":
        rules.push(`.mod{background:${tint};border:${bw}px solid ${line};box-shadow:none;padding:var(--pd-pad,18px);backdrop-filter:none;-webkit-backdrop-filter:none}`)
        break
      case "glass":
        rules.push(`.mod{background:${tint};border:${bw}px solid ${line};box-shadow:none;padding:var(--pd-pad,18px);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}`)
        break
      case "elevated":
        rules.push(`.mod{background:${tint};border:0;box-shadow:0 10px 34px rgba(0,0,0,.28);padding:var(--pd-pad,18px);backdrop-filter:none;-webkit-backdrop-filter:none}`)
        break
    }
  }

  if (accent2) vars.push(`--pd-accent2:${accent2};--pd-accent2-rgb:${rgbTriplet(accent2)}`)
  if (textColor) vars.push(`--pd-text:${textColor}`)
  if (dimColor) vars.push(`--pd-text-dim:${dimColor}`)
  if (bgColor) vars.push(`--pd-bg:${bgColor}`)
  if (bgOverlay != null) vars.push(`--pd-bg-overlay:rgba(0,0,0,${(bgOverlay / 100).toFixed(2)})`)

  if (nameGradient) {
    const to = accent2 ? "var(--pd-accent2)" : "rgba(var(--accent-rgb),.45)"
    rules.push(
      `.name{background:linear-gradient(94deg,var(--accent),${to});` +
        `-webkit-background-clip:text;background-clip:text;color:transparent}`
    )
  }

  if (align === "left") rules.push(`.hero{align-items:flex-start;text-align:left}`)
  else if (align === "center") rules.push(`.hero{align-items:center;text-align:center}`)

  if (cols && cols !== "auto") {
    const n = Number(cols)
    if (n === 1) {
      rules.push(`@media(min-width:641px){body:not(.layout-bento) .mods{display:flex;flex-direction:column}}`)
    } else {
      rules.push(
        `@media(min-width:641px){` +
          `body:not(.layout-bento) .mods{display:grid;grid-template-columns:repeat(${n},minmax(0,1fr));gap:var(--mod-gap)}` +
          `body:not(.layout-bento) .mods>.mod{grid-column:span 1}` +
          `body:not(.layout-bento) .mods>[data-size="full"]{grid-column:1/-1}` +
          `body:not(.layout-bento) .mod-gallery,body:not(.layout-bento) .mod-timeline,body:not(.layout-bento) .mod-music{grid-column:1/-1}` +
          `}`
      )
    }
  }

  if (hoverLift != null) vars.push(`--pd-hover-lift:-${hoverLift}px`)
  if (motion === "none") {
    rules.push(`*,*::before,*::after{animation:none!important;transition:none!important}`)
  } else if (motion === "subtle") {
    vars.push(`--pd-hover-lift:0px`)
    rules.push(`body::before{animation:none!important}`)
  }

  if (reveal && reveal !== "none" && motion !== "none") {
    const from = reveal === "rise" || reveal === "stagger" ? "translateY(14px)" : "none"
    rules.push(
      `@keyframes pd-reveal{from{opacity:0;transform:${from}}to{opacity:1;transform:none}}` +
        `.mod{animation:pd-reveal .5s cubic-bezier(.22,.61,.36,1) both}`
    )
    if (reveal === "stagger") {
      for (let i = 1; i <= 8; i++) {
        rules.push(`.mods>.mod:nth-child(${i}){animation-delay:${(i - 1) * 70}ms}`)
      }
    }
    rules.push(`@media(prefers-reduced-motion:reduce){.mod{animation:none}}`)
  }

  if (grain) {
    rules.push(
      `body::after{content:"";position:fixed;inset:0;z-index:2;pointer-events:none;` +
        `background-image:url("${GRAIN_SVG}");opacity:${(grain / 100 * 0.42).toFixed(3)};mix-blend-mode:overlay}`
    )
  }
  if (vignette) {
    rules.push(
      `.pd-vignette{position:fixed;inset:0;z-index:1;pointer-events:none;` +
        `background:radial-gradient(ellipse 75% 65% at 50% 45%,transparent 45%,rgba(0,0,0,${(vignette / 100 * 0.75).toFixed(2)}) 100%)}`
    )
  }

  const rootBlock = vars.length > 0 ? `:root{${vars.join(";")}}` : ""
  return `${rootBlock}\n${rules.join("\n")}`
}

/** 预览时禁用入场动画的注入样式（不进库，只在编辑器预览 iframe 里生效）。 */
export const PREVIEW_NO_ANIM_CSS = [
  // 交互式开屏遮罩（enter/portal/typewriter）直接隐藏
  `.intro-overlay{display:none!important}`,
  // fade/slide 这类非交互式开屏作用在 .wrap 上，强制收尾态
  `.wrap{animation:none!important;opacity:1!important;transform:none!important}`,
  // 模块入场（reveal）
  `.mod{animation:none!important;transition:none!important}`,
].join("\n")
