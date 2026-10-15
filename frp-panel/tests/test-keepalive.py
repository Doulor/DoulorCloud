#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
回归测试：keep-alive 连接上的请求体不得串到下一个请求。

背景（真实踩过的坑）：
    HTTP/1.1 keep-alive 下，BaseHTTPRequestHandler 用**同一个实例**连续处理
    同一条连接上的多个请求。如果请求体缓存在实例属性上而不在每个请求开头清空，
    第 N 个请求就会拿到**第 N-1 个请求的 body** —— `self.path`（op）是新的、
    `content` 是旧的，授权判定就基于了错误的对象。

    实测症状是面板日志里 op 与 content 系统性错配，并且 frpc 每 ~13 秒被断开重连一次。

本测试的做法：**在一条复用的连接上交替发送「应当放行」和「应当拒绝」的请求**。
如果 body 发生串用，后一个请求就会得到前一个请求的判定结果，断言立刻失败。

关键点：必须复用同一条连接（http.client.HTTPConnection），
每次新建连接是测不出这个 bug 的。
"""
import http.client
import json
import sys
import time

PORT = 7210
ACCOUNTS = "/tmp/frpbench/accounts.json"

FIXTURE = {
    "version": 1,
    "accounts": [{
        "user": "dcfrp_bench01",
        "token": "bench-user-token-01",
        "comment": "keep-alive 回归测试",
        "enable": True,
        "ports": [31000],
        "domains": [""],
        "subdomains": [""],
        "expire_at": "2026-12-31T00:00:00Z",
    }],
}


def setup_fixture():
    with open(ACCOUNTS, "w", encoding="utf-8") as fh:
        json.dump(FIXTURE, fh, ensure_ascii=False, indent=2)
    time.sleep(0.6)   # 面板按 mtime 变化自动重载


def post(conn, op, content):
    body = json.dumps({"version": "0.1.0", "op": op, "content": content}).encode("utf-8")
    conn.request("POST", "/handler?version=0.1.0&op=" + op, body=body,
                 headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8")
    return json.loads(raw)


def login(token):
    return {"user": "dcfrp_bench01", "metas": {"token": token}, "timestamp": 1}


setup_fixture()

# 一条连接，全程复用
conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=8)

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-46s 期望 reject=%-5s 实际 %s" % ("✓" if ok else "✗", name, want, got))


print("=== 同一条 keep-alive 连接上交替发送放行/拒绝请求 ===")
print("（若请求体串用，后面的请求会拿到前一个的判定结果）")
print("")

# 交替：对 / 错 / 对 / 错 / 对 —— 只要有一处串用就会暴露
check("第 1 次 Login（令牌正确）", post(conn, "Login", login("bench-user-token-01"))["reject"], False)
check("第 2 次 Login（令牌错误）", post(conn, "Login", login("WRONG"))["reject"], True)
check("第 3 次 Login（令牌正确）", post(conn, "Login", login("bench-user-token-01"))["reject"], False)
check("第 4 次 Login（令牌错误）", post(conn, "Login", login("WRONG"))["reject"], True)
check("第 5 次 Login（令牌正确）", post(conn, "Login", login("bench-user-token-01"))["reject"], False)

print("")
print("=== 不同 op 交替（最像真实场景：Ping / NewProxy 混着来）===")
proxy_ok = {"user": {"user": "dcfrp_bench01"}, "proxy_name": "p1", "proxy_type": "tcp", "remote_port": 31000}
proxy_bad = {"user": {"user": "dcfrp_bench01"}, "proxy_name": "p2", "proxy_type": "tcp", "remote_port": 31999}
check("NewProxy（端口已分配）", post(conn, "NewProxy", proxy_ok)["reject"], False)
check("Ping（正常）", post(conn, "Ping", {"user": {"user": "dcfrp_bench01"}})["reject"], False)
check("NewProxy（端口越权）", post(conn, "NewProxy", proxy_bad)["reject"], True)
check("Ping（正常）", post(conn, "Ping", {"user": {"user": "dcfrp_bench01"}})["reject"], False)
check("NewProxy（端口已分配）", post(conn, "NewProxy", proxy_ok)["reject"], False)

conn.close()

print("")
failed = results.count(False)
print("结果：%d 个用例，%d 个失败" % (len(results), failed))
if failed:
    print("→ 请求体在不同请求之间发生了串用（检查 handle_one_request 是否清了缓存）")
sys.exit(1 if failed else 0)
