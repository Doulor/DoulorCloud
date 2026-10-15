#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：亮/暗主题切换。

主题是"每台设备各自记"的显示偏好，存在 cookie 里。两件事必须守住：
  1. 切换真的生效（cookie → 页面 data-theme / theme-color / 按钮文案三者一致）
  2. **只跳回同源** —— 否则 /theme?to=x 就是个开放重定向
"""
import http.cookiejar
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_CAND = [os.path.join(os.path.dirname(HERE), "panel.py"), os.path.join(HERE, "panel.py")]
PANEL_PY = next((p for p in _CAND if os.path.exists(p)), _CAND[0])
if not os.path.exists(PANEL_PY):
    print("找不到 panel.py")
    sys.exit(2)

PORT = 7216
BASE = "http://127.0.0.1:%d" % PORT
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-44s 期望 %-12s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def check_true(name, cond, detail=""):
    results.append(bool(cond))
    print("  %s %-44s %s" % ("✓" if cond else "✗", name, detail))


jar = http.cookiejar.CookieJar()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar), NoRedirect)


def get(path, referer=None):
    req = urllib.request.Request(BASE + path)
    if referer:
        req.add_header("Referer", referer)
    try:
        with opener.open(req, timeout=10) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)


def theme_of(body):
    m = re.search(r'data-theme="(\w+)"', body)
    return m.group(1) if m else "(无)"


def color_of(body):
    m = re.search(r'name="theme-color" content="([^"]+)"', body)
    return m.group(1) if m else "(无)"


tmp = tempfile.mkdtemp(prefix="theme-")
cfg = os.path.join(tmp, "panel.json")
import json  # noqa: E402

with open(cfg, "w", encoding="utf-8") as fh:
    json.dump({
        "listen_host": "127.0.0.1", "listen_port": PORT,
        "data_file": os.path.join(tmp, "accounts.json"),
        "log_file": os.path.join(tmp, "panel.log"),
        "user_prefix": "dcfrp_", "agent_secret": "s",
        "admin_user": "admin", "admin_password": "x",
        "sweep_interval_seconds": 99999,
    }, fh, ensure_ascii=False)

proc = subprocess.Popen([sys.executable, PANEL_PY, "--config", cfg],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3)

    print("=== 1. 默认与切换 ===")
    st, body, _ = get("/")
    check("默认暗色", theme_of(body), "dark")
    check("默认 theme-color 是暗色底", color_of(body), "#141218")
    check_true("导航里有主题按钮", "rail-theme" in body, "")

    st, _, headers = get("/theme?to=light")
    check("/theme 重定向 -> 303", st, 303)
    check_true("下发主题 cookie", "frp_panel_theme=light" in (headers.get("Set-Cookie") or ""),
               headers.get("Set-Cookie", "")[:60])

    st, body, _ = get("/")
    check("切后页面是亮色", theme_of(body), "light")
    check("亮色 theme-color", color_of(body), "#fef7ff")
    check_true("按钮文案变成「暗色」", "<span>暗色</span>" in body, "")
    check_true("亮色变量已注入", "--md-surface:#fef7ff" in body, "")

    st, _, _ = get("/theme?to=dark")
    st, body, _ = get("/")
    check("切回暗色", theme_of(body), "dark")
    check_true("按钮文案变成「亮色」", "<span>亮色</span>" in body, "")

    print("")
    print("=== 2. 非法值当成暗色，不报错 ===")
    st, _, _ = get("/theme?to=rainbow")
    check("非法值 -> 303（不 500）", st, 303)
    st, body, _ = get("/")
    check("落到暗色", theme_of(body), "dark")

    st, _, _ = get("/theme")
    check("缺参数 -> 303", st, 303)

    print("")
    print("=== 3. 只能跳回同源（防开放重定向）===")
    st, _, headers = get("/theme?to=light", referer="http://evil.example.com/steal")
    loc = headers.get("Location") or ""
    check_true("外部 Referer 被丢弃，跳回 /", loc.endswith("/") and "evil" not in loc, loc)

    st, _, headers = get("/theme?to=light", referer=BASE + "/ports")
    check("同源 Referer 会跳回原页", headers.get("Location"), "/ports")

    st, _, headers = get("/theme?to=light", referer=BASE + "/logs?kind=bad")
    check("带查询串也保留", headers.get("Location"), "/logs?kind=bad")

    print("")
    print("=== 4. 行密度 ===")
    st, body, _ = get("/")
    check("默认舒适", re.search(r'data-density="(\w+)"', body).group(1), "comfortable")

    st, _, headers = get("/density?to=compact")
    check("/density 重定向 -> 303", st, 303)
    check_true("下发密度 cookie",
               "frp_panel_density=compact" in (headers.get("Set-Cookie") or ""),
               (headers.get("Set-Cookie") or "")[:56])

    st, body, _ = get("/")
    check("切后是紧凑", re.search(r'data-density="(\w+)"', body).group(1), "compact")
    check_true("紧凑模式 CSS 已注入", '[data-density="compact"] tbody td' in body, "")

    st, _, headers = get("/density?to=compact", referer="http://evil.example.com/x")
    check_true("密度路由同样防开放重定向",
               "evil" not in (headers.get("Location") or ""), headers.get("Location"))

    get("/density?rainbow")
    st, body, _ = get("/")
    check("非法值落回舒适", re.search(r'data-density="(\w+)"', body).group(1), "comfortable")

    print("")
    print("=== 5. 两个偏好互不干扰 ===")
    get("/theme?to=light")
    get("/density?to=compact")
    st, body, _ = get("/")
    check("主题仍是亮色", theme_of(body), "light")
    check("密度仍是紧凑", re.search(r'data-density="(\w+)"', body).group(1), "compact")
    get("/theme?to=dark")
    st, body, _ = get("/")
    check("切主题不影响密度", re.search(r'data-density="(\w+)"', body).group(1), "compact")

    print("")
    print("=== 6. 偏好不影响功能（写操作照常）===")
    st, body, _ = get("/")
    tok = re.search(r'name="csrf" value="([^"]+)"', body)
    check_true("亮色下依然拿得到 CSRF", bool(tok), tok.group(1)[:12] + "…" if tok else "（无）")
    get("/theme?to=dark")
    get("/density?to=comfortable")
    st, body, _ = get("/")
    check("切回后功能正常", st, 200)

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
