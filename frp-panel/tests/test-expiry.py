#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试「到期后隧道还能不能用」—— 用真实访客连接触发 NewWorkConn。

场景：
  1. frpc 已连上，隧道 31000 可用
  2. 把账号改成「已到期」（expire_at 设为过去）
  3. 向 31000 发起一次真实 TCP 连接（这会让 frps 调 NewWorkConn）
  4. 观察：访客连接是否被拒？frpc 是否被断开？
"""
import json
import socket
import sys
import time
import urllib.request

ACCOUNTS = "/tmp/frpbench/accounts.json"
REMOTE = ("127.0.0.1", 31000)


def load():
    with open(ACCOUNTS, encoding="utf-8") as fh:
        return json.load(fh)


def save(data):
    with open(ACCOUNTS, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def set_expired(expired):
    data = load()
    for acc in data["accounts"]:
        if acc["user"] == "dcfrp_bench01":
            acc["expire_at"] = "2020-01-01T00:00:00Z" if expired else "2026-12-31T00:00:00Z"
    save(data)
    print("  账号到期状态 -> %s" % ("已到期" if expired else "有效"))


def try_connect(label):
    started = time.time()
    try:
        s = socket.create_connection(REMOTE, timeout=8)
        s.settimeout(8)
        # 隧道后面是 127.0.0.1:8899（bench 里没有服务），
        # 所以「能建立连接」= 隧道通了；「超时/被拒」= 没通
        try:
            s.sendall(b"\n")
            s.recv(16)
        except socket.timeout:
            pass
        s.close()
        print("  %s: 访客连接【成功建立】（用时 %.0fms）" % (label, (time.time() - started) * 1000))
        return True
    except Exception as exc:  # noqa: BLE001
        print("  %s: 访客连接【失败】%s（用时 %.0fms）"
              % (label, type(exc).__name__, (time.time() - started) * 1000))
        return False


def panel_admin(action, user):
    """顺带验证面板管理 API 可用（不走 agent 也能管）。"""
    url = "http://127.0.0.1:7210/" + action
    body = json.dumps({"users": [{"user": user}]}).encode("utf-8")
    if action == "add":
        return None
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


print("=== 步骤 1：账号有效时，隧道应当可用 ===")
set_expired(False)
time.sleep(0.5)
ok_before = try_connect("有效账号")

print("")
print("=== 步骤 2：把账号改成已到期 ===")
set_expired(True)
time.sleep(0.5)

print("")
print("=== 步骤 3：到期后再连一次（触发 NewWorkConn）===")
ok_after = try_connect("已到期账号")

print("")
print("=== 步骤 4：面板管理 API 自检（disable / enable）===")
print("  disable ->", panel_admin("disable", "dcfrp_bench01"))
print("  enable  ->", panel_admin("enable", "dcfrp_bench01"))

print("")
print("结论：")
if ok_before and not ok_after:
    print("  ✅ 到期后隧道立即不可用（访客连不进来）—— 强制点有效")
    sys.exit(0)
if not ok_before:
    print("  ⚠️ 基线就不通（隧道本身没建起来，或 8899 没有服务），需要先修正测试台")
    sys.exit(2)
print("  ❌ 到期后访客仍能连进来 —— 到期没有生效")
sys.exit(1)
