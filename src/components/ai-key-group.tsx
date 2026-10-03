/**
 * 「API Key 分组」相关的小组件（捐献模型独立分组的配套 UI），
 * 外加「全部可用模型」那张卡片的模型清单渲染。
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
import { ChevronRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  groupModelsBySection,
  MODALITY_AUDIO,
  MODALITY_IMAGE,
  MODALITY_VIDEO,
  OTHER_VENDOR,
  VENDOR_SPLIT_THRESHOLD,
} from "@/lib/model-vendor"
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

/** 单个模型名：点一下复制。复制的是原名，改名就调不通了 */
function ModelBadge({ model, onCopy }: { model: string; onCopy: (model: string) => void }) {
  const { t } = useT()
  return (
    <Badge
      variant="outline"
      className="cursor-pointer bg-background font-mono text-xs"
      onClick={() => onCopy(model)}
      title={t("ai.clickCopyModel")}
    >
      {model}
    </Badge>
  )
}

/** 模态小节与兜底小节的标题走 i18n；厂商小节直接显示官方品牌名 */
const SPECIAL_LABELS: Record<string, string> = {
  [MODALITY_AUDIO]: "ai.group.audio",
  [MODALITY_IMAGE]: "ai.group.image",
  [MODALITY_VIDEO]: "ai.group.video",
  [OTHER_VENDOR]: "ai.group.other",
}

/**
 * 「全部可用模型」里的模型清单。
 *
 * 默认分组十几个模型，平铺最好扫；捐献分组几百个，平铺就找不到东西了 ——
 * 所以只在超过 VENDOR_SPLIT_THRESHOLD 个模型时按厂商再切一层小节。
 * 厂商归类逻辑见 `@/lib/model-vendor`。
 *
 * 折叠用原生 `<details>`：不用 state，键盘、无障碍、触屏全是浏览器自带行为；
 * 默认全部收起 —— 捐献分组几百个模型，全展开要滚几十屏，先看厂商和数量、
 * 想找哪家再点开哪家。
 */
export function ModelVendorSections({
  models,
  onCopy,
}: {
  models: string[]
  onCopy: (model: string) => void
}) {
  const { t } = useT()

  if (models.length <= VENDOR_SPLIT_THRESHOLD) {
    return (
      <div className="flex flex-wrap gap-2">
        {models.map((m) => (
          <ModelBadge key={m} model={m} onCopy={onCopy} />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {groupModelsBySection(models).map(({ section, models: list }) => (
        <details key={section} className="group/section rounded-md border bg-muted/20">
          <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/section:rotate-90" />
            <span className="text-xs font-medium">
              {SPECIAL_LABELS[section] ? t(SPECIAL_LABELS[section]) : section}
            </span>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {t("ai.modelCount", { n: list.length })}
            </Badge>
          </summary>
          <div className="flex flex-wrap gap-2 px-2.5 pb-2.5">
            {list.map((m) => (
              <ModelBadge key={m} model={m} onCopy={onCopy} />
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}
