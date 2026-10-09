/**
 * 自动签到判定内核的断言脚本（真实可跑的验收，不是「自写自检」）。
 *
 * 运行：node scripts/check-auto-checkin.mjs
 * 被覆盖的纯函数：src/lib/auto-checkin.ts（Node 24 原生剥离类型，直接 import .ts）。
 *
 * 重点回归「自动签到不生效」这个 bug：
 *   修复前守卫是 `sessionStorage["auto-checkin-ran"] = "1"`（不含日期）。
 *   只要它在（页面开着过夜 / 开关是本次会话中途打开的），本次检查就什么都不做 ——
 *   第二天照旧跳过。下面第 6 条用例正是「标记是昨天的」场景，旧实现会 skip，
 *   新实现必须 checkin。
 */
import assert from "node:assert/strict"
import {
  decideAutoCheckin,
  shouldMarkAfterAttempt,
  shouldSignInOnEnable,
} from "../src/lib/auto-checkin.ts"

const base = { enabled: true, today: "2026-10-10", checkedIn: false, autoCheckin: true }

const cases = [
  {
    name: "功能总开关关闭 → skip（且不写标记，便于开启后立即生效）",
    status: { ...base, enabled: false },
    storedDay: null,
    expect: "skip",
  },
  {
    name: "用户没开自动签到 → skip",
    status: { ...base, autoCheckin: false },
    storedDay: null,
    expect: "skip",
  },
  {
    name: "开了自动签到、今天没签、无标记 → checkin",
    status: base,
    storedDay: null,
    expect: "checkin",
  },
  {
    name: "今天已经处理过（标记=今天）→ done，不再打接口",
    status: base,
    storedDay: "2026-10-10",
    expect: "done",
  },
  {
    name: "今天已经签过（手动或更早的自动）→ done",
    status: { ...base, checkedIn: true },
    storedDay: null,
    expect: "done",
  },
  {
    name: "【核心回归】标记停留在昨天（页面开着过夜 / 会话残留）→ 必须 checkin",
    status: base,
    storedDay: "2026-10-09",
    expect: "checkin",
  },
  {
    name: "服务端未返回 today（过渡期）→ 退化为按 checkedIn 判定",
    status: { ...base, today: "" },
    storedDay: null,
    expect: "checkin",
  },
  {
    name: "服务端未返回 today 且今天已签 → done",
    status: { ...base, today: "", checkedIn: true },
    storedDay: null,
    expect: "done",
  },
]

for (const c of cases) {
  const got = decideAutoCheckin(c.status, c.storedDay).kind
  assert.equal(got, c.expect, `用例失败：${c.name}｜期望 ${c.expect}，实际 ${got}`)
  console.log(`  ✓ ${c.name}`)
}

// 「失败不写标记」这条不变式
assert.equal(shouldMarkAfterAttempt("success"), true, "签到成功必须写标记")
assert.equal(shouldMarkAfterAttempt("already"), true, "别处已签也必须写标记")
assert.equal(shouldMarkAfterAttempt("error"), false, "失败必须不写标记（留待重试）")
console.log("  ✓ 只有成功/已签才写「今天已处理」标记，失败不写")

// 「打开开关即刻补签」这条交互不变式
assert.equal(shouldSignInOnEnable(true, { checkedIn: false }), true, "开启且今天没签 → 立刻补签")
assert.equal(shouldSignInOnEnable(true, { checkedIn: true }), false, "开启但今天已签 → 不再补签")
assert.equal(shouldSignInOnEnable(false, { checkedIn: false }), false, "关闭开关 → 不补签")
assert.equal(shouldSignInOnEnable(true, null), false, "状态未知 → 不补签")
console.log("  ✓ 打开自动签到开关时：仅「今天还没签」才立刻补签一次")

console.log("\ncheck-auto-checkin: 全部通过")
