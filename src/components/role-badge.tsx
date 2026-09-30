/**
 * 角色徽章：管理员金色、站长（root）红色，均带两种流光——
 *   1. 文字上的扫光（role-sheen / role-sheen-strong，内层 ::after）；
 *   2. 四周描边的循环流光（role-ring / role-ring-strong，外层 conic 光带，白色光斑）。
 * 站长两种流光都比管理员更浓更快。
 *
 * 不用 Badge 组件——需要分层可控，自定义 span 更稳。社区广场、个人空间、
 * 头像悬浮卡片共用这一份，避免三处各写一遍、样式漂移。
 */
export function RoleBadge({ role }: { role: "admin" | "root" }) {
  const root = role === "root"
  return (
    <span
      className={
        "inline-flex h-5 shrink-0 items-center rounded-md p-[1.5px] " +
        (root ? "role-ring-strong" : "role-ring")
      }
    >
      <span
        className={
          "inline-flex h-full items-center rounded-[5px] px-1.5 text-[10px] font-semibold leading-none " +
          (root
            ? "role-sheen-strong bg-gradient-to-r from-red-600 to-rose-600 text-white"
            : "role-sheen bg-gradient-to-r from-amber-400 to-yellow-500 text-amber-950")
        }
      >
        {root ? "站长" : "管理员"}
      </span>
    </span>
  )
}
