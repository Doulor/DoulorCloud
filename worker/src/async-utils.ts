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
