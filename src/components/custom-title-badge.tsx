import type { CSSProperties } from "react"

import { readableTextOn, ringBaseColor, ringSpotColor } from "@/lib/color"
import type { CustomTitle } from "@/types"

/**
 * 自定义称号徽章 —— 样式对标 role-badge（管理员/站长）：
 *   1. 文字上的扫光：直接复用 role-sheen（结构与 keyframes 相同）；
 *   2. 四周描边的循环流光：title-ring（role-ring 的颜色参数化版）。
 *
 * 与 RoleBadge 的区别：颜色不写死 —— 渐变双色、文字黑/白、描边流光色
 * 全部由 JS 按称号主色自动衍生（见 src/lib/color.ts），内联 style 全是
 * 计算好的具体颜色，兼容性与 role-ring 等价。
 *
 * 社区广场、个人空间、头像悬浮卡片共用这一份（与 RoleBadge 同理）。
 */
export function CustomTitleBadge({ title }: { title: CustomTitle }) {
  const from = title.colorFrom
  const to = title.colorTo
  return (
    <span
      className="title-ring inline-flex h-5 shrink-0 items-center rounded-md p-[1.5px]"
      style={
        {
          "--title-ring-base": ringBaseColor(from),
          "--title-ring-spot": ringSpotColor(from),
        } as CSSProperties
      }
    >
      <span
        className="role-sheen inline-flex h-full items-center rounded-[5px] px-1.5 text-[10px] font-semibold leading-none"
        style={{
          background: `linear-gradient(to right, ${from}, ${to})`,
          color: readableTextOn(from, to),
        }}
      >
        {title.name}
      </span>
    </span>
  )
}
