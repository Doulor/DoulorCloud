import { LoadingSkeleton, type SkeletonVariant } from "@/components/skeletons"

/**
 * 加载占位。
 *
 * 2026-10-08 起**默认渲染骨架屏**（以前是转圈 icon）。原因：转圈只说明「在忙」，
 * 数据量大的页面要等一秒以上，空白 + 转圈的观感就是「卡住了」；骨架屏先把版面
 * 撑起来，数据到位时是「填充」而不是「整块跳出来」，视觉上也更连续。
 * （背景与取舍见 skeletons.tsx 的文件头注释。）
 *
 * `variant` 选骨架形状（list / table / cards / form）：
 *   - 表格类页面（管理面板各列表）传 `table`，骨架表头与真实表头对得上；
 *   - 卡片类页面（网盘 / AI 账号 / 域名）传 `cards`；
 *   - 表单/设置类传 `form`；
 *   - 不传则用通用的列表形，对大多数「一条条记录」的页面都合适。
 *
 * `className` 透传到骨架容器（例如放进小卡片时用 `p-0` 去掉多余留白）。
 */
export function LoadingBlock({
  className,
  variant,
}: {
  className?: string
  variant?: SkeletonVariant
}) {
  return <LoadingSkeleton variant={variant} className={className} />
}
