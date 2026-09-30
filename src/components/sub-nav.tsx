import * as React from "react"

/**
 * 二级子侧边栏的导航件。
 *
 * 抽出来是因为「管理面板」与「捐献页」用同一套交互：左侧一列导航切换右侧内容，
 * 高亮靠受控 state 而非 URL 路由（所以两处都不改路由，刷新回到默认项是可接受的）。
 *
 * 之前这两个组件内联在 admin.tsx 里（未 export），捐献页要复用只能复制一份 ——
 * 复制出来的两份迟早会漂移（改了一处的间距忘了另一处），故抽到此处共用。
 */

/** 侧边栏的单个导航项 */
export function NavItem({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  /**
   * 可选角标数（>0 才显示）—— 表示「这个栏目有待处理的事」。
   * 用实心深色而不是浅灰：它意味着需要管理员动手，不是「有新内容可看」。
   * （本站是黑白灰极简风，不用红色 —— 大红色与整体风格不搭。）
   */
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors " +
        (active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      {typeof count === "number" && count > 0 && (
        <span className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium leading-none tabular-nums text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  )
}

/** 侧边栏的分组（带小标题 + 分隔） */
export function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}
