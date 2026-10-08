/**
 * 名片设计系统的前端常量。
 *
 * ⚠️ 与 `worker/src/profile-design.ts` 的 DESIGN_RANGES / DESIGN_ENUMS 同源 —
 * 改任何一处范围或枚举，两处必须同步（前端用范围做滑块上下限，后端用范围做夹取，
 * 不一致会导致滑块能拖出后端会拒的值）。worker 是校验的事实来源。
 */

export interface DesignRange {
  min: number
  max: number
  def: number
  /** 滑块步进；缺省 1 */
  step?: number
  /** 显示单位（% / px / em） */
  unit?: string
  /** 展示时换算：存的是千分之一，给用户看要除以 1000（如 nameSpacing） */
  displayDiv?: number
  /** 展示小数位 */
  decimals?: number
}

export const DESIGN_RANGES: Record<string, DesignRange> = {
  fontScale: { min: 80, max: 130, def: 100, step: 1, unit: "%" },
  nameScale: { min: 60, max: 200, def: 100, step: 1, unit: "%" },
  nameWeight: { min: 300, max: 900, def: 600, step: 100 },
  nameSpacing: { min: -50, max: 400, def: 0, step: 5, unit: "em", displayDiv: 1000, decimals: 3 },
  lineHeight: { min: 130, max: 230, def: 170, step: 5, unit: "%" },
  titleSpacing: { min: 0, max: 50, def: 16, step: 1, unit: "em", displayDiv: 100, decimals: 2 },
  density: { min: 60, max: 160, def: 100, step: 5, unit: "%" },
  maxWidth: { min: 360, max: 1200, def: 460, step: 10, unit: "px" },
  radius: { min: 0, max: 48, def: 18, step: 1, unit: "px" },
  avatarSize: { min: 48, max: 200, def: 96, step: 2, unit: "px" },
  surfaceOpacity: { min: 0, max: 100, def: 70, step: 5, unit: "%" },
  borderWidth: { min: 0, max: 4, def: 1, step: 0.5, unit: "px", decimals: 1 },
  bgOverlay: { min: 0, max: 95, def: 55, step: 5, unit: "%" },
  hoverLift: { min: 0, max: 10, def: 2, step: 1, unit: "px" },
  grain: { min: 0, max: 100, def: 0, step: 5, unit: "%" },
  vignette: { min: 0, max: 100, def: 0, step: 5, unit: "%" },
}

export const DESIGN_ENUMS: Record<string, string[]> = {
  titleStyle: ["upper", "normal", "hidden"],
  avatarShape: ["circle", "squircle", "rounded", "square", "hex", "blob"],
  surface: ["none", "outline", "solid", "glass", "elevated"],
  cols: ["auto", "1", "2", "3"],
  align: ["center", "left"],
  motion: ["full", "subtle", "none"],
  reveal: ["none", "fade", "rise", "stagger"],
}

/** 颜色类参数（用取色器渲染） */
export const DESIGN_COLOR_KEYS = ["accent2", "textColor", "dimColor", "bgColor"] as const

/** 从 design 对象读某个数值参数；未设返回 undefined（不是默认值，便于「跟随主题」判定） */
export function designNum(design: Record<string, unknown>, key: string): number | undefined {
  const v = design[key]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

export function designStr(design: Record<string, unknown>, key: string): string | undefined {
  const v = design[key]
  return typeof v === "string" && v !== "" ? v : undefined
}

export function designBool(design: Record<string, unknown>, key: string): boolean {
  return design[key] === true
}

/** design 是否完全为空（= 完全跟随主题），用于「重置」按钮的禁用态 */
export function isDesignEmpty(design: Record<string, unknown>): boolean {
  return Object.keys(design).length === 0
}
