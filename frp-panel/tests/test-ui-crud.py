#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：网页端的账号管理（新建 / 编辑 / 启停 / 续期 / 删除 / 生成配置）。

这轮是把只读面板做成「真能操作」的面板，所以必须逐项验收：
  · 新建账号（含租期按天数 / 指定日期）
  · 编辑所有字段
  · 续期（在现有到期日基础上加，已过期的从今天算）
  · 启用 / 停用
  · 删除
  · 生成 frpc.toml
  · **CSRF 必须挡住没有令牌的提交**（否则管理员浏览器里随便一个网页都能改账号）
  · 校验：端口冲突、非法账号名、空端口都要给出可读的错误

测试自己拉起一个临时实例（端口 7213，只监听回环）。
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
_CANDIDATES = [os.path.join(os.path.dirname(HERE), "panel.py"),
               os.path.join(HERE, "panel.py")]
PANEL_PY = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[0])
if not os.path.exists(PANEL_PY):
    print("找不到 panel.py，试过：%s" % _CANDIDATES)
    sys.exit(2)

PORT = 7213
BASE = "http://127.0.0.1:%d" % PORT
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-46s 期望 %-26s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def check_true(name, cond, detail=""):
    results.append(bool(cond))
    print("  %s %-46s %s" % ("✓" if cond else "✗", name, detail))


jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def get(path, follow=True):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None
    op = opener if follow else urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar), NoRedirect)
    try:
        with op.open(BASE + path, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def post(path, data, follow=True):
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None
    op = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar), NoRedirect)
    try:
        with op.open(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


CSRF_RE = re.compile(r'name="csrf" value="([^"]+)"')


def csrf_from(html_text):
    m = CSRF_RE.search(html_text)
    return m.group(1) if m else ""


def fetch_csrf():
    _, body = get("/")
    return csrf_from(body)


tmp = tempfile.mkdtemp(prefix="ui-crud-")
cfg = os.path.join(tmp, "panel.json")
with open(cfg, "w", encoding="utf-8") as fh:
    json.dump({
        "listen_host": "127.0.0.1",
        "listen_port": PORT,
        "data_file": os.path.join(tmp, "accounts.json"),
        "log_file": os.path.join(tmp, "panel.log"),
        "user_prefix": "dcfrp_",
        "agent_secret": "ui-crud-secret",
        "admin_user": "admin",
        "admin_password": "x",
        "frps_public_addr": "frp.example.com",
        "frps_bind_port": 7000,
        "frps_global_token": "GLOBALTOKEN",
        "default_rental_days": 30,
        "sweep_interval_seconds": 99999,
    }, fh, ensure_ascii=False)
with open(os.path.join(tmp, "accounts.json"), "w", encoding="utf-8") as fh:
    json.dump({"version": 1, "accounts": []}, fh)

proc = subprocess.Popen([sys.executable, PANEL_PY, "--config", cfg],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3)

    print("=== 1. 列表页与 CSRF ===")
    st, body = get("/")
    check("首页 200", st, 200)
    check("有「新建账号」入口", "/account/new" in body, True)
    csrf = csrf_from(body)
    check_true("页面里带 CSRF 令牌", bool(csrf), csrf[:16] + "…" if csrf else "（无）")

    print("")
    print("=== 2. 新建账号（按天数租期）===")
    st, body = post("/account/new", {
        "csrf": csrf, "user": "dcfrp_web01", "token": "",
        "ports": "31100, 31101-31103", "comment": "网页新建",
        "enable": "1", "rental_mode": "days", "rental_days": "30",
    })
    check("提交后 200", st, 200)
    check_true("提示已新建", "已新建" in body, "")
    check_true("列表里出现新账号", "dcfrp_web01" in body, "")
    check_true("端口区间已展开", "31101" in body and "31103" in body, "")

    # 直接读数据文件核对落库内容
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        data = {a["user"]: a for a in json.load(fh)["accounts"]}
    acc = data.get("dcfrp_web01") or {}
    check("端口落库正确", acc.get("ports"), [31100, 31101, 31102, 31103])
    check_true("令牌自动生成（非空）", bool(acc.get("token")), acc.get("token", ""))
    check_true("到期日已设置", bool(acc.get("expire_at")), acc.get("expire_at", ""))
    check("备注落库", acc.get("comment"), "网页新建")

    print("")
    print("=== 3. 编辑：改端口/备注/令牌 ===")
    st, body = post("/account/dcfrp_web01", {
        "csrf": csrf, "token": "NEWTOKEN123", "ports": "31200",
        "comment": "改过了", "enable": "1", "rental_mode": "keep",
    })
    check("编辑后 200", st, 200)
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        acc = {a["user"]: a for a in json.load(fh)["accounts"]}["dcfrp_web01"]
    check("端口已改", acc.get("ports"), [31200])
    check("令牌已改", acc.get("token"), "NEWTOKEN123")
    check("备注已改", acc.get("comment"), "改过了")

    print("")
    print("=== 4. 续期 +30 天（在原到期日基础上加）===")
    before = acc.get("expire_at")
    st, body = post("/account/dcfrp_web01/renew", {"csrf": csrf, "days": "30"})
    check("续期后 200", st, 200)
    check_true("提示已续期", "已为" in body and "续期" in body, "")
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        after = {a["user"]: a for a in json.load(fh)["accounts"]}["dcfrp_web01"]
    check_true("到期日延后了", after.get("expire_at") > before,
               "%s -> %s" % (before[:10], after.get("expire_at", "")[:10]))

    print("")
    print("=== 5. 停用 / 启用 ===")
    post("/account/dcfrp_web01/toggle", {"csrf": csrf})
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        acc = {a["user"]: a for a in json.load(fh)["accounts"]}["dcfrp_web01"]
    check("已停用", acc.get("enable"), False)
    post("/account/dcfrp_web01/toggle", {"csrf": csrf})
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        acc = {a["user"]: a for a in json.load(fh)["accounts"]}["dcfrp_web01"]
    check("已启用", acc.get("enable"), True)

    print("")
    print("=== 6. 生成 frpc.toml ===")
    st, body = get("/account/dcfrp_web01/config")
    check("配置页 200", st, 200)
    check_true("含 serverAddr", "frp.example.com" in body, "")
    check_true("含全局 token", "GLOBALTOKEN" in body, "")
    check_true("含账号 token", "NEWTOKEN123" in body, "")
    check_true("含 metadatas.token", "metadatas.token" in body, "")
    check_true("含 proxies 段", "[[proxies]]" in body, "")
    check_true("含 remotePort 31200", "remotePort = 31200" in body, "")

    # 带引号的行要在**下载的原始 TOML** 上校验：
    # 网页里那段配置是 HTML 转义过的（" 变成 &quot;），这是对的，不能拿它比引号。
    st, body = get("/account/dcfrp_web01/config.toml")
    check("下载端点 200", st, 200)
    check_true("下载内容是纯 TOML", body.startswith("#") and "<html" not in body.lower(), "")
    check_true('含 user = "dcfrp_web01"', 'user = "dcfrp_web01"' in body, "")
    check_true('含 remotePort = 31200', "remotePort = 31200" in body, "")

    print("")
    print("=== 7. CSRF 必须挡住无令牌提交 ===")
    st, body = post("/account/new", {
        "user": "dcfrp_evil", "token": "x", "ports": "31300",
        "comment": "", "enable": "1", "rental_mode": "days", "rental_days": "30",
    })
    check_true("无 CSRF 提交被拒", st == 200 and "CSRF" in body, "")
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        names = [a["user"] for a in json.load(fh)["accounts"]]
    check_true("非法提交没有落库", "dcfrp_evil" not in names, "")

    st, body = post("/account/new", {
        "csrf": "deadbeef.deadbeef", "user": "dcfrp_evil2", "token": "x",
        "ports": "31301", "comment": "", "enable": "1",
        "rental_mode": "days", "rental_days": "30",
    })
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        names = [a["user"] for a in json.load(fh)["accounts"]]
    check_true("伪造 CSRF 也被拒", "dcfrp_evil2" not in names, "")

    print("")
    print("=== 8. 表单校验 ===")
    csrf = fetch_csrf()
    st, body = post("/account/new", {
        "csrf": csrf, "user": "非法 名字!", "token": "x", "ports": "31400",
        "comment": "", "enable": "1", "rental_mode": "days", "rental_days": "30",
    })
    check_true("非法账号名被拒", "账号名只能包含" in body, "")

    st, body = post("/account/new", {
        "csrf": csrf, "user": "dcfrp_dup", "token": "x", "ports": "31200",
        "comment": "", "enable": "1", "rental_mode": "days", "rental_days": "30",
    })
    check_true("端口冲突被拒", "已被账号" in body, "")

    st, body = post("/account/new", {
        "csrf": csrf, "user": "dcfrp_noport", "token": "x", "ports": "",
        "comment": "", "enable": "1", "rental_mode": "days", "rental_days": "30",
    })
    check_true("空端口被拒", "至少要分配一个端口" in body, "")

    st, body = post("/account/new", {
        "csrf": csrf, "user": "dcfrp_baddate", "token": "x", "ports": "31500",
        "comment": "", "enable": "1", "rental_mode": "date", "expire_date": "2026/1/1",
    })
    check_true("非法日期被拒", "格式应为" in body, "")

    print("")
    print("=== 9. 删除 ===")
    csrf = fetch_csrf()
    st, body = post("/account/dcfrp_web01/delete", {"csrf": csrf})
    check("删除后 200", st, 200)
    with open(os.path.join(tmp, "accounts.json"), encoding="utf-8") as fh:
        names = [a["user"] for a in json.load(fh)["accounts"]]
    check_true("账号已从库里删除", "dcfrp_web01" not in names, str(names))

    print("")
    print("=== 10. 到期分布图 ===")
    # 先造几个不同到期时间的账号，验证分桶
    for name, days in (("dcfrp_w1", 3), ("dcfrp_w2", 10), ("dcfrp_w3", 45)):
        exp = time.strftime("%Y-%m-%d", time.localtime(time.time() + days * 86400))
        st, _ = post("/account/new", {
            "csrf": fetch_csrf(), "user": name, "token": "t", "ports": "31%03d" % (600 + days),
            "comment": "分布测试", "enable": "1", "rental_mode": "date", "expire_date": exp,
        })
    st, body = get("/")
    check("首页 200", st, 200)
    check_true("分布图存在", "histcard" in body, "")
    check("正好 12 根柱子", body.count('class="hist-col"'), 12)
    check_true("图例里有「12 周内」", "12 周内" in body, "")
    check_true("每根柱子有 title 提示",
               body.count('class="hist-col" title="第') == 12, "")

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
