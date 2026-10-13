import { useLocation } from "react-router-dom"
import { FlaskConical, Gamepad2, LayoutGrid, Settings2 } from "lucide-react"

import { NavLinkItem } from "@/components/sub-nav"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"

/**
 * 造物集 / 造物典藏共用的左侧二级导航。
 *
 * 四项：
 *   展示大厅   `/dashboard/gallery`
 *   我的造物集 `/dashboard/gallery?view=mine`
 *   造物典藏   `/dashboard/gallery/collection`（游戏大厅）
 *   典藏设置   `/dashboard/gallery/collection/settings`（仅管理员）
 *
 * ⚠️ 这里**全部是链接**（不是按钮切 state）：造物典藏与典藏设置是独立页面，
 *    而展示大厅 / 我的造物集用 `?view=` 表达。统一走 URL 之后：
 *      · 高亮逻辑只有一份（按 location 判断），不会出现「两个都亮」；
 *      · 刷新、分享、浏览器前进后退都正常工作。
 *
 * ⚠️ 「典藏设置」的显示条件只是**前端收敛入口**，真正的裁决在服务端
 *    （`requireAdminScope(env, request, "collection")`）。没权限的人手敲 URL
 *    也要被接口挡掉 —— 所以这个组件不承担任何安全职责。
 */
export function CollectionAside() {
  const { t } = useT()
  const { user } = useAuth()
  const location = useLocation()
  const canManage = isAdminRole(user?.role)

  const path = location.pathname.replace(/\/+$/, "") || "/"
  const isMine = new URLSearchParams(location.search).get("view") === "mine"
  const inCollection = path === "/dashboard/gallery/collection"
  const inSettings = path === "/dashboard/gallery/collection/settings"

  return (
    <aside className="w-full shrink-0 lg:w-48">
      <nav className="flex flex-col gap-0.5">
        <NavLinkItem
          to="/dashboard/gallery"
          active={path === "/dashboard/gallery" && !isMine}
          icon={LayoutGrid}
          label={t("gal.tab.hall")}
        />
        <NavLinkItem
          to="/dashboard/gallery?view=mine"
          active={path === "/dashboard/gallery" && isMine}
          icon={FlaskConical}
          label={t("gal.tab.mine")}
        />
        {/* 造物典藏：游戏大厅。进入某个游戏后仍高亮它（路径前缀匹配） */}
        <NavLinkItem
          to="/dashboard/gallery/collection"
          active={(inCollection || path.startsWith("/dashboard/gallery/collection/")) && !inSettings}
          icon={Gamepad2}
          label={t("col.tab.hall")}
        />
        {canManage && (
          <NavLinkItem
            to="/dashboard/gallery/collection/settings"
            active={inSettings}
            icon={Settings2}
            label={t("col.tab.settings")}
          />
        )}
      </nav>
    </aside>
  )
}

/** 是不是「管理端」角色。与 dashboard-layout 里的判断同口径（那里也这么做） */
export function isAdminRole(role: string | undefined | null): boolean {
  return role === "admin" || role === "superadmin" || role === "root"
}
