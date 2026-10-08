/**
 * 名片「设计系统」—— 把排版/间距/形状/材质/配色从「11 套写死的主题 CSS」
 * 里解放出来，变成用户可逐项调节的参数。
 *
 * ── 为什么要有这一层 ──
 * 原来每加一个设计开关就要：加一列 + 加校验 + 加 API 字段 + 在 11 个主题里各写一遍。
 * 线上数据显示 89% 的人停在默认布局、69% 停在默认主题、只有 3% 改过强调色 ——
 * 继续堆「预设」没有意义，真正缺的是**能自己调**。
 *
 * ── 实现原则（决定了这件事安全不安全）──
 * 所有参数走 `--pd-*` 变量，在 BASE_CSS 的**消费点**以三级回退接入：
 *     var(--pd-radius, var(--mod-radius, 18px))
 *          ↑用户         ↑主题            ↑兜底
 * 于是「用户没设」== 变量未定义 == 回退到主题值 == **与改动前逐像素一致**。
 * 343 张存量名片的 design 都是 `{}`，不需要任何数据回填。
 *
 * 比例类参数（字号/间距）用乘数而非替换，这样能在任何主题上按比例缩放：
 *     calc(var(--mod-gap) * var(--pd-density, 1))
 */

/** 用户的设计参数。全部可选 —— 缺省即「跟随主题」。 */
export interface ProfileDesign {
  // ---- 排版 ----
  /** 正文字号比例 %（80–130） */
  fontScale?: number
  /** 昵称字号比例 %（60–200） */
  nameScale?: number
  /** 昵称字重（300–900，百位步进） */
  nameWeight?: number
  /** 昵称字距（-0.05em–0.4em，存千分之一 em：-50–400） */
  nameSpacing?: number
  /** 正文行高 %（130–230） */
  lineHeight?: number
  /** 模块标题风格：大写拉丁 / 原样（中文友好）/ 完全隐藏 */
  titleStyle?: "upper" | "normal" | "hidden"
  /** 模块标题字距（存百分之一 em：0–50） */
  titleSpacing?: number

  // ---- 间距与尺寸 ----
  /** 整体留白密度 %（60–160），同时缩放模块间距与内边距 */
  density?: number
  /** 内容最大宽度 px（360–1200） */
  maxWidth?: number
  /** 模块间距与内边距 px；未设置时跟随主题和密度 */
  moduleGap?: number
  modulePadding?: number

  // ---- 形状 ----
  /** 全局圆角 px（0–48），覆盖主题的模块/链接/播放器圆角 */
  radius?: number
  /** 头像尺寸 px（48–200） */
  avatarSize?: number
  /** 头像形状 */
  avatarShape?: "circle" | "squircle" | "rounded" | "square" | "hex" | "blob"

  // ---- 材质 ----
  /** 模块容器材质 */
  surface?: "none" | "outline" | "solid" | "glass" | "elevated"
  /** 材质不透明度 %（0–100），solid/glass 生效 */
  surfaceOpacity?: number
  /** 描边粗细 px（0–4） */
  borderWidth?: number

  // ---- 配色 ----
  /** 第二强调色（#rrggbb）；设了就让昵称/进度条走双色渐变 */
  accent2?: string
  /** 正文色覆盖 */
  textColor?: string
  /** 次要文字色覆盖 */
  dimColor?: string
  /** 背景色覆盖 */
  bgColor?: string
  /** 背景图蒙版浓度 %（0–95） */
  bgOverlay?: number
  /** 背景图焦点百分比与模糊半径 px */
  bgX?: number
  bgY?: number
  bgBlur?: number
  /** 模块填充色与描边色 */
  surfaceColor?: string
  borderColor?: string
  /** 身份区与页脚字段可见性 */
  showAvatar?: boolean
  showBio?: boolean
  showUid?: boolean
  showJoined?: boolean
  showViews?: boolean
  /** 昵称走渐变（需要 accent2，否则用 accent 单色渐隐） */
  nameGradient?: boolean

  // ---- 布局 ----
  /** 桌面端模块列数；auto = 按模块数自动（≥3 两列） */
  cols?: "auto" | "1" | "2" | "3"
  /** 身份区对齐 */
  align?: "center" | "left"

  // ---- 动效 ----
  /** 动效强度 */
  motion?: "full" | "subtle" | "none"
  /** 悬停抬升 px（0–10） */
  hoverLift?: number
  /** 模块入场动画 */
  reveal?: "none" | "fade" | "rise" | "stagger"

  // ---- 质感装饰 ----
  /** 噪点颗粒强度 %（0–100） */
  grain?: number
  /** 四周暗角强度 %（0–100） */
  vignette?: number
}

/* ------------------------------------------------------------------ */
/* 校验                                                               */
/* ------------------------------------------------------------------ */

/** 数值参数的取值范围（同时用于后端夹取与前端滑块上下限，单一事实来源） */
export const DESIGN_RANGES = {
  fontScale: { min: 80, max: 130, def: 100 },
  nameScale: { min: 60, max: 200, def: 100 },
  nameWeight: { min: 300, max: 900, def: 600 },
  nameSpacing: { min: -50, max: 400, def: 0 },
  lineHeight: { min: 130, max: 230, def: 170 },
  titleSpacing: { min: 0, max: 50, def: 16 },
  density: { min: 60, max: 160, def: 100 },
  maxWidth: { min: 360, max: 1200, def: 460 },
  radius: { min: 0, max: 48, def: 18 },
  avatarSize: { min: 48, max: 200, def: 96 },
  surfaceOpacity: { min: 0, max: 100, def: 70 },
  borderWidth: { min: 0, max: 4, def: 1 },
  bgOverlay: { min: 0, max: 95, def: 55 },
  hoverLift: { min: 0, max: 10, def: 2 },
  grain: { min: 0, max: 100, def: 0 },
  vignette: { min: 0, max: 100, def: 0 },
} as const

/** 枚举参数的白名单 */
export const DESIGN_ENUMS = {
  titleStyle: ["upper", "normal", "hidden"],
  avatarShape: ["circle", "squircle", "rounded", "square", "hex", "blob"],
  surface: ["none", "outline", "solid", "glass", "elevated"],
  cols: ["auto", "1", "2", "3"],
  align: ["center", "left"],
  motion: ["full", "subtle", "none"],
  reveal: ["none", "fade", "rise", "stagger"],
} as const

const COLOR_KEYS = ["accent2", "textColor", "dimColor", "bgColor"] as const
const HEX_RE = /^#[0-9a-f]{6}$/i

/**
 * 清洗用户提交的 design。
 *
 * 白名单语义，与 sanitizeModules 一致：只认识的键才留，数值夹到范围内，
 * 非法值直接**丢弃**（而不是替换成默认值）—— 丢弃后该项回退到主题值，
 * 永远不会因为一个坏字段把整张名片的样式带偏。
 */
export function sanitizeDesign(raw: unknown): ProfileDesign {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [key, range] of Object.entries(DESIGN_RANGES)) {
    const v = o[key]
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    const n = Math.round(v)
    // 夹取而不是拒绝：前端滑块偶有越界，夹进来比整项丢掉更符合预期
    out[key] = Math.max(range.min, Math.min(range.max, n))
  }

  for (const [key, allowed] of Object.entries(DESIGN_ENUMS)) {
    const v = o[key]
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
      out[key] = v
    }
  }

  for (const key of COLOR_KEYS) {
    const v = o[key]
    if (typeof v === "string" && HEX_RE.test(v)) out[key] = v.toLowerCase()
  }

  if (typeof o.nameGradient === "boolean") out.nameGradient = o.nameGradient

  return out as ProfileDesign
}

/** 解析入库的 design JSON；坏数据一律回空对象（= 完全跟随主题） */
export function parseDesign(rawJson: string | null | undefined): ProfileDesign {
  if (!rawJson) return {}
  try {
    return sanitizeDesign(JSON.parse(rawJson))
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------------ */
/* CSS 生成                                                           */
/* ------------------------------------------------------------------ */

/** #rrggbb → "r,g,b"（给 rgba() 用） */
function rgbTriplet(hex: string): string {
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `${r},${g},${b}`
}

/** 头像形状 → border-radius / clip-path */
const AVATAR_SHAPE_CSS: Record<string, string> = {
  circle: "border-radius:50%",
  squircle: "border-radius:30%",
  rounded: "border-radius:22%",
  square: "border-radius:0",
  hex: "border-radius:0;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)",
  // 有机不规则形：四角不同半径，像一滴水
  blob: "border-radius:62% 38% 46% 54%/49% 56% 44% 51%",
}

/**
 * 噪点颗粒：内联 SVG feTurbulence。
 * 用 data URI 而不是外链图片 —— 名片页在自定义域名下也要能显示，不引入跨域依赖。
 */
const GRAIN_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3"/></filter><rect width="140" height="140" filter="url(#n)" opacity="1"/></svg>`
  )

/**
 * 把 design 编译成一段 CSS，插在主题 CSS **之后**。
 *
 * 只输出用户真正设过的项 —— 没设的键不产生任何声明，于是 BASE_CSS 里的
 * `var(--pd-x, var(--主题值))` 自然回退到主题值。这是「存量名片不变样」的保证。
 */
export function designCss(d: ProfileDesign): string {
  if (!d || Object.keys(d).length === 0) return ""

  /** :root 上的变量声明 */
  const vars: string[] = []
  /** 需要额外选择器的规则 */
  const rules: string[] = []

  // ---- 排版 ----
  if (d.fontScale != null) vars.push(`--pd-font-scale:${d.fontScale / 100}`)
  if (d.nameScale != null) vars.push(`--pd-name-scale:${d.nameScale / 100}`)
  if (d.nameWeight != null) vars.push(`--pd-name-weight:${d.nameWeight}`)
  if (d.nameSpacing != null) vars.push(`--pd-name-ls:${d.nameSpacing / 1000}em`)
  if (d.lineHeight != null) vars.push(`--pd-line-height:${d.lineHeight / 100}`)
  if (d.titleSpacing != null) vars.push(`--pd-title-ls:${d.titleSpacing / 100}em`)

  if (d.titleStyle === "normal") {
    // 中文模块标题：大写无效、宽字距反而割裂，改成字重 + 颜色区分层级
    vars.push(`--pd-title-transform:none`)
  } else if (d.titleStyle === "upper") {
    vars.push(`--pd-title-transform:uppercase`)
  } else if (d.titleStyle === "hidden") {
    rules.push(`.mod-title{display:none}`)
  }

  // ---- 间距与宽度 ----
  if (d.density != null) vars.push(`--pd-density:${d.density / 100}`)
  if (d.maxWidth != null) vars.push(`--pd-max-width:${d.maxWidth}px`)

  // ---- 形状 ----
  if (d.radius != null) {
    const r = d.radius
    vars.push(`--pd-radius:${r}px`)
    // 链接/播放器/图片墙按主圆角等比收敛，避免「卡片很圆、里面的条很方」
    vars.push(`--pd-radius-sm:${Math.max(0, Math.round(r * 0.7))}px`)
    vars.push(`--pd-radius-xs:${Math.max(0, Math.round(r * 0.5))}px`)
  }
  if (d.avatarSize != null) vars.push(`--pd-avatar-size:${d.avatarSize}px`)
  if (d.avatarShape) {
    const shape = AVATAR_SHAPE_CSS[d.avatarShape]
    if (shape) rules.push(`.avatar,.avatar-fallback{${shape}}`)
  }

  // ---- 材质 ----
  if (d.borderWidth != null) vars.push(`--pd-border-width:${d.borderWidth}px`)
  if (d.surface) {
    const op = (d.surfaceOpacity ?? DESIGN_RANGES.surfaceOpacity.def) / 100
    const bw = d.borderWidth ?? 1
    // 用中性灰 + alpha 而不是写死颜色：深色/浅色主题下都成立
    const tint = `rgba(127,127,140,${(op * 0.14).toFixed(3)})`
    const line = `rgba(127,127,140,${(op * 0.3).toFixed(3)})`
    switch (d.surface) {
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

  // ---- 配色 ----
  if (d.accent2) vars.push(`--pd-accent2:${d.accent2};--pd-accent2-rgb:${rgbTriplet(d.accent2)}`)
  if (d.textColor) vars.push(`--pd-text:${d.textColor}`)
  if (d.dimColor) vars.push(`--pd-text-dim:${d.dimColor}`)
  if (d.bgColor) vars.push(`--pd-bg:${d.bgColor}`)
  if (d.bgOverlay != null) vars.push(`--pd-bg-overlay:rgba(0,0,0,${(d.bgOverlay / 100).toFixed(2)})`)

  if (d.nameGradient) {
    // 有第二色走双色渐变；没有则用 accent → 半透明自身，仍有质感但不脏
    const to = d.accent2 ? "var(--pd-accent2)" : "rgba(var(--accent-rgb),.45)"
    rules.push(
      `.name{background:linear-gradient(94deg,var(--accent),${to});` +
        `-webkit-background-clip:text;background-clip:text;color:transparent}`
    )
  }

  // ---- 布局 ----
  if (d.align === "left") {
    rules.push(`.hero{align-items:flex-start;text-align:left}`)
  } else if (d.align === "center") {
    rules.push(`.hero{align-items:center;text-align:center}`)
  }

  // 列数：显式指定时覆盖 BASE_CSS 的 :has() 自动规则。
  // ⚠️ 必须同时写 .mods>.mod 的 grid-column，否则没设过 size 的模块会掉进
  // grid 默认行为各占一列 —— 那是「所有模块突然变半宽」的坑。
  if (d.cols && d.cols !== "auto") {
    const n = Number(d.cols)
    if (n === 1) {
      rules.push(
        `@media(min-width:641px){body:not(.layout-bento) .mods{display:flex;flex-direction:column}}`
      )
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

  // ---- 动效 ----
  if (d.hoverLift != null) vars.push(`--pd-hover-lift:-${d.hoverLift}px`)
  if (d.motion === "none") {
    rules.push(`*,*::before,*::after{animation:none!important;transition:none!important}`)
  } else if (d.motion === "subtle") {
    vars.push(`--pd-hover-lift:0px`)
    rules.push(`body::before{animation:none!important}`)
  }

  if (d.reveal && d.reveal !== "none" && d.motion !== "none") {
    const from = d.reveal === "rise" || d.reveal === "stagger" ? "translateY(14px)" : "none"
    rules.push(
      `@keyframes pd-reveal{from{opacity:0;transform:${from}}to{opacity:1;transform:none}}` +
        `.mod{animation:pd-reveal .5s cubic-bezier(.22,.61,.36,1) both}`
    )
    if (d.reveal === "stagger") {
      // 逐个错位入场：手写 8 条，比 JS 计算延迟更稳（无脚本依赖）
      for (let i = 1; i <= 8; i++) {
        rules.push(`.mods>.mod:nth-child(${i}){animation-delay:${(i - 1) * 70}ms}`)
      }
    }
    // 尊重系统「减少动态效果」
    rules.push(
      `@media(prefers-reduced-motion:reduce){.mod{animation:none}}`
    )
  }

  // ---- 质感装饰（叠在最上层，不拦截点击）----
  if (d.grain) {
    rules.push(
      `body::after{content:"";position:fixed;inset:0;z-index:2;pointer-events:none;` +
        `background-image:url("${GRAIN_SVG}");opacity:${(d.grain / 100 * 0.42).toFixed(3)};mix-blend-mode:overlay}`
    )
  }
  if (d.vignette) {
    rules.push(
      `.pd-vignette{position:fixed;inset:0;z-index:1;pointer-events:none;` +
        `background:radial-gradient(ellipse 75% 65% at 50% 45%,transparent 45%,rgba(0,0,0,${(d.vignette / 100 * 0.75).toFixed(2)}) 100%)}`
    )
  }

  const rootBlock = vars.length > 0 ? `:root{${vars.join(";")}}` : ""
  return `\n/* ---- 用户自定义设计 ---- */\n${rootBlock}\n${rules.join("\n")}`
}

/** vignette 需要一个真实元素（body 的 ::before/::after 已被背景纹理与噪点占用） */
export function designHtml(d: ProfileDesign): string {
  return d?.vignette ? `<div class="pd-vignette"></div>` : ""
}
