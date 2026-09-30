/**
 * 「有趣的网页分享」的分类。
 *
 * 库里存的是短键（`aesthetic` / `tool` / `ent`），中文只出现在界面上。
 * ⚠️ **加分类要同步改后端 `worker/src/handlers/fun-links.ts` 的 `CATEGORIES`**——
 * 两边是独立的 TS 工程，共享不了常量，只能各自维护一份。
 */
export const FUN_LINK_CATEGORIES = [
  { id: "aesthetic", label: "唯美" },
  { id: "tool", label: "工具" },
  { id: "ent", label: "娱乐" },
] as const

export type FunLinkCategory = (typeof FUN_LINK_CATEGORIES)[number]["id"]

/** 认不出来的值（历史脏数据 / 后端加了新分类而前端还没更新）原样显示，不藏内容 */
export function funLinkCategoryLabel(id: string): string {
  return FUN_LINK_CATEGORIES.find((c) => c.id === id)?.label ?? id
}
