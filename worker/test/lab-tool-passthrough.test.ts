// AI 实验室 /lab/chat 的「原生工具调用消息必须原样放行」回归测试。
//
// 🔴 2026-10-12 事故（站长反馈「模型明明写了文件却觉得自己没写、反复重写」的
// 真凶之一）：旧版 sanitizeMessages 只认 system/user/assistant，
//   · `role:"tool"` 的回执消息被**静默丢弃**；
//   · assistant 的 `tool_calls` 字段被剥掉（只保留 role+content）。
// ⇒ 上游收到「悬空 tool_calls」——有的渠道直接报错，glm-5.3 的表现是
//   下一轮表现得像从没写过文件。这套测试锁死以下行为：
//   1. tool 消息通过且 tool_call_id 保留；
//   2. assistant.tool_calls 通过（id/name/arguments）；
//   3. 裁剪（MAX_MESSAGES / 超总量）后开头不残留孤儿 tool 消息；
//   4. 非法 tool_calls 项（缺 id/name）被剔除但合法的保留；
//   5. 原有行为不回归：图片只许出现在 user、system 只留最后一条。
import { describe, it, expect } from "vitest"
import { sanitizeMessages } from "../src/handlers/lab"

const toolMsg = { role: "tool", content: "[写入 index.html 成功]", tool_call_id: "call_1" }
const assistantWithCalls = {
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "write", arguments: '{"path":"index.html","content":"<h1>hi</h1>"}' },
    },
  ],
}

describe("sanitizeMessages：原生工具调用放行", () => {
  it("tool 消息不丢、tool_call_id 保留", () => {
    const out = sanitizeMessages([
      { role: "user", content: "建个页面" },
      assistantWithCalls,
      toolMsg,
      { role: "user", content: "继续" },
    ])
    const tools = out.filter((m) => m.role === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0].tool_call_id).toBe("call_1")
    expect(tools[0].content).toContain("index.html")
  })

  it("assistant.tool_calls 原样通过（id/name/arguments）", () => {
    const out = sanitizeMessages([
      { role: "user", content: "建个页面" },
      assistantWithCalls,
      toolMsg,
      { role: "user", content: "继续" },
    ])
    const a = out.find((m) => m.role === "assistant")
    expect(a?.tool_calls).toHaveLength(1)
    expect(a?.tool_calls?.[0].id).toBe("call_1")
    expect(a?.tool_calls?.[0].function.name).toBe("write")
    expect(a?.tool_calls?.[0].function.arguments).toContain("index.html")
  })

  it("缺 id / name 的非法 tool_calls 项被剔除，合法的保留", () => {
    const bad = {
      role: "assistant",
      content: "",
      tool_calls: [
        { function: { name: "write", arguments: "{}" } }, // 缺 id
        {
          id: "call_2",
          type: "function",
          function: { arguments: "{}" }, // 缺 name
        },
        {
          id: "call_3",
          type: "function",
          function: { name: "read", arguments: '{"path":"a.txt"}' },
        },
      ],
    }
    const out = sanitizeMessages([
      { role: "user", content: "干" },
      bad,
      { role: "tool", content: "ok", tool_call_id: "call_3" },
      { role: "user", content: "完事" },
    ])
    const a = out.find((m) => m.role === "assistant")
    expect(a?.tool_calls).toHaveLength(1)
    expect(a?.tool_calls?.[0].id).toBe("call_3")
  })

  it("超量裁剪后开头不残留孤儿 tool 消息（重锚）", () => {
    // 造 61 条消息（超过 MAX_MESSAGES=60），把 tool 消息排在最前
    const msgs: unknown[] = [toolMsg]
    for (let i = 0; i < 61; i++) {
      msgs.push({ role: "user", content: "x".repeat(100) })
    }
    const out = sanitizeMessages(msgs)
    expect(out.length).toBeLessThanOrEqual(60)
    // 开头绝不能是 tool（它的 assistant 已经被裁掉了）
    expect(out[0].role).not.toBe("tool")
  })

  it("原有行为不回归：system 只留最后一条", () => {
    const out = sanitizeMessages([
      { role: "system", content: "旧系统提示" },
      { role: "system", content: "新系统提示" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "你好" },
    ])
    expect(out[0].role).toBe("system")
    expect(out[0].content).toBe("新系统提示")
  })
})
