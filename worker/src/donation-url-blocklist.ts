/**
 * 自定义 AI 渠道捐献的 **baseUrl 黑名单**（2026-10-10 站长要求）。
 *
 * ── 语义（站长原话：「要么跟我填的一模一样，要么在我的现有的结尾加」）──
 * 一条地址被判为「命中」只有两种可能：
 *   ① **一模一样** —— `https://token.sensenova.cn`
 *   ② **在后面接路径** —— `https://token.sensenova.cn/v1`、`.../`、`.../v1/chat`
 *
 * ⚠️ **不是**「谁以我为前缀就算」。接在后面的第一个字符必须是 `/`（路径）、
 * `:`（端口）、`?` / `#`，即**同一台服务器上的别的位置**才算命中。
 * 所以 `api.x.com` **不会**拦住 `api.x.company.com` —— 那是另一个域名，
 * 只是字母碰巧连着（`.com` 后面接着 `pany.com`）。这条边界是站长明确要的。
 *
 * 归一化（两边都做，否则「填了却拦不住」，属于**防绕过**而不是放宽语义）：
 *   · 去首尾空白；
 *   · 转小写 —— 域名本来就不分大小写，不折一下，把字母改大写就绕过去了；
 *   · 剥掉 `http://` / `https://` —— 同理，不加这条，把 https 改成 http 就绕过去了；
 *   · 去掉末尾的 `/`。
 * ⚠️ **不剥 `/v1`**（上一版剥了，属于自作聪明）：前缀匹配本来就覆盖它，
 * 剥掉反而会让「填 `.../v1` 只想拦那一个路径」变成拦整个域名。
 *
 * 存库时**保留站长输入的原样拼写**（只做去空白 / 拆条 / 去重），归一化只发生在比较时
 * —— 这样管理面板里看到的就是他自己填的那几行，不会被悄悄改写。
 *
 * ⚠️ 这一份必须**保存侧（handlers/admin.ts）与读取侧（handlers/donations.ts）共用**
 * （同 `email-domains.ts` 的教训）：两边分家就会出现「存进库了却一个都匹配不上」。
 *
 * 本模块**刻意不 import 任何东西**（`settings.ts` 要引它拿默认值，引别的大模块容易踩循环依赖）。
 */

/** 默认名单：站长点名的这个上游端点（内置的商汤捐献通道走自己的渠道，不受影响） */
export const DEFAULT_DONATION_URL_BLOCKLIST = "https://token.sensenova.cn"

/** 比较用归一化：小写 → 剥协议 → 去末尾斜杠（理由见文件头注释） */
function compareKey(raw: string): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
}

/**
 * 条目后面允许紧跟的边界字符（`/` 路径、`:` 端口、`?` 查询、`#` 锚点）。
 * 不是这几个，就说明命中的是**另一个域名**（`x.com` vs `x.company.com`），不算命中。
 */
const BOUNDARY = "/:?#"

/**
 * 归一化整份名单（**存库前调用**）：按换行 / 逗号 / 分号 / 空白拆条，去空白、去重
 * （去重按比较口径 —— 大小写与末尾斜杠不同视为同一条）。空串 = 不启用黑名单。
 * ⚠️ 输出保留原样拼写：管理面板回显的就是当初填的那几行。
 */
export function normalizeUrlBlocklist(raw: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of (raw ?? "").split(/[\s,;]+/)) {
    const entry = part.trim()
    if (!entry) continue
    const key = compareKey(entry)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out.join("\n")
}

/**
 * 待检地址是否命中黑名单。
 *
 * @param baseUrl   用户提交的上游地址（原样传入即可，内部做比较用归一化）
 * @param blocklist 库里的名单原文（`normalizeUrlBlocklist` 的产物或默认值）
 */
export function isUpstreamUrlBlocked(baseUrl: string, blocklist: string): boolean {
  const candidate = compareKey(baseUrl)
  if (!candidate) return false
  for (const part of (blocklist ?? "").split(/[\s,;]+/)) {
    const entry = compareKey(part)
    if (!entry || !candidate.startsWith(entry)) continue
    // ① 一模一样
    if (candidate.length === entry.length) return true
    // ② 在我填的后面**接路径 / 端口 / 查询**（`/v1`、`/`、`:8443`）
    //    —— 接别的字符（`.company.com` 里那个 `p`）那是另一个域名，不算
    if (BOUNDARY.includes(candidate[entry.length])) return true
  }
  return false
}

/** 给用户看的拒绝理由（前端直接展示） */
export const DONATION_URL_BLOCKED_MESSAGE =
  "该上游地址不在本站接受的捐献范围内，无法捐献。"
