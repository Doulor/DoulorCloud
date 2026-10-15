#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：批量操作 + 端口分配视图。

批量操作一次改多个账号，是**最容易出事**的一类写操作（选错了就是一批人掉线），
所以必须逐项验：续期 / 启停 / 删除 / 无选择 / CSRF / 非法动作。

端口视图验的是运营最常问的两句：「这个端口是谁的」「还有哪些空着」。
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

PORT = 7214
BASE = "http://127.0.0.1:%d" % PORT
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-44s 期望 %-22s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def check_true(name, cond, detail=""):
    results.append(bool(cond))
    print("  %s %-44s %s" % ("✓" if cond else "✗", name, detail))


jar = http.cookiejar.CookieJar()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


def _open(path, data=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
    req = urllib.request.Request(BASE + path)
    if data is not None:
        req.data = urllib.parse.urlencode(data, doseq=True).encode("utf-8")
        req.method = "POST"
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with op.open(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def get(path):
    return _open(path)


def post(path, data):
    return _open(path, data)


CSRF_RE = re.compile(r'name="csrf" value="([^"]+)"')


def csrf():
    _, body = get("/")
    m = CSRF_RE.search(body)
    return m.group(1) if m else ""


tmp = tempfile.mkdtemp(prefix="bulk-")
cfg = os.path.join(tmp, "panel.json")
DATA = os.path.join(tmp, "accounts.json")
with open(cfg, "w", encoding="utf-8") as fh:
    json.dump({
        "listen_host": "127.0.0.1", "listen_port": PORT, "data_file": DATA,
        "log_file": os.path.join(tmp, "panel.log"), "user_prefix": "dcfrp_",
        "agent_secret": "bulk-secret", "admin_user": "admin", "admin_password": "x",
        "frps_public_addr": "frp.example.com", "frps_bind_port": 7000,
        "frps_global_token": "GT", "default_rental_days": 30,
        "default_port_start": 33000, "default_port_end": 33019,
        "sweep_interval_seconds": 99999,
    }, fh, ensure_ascii=False)

seed = []
for i in range(3):
    seed.append({"user": "dcfrp_bulk%d" % i, "token": "tok%d" % i, "comment": "批量测试%d" % i,
                 "enable": True, "ports": [33000 + i], "domains": [""], "subdomains": [""],
                 "expire_at": "2026-12-31T23:59:59Z"})
# 一个区间外的历史账号，用来验端口视图的"区间外"提示
seed.append({"user": "legacy_handmade", "token": "old", "comment": "手工分配",
             "enable": True, "ports": [22222], "domains": [""], "subdomains": [""],
             "expire_at": ""})
with open(DATA, "w", encoding="utf-8") as fh:
    json.dump({"version": 1, "accounts": seed}, fh, ensure_ascii=False)


def load():
    with open(DATA, encoding="utf-8") as fh:
        return {a["user"]: a for a in json.load(fh)["accounts"]}


proc = subprocess.Popen([sys.executable, PANEL_PY, "--config", cfg],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3)
    tok = csrf()
    check_true("拿到 CSRF 令牌", bool(tok), tok[:14] + "…" if tok else "（无）")

    print("")
    print("=== 1. 批量续期 ===")
    before = load()["dcfrp_bulk0"]["expire_at"]
    st, body = post("/bulk", {"csrf": tok, "users": ["dcfrp_bulk0", "dcfrp_bulk1", "dcfrp_bulk2"],
                              "bulk_action": "renew", "days": "30"})
    check("批量续期 -> 200", st, 200)
    check_true("提示已批量续期", "已批量续期 3 个账号" in body, "")
    after = load()
    check_true("三个账号都延后了",
               all(after["dcfrp_bulk%d" % i]["expire_at"] > before for i in range(3)),
               "%s -> %s" % (before[:10], after["dcfrp_bulk0"]["expire_at"][:10]))
    check_true("只有选中的被改（历史账号没动）",
               after["legacy_handmade"]["expire_at"] == "", "")

    print("")
    print("=== 2. 批量停用 / 启用 ===")
    st, body = post("/bulk", {"csrf": tok, "users": ["dcfrp_bulk0", "dcfrp_bulk1"],
                              "bulk_action": "disable"})
    check("批量停用 -> 200", st, 200)
    a = load()
    check("bulk0 已停用", a["dcfrp_bulk0"]["enable"], False)
    check("bulk1 已停用", a["dcfrp_bulk1"]["enable"], False)
    check("未选中的 bulk2 保持启用", a["dcfrp_bulk2"]["enable"], True)

    st, _ = post("/bulk", {"csrf": tok, "users": ["dcfrp_bulk0", "dcfrp_bulk1"],
                           "bulk_action": "enable"})
    a = load()
    check("批量启用后 bulk0 恢复", a["dcfrp_bulk0"]["enable"], True)
    check("批量启用后 bulk1 恢复", a["dcfrp_bulk1"]["enable"], True)

    print("")
    print("=== 3. 负向：不能误伤 ===")
    st, body = post("/bulk", {"csrf": tok, "users": [], "bulk_action": "delete"})
    check_true("没选中任何账号 -> 明确提示", "没有选中任何账号" in body, "")
    check("账号一个都没少", len(load()), 4)

    st, body = post("/bulk", {"csrf": tok, "users": ["dcfrp_bulk0"],
                              "bulk_action": "rm -rf"})
    check_true("非法动作被拒", "未知的批量操作" in body, "")

    st, body = post("/bulk", {"csrf": tok, "users": ["dcfrp_bulk0"],
                              "bulk_action": "renew", "days": "0"})
    check_true("续期天数越界被拒", "1~3650" in body, "")

    st, body = post("/bulk", {"csrf": "bogus.bogus", "users": ["dcfrp_bulk0"],
                              "bulk_action": "delete"})
    check_true("伪造 CSRF 被拒", "CSRF" in body, "")
    check("账号没被删掉", "dcfrp_bulk0" in load(), True)

    st, body = post("/bulk", {"users": ["dcfrp_bulk0"], "bulk_action": "delete"})
    check_true("无 CSRF 被拒", "CSRF" in body, "")

    st, body = post("/bulk", {"csrf": tok, "users": ["dcfrp_bulk0", "根本不存在的账号"],
                              "bulk_action": "disable"})
    check_true("不存在的账号被跳过并说明", "跳过" in body, "")

    print("")
    print("=== 4. 批量删除 ===")
    st, body = post("/bulk", {"csrf": tok, "users": ["dcfrp_bulk0", "dcfrp_bulk1"],
                              "bulk_action": "delete"})
    check("批量删除 -> 200", st, 200)
    a = load()
    check_true("两个已删除", "dcfrp_bulk0" not in a and "dcfrp_bulk1" not in a, str(sorted(a)))
    check_true("未选中的还在", "dcfrp_bulk2" in a, "")

    print("")
    print("=== 5. 端口分配视图 ===")
    st, body = get("/ports")
    check("端口页 200", st, 200)
    check_true("列出已分配端口 33000", ">33000<" in body, "")
    check_true("标出空闲端口（虚线）", 'class="port free"' in body, "")
    check_true("已分配标为 taken", 'class="port taken"' in body, "")
    check_true("区间外端口有单独提示", "在默认区间之外" in body or "默认区间之外" in body, "")
    check_true("区间外提到 22222", "22222" in body, "")
    check_true("端口页有回到账号列表的入口", 'href="/"' in body, "")

    st, body = get("/")
    check_true("列表页有端口视图入口", 'href="/ports"' in body, "")
    check_true("列表页有批量操作条", 'id="bulkform"' in body, "")
    check_true("勾选框关联到表格外的表单", 'form="bulkform"' in body, "")
    check_true("列表页有概览指标", 'class="metric' in body, "")

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
