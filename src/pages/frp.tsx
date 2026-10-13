import { FrpRentalPanel } from "@/components/frp-rental-panel"
import { PageHeader } from "@/components/page-header"
import { useT } from "@/i18n"

/**
 * 内网穿透（用户端）。
 *
 * 2026-10-13 之前，这一页是「填表申请 → 等管理员审核 → 管理员登 frps-panel 手工建号
 * → 回本站批准 → 收到邮件」的一整套人工流程，光这个文件就一千多行。
 *
 * 现在只剩一件事：**用积分租用**。
 * 下单即开通（服务器上的 agent 20 秒内同步），到期自动回收，全程自助。
 *
 * 退役这套流程的两个硬理由：
 *   1. 它要求管理员手工登 frps-panel 建号 —— 而那个面板的网页**本身已经是坏的**
 *      （gin-contrib/i18n 对空切片取 [0] 导致所有 HTML 路由 panic），根本打不开。
 *   2. 人工审核不可能规模化。
 *
 * 具体实现见 components/frp-rental-panel.tsx 与 docs/内网穿透租用化改造方案.md。
 */
export default function FrpPage() {
  const { t } = useT()

  return (
    <div>
      <PageHeader title={t("frp.title")} description={t("frp.tagline")} />
      <FrpRentalPanel />
    </div>
  )
}
