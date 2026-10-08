/**
 * 名片「设计系统」编辑器面板。
 *
 * 把排版/间距/形状/材质/配色/布局/动效/质感八个维度开放给用户逐项调节。
 * 每一项都有「跟随主题」状态 —— 未设置时该项回退到主题默认值，一个「重置」
 * 按钮就回到完全跟随主题（对应后端：design 里删掉这个键）。
 *
 * 数据源：`src/lib/profile-design.ts` 的范围/枚举（与后端 sanitizeDesign 同源）。
 */
import * as React from "react"
import { RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DESIGN_RANGES,
  DESIGN_COLOR_KEYS,
  designNum,
  designStr,
  designBool,
  isDesignEmpty,
} from "@/lib/profile-design"
import { useT } from "@/i18n"

interface PanelProps {
  design: Record<string, unknown>
  /** 单项写入；value 传 undefined 表示删除该键（回退主题默认） */
  onChange: (key: string, value: unknown) => void
  /** 清空全部 */
  onReset: () => void
}

/** 一个数值滑块行：标签 + 滑块 + 当前值 + 重置 */
function SliderRow({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  hint?: string
}) {
  const { t } = useT()
  const range = DESIGN_RANGES[id]
  if (!range) return null
  const current = value ?? range.def
  const isSet = value !== undefined
  const display =
    range.displayDiv != null ? current / range.displayDiv : current
  const displayText =
    (range.decimals != null ? display.toFixed(range.decimals) : String(Math.round(display))) +
    (range.unit ?? "")

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`pd-${id}`} className="text-xs">
          {label}
        </Label>
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              isSet ? "text-foreground" : "text-muted-foreground/60"
            )}
            title={isSet ? undefined : t("pd.followTheme")}
          >
            {displayText}
          </span>
          {isSet && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={t("pd.reset")}
              title={t("pd.followTheme")}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <input
        id={`pd-${id}`}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step ?? 1}
        value={current}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** 一个颜色行：标签 + 取色器 + 文本框 + 重置 */
function ColorRow({
  label,
  value,
  fallback,
  onChange,
}: {
  /** 参数 id（仅语义标注，取色器用 aria-label=label） */
  id: string
  label: string
  value: string | undefined
  fallback: string
  onChange: (v: string | undefined) => void
}) {
  const { t } = useT()
  const isSet = value !== undefined
  const shown = value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={shown}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-11 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
          aria-label={label}
        />
        <Input
          placeholder={fallback}
          value={value ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim()
            onChange(v === "" ? undefined : v)
          }}
          className="h-8 flex-1 font-mono text-xs"
        />
        {isSet && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t("pd.reset")}
            title={t("pd.followTheme")}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}

/** 一个枚举行：标签 + 分段按钮 */
function EnumRow({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  /** 参数 id（仅语义标注） */
  id: string
  label: string
  value: string | undefined
  options: { id: string; label: string }[]
  onChange: (v: string | undefined) => void
  hint?: string
}) {
  const { t } = useT()
  const isSet = value !== undefined
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        {isSet && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t("pd.reset")}
            title={t("pd.followTheme")}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = isSet ? value === o.id : o.id === "__theme__"
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id === "__theme__" ? undefined : o.id)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-border bg-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** 分组容器 */
function Group({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h4 className="text-sm font-medium">{title}</h4>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

export function ProfileDesignPanel({ design, onChange, onReset }: PanelProps) {
  const { t } = useT()
  const set = (key: string, v: unknown) => onChange(key, v)
  const num = (k: string) => designNum(design, k)
  const str = (k: string) => designStr(design, k)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("pd.intro")}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={isDesignEmpty(design)}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          {t("pd.resetAll")}
        </Button>
      </div>

      {/* ---- 排版 ---- */}
      <Group title={t("pd.g.typography")} desc={t("pd.g.typographyDesc")}>
        <SliderRow id="fontScale" label={t("pd.fontScale")} value={num("fontScale")} onChange={(v) => set("fontScale", v)} />
        <SliderRow id="nameScale" label={t("pd.nameScale")} value={num("nameScale")} onChange={(v) => set("nameScale", v)} />
        <SliderRow id="nameWeight" label={t("pd.nameWeight")} value={num("nameWeight")} onChange={(v) => set("nameWeight", v)} />
        <SliderRow id="nameSpacing" label={t("pd.nameSpacing")} value={num("nameSpacing")} onChange={(v) => set("nameSpacing", v)} />
        <SliderRow id="lineHeight" label={t("pd.lineHeight")} value={num("lineHeight")} onChange={(v) => set("lineHeight", v)} />
        <EnumRow
          id="titleStyle"
          label={t("pd.titleStyle")}
          value={str("titleStyle")}
          onChange={(v) => set("titleStyle", v)}
          options={[
            { id: "__theme__", label: t("pd.followTheme") },
            { id: "upper", label: t("pd.titleStyle.upper") },
            { id: "normal", label: t("pd.titleStyle.normal") },
            { id: "hidden", label: t("pd.titleStyle.hidden") },
          ]}
          hint={t("pd.titleStyleHint")}
        />
        <SliderRow id="titleSpacing" label={t("pd.titleSpacing")} value={num("titleSpacing")} onChange={(v) => set("titleSpacing", v)} />
      </Group>

      {/* ---- 间距与宽度 ---- */}
      <Group title={t("pd.g.spacing")} desc={t("pd.g.spacingDesc")}>
        <SliderRow id="density" label={t("pd.density")} value={num("density")} onChange={(v) => set("density", v)} hint={t("pd.densityHint")} />
        <SliderRow id="maxWidth" label={t("pd.maxWidth")} value={num("maxWidth")} onChange={(v) => set("maxWidth", v)} hint={t("pd.maxWidthHint")} />
      </Group>

      {/* ---- 形状 ---- */}
      <Group title={t("pd.g.shape")}>
        <SliderRow id="radius" label={t("pd.radius")} value={num("radius")} onChange={(v) => set("radius", v)} />
        <SliderRow id="avatarSize" label={t("pd.avatarSize")} value={num("avatarSize")} onChange={(v) => set("avatarSize", v)} />
        <EnumRow
          id="avatarShape"
          label={t("pd.avatarShape")}
          value={str("avatarShape")}
          onChange={(v) => set("avatarShape", v)}
          options={[
            { id: "__theme__", label: t("pd.followTheme") },
            { id: "circle", label: t("pd.avatarShape.circle") },
            { id: "squircle", label: t("pd.avatarShape.squircle") },
            { id: "rounded", label: t("pd.avatarShape.rounded") },
            { id: "square", label: t("pd.avatarShape.square") },
            { id: "hex", label: t("pd.avatarShape.hex") },
            { id: "blob", label: t("pd.avatarShape.blob") },
          ]}
        />
      </Group>

      {/* ---- 材质 ---- */}
      <Group title={t("pd.g.surface")} desc={t("pd.g.surfaceDesc")}>
        <EnumRow
          id="surface"
          label={t("pd.surface")}
          value={str("surface")}
          onChange={(v) => set("surface", v)}
          options={[
            { id: "__theme__", label: t("pd.followTheme") },
            { id: "none", label: t("pd.surface.none") },
            { id: "outline", label: t("pd.surface.outline") },
            { id: "solid", label: t("pd.surface.solid") },
            { id: "glass", label: t("pd.surface.glass") },
            { id: "elevated", label: t("pd.surface.elevated") },
          ]}
        />
        <SliderRow id="surfaceOpacity" label={t("pd.surfaceOpacity")} value={num("surfaceOpacity")} onChange={(v) => set("surfaceOpacity", v)} />
        <SliderRow id="borderWidth" label={t("pd.borderWidth")} value={num("borderWidth")} onChange={(v) => set("borderWidth", v)} />
      </Group>

      {/* ---- 配色 ---- */}
      <Group title={t("pd.g.color")} desc={t("pd.g.colorDesc")}>
        {DESIGN_COLOR_KEYS.map((key) => (
          <ColorRow
            key={key}
            id={key}
            label={t(`pd.${key}`)}
            value={str(key)}
            fallback={key === "bgColor" ? "#050505" : key === "dimColor" ? "#8b8b8b" : "#ececec"}
            onChange={(v) => set(key, v)}
          />
        ))}
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="text-xs">
            <div className="font-medium">{t("pd.nameGradient")}</div>
            <div className="text-muted-foreground">{t("pd.nameGradientHint")}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={designBool(design, "nameGradient")}
            onClick={() => set("nameGradient", designBool(design, "nameGradient") ? undefined : true)}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors",
              designBool(design, "nameGradient") ? "bg-primary" : "bg-muted-foreground/30"
            )}
          >
            <span
              className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
              style={{ left: designBool(design, "nameGradient") ? "22px" : "2px" }}
            />
          </button>
        </div>
        <SliderRow id="bgOverlay" label={t("pd.bgOverlay")} value={num("bgOverlay")} onChange={(v) => set("bgOverlay", v)} hint={t("pd.bgOverlayHint")} />
      </Group>

      {/* ---- 布局 ---- */}
      <Group title={t("pd.g.layout")}>
        <EnumRow
          id="cols"
          label={t("pd.cols")}
          value={str("cols")}
          onChange={(v) => set("cols", v)}
          options={[
            { id: "__theme__", label: t("pd.followTheme") },
            { id: "1", label: t("pd.cols.1") },
            { id: "2", label: t("pd.cols.2") },
            { id: "3", label: t("pd.cols.3") },
          ]}
          hint={t("pd.colsHint")}
        />
        <EnumRow
          id="align"
          label={t("pd.align")}
          value={str("align")}
          onChange={(v) => set("align", v)}
          options={[
            { id: "__theme__", label: t("pd.followTheme") },
            { id: "center", label: t("pd.align.center") },
            { id: "left", label: t("pd.align.left") },
          ]}
        />
      </Group>

      {/* ---- 动效 ---- */}
      <Group title={t("pd.g.motion")}>
        <EnumRow
          id="motion"
          label={t("pd.motion")}
          value={str("motion")}
          onChange={(v) => set("motion", v)}
          options={[
            { id: "__theme__", label: t("pd.followTheme") },
            { id: "full", label: t("pd.motion.full") },
            { id: "subtle", label: t("pd.motion.subtle") },
            { id: "none", label: t("pd.motion.none") },
          ]}
        />
        <SliderRow id="hoverLift" label={t("pd.hoverLift")} value={num("hoverLift")} onChange={(v) => set("hoverLift", v)} />
        <EnumRow
          id="reveal"
          label={t("pd.reveal")}
          value={str("reveal")}
          onChange={(v) => set("reveal", v)}
          options={[
            { id: "__theme__", label: t("pd.followTheme") },
            { id: "none", label: t("pd.reveal.none") },
            { id: "fade", label: t("pd.reveal.fade") },
            { id: "rise", label: t("pd.reveal.rise") },
            { id: "stagger", label: t("pd.reveal.stagger") },
          ]}
          hint={t("pd.revealHint")}
        />
      </Group>

      {/* ---- 质感 ---- */}
      <Group title={t("pd.g.texture")} desc={t("pd.g.textureDesc")}>
        <SliderRow id="grain" label={t("pd.grain")} value={num("grain")} onChange={(v) => set("grain", v)} />
        <SliderRow id="vignette" label={t("pd.vignette")} value={num("vignette")} onChange={(v) => set("vignette", v)} />
      </Group>
    </div>
  )
}
