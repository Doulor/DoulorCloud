/**
 * 系统通知文案消毒（2026-11-10 渗透测试 finding#3）。
 *
 * 为什么单独抽一个模块：站内"系统通知"现在有**两条**投递通道，文案来源却都是
 * 外部可控的入站邮件：
 *   · 轮询：`GET /api/mailbox/latest-unread` → 前端 `showSystemNotification`（handlers/email.ts）
 *   · 推送：收信后 `pushToUser` → Service Worker `push` 事件（email-delivery.ts）
 * 两条必须用**同一套规则**，否则修了一条、另一条仍然是伪造入口（改这条注释时
 * 先看一遍 `public/sw.js` 里同规则的前端兜底）。
 *
 * 规则：
 *   1. 控制字符（换行/回车/制表）先**换成空格**再压缩 —— 通知只显示一行，
 *      直接删掉会把两行粘连成一个词（"安全\n提醒" → "安全提醒"），读起来更迷惑；
 *   2. 删零宽 / 双向控制符 —— 不可见，却能让文本"凭空多字"或反向显示；
 *   3. 删 `<` `>` —— 通知里不该出现标记，客户端若按 HTML 解析也成不了标签；
 *   4. 连续空白压成单空格并 trim；
 *   5. **最后**才截断：先截会把超长控制符留在结果里。
 */
export function sanitizeNotifyText(input: string, max: number): string {
  const cleaned = String(input ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.slice(0, Math.max(0, Math.trunc(max)))
}
