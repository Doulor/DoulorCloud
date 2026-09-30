/**
 * 「待办角标」的跨组件同步。
 *
 * 为什么需要：角标数据（`/api/attention`）由侧边栏与管理面板各自持有 state，
 * 靠 60 秒轮询兜底。管理员在某个栏目里处理掉一条待办后，**只有自己那一份 state
 * 知道**，侧边栏的角标要等下一轮轮询才减 —— 表现为「我明明处理了，角标还挂着」。
 *
 * 处理动作分散在好几个组件里（活动发放、捐献审核在 admin.tsx；反馈在
 * admin-feedback.tsx；积分商品/订单在 admin-points.tsx），所以用 window 事件
 * 单向广播，谁处理完谁喊一声，各处收到后立即重拉，不必互相 import。
 *
 * 与 `message-events.ts` 同一套做法（那条链路解决的是「铃铛红点不消失」）。
 */
const EVENT = "doulor:attention-changed"

/** 处理完一条待办后调用 —— 让所有角标立即重算，而不是等 60 秒轮询 */
export function notifyAttentionChanged(): void {
  window.dispatchEvent(new Event(EVENT))
}

/** 订阅角标变化；返回取消订阅函数 */
export function onAttentionChanged(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
