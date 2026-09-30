/**
 * 通用异步小工具。
 */

/**
 * 有并发上限的 map。
 *
 * 用于「逐个真实调用外部地址」的场景（AI 渠道逐模型测试、代理订阅逐个校验）：
 * 串行太慢，全并发又会打爆对方，所以限定窗口大小。
 *
 * 保持输入顺序返回结果（`out[i]` 按下标写），方便调用方按下标对应回去。
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  )
  return out
}

/**
 * 带超时的 fetch（2026-09-25 审计 H15）。
 *
 * 为什么必须有：Cloudflare Workers 的 `fetch` **默认没有超时**。
 * 上游只要保持连接不返回（半开连接、慢速攻击、卡死的服务商 API），
 * 这个 Worker 请求就会一直挂到平台层的 wall-clock 上限（免费计划 CPU 之外
 * 还有整体请求时长限制），期间占住一个并发位。多个请求同时挂住 = 全站变慢。
 * 全仓此前有 5 处裸 `fetch()` 都属这类（cloudflare.ts / newapi-client.ts /
 * custom-domain.ts / r2-admin.ts）。
 *
 * 注意：超时抛出的错误与网络错误一样是 `AbortError`/`TypeError`，
 * 调用方原有的 try/catch 与错误映射逻辑无需改动。
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
