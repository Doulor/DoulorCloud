/**
 * 「AI 实验室」专用 Key 的名字口径 —— 单独一个模块，避免 lab.ts ↔ newapi.ts 循环引用。
 *
 * 第一个是**规范名**（新用户自动建的就是它），后面的是历史遗留名：
 * 老版本叫「网页实验室」，2026-10-09 站长要求改成「AI实验室」，与页面显示名一致。
 *
 * ⚠️ 为什么要兼容老名字：库里已有几十个账号的 Key 就叫「网页实验室」。
 *    只改常量的话，这些用户一进实验室就会被当成「没有 Key」⇒ 再建一个新的，
 *    于是同一个人有两个实验室 Key，旧的那个还挂在那儿。
 *
 * ⚠️ 上游（NewAPI）里 token 的名字**不动**：`PUT /api/token/` 是整体覆盖，
 *    只想改个名字却传半个对象，会把分组等字段抹掉 —— 风险远大于收益。
 *    用户看到的是本站的 Key 列表，显示名由 `listKeys` 统一成规范名。
 *
 * ⚠️ 这个 Key 是**系统 Key**：网页端不给复制、不给删除。
 *    只藏按钮不够 —— 用户照样能直接调接口，所以 `removeKey` / `revealKey`
 *    在服务端也要拒绝（见 newapi.ts）。
 */
export const LAB_KEY_NAMES = ["AI实验室", "网页实验室"] as const

/** 规范名：新建 Key 用这个 */
export const LAB_KEY_NAME: string = LAB_KEY_NAMES[0]

/** 是否是「系统保留」的实验室 Key 名 */
export function isLabKeyName(name: unknown): boolean {
  return (
    typeof name === "string" && (LAB_KEY_NAMES as readonly string[]).includes(name)
  )
}
