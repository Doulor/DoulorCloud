import * as React from "react"

import { FadeImage } from "@/components/fade-image"
import { validateCoverInput } from "@/lib/shop-cover"
import { useT } from "@/i18n"
import { ImageOff } from "lucide-react"

/**
 * 商品封面输入框下方的即时预览（用户端 / 管理端共用）。
 *
 * 为什么需要：封面值可能是几百 KB 的 Data URL，输入框里只能看到一截尾巴，
 * 用户没法确认「粘进去的到底是什么图」。这里按**与提交相同的校验口径**
 * （lib/shop-cover.ts）实时判断，三种状态：
 *
 *   · ok       —— 渲染缩略图（Data URL 与 http 链接都走 <img>，SVG 同理）；
 *   · invalid  —— 明确报「地址不合法」而不是默默不显示；
 *   · tooLarge —— 报超长并提示改用本地上传。
 *
 * 只在输入框为空时不渲染（封面可选）。
 */
export function CoverPreview({ value }: { value: string }) {
  const { t } = useT()
  const v = value.trim()
  const verdict = React.useMemo(() => validateCoverInput(v), [v])

  if (!v) return null

  if (verdict !== "ok") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-destructive">
        <ImageOff className="h-3.5 w-3.5 shrink-0" />
        {t(verdict === "invalid" ? "pt.err.coverInvalid" : "pt.err.coverTooLarge")}
      </p>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <FadeImage
        // key 带值长度：粘贴一张新图（同类型、长度不同）也重新走一次渐入，
        // 否则 React 复用同一个 img 元素会短暂显示上一张。
        key={v.length}
        src={v}
        alt={t("pt.form.coverPreviewAlt")}
        className="h-16 w-24 shrink-0 rounded-md border"
      />
      <span className="text-xs text-muted-foreground">{t("pt.form.coverPreviewHint")}</span>
    </div>
  )
}
