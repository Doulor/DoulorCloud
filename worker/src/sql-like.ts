/**
 * `LIKE` 模式的安全构造。
 *
 * ⚠️ **D1 的 SQLite 把 `LIKE` / `GLOB` 模式长度限制在 50 字符。**
 * 超过不是「匹配不到」而是**直接报错**：
 *
 *     LIKE or GLOB pattern too complex: SQLITE_ERROR [code: 7500]
 *
 * 实测（2026-09-30，线上 d1 execute）：模式 50 字符通过，
 * **51 字符即报错**。`SQLITE_MAX_LIKE_PATTERN_LENGTH` 在标准 SQLite 里默认 50000，
 * D1 明显下调过，所以「模式长一点没关系」这个直觉在这里是错的。
 *
 * 后果一律是**未捕获的 500**（`服务器内部错误`）——调用方通常只写了一句
 * `env.DB.prepare(...).bind(\`%${用户输入}%\`)`，没有任何地方提示「输入不能太长」。
 * 已经踩到两次：
 *   · 捐献的「同一上游是否已提交过」用 `payload LIKE '%"baseUrl":"<地址>"%'`，
 *     固定前缀 15 字符 ⇒ **地址超过 35 字符就必炸**（详见 donations.ts 的
 *     `hasDuplicateUpstream` 注释；当时表现为「自定义 AI 渠道捐献报服务器内部错误」）。
 *   · 管理端搜索框直接拼 `%${query}%`，长邮箱/长用户名搜索会 500。
 *
 * 因此：**凡是用户输入要进 LIKE 的，一律经过这里**；能用等值/JSON 精确比对的
 * 就别用 LIKE（精确比对既没有长度限制，也没有 `%` / `_` 通配符误判的问题）。
 */
/** D1 实际允许的 LIKE 模式最大长度（实测边界：50 通过、51 失败） */
export const LIKE_PATTERN_MAX = 50

/**
 * 把用户输入截到「两侧各留一个 `%` 之后仍不超上限」的长度。
 * 取 40（而非刚好 48）是留余量：万一以后 D1 再调低上限，也不至于立刻全站 500。
 */
const TERM_MAX = 40

/** `%term%` —— 「包含」搜索 */
export function likeContains(term: string): string {
  return `%${term.slice(0, TERM_MAX)}%`
}

/** `term%` —— 「前缀」搜索 */
export function likeStartsWith(term: string): string {
  return `${term.slice(0, TERM_MAX)}%`
}
