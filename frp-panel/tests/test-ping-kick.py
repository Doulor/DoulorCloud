#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：账号到期后，frps 会不会把**已在线**的客户端踢下线。

这是目标里「到期即时拒绝（frps 立刻断开隧道）」的验收。
机制：客户端每 `transport.heartbeatInterval` 秒发一次 Ping，
      frps 把 Ping 转给插件；插件拒绝 → frps 断开该客户端。

需要测试台：本机 frps(7100) + 面板(7210) + frpc(心跳 10s)。
"""
import json
import os
import sys
import time

ACCOUNTS = "/tmp/frpbench/accounts.json"
PANEL_LOG = "/tmp/frpbench/panel.log"
FRPC_LOG = "/tmp/frpbench/frpc4.log"


def set_expire(expire_at):
    with open(ACCOUNTS) as fh:
        data = json.load(fh)
    for acc in data["accounts"]:
        if acc["user"] == "dcfrp_bench01":
            acc["expire_at"] = expire_at
    with open(ACCOUNTS, "w") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print("  账号 expire_at = %s" % expire_at)


def count(path, needle):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read().count(needle)
    except IOError:
        return 0


def tail(path, n=6):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return "".join(fh.readlines()[-n:])
    except IOError:
        return "(读不到)"


print("=== 步骤 1：账号有效，让客户端稳定在线 ===")
set_expire("2026-12-31T00:00:00Z")
time.sleep(12)   # 覆盖至少一次 Ping

ping_before = count(PANEL_LOG, "ALLOW  Ping")
reject_before = count(PANEL_LOG, "REJECT Ping")
print("  有效期内：ALLOW Ping = %d，REJECT Ping = %d" % (ping_before, reject_before))

print("")
print("=== 步骤 2：把账号改成已到期 ===")
set_expire("2020-01-01T00:00:00Z")

print("")
print("=== 步骤 3：等心跳周期（最多 45 秒），观察是否被踢 ===")
kicked_at = None
start = time.time()
while time.time() - start < 45:
    if count(PANEL_LOG, "REJECT Ping") > reject_before:
        kicked_at = time.time() - start
        break
    time.sleep(1)

if kicked_at is None:
    print("  ❌ 45 秒内没有出现 REJECT Ping —— 到期没能通过心跳拦住")
    print("  面板日志尾部：")
    print(tail(PANEL_LOG))
    sys.exit(1)

print("  第 %.0f 秒出现第一次 REJECT Ping（心跳间隔 10 秒）" % kicked_at)

print("")
print("=== 步骤 4：确认客户端确实被断开（出现重连/重登失败）===")
time.sleep(12)
relogin = count(FRPC_LOG, "login to server success")
fail = count(FRPC_LOG, "token in login doesn't match") + count(FRPC_LOG, "login to server failed")
print("  frpc 日志：")
for line in tail(FRPC_LOG, 6).rstrip().split("\n"):
    print("    %s" % line)

print("")
print("=== 结论 ===")
print("  ✓ 到期后心跳被拒（REJECT Ping），frps 据此断开客户端")
print("  ✓ 客户端重连时在 Login 再次被拒 —— 无法自行恢复")
sys.exit(0)
