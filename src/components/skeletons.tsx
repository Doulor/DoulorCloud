import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

/**
 * 页面级骨架屏（2026-10-08）。
 *
 * 背景：全站 59 处加载态此前一律是 `LoadingBlock` 那个**转圈 icon**。转圈只说明
 * 「在忙」，数据量大的页面要等一秒以上，转圈期间是空白，观感上就是「卡住了」。
 * 概览页（dashboard）早就改成骨架屏，这次推广到全站。
 *
 * ⚠️ 设计原则（2026-10-08 站长反馈「骨架跟真实排版别差太多」后重做）：
 *   骨架屏的价值在于**结构对得上真实内容** —— 表头在哪、几列、头像多大、卡片
 *   多高，都要和真数据一致，数据到位时才是「原地填充」而不是「整块换掉」。
 *   所以这里尽量**复用真实排版用的组件**（Table/Card 那几件套）来搭骨架，
 *   这样 padding、边框、圆角、行高天然一致，不靠手工对齐数值。
 *
 * 分成两层：
 *   1. 页面级骨架（下面前几个）—— 给内容结构明确的重点页面用，逐个照抄真实排版；
 *   2. 通用形状（list / table / cards / form）—— 给长尾页面兜底，形状接近即可。
 */

/** 骨架条：统一走 bg-muted，宽高用 tailwind class 控制 */
function Bar({ className }: { className?: string }) {
  return <Skeleton className={cn("h-3.5", className)} />
}

/* ------------------------------------------------------------------ *
 * 一、页面级骨架（照真实排版搭）
 * ------------------------------------------------------------------ */

/**
 * 管理面板「用户」列表。
 *
 * 照 admin.tsx 里真实的表头来。**默认 11 列**（UID / 用户名+邮箱 / 邀请码 /
 * 注册时间 / 5 个模块状态 / 角色状态 / 操作）；「注册 IP」列由页面上的开关控制，
 * 所以这里也跟着 `withRegisterIp` 增减一列 —— 列数对不上，数据到位时整张表会横向跳。
 *
 * 尺寸是照线上实测校准的（2026-10-08）：
 *   · 真实表头高 41px、行高 65px（用户名两行文字撑起来的）；
 *   · 宽度上 UID 约 64、用户名约 186、五个模块列仅 36~66px（真身是图标/小徽章，
 *     不是文字），操作列吃掉剩余宽度。
 *   骨架的每个格子都按真身尺寸给（两行用 h-5/h-4 对上 text-sm/text-xs 的行高），
 *   这样行高与列宽自然会落在同一个量级，不靠猜。
 */
export function AdminUsersSkeleton({
  rows = 12,
  withRegisterIp = false,
}: {
  rows?: number
  /** 与页面上「注册 IP」列的开关保持一致（开启时多一列） */
  withRegisterIp?: boolean
}) {
  const moduleCols = 5
  return (
    <div className="rounded-lg border bg-card">
      <Table wrapperClassName="overflow-x-auto lg:overflow-clip">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky top-[56px] z-10 w-16 border-b bg-card">
              <Bar className="h-4 w-10" />
            </TableHead>
            <TableHead className="sticky top-[56px] z-10 border-b bg-card">
              <Bar className="h-4 w-[170px]" />
            </TableHead>
            <TableHead className="sticky top-[56px] z-10 border-b bg-card">
              <Bar className="h-4 w-12" />
            </TableHead>
            <TableHead className="sticky top-[56px] z-10 border-b bg-card">
              <Bar className="h-4 w-10" />
            </TableHead>
            {withRegisterIp && (
              <TableHead className="sticky top-[56px] z-10 border-b bg-card">
                <Bar className="h-4 w-14" />
              </TableHead>
            )}
            {/* 5 个模块状态列：真身是一列小图标（很窄） */}
            {Array.from({ length: moduleCols }).map((_, i) => (
              <TableHead
                key={`mh${i}`}
                className="sticky top-[56px] z-10 border-b bg-card text-center"
              >
                <Bar className="mx-auto h-4 w-8" />
              </TableHead>
            ))}
            <TableHead className="sticky top-[56px] z-10 border-b bg-card">
              <Bar className="h-4 w-14" />
            </TableHead>
            <TableHead className="sticky top-[56px] z-10 w-24 border-b bg-card" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, r) => (
            <TableRow key={r}>
              {/* UID：等宽小字 */}
              <TableCell>
                <Bar className="h-4 w-9" />
              </TableCell>
              {/* 用户名 + 邮箱：真实结构固定 170px、两行（text-sm / text-xs） */}
              <TableCell>
                <div className="w-[170px] space-y-1">
                  <Bar className="h-5 w-24" />
                  <Bar className="h-4 w-36" />
                </div>
              </TableCell>
              {/* 邀请码 */}
              <TableCell>
                <Bar className="h-4 w-12" />
              </TableCell>
              {/* 注册时间 */}
              <TableCell>
                <Bar className="h-4 w-10" />
              </TableCell>
              {withRegisterIp && (
                <TableCell>
                  <Bar className="h-4 w-20" />
                </TableCell>
              )}
              {/* 模块状态：真身是居中的小图标 */}
              {Array.from({ length: moduleCols }).map((_, i) => (
                <TableCell key={i}>
                  <Skeleton className="mx-auto h-4 w-4 rounded-full" />
                </TableCell>
              ))}
              {/* 角色/状态：真身是一个 Badge */}
              <TableCell>
                <Skeleton className="h-5 w-12 rounded-full" />
              </TableCell>
              {/* 操作列（真实里这列吃掉剩余宽度，内容靠右） */}
              <TableCell>
                <Skeleton className="ml-auto h-7 w-16 rounded-md" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * 管理面板「邀请码」列表。
 * 真实表头 6 列：码 / 额度(已用/上限) / 创建者 / 创建时间 / 权限 / 操作。
 */
export function AdminInvitesSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {[0, 1, 2, 3, 4].map((i) => (
              <TableHead key={i}>
                <Bar className={i === 0 ? "w-24" : "w-16"} />
              </TableHead>
            ))}
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, r) => (
            <TableRow key={r}>
              {/* 邀请码：等宽字体，比一般字宽一点 */}
              <TableCell>
                <Bar className="h-3.5 w-28" />
              </TableCell>
              <TableCell>
                <Bar className="w-14" />
              </TableCell>
              <TableCell>
                <Bar className="w-20" />
              </TableCell>
              <TableCell>
                <Bar className="w-16" />
              </TableCell>
              {/* 权限：一排小徽章 */}
              <TableCell>
                <div className="flex gap-1.5">
                  <Skeleton className="h-5 w-10 rounded-full" />
                  <Skeleton className="h-5 w-10 rounded-full" />
                  <Skeleton className="h-5 w-12 rounded-full" />
                </div>
              </TableCell>
              <TableCell>
                <Bar className="ml-auto h-7 w-14 rounded-md" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * 社区广场的帖子流。
 *
 * 照 community.tsx 的 PostCard 搭：左侧一条强调色竖条 + 头像 + 昵称 + 分类徽章
 * + 正文两行 + 底部互动行（点赞/评论/分享/删除）。
 * 卡片总高度按「有正文无图」的常见情形给，别做成一行矮条 —— 那会和真实卡片差很远。
 */
export function CommunityFeedSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="relative overflow-hidden rounded-xl border bg-card p-4"
        >
          {/* 左侧强调色竖条 */}
          <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl bg-gradient-to-b from-primary/40 to-primary/10" />
          <div className="min-w-0 pl-2">
            {/* 作者行：头像 + 昵称 + 身份徽章 */}
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="flex min-w-0 items-center gap-1.5">
                <Bar className="w-20" />
                <Skeleton className="h-4 w-11 rounded-full" />
              </div>
            </div>
            {/* 分类徽章 */}
            <div className="mt-1.5">
              <Skeleton className="h-4 w-12 rounded-full" />
            </div>
            {/* 正文：2~3 行 */}
            <div className="mt-2.5 space-y-2">
              <Bar className="w-full" />
              <Bar className="w-[92%]" />
              {i % 2 === 0 && <Bar className="w-3/5" />}
            </div>
            {/* 互动行 */}
            <div className="mt-3 flex items-center gap-4">
              <Bar className="h-3.5 w-10" />
              <Bar className="h-3.5 w-10" />
              <Bar className="h-3.5 w-10" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 网盘（storage）主页。
 * 照真实排版：一张 Card —— 头部（图标 + 标题 + 描述，右侧两个按钮）+ 进度条 + 一行说明。
 */
export function StorageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card">
        {/* CardHeader：左标题右按钮 */}
        <div className="flex items-start justify-between gap-4 p-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded" />
              <Bar className="w-24" />
            </div>
            <Bar className="h-3 w-52" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </div>
        <div className="px-6 pb-6">
          {/* 容量进度条 */}
          <Skeleton className="h-2 w-full rounded-full" />
          <Bar className="mt-2 h-3 w-40" />
        </div>
      </div>
      {/* 下方文件列表卡片 */}
      <div className="rounded-xl border bg-card">
        <div className="border-b p-4">
          <Bar className="w-28" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Bar className="w-2/5" />
                <Bar className="h-3 w-24" />
              </div>
              <Bar className="h-3 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 卡片型功能页（AI 中转站 / 代理 / 内网穿透等）。
 * 真实排版是「一张 Card 包一组条目」，每条：图标 + 标题 + 两行说明 + 右侧状态/按钮。
 */
export function FeatureCardsSkeleton({ cards = 2, rows = 3 }: { cards?: number; rows?: number }) {
  return (
    <div className="space-y-6">
      {Array.from({ length: cards }).map((_, c) => (
        <div key={c} className="rounded-xl border bg-card">
          <div className="flex items-start justify-between gap-4 p-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4 rounded" />
                <Bar className="w-24" />
              </div>
              <Bar className="h-3 w-48" />
            </div>
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="space-y-3 px-6 pb-6">
            {Array.from({ length: rows }).map((_, r) => (
              <div
                key={r}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Bar className="w-1/3" />
                  <Bar className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-7 w-16 shrink-0 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 域名（domains）列表：右侧「解析列表」那几行。
 * 真实排版：每行 记录类型徽章 + 主机记录 + 目标值 + 右侧操作按钮。
 */
export function DomainRecordsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <Skeleton className="h-5 w-12 shrink-0 rounded-full" />
          <Bar className="w-24" />
          <Bar className="min-w-0 flex-1" />
          <Skeleton className="h-7 w-7 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 二、通用形状（长尾页面兜底）
 * ------------------------------------------------------------------ */

/** 列表：头像/图标方块 + 两行文字。适合「一条条记录」的列表页。 */
export function SkeletonList({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <Skeleton className="h-10 w-10 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Bar className="w-1/3" />
            <Bar className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 通用表格。**优先用上面那几个页面级表格骨架**（列宽才对得上）；
 * 这个只给「列结构不确定 / 长尾」的页面兜底。
 */
export function SkeletonTable({
  rows = 6,
  cols = 5,
  className,
}: {
  rows?: number
  cols?: number
  className?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <div className="flex items-center gap-4 border-b bg-muted/40 px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Bar key={i} className="flex-1" />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3.5">
            {Array.from({ length: cols }).map((_, c) => (
              <Bar key={c} className="flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 卡片网格：适合「一格一卡片」的版面 */
export function SkeletonCards({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
            <Bar className="w-1/3" />
          </div>
          <Bar className="w-full" />
          <Bar className="w-4/5" />
        </div>
      ))}
    </div>
  )
}

/** 表单：若干「标签 + 输入框」 */
export function SkeletonForm({ fields = 4, className }: { fields?: number; className?: string }) {
  return (
    <div className={cn("space-y-5", className)}>
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      ))}
    </div>
  )
}

/** `LoadingBlock` 支持的形状 */
export type SkeletonVariant = "list" | "table" | "cards" | "form"

/**
 * 按形状取骨架屏（`LoadingBlock` 的默认入口）。
 * 注意：内容结构明确的页面建议**直接用上面那些页面级骨架**，
 * 比这里按形状取更贴合真实排版。
 */
export function LoadingSkeleton({
  variant = "list",
  className,
}: {
  variant?: SkeletonVariant
  className?: string
}) {
  switch (variant) {
    case "table":
      return <SkeletonTable className={className} />
    case "cards":
      return <SkeletonCards className={className} />
    case "form":
      return <SkeletonForm className={className} />
    default:
      return <SkeletonList className={className} />
  }
}
