/**
 * 把 `?next=` 参数收敛成一个安全的站内路径。
 *
 * ⚠️ 为什么必须校验：`?next=` 是**开放重定向**的经典入口。
 * 如果不加校验就直接 `navigate(next)`，攻击者可以构造
 *   https://cloud.doulor.cn/login?next=https://evil.com
 * 让用户在一个看起来完全正常的本站域名上点登录，
 * 登录成功后被送到钓鱼站 —— 用户很难察觉（域名是真的、登录是真的）。
 *
 * 判据：只接受**以单个 `/` 开头的站内绝对路径**。
 * 具体拒绝：
 *   - `//evil.com`      协议相对 URL（浏览器会当成 https://evil.com）
 *   - `/\evil.com`      部分浏览器把反斜杠等价成正斜杠
 *   - `https://evil.com`、`javascript:...` 等带 scheme 的
 *   - `/\t/evil.com`    以 Tab/换行开头绕过前缀检查的变体
 */

/** 控制字符（Tab / 换行 / 回车等）在 URL 解析中会被吃掉，必须先剔除再判断 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null

  const cleaned = raw.replace(CONTROL_CHARS, "")
  if (!cleaned) return null

  // 必须是站内绝对路径
  if (!cleaned.startsWith("/")) return null
  // 协议相对：//evil.com
  if (cleaned.startsWith("//")) return null
  // 反斜杠变体：/\evil.com
  if (cleaned.startsWith("/\\")) return null

  // 兜底：解析后若跑到了别的源，一律拒绝
  try {
    const base = "https://placeholder.invalid"
    const url = new URL(cleaned, base)
    if (url.origin !== base) return null
    return url.pathname + url.search + url.hash
  } catch {
    return null
  }
}
