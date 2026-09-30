/**
 * 消息已读状态的跨组件同步。
 *
 * 为什么需要：顶栏铃铛（MessageBell）与消息中心页（MessagesPage）是两个
 * 互不相关的组件，各自持有独立的未读数 state。用户在消息中心点「已读」后，
 * 服务端已经更新，但铃铛只能等下一次轮询（最长 60 秒）才会消失 ——
 * 表现为「我明明读过了，红点还挂着」。
 *
 * 用一个 window 事件把「消息状态变了」广播出去，铃铛收到后立即重拉。
 * 不引入 Context：这条链路只有「消息页 → 铃铛」一个方向，事件足够且更轻。
 */
const EVENT = "doulor:messages-changed"

/** 消息已读状态发生变化时调用（消息中心页在用） */
export function notifyMessagesChanged(): void {
  window.dispatchEvent(new Event(EVENT))
}

/** 订阅消息状态变化；返回取消订阅函数 */
export function onMessagesChanged(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
