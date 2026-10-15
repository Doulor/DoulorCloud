#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
兼容性验收：**真实的 `frp-agent.py` 不做任何改动，能不能直接接管新面板？**

这是目标⑤「保留现有 agent 轮询作为可回退路径」的核心承诺。
做法：把真实的 frp-agent.py 当模块加载，只把 panel_base 指向新面板，
      然后把它自己的 diff_plan / apply_actions 跑起来，逐个验证动作类型。

覆盖：
  · panel_get_tokens() 能否读懂新面板的 /tokens 响应
  · ADD / ENABLE / DISABLE / PUPDATE / REMOVE 五种动作能否全部落地
  · 安全边界：面板里非 dcfrp_ 前缀的历史账号**绝不能**被 REMOVE

需要：新面板在 127.0.0.1:7210 跑着，且 config 里 user_prefix="dcfrp_"。
"""
import importlib.util
import json
import os
import sys
import urllib.request

AGENT_PATH = os.environ.get("FRP_AGENT_PATH", "/tmp/frpbench/frp-agent.py")
PANEL_BASE = "http://127.0.0.1:7210"
PANEL_DATA = "/tmp/frpbench/accounts.json"

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-52s 期望 %-24s 实际 %s" % ("✓" if ok else "✗", name, want, got))


# ---------------------------------------------------------------- 加载真实 agent
spec = importlib.util.spec_from_file_location("frp_agent", AGENT_PATH)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

# 只改指向新面板 + 关掉 dry_run；其它一律不动
agent.CONFIG["panel_base"] = PANEL_BASE
agent.CONFIG["user_prefix"] = "dcfrp_"
agent.CONFIG["dry_run"] = False
agent.CONFIG["timeout_seconds"] = 10

print("已加载真实 agent：%s" % AGENT_PATH)
print("agent 的 panel_base -> %s（dry_run=%s）" % (agent.CONFIG["panel_base"], agent.CONFIG["dry_run"]))
print("")


def reset_panel(accounts):
    """直接写面板的数据文件（面板会按 mtime 自动重载）。"""
    import time
    with open(PANEL_DATA, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "accounts": accounts}, fh, ensure_ascii=False, indent=2)
    time.sleep(0.6)


def panel_state():
    with open(PANEL_DATA, encoding="utf-8") as fh:
        return {a["user"]: a for a in json.load(fh)["accounts"]}


LEGACY = {
    "user": "some_legacy_user",          # 非 dcfrp_ 前缀 → 自动流程绝不能碰
    "token": "legacy-token",
    "comment": "历史人工账号",
    "enable": True,
    "ports": [22222],
    "domains": [""],
    "subdomains": [""],
    "expire_at": "",
}

print("=== 1. agent 能否读懂新面板的 /tokens ===")
reset_panel([LEGACY])
tokens = agent.panel_get_tokens()
check("panel_get_tokens() 返回非 None", tokens is not None, True)
check("读到 1 个账号", len(tokens or []), 1)
check("账号名解析正确", (tokens or [{}])[0].get("user"), "some_legacy_user")

print("")
print("=== 2. ADD：期望里有、面板里没有 ===")
reset_panel([LEGACY])
desired = [{"user": "dcfrp_aaa", "token": "tok-a", "comment": "DoulorCloud | active | 到期 2026-12-01",
            "enable": True, "ports": [31000, 31001]}]
actions = agent.diff_plan(desired, agent.panel_get_tokens())
check("规划出 ADD", [a[0] for a in actions], ["ADD"])
landed, errors = agent.apply_actions(actions)
check("无错误", errors, [])
state = panel_state()
check("账号已创建", "dcfrp_aaa" in state, True)
check("端口正确", state["dcfrp_aaa"]["ports"], [31000, 31001])
check("comment 正确", state["dcfrp_aaa"]["comment"], "DoulorCloud | active | 到期 2026-12-01")

print("")
print("=== 3. DISABLE / ENABLE ===")
reset_panel([LEGACY, dict(state["dcfrp_aaa"])])
desired_off = [dict(desired[0], enable=False)]
actions = agent.diff_plan(desired_off, agent.panel_get_tokens())
check("规划出 DISABLE", [a[0] for a in actions], ["DISABLE"])
agent.apply_actions(actions)
check("面板已停用", panel_state()["dcfrp_aaa"]["enable"], False)

actions = agent.diff_plan(desired, agent.panel_get_tokens())
check("规划出 ENABLE", [a[0] for a in actions], ["ENABLE"])
agent.apply_actions(actions)
check("面板已启用", panel_state()["dcfrp_aaa"]["enable"], True)

print("")
print("=== 4. PUPDATE：续期（只改 comment 里的到期日）===")
renewed = [dict(desired[0], comment="DoulorCloud | active | 到期 2027-03-15")]
actions = agent.diff_plan(renewed, agent.panel_get_tokens())
check("规划出 PUPDATE", [a[0] for a in actions], ["PUPDATE"])
agent.apply_actions(actions)
check("到期日已更新",
      "2027-03-15" in panel_state()["dcfrp_aaa"]["comment"], True)

print("")
print("=== 5. REMOVE：期望里没有了 ===")
actions = agent.diff_plan([], agent.panel_get_tokens())
check("规划出 REMOVE", [a[0] for a in actions], ["REMOVE"])
agent.apply_actions(actions)
state = panel_state()
check("dcfrp_aaa 已删除", "dcfrp_aaa" in state, False)

print("")
print("=== 6. 安全边界：历史账号绝不能被误删 ===")
check("some_legacy_user 仍在", "some_legacy_user" in state, True)
check("历史账号端口未变", state["some_legacy_user"]["ports"], [22222])

print("")
failed = results.count(False)
print("结果：%d 个用例，%d 个失败" % (len(results), failed))
if failed:
    print("→ 真实 agent 与新面板不兼容，切换会出问题")
sys.exit(1 if failed else 0)
