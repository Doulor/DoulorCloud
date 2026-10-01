/**
 * 「API Key 分组」相关的小组件（捐献模型独立分组的配套 UI）。
 *
 * 为什么单独一个文件而不是写在 ai.tsx 里：`ai.tsx` 是一万行级的大文件，
 * 同时也是**多个会话并发编辑**的热点（i18n 改版等）。把这块 UI 抽出来之后，
 * ai.tsx 只需要插几行引用，被覆盖重做时成本很低。
 *
 * 背景：2026-10-01 起捐献渠道被移到独立的 NewAPI 分组（设置项
 * `newapi_donation_group`，默认 `donation`），于是：
 *   · 站点分组（default）的 Key **调不到**捐献模型；
 *   · 想要捐献模型，必须**另建一个选了捐献分组的 Key**。
 * 这三个组件就是让用户能选分组、能看出每个 Key 属于哪一组。
 */
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { useT, tStatic } from "@/i18n"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** 建 Key 时可选的某一个分组在 UI 上的名字 */
function groupLabel(g: string, donationGroup: string, first: string): string {
  if (g === donationGroup) return tStatic("kg.groupDonation", { group: g })
  if (g === first) return tStatic("kg.groupDefault", { group: g })
  return g
}

/**
 * 新建 Key 时的分组选择器 + 随分组变化的说明。
 *
 * `value` 为空串表示「用服务端给的默认（列表第一项）」，与后端 `createKey`
 * 的语义一致（不传 group ⇒ 用站点分组）。
 */
export function KeyGroupPicker({
  keyGroups,
  donationGroup,
  value,
  onChange,
}: {
  /** 可选分组（服务端下发，顺序即顺序，第一项是默认） */
  keyGroups: string[]
  donationGroup: string
  /** 当前选中；空串 = 默认 */
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useT()
  const first = keyGroups[0] ?? ""
  const current = value || first
  return (
    <>
      <div className="space-y-2">
        <Label>{t("ai.key.group")}</Label>
        <Select value={current} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {keyGroups.map((g) => (
              <SelectItem key={g} value={g}>
                {groupLabel(g, donationGroup, first)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
        {current === donationGroup ? (
          <>
            {t("kg.donationNote.a", { group: donationGroup })}
            <span className="font-medium text-foreground">{t("kg.donationModel")}</span>
            {t("kg.donationNote.b")}
            <code className="font-mono">donation-</code>
            {t("kg.donationNote.c")}
          </>
        ) : (
          <>
            {t("kg.freeNote.a")}
            <span className="font-medium text-foreground">{t("kg.donationModel")}</span>
            {t("kg.freeNote.b")}
            <span className="font-medium text-foreground">{donationGroup}</span>
            {t("kg.freeNote.c")}
          </>
        )}
      </div>
    </>
  )
}

/** Key 列表里的「分组」单元格：一眼看出这个 Key 能不能调捐献模型 */
export function KeyGroupCell({
  group,
  donationGroup,
}: {
  group: string | null | undefined
  donationGroup: string
}) {
  const { t } = useT()
  if (!group) return <span className="text-xs text-muted-foreground">—</span>
  if (group === donationGroup) return <Badge variant="secondary">{t("kg.donationModel")}</Badge>
  return <Badge variant="outline">{group}</Badge>
}

/** 「全部可用模型」里捐献分组标题旁的那句提示 */
export function KeyGroupNote({ donationGroup }: { donationGroup: string }) {
  const { t } = useT()
  return (
    <span className="text-xs text-muted-foreground">
      {t("kg.footerNote", { group: donationGroup })}
    </span>
  )
}
