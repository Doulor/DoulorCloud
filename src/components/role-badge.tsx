import { useT } from "@/i18n"
/**
 * 角色徽章：超级管理员紫色、管理员金色、站长（root）红色，均带两种流光——
 *   1. 文字上的扫光（role-sheen / role-sheen-strong，内层 ::after）；
 *   2. 四周描边的循环流光（role-ring / role-ring-super / role-ring-strong）。
 * 站长流光最浓最快；超级管理员与管理员速度一致，仅配色不同。
 *
 * 不用 Badge 组件——需要分层可控，自定义 span 更稳。社区广场、个人空间、
 * 头像悬浮卡片共用这一份，避免三处各写一遍、样式漂移。
 */
export function RoleBadge({ role }: { role: "admin" | "superadmin" | "root" }) {
  const { t } = useT()
  const root = role === "root"
  const superadmin = role === "superadmin"

  const ring = root ? "role-ring-strong" : superadmin ? "role-ring-super" : "role-ring"
  const fill = root
    ? "role-sheen-strong bg-gradient-to-r from-red-600 to-rose-600 text-white"
    : superadmin
      ? "role-sheen bg-gradient-to-r from-violet-500 to-purple-600 text-white"
      : "role-sheen bg-gradient-to-r from-amber-400 to-yellow-500 text-amber-950"
  const label = root ? t("au.role.root") : superadmin ? t("au.role.superadmin") : t("au.role.admin")

  return (
    <span className={"inline-flex h-5 shrink-0 items-center rounded-md p-[1.5px] " + ring}>
      <span className={"inline-flex h-full items-center rounded-[5px] px-1.5 text-[10px] font-semibold leading-none " + fill}>
        {label}
      </span>
    </span>
  )
}
