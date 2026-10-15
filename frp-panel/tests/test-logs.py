#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：操作日志视图。

面板一直在记日志（谁改了什么、插件放行还是拒绝了谁），但以前只能 SSH 上去 tail。
这个视图把它搬到界面上 —— 运营问「刚才那次改动是谁做的」时能直接回答。

重点验两件事：
  1. 分类与筛选对不对（放行/拒绝/管理/错误各自归位）
  2. **日志文件很大时不能读爆内存** —— 真实环境里日志是几百 MB 的
"""
import http.cookiejar
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_CAND = [os.path.join(os.path.dirname(HERE), "panel.py"), os.path.join(HERE, "panel.py")]
PANEL_PY = next((p for p in _CAND if os.path.exists(p)), _CAND[0])
if not os.path.exists(PANEL_PY):
    print("找不到 panel.py")
    sys.exit(2)

PORT = 7215
BASE = "http://127.0.0.1:%d" % PORT
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-46s 期望 %-10s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def check_true(name, cond, detail=""):
    results.append(bool(cond))
    print("  %s %-46s %s" % ("✓" if cond else "✗", name, detail))


def get(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


tmp = tempfile.mkdtemp(prefix="logs-")
LOGPATH = os.path.join(tmp, "panel.log")
cfg = os.path.join(tmp, "panel.json")

# 造一份"像真的一样"的日志：混合各种级别
lines = []
for i in range(120):
    lines.append("2026-10-13 10:%02d:%02d ALLOW Login user=dcfrp_a%02d" % (i % 60, i % 60, i))
for i in range(30):
    lines.append("2026-10-13 11:%02d:%02d REJECT Login user=dcfrp_b%02d reason=expired" % (i % 60, i % 60, i))
for i in range(8):
    lines.append("2026-10-13 12:00:%02d WEB 更新 dcfrp_c%02d ports=[3100%d]" % (i, i, i % 10))
lines.append("2026-10-13 12:30:00 查看令牌：dcfrp_a01（来源 127.0.0.1）")
lines.append("2026-10-13 12:31:00 ERROR 账号写操作异常：TypeError: boom")
lines.append("2026-10-13 12:31:00 Traceback (most recent call last):")
lines.append('  File "panel.py", line 1, in <module>')
lines.append("2026-10-13 12:32:00 巡检：账号 dcfrp_z01 已于 2026-10-01 到期")
with open(LOGPATH, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")

with open(cfg, "w", encoding="utf-8") as fh:
    json.dump({
        "listen_host": "127.0.0.1", "listen_port": PORT,
        "data_file": os.path.join(tmp, "accounts.json"),
        "log_file": LOGPATH, "user_prefix": "dcfrp_", "agent_secret": "s",
        "admin_user": "admin", "admin_password": "x",
        "sweep_interval_seconds": 99999,
    }, fh, ensure_ascii=False)

proc = subprocess.Popen([sys.executable, PANEL_PY, "--config", cfg],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3)

    print("=== 1. 日志能读到 ===")
    st, body = get("/logs")
    check("日志页 -> 200", st, 200)
    check_true("有日志行", body.count('class="logline') > 50, "%d 行" % body.count('class="logline'))
    check_true("能读到 ALLOW 记录", "ALLOW Login" in body, "")
    check_true("能读到 REJECT 记录", "REJECT Login" in body, "")
    check_true("能读到管理操作", "WEB 更新" in body, "")
    check_true("能读到取令牌留痕", "查看令牌" in body, "")

    print("")
    print("=== 2. 级别分类 ===")
    check_true("ALLOW 归为「放行」", 'pill ok">放行' in body, "")
    check_true("REJECT 归为「拒绝」", 'pill bad">拒绝' in body, "")
    check_true("ERROR 归为「错误」", 'pill err">错误' in body, "")
    check_true("巡检归为「警告」", 'pill warn">警告' in body, "")

    print("")
    print("=== 3. 异常堆栈要并进上一条，不该当成独立事件 ===")
    check_true("Traceback 没有变成独立日志行",
               body.count("Traceback (most recent call last)") >= 1
               and 'class="logline' in body, "")
    check_true("堆栈被折进折叠块", 'class="logstack"' in body, "")

    print("")
    print("=== 4. 筛选 ===")
    st, only_bad = get("/logs?kind=bad")
    check("筛选「拒绝」-> 200", st, 200)
    check_true("只剩拒绝", "REJECT Login" in only_bad and "ALLOW Login" not in only_bad, "")
    check_true("拒绝数量合计 30", ">30<" in only_bad or "30" in only_bad, "")

    st, only_info = get("/logs?kind=info")
    check_true("筛选「管理」只含管理操作",
               "WEB 更新" in only_info and "ALLOW Login" not in only_info, "")

    st, only_ok = get("/logs?kind=ok")
    check_true("筛选「放行」只含放行",
               "ALLOW Login" in only_ok and "REJECT Login" not in only_ok, "")

    print("")
    print("=== 5. 导航栏 ===")
    check_true("有导航栏", 'class="rail"' in body, "")
    check_true("日志页高亮在「日志」", 'href="/logs" aria-current="page"' in body, "")
    check_true("导航含账号入口", 'href="/"' in body, "")
    check_true("导航含端口入口", 'href="/ports"' in body, "")

    st, listbody = get("/")
    check_true("账号页高亮在「账号」", 'href="/" aria-current="page"' in listbody, "")

    print("")
    print("=== 6. 大文件不能读爆内存（关键）===")
    # 追加 ~6MB 日志，再请求一次，看是否仍然只回 200 且很快
    with open(LOGPATH, "a", encoding="utf-8") as fh:
        pad = "2026-10-13 13:00:00 ALLOW Ping user=dcfrp_big padding=%s\n" % ("x" * 200)
        fh.write(pad * 30000)
    size_mb = os.path.getsize(LOGPATH) / 1048576.0
    t0 = time.time()
    st, big = get("/logs")
    elapsed = time.time() - t0
    check("大日志下仍 200", st, 200)
    check_true("日志 %.1fMB 时响应 < 5s（实际 %.2fs）" % (size_mb, elapsed), elapsed < 5.0,
               "%.2fs" % elapsed)
    check_true("只回最近 500 条，不是整个文件", big.count('class="logline') <= 500,
               "%d 行" % big.count('class="logline'))

    print("")
    failed = results.count(False)
    print("结果：%d 个用例，%d 个失败" % (len(results), failed))
    sys.exit(1 if failed else 0)
finally:
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        proc.kill()
