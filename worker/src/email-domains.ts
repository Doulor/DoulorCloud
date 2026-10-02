/**
 * 注册邮箱白名单（设置项 `register_email_domains`）的解析与归一化。
 *
 * 值与语义：
 *   · 逗号分隔的域名列表，**留空 = 不限制**（这是合法值，不是「没配」）；
 *   · 匹配的是 `@` 之后的**完整域名**（小写），不做子域通配 ——
 *     写了 `qq.com` 不会放过 `mail.qq.com`，要放子域就把子域自己也写进去。
 *
 * 为什么要单独抽一个文件：这一份值有**两个**消费点，且必须同口径 ——
 *   · 写入侧 `handlers/admin.ts`（管理员在面板的多行输入框里提交）
 *   · 读取侧 `handlers/auth.ts`（注册时判定这个域名允不允许）
 * 原先两边各写了一份 `split(",")`。只要有一处分家，症状就是
 * 「面板里明明配了，注册却全被拒」—— 很难查，因为两处单看都「没错」。
 *
 * 分隔符刻意收得宽：后台那个控件是 3 行的 **Textarea**，管理员最自然的写法就是
 * 「一行一个域名」。若只按逗号切，整段会变成**一个**条目，于是白名单里每个域名
 * 都匹配不上（实测：换行分隔时 100% 注册失败），且报错文案会把一串换行原样吐给
 * 用户看。故逗号 / 分号 / 各种空白（含换行、制表符、全角空格）都当分隔符，
 * 中英文标点都认；顺手洗掉常见手滑写法（顺手带上的 `@`、大小写）。
 */

/** 分隔符：中英文逗号 / 分号，以及所有空白（`\s` 含换行、制表符、全角空格 U+3000） */
const SEPARATORS = /[\s,;，；、]+/

/**
 * 解析成域名数组（已去空白、转小写、去掉多余的 `@`、去重）。
 * 留空 → 返回空数组，调用方据此判定「不限制」。
 */
export function parseEmailDomains(raw: string | null | undefined): string[] {
  const parts = (raw ?? "")
    .split(SEPARATORS)
    .map((d) => d.trim().toLowerCase().replace(/^@+/, ""))
    .filter(Boolean)
  return [...new Set(parts)]
}

/** 归一化成存储形态（纯逗号分隔，无空格）。留空依旧是空串。 */
export function normalizeEmailDomains(raw: string | null | undefined): string {
  return parseEmailDomains(raw).join(",")
}
