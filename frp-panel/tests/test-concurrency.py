#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
并发 / 状态隔离压测。

为什么要有这个：这个面板刚被发现过一个**跨请求状态泄漏**的 bug
（keep-alive 下用了上一个请求的 body → 授权判定基于了错误的对象）。
状态类 bug 很少只有一处，所以这里用并发去逼：

  · 多线程、每线程独立 keep-alive 连接
  · 每条连接上**交替**发送「应当放行」和「应当拒绝」的请求
  · 断言每个响应只对得上**它自己的**请求
  · 同时混发 Login / NewProxy / Ping，压满分发路径

只要有任何共享状态被串用（请求体、解析出的 op、账号缓存…），
交替模式就会立刻暴露成「该拒的放行了 / 该放的被拒了」。
"""
import http.client
import json
import sys
import threading
import time

PORT = 7210
ACCOUNTS = "/tmp/frpbench/accounts.json"
THREADS = 8
ROUNDS = 30

FIXTURE = {
    "version": 1,
    "accounts": [{
        "user": "dcfrp_bench01",
        "token": "bench-user-token-01",
        "comment": "concurrency test",
        "enable": True,
        "ports": [31000],
        "domains": [""],
        "subdomains": [""],
        "expire_at": "2026-12-31T00:00:00Z",
    }],
}

with open(ACCOUNTS, "w", encoding="utf-8") as fh:
    json.dump(FIXTURE, fh, ensure_ascii=False, indent=2)
time.sleep(0.6)

GOOD_TOKEN = "bench-user-token-01"
BAD_TOKEN = "definitely-wrong"

errors = []
lock = threading.Lock()


def post(conn, op, content):
    body = json.dumps({"version": "0.1.0", "op": op, "content": content}).encode("utf-8")
    conn.request("POST", "/handler?version=0.1.0&op=" + op, body=body,
                 headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    return json.loads(resp.read().decode("utf-8"))


def worker(tid):
    local_errors = []
    try:
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=15)
        for i in range(ROUNDS):
            # 交替：偶数轮应当放行，奇数轮应当拒绝
            allow_round = (i % 2 == 0)
            token = GOOD_TOKEN if allow_round else BAD_TOKEN
            want_reject = not allow_round

            res = post(conn, "Login", {
                "user": "dcfrp_bench01", "metas": {"token": token}, "timestamp": i,
            })
            if bool(res.get("reject")) != want_reject:
                local_errors.append(
                    "T%d 第%d轮 Login 期望 reject=%s 得到 %s（%s）"
                    % (tid, i, want_reject, res.get("reject"), res.get("reject_reason")))

            # 混发 NewProxy / Ping，压分发路径
            res = post(conn, "NewProxy", {
                "user": {"user": "dcfrp_bench01"},
                "proxy_name": "p%d" % i, "proxy_type": "tcp",
                # 偶数轮用已分配端口（放行），奇数轮用未分配端口（拒绝）
                "remote_port": 31000 if allow_round else 31999,
            })
            if bool(res.get("reject")) != want_reject:
                local_errors.append(
                    "T%d 第%d轮 NewProxy 期望 reject=%s 得到 %s（%s）"
                    % (tid, i, want_reject, res.get("reject"), res.get("reject_reason")))

            res = post(conn, "Ping", {"user": {"user": "dcfrp_bench01"}})
            # Ping **总是应当放行** —— 因为 Ping 的 content 里**没有用户令牌**：
            #   {user:{user,metas,run_id}, privilege_key, timestamp}
            # 其中 privilege_key 是 frps **全局** auth.token 的派生值，与账号无关。
            # 用户身份在 Login 时已经确认，frps 只对已登录的连接发 Ping。
            # （账号被停用/到期时 Ping 会被拒 —— 那是 test-ping-kick.py 的场景。）
            #
            # ⚠️ 这里断言「总是放行」同样能测出状态串用：
            #    若 Ping 拿到了别的请求的 body（比如令牌错误的 Login），它就会被误拒。
            if bool(res.get("reject")):
                local_errors.append(
                    "T%d 第%d轮 Ping 不该被拒，却得到 reject=True（%s）"
                    % (tid, i, res.get("reject_reason")))

        conn.close()
    except Exception as exc:  # noqa: BLE001
        local_errors.append("T%d 异常: %s: %s" % (tid, type(exc).__name__, exc))

    with lock:
        errors.extend(local_errors)


print("并发压测：%d 线程 × %d 轮 × 3 个回调 = %d 次请求"
      % (THREADS, ROUNDS, THREADS * ROUNDS * 3))
started = time.time()
threads = [threading.Thread(target=worker, args=(t,)) for t in range(THREADS)]
for t in threads:
    t.start()
for t in threads:
    t.join()
elapsed = time.time() - started

print("耗时 %.2f 秒（%.0f 请求/秒）" % (elapsed, THREADS * ROUNDS * 3 / max(elapsed, 0.001)))
print("")

if errors:
    print("发现 %d 处错配：" % len(errors))
    for e in errors[:20]:
        print("  ✗ %s" % e)
    if len(errors) > 20:
        print("  …还有 %d 处" % (len(errors) - 20))
    print("")
    print("→ 存在跨请求/跨线程的状态串用")
    sys.exit(1)

print("✓ 全部 %d 次请求的判定都与自己的请求一致 —— 无状态串用"
      % (THREADS * ROUNDS * 3))
sys.exit(0)
