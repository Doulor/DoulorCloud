#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对自研面板跑一组拒绝路径测试（直接打 /handler，不需要 frpc）。"""
import json
import sys
import time
import urllib.request

PORT = 7210
BASE = "http://127.0.0.1:%d/handler" % PORT
ACCOUNTS = "/tmp/frpbench/accounts.json"

# ------------------------------------------------------------------ 测试夹具
# 本脚本依赖账号处于「有效」状态，而别的测试（如 test-expiry.py）可能把它改成已到期，
# 从而造成假失败。所以每次运行都先把夹具写回。
FIXTURE = {
    "version": 1,
    "accounts": [{
        "user": "dcfrp_bench01",
        "token": "bench-user-token-01",
        "comment": "DoulorCloud | active | 到期 2026-12-31",
        "enable": True,
        "ports": [31000],
        "domains": [""],
        "subdomains": [""],
        "expire_at": "2026-12-31T00:00:00Z",
    }],
}


def setup_fixture():
    try:
        with open(ACCOUNTS, "w", encoding="utf-8") as fh:
            json.dump(FIXTURE, fh, ensure_ascii=False, indent=2)
    except IOError as exc:
        print("⚠️  写夹具失败（%s）；若账号当前是到期状态，下面会有假失败" % exc)
    time.sleep(0.6)   # 面板按 mtime 变化自动重载


setup_fixture()


def call(op, content):
    url = BASE + "?version=0.1.0&op=" + op
    data = json.dumps({"version": "0.1.0", "op": op, "content": content}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def login_content(user, token):
    return {"user": user, "metas": {"token": token}, "timestamp": 1, "privilege_key": "x"}


CASES = [
    ("令牌正确 → 放行",
     "Login", login_content("dcfrp_bench01", "bench-user-token-01"), False),
    ("令牌错误 → 拒绝",
     "Login", login_content("dcfrp_bench01", "wrong-token"), True),
    ("账号不存在 → 拒绝",
     "Login", login_content("dcfrp_ghost", "whatever"), True),
    ("端口已分配 → 放行",
     "NewProxy",
     {"user": {"user": "dcfrp_bench01"}, "proxy_name": "p1", "proxy_type": "tcp",
      "remote_port": 31000}, False),
    ("端口未分配（越权）→ 拒绝",
     "NewProxy",
     {"user": {"user": "dcfrp_bench01"}, "proxy_name": "p2", "proxy_type": "tcp",
      "remote_port": 31999}, True),
    ("Ping 正常 → 放行",
     "Ping", {"user": {"user": "dcfrp_bench01"}}, False),
]

failed = 0
for name, op, content, want_reject in CASES:
    try:
        res = call(op, content)
    except Exception as exc:  # noqa: BLE001
        print("  ✗ %-26s 请求失败: %s" % (name, exc))
        failed += 1
        continue
    got = bool(res.get("reject"))
    ok = got == want_reject
    if not ok:
        failed += 1
    print("  %s %-26s reject=%-5s unchange=%s%s"
          % ("✓" if ok else "✗", name, got, res.get("unchange"),
             ("  原因=" + str(res.get("reject_reason"))) if got else ""))

print("")
print("结果：%d 个用例，%d 个失败" % (len(CASES), failed))
sys.exit(1 if failed else 0)
