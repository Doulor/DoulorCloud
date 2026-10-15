#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：「谁在线」指示。

为什么要单独测这个：在线状态是**全局共享的可变状态**，而插件回调是多线程的
（ThreadingHTTPServer）。面板里凡是全局可变状态踩过坑 —— 主题/密度那次就是
因为用了模块级变量而不是 threading.local，多线程下互相踩。
在线表同样危险：不加锁会读到写坏的 dict，表现是「偶尔少数几个账号消失」，
这种 bug 极难复现、极难定位。

所以这里既有功能测试，也有并发测试。

前置：一个跑在 7210 的面板实例（和其它测试一样）。
"""
import importlib.util
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

PORT = 7210
BASE = "http://127.0.0.1:%d" % PORT
HANDLER = BASE + "/handler"
HERE = os.path.dirname(os.path.abspath(__file__))
PANEL_PY = os.path.join(os.path.dirname(HERE), "panel.py")
if not os.path.exists(PANEL_PY):
    PANEL_PY = os.path.join(HERE, "panel.py")

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-44s 期望 %-14s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def check_true(name, cond, detail=""):
    results.append(bool(cond))
    print("  %s %-44s %s" % ("✓" if cond else "✗", name, detail))


def add_account(user, token, ports):
    """
    先建账号。

    ⚠️ 插件回调**只能授权，不能建号** —— 面板里没有这个账号，Login/Ping 会被拒，
    也就永远走不到记在线那一步。所以测试必须先把账号准备好，否则后面全是在
    验证「被拒的账号不在线」，看起来通过、其实什么也没测。
    """
    payload = {"user": user, "token": token, "comment": "online-test",
               "enable": True, "ports": ports, "domains": [""], "subdomains": [""]}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE + "/add", data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def plugin(op, content):
    # ⚠️ op 必须放在 **query string** 里 —— frps 就是这么调的（POST /handler?op=Login）。
    #    只放在 body 里的话，面板读不到 op，会落到「未知插件事件，保守放行」那条兜底路径：
    #    回调返回成功、却不做任何判定，也不记在线。测试若这么写就会「假通过」。
    url = HANDLER + "?version=0.1.0&op=" + op
    data = json.dumps({"version": "0.1.0", "op": op, "content": content}).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"reject": True, "http": e.code, "body": e.read().decode("utf-8", "replace")}


def page():
    with urllib.request.urlopen(BASE + "/", timeout=10) as resp:
        return resp.read().decode("utf-8", "replace")


def online_names(html):
    """从列表页里抠出「行内在线指示」的账号名。"""
    import re
    return re.findall(r'class="who"[^>]*>([^<]{1,60}?)<span class="live"', html)


def metric_online(html):
    import re
    m = re.search(r'>在线</div><div class="v">(\d+)</div>', html)
    return int(m.group(1)) if m else None


def ping_content(user, token):
    return {"user": user, "metas": {"token": token}}


print("=== 0. 前置：面板在跑吗 ===")
try:
    html = page()
    check_true("目标是面板列表页", "<!doctype html>" in html.lower() or "<html" in html.lower())
except Exception as exc:  # noqa: BLE001
    print("  面板没在 %d 上跑：%s" % (PORT, exc))
    sys.exit(2)

# 先建两个测试账号：一个正常，一个停用（用来验证「被拒的不算在线」）
BENCH_USERS = [("dcfrp_online_a", "online-token-aaa", [31701]),
               ("dcfrp_online_b", "online-token-bbb", [31702])]
for user, token, ports in BENCH_USERS:
    r = add_account(user, token, ports)
    check_true("建号 %s" % user, r.get("success") is True, str(r)[:70])

print("")
print("=== 1. 心跳会让账号显示为在线 ===")
res = plugin("Ping", ping_content("dcfrp_online_a", "online-token-aaa"))
check_true("Ping 被放行", res.get("reject") is False, str(res)[:80])

html = page()
names = online_names(html)
check_true("dcfrp_online_a 出现在在线列表", "dcfrp_online_a" in names, str(names[:4]))
check("指标卡的在线数与行内指示一致", metric_online(html), len(names))

print("")
print("=== 2. 只有真的有心跳的账号才在线 ===")
# online_b 没有 Ping 过（只有 Login 也会记一笔，所以要用全新账号验证）
fresh = "dcfrp_never_pinged"
check_true("全新账号不在在线列表", fresh not in online_names(page()), "")

print("")
print("=== 3. NewWorkConn / Login 也算「活着」 ===")
r1 = plugin("NewWorkConn", ping_content("dcfrp_online_b", "online-token-bbb"))
check_true("NewWorkConn 被放行", r1.get("reject") is False, str(r1)[:60])
check_true("dcfrp_online_b 也在线", "dcfrp_online_b" in online_names(page()), "")

print("")
print("=== 4. 被拒绝的回调不算在线 ===")
# 用一个一定不存在的账号：Login 会被拒，就不该出现在在线表里
bad = "dcfrp_ghost_online"
rb = plugin("Ping", ping_content(bad, "whatever"))
check_true("未知账号的 Ping 被拒", rb.get("reject") is True, str(rb)[:60])
check_true("被拒的账号不在线", bad not in online_names(page()), "")

print("")
print("=== 5. 模块级：TTL 与边界 ===")
spec = importlib.util.spec_from_file_location("panel_under_test", PANEL_PY)
mod = importlib.util.module_from_spec(spec)
sys.modules["panel_under_test"] = mod
spec.loader.exec_module(mod)

mod._online_seen.clear()
mod.note_online("u1")
check_true("刚记过就在在线表里", "u1" in mod.online_map(), "")
mod._online_seen["u1"] = time.time() - (mod.ONLINE_TTL_SEC + 5)
check_true("超过 TTL 后自动离线", "u1" not in mod.online_map(), "")
mod._online_seen["u1"] = time.time() - (mod.ONLINE_TTL_SEC - 5)
check_true("TTL 边界内还算在线", "u1" in mod.online_map(), "")
check("空用户名不记录", (mod.note_online(""), len(mod.online_map()))[1], 1)
mod.note_online(None)
check("None 也不记录", len(mod.online_map()), 1)

check("human_since(0)", mod.human_since(0), "0 秒前")
check("human_since(59)", mod.human_since(59), "59 秒前")
check("human_since(60)", mod.human_since(60), "1 分钟前")
check("human_since(3599)", mod.human_since(3599), "59 分钟前")
check("human_since(3600)", mod.human_since(3600), "1 小时前")
check("human_since(None)", mod.human_since(None), "0 秒前")

print("")
print("=== 6. 并发：多线程同时读写在线表 ===")
# 这是这个文件存在的主要理由。
# 不带锁的话，高并发下会出现「账号写进去了但读不到」或抛异常。
mod._online_seen.clear()
THREADS, PER_THREAD = 24, 60
errors = []


def hammer(idx):
    try:
        for i in range(PER_THREAD):
            name = "c_%d_%d" % (idx, i)
            mod.note_online(name)
            mod.online_map()
    except Exception as exc:  # noqa: BLE001
        errors.append("%s: %s" % (type(exc).__name__, exc))


threads = [threading.Thread(target=hammer, args=(i,)) for i in range(THREADS)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("并发过程中没有异常", len(errors), 0)
if errors:
    print("      " + errors[0][:120])
check("并发写入的账号数正确", len(mod.online_map()), THREADS * PER_THREAD)

print("")
print("=== 7. 通过插件接口并发心跳 ===")
def ping_worker(idx):
    try:
        plugin("Ping", ping_content("dcfrp_online_a", "online-token-aaa"))
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))


errors.clear()
ts = [threading.Thread(target=ping_worker, args=(i,)) for i in range(30)]
for t in ts:
    t.start()
for t in ts:
    t.join()
check("30 个并发插件回调无异常", len(errors), 0)
check_true("并发后账号仍在线", "dcfrp_online_a" in online_names(page()), "")

print("")
failed = results.count(False)
print("结果：%d 个用例，%d 个失败" % (len(results), failed))
sys.exit(1 if failed else 0)
