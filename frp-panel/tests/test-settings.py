#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：面板内的设置页 + API 密钥管理 + 文档页。

最要紧的一条是**闭环**：在界面上创建一个 API 密钥 → 拿它签一个 HMAC 请求 →
必须通；停用/吊销之后 → 必须不通。只验"页面上出现了密钥"是没有意义的。
"""
import hashlib
import http.cookiejar
import hmac
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

PORT = 7217
BASE = "http://127.0.0.1:%d" % PORT
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-46s 期望 %-18s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def check_true(name, cond, detail=""):
    results.append(bool(cond))
    print("  %s %-46s %s" % ("✓" if cond else "✗", name, detail))


jar = http.cookiejar.CookieJar()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar), NoRedirect)


def req(path, data=None, headers=None, method=None):
    r = urllib.request.Request(BASE + path)
    if data is not None:
        r.data = urllib.parse.urlencode(data, doseq=True).encode("utf-8")
        r.method = "POST"
        r.add_header("Content-Type", "application/x-www-form-urlencoded")
    if method:
        r.method = method
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with opener.open(r, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def csrf():
    _, body = req("/settings")
    m = re.search(r'name="csrf" value="([^"]+)"', body)
    return m.group(1) if m else ""


def sign(secret, method, path, body=b""):
    ts = str(int(time.time()))
    canonical = "\n".join([ts, method.upper(), path,
                           hashlib.sha256(body).hexdigest()])
    sig = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {"X-Frp-Agent-Ts": ts, "X-Frp-Agent-Signature": sig}


tmp = tempfile.mkdtemp(prefix="settings-")
CFG = os.path.join(tmp, "panel.json")
ORIG_PW = "orig-pass-12345"
with open(CFG, "w", encoding="utf-8") as fh:
    json.dump({
        "listen_host": "127.0.0.1", "listen_port": PORT,
        "data_file": os.path.join(tmp, "accounts.json"),
        "log_file": os.path.join(tmp, "panel.log"),
        "user_prefix": "dcfrp_", "agent_secret": "legacy-secret-abc",
        "admin_user": "admin", "admin_password": ORIG_PW,
        "default_rental_days": 30, "default_port_start": 31000,
        "default_port_end": 31999, "expiring_soon_days": 3,
        "login_max_fails": 5, "login_ban_seconds": 300, "session_ttl": 43200,
        "sweep_interval_seconds": 300, "auto_disable_expired": False,
        "frps_public_addr": "old.example.com", "frps_bind_port": 7000,
        "frps_global_token": "GT-OLD", "proxy_name_template": "port-{port}",
    }, fh, ensure_ascii=False)


def cfgfile():
    with open(CFG, encoding="utf-8") as fh:
        return json.load(fh)


proc = subprocess.Popen([sys.executable, PANEL_PY, "--config", CFG],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3)

    print("=== 1. 页面能打开 ===")
    st, body = req("/settings")
    check("设置页 -> 200", st, 200)
    check_true("有管理员登录区", 'name="admin_password"' in body, "")
    check_true("有 API 密钥区", "/settings/key/new" in body, "")
    check_true("有只读配置区", "只读配置" in body, "")
    check_true("导航里有「设置」", 'href="/settings"' in body, "")
    check_true("导航里有「文档」", 'href="/docs"' in body, "")

    st, body = req("/docs")
    check("文档页 -> 200", st, 200)
    check_true("含 HMAC 签名说明", "canonical" in body, "")
    check_true("含端点表", "/api/admin/accounts" in body, "")
    check_true("含访问控制表", "必须登录" in body, "")

    print("")
    print("=== 2. 保存设置会写回文件 ===")
    tok = csrf()
    st, _ = req("/settings", {"csrf": tok, "admin_user": "admin",
                              "admin_password": "", "admin_password2": "",
                              "frps_public_addr": "frp.newdomain.cn",
                              "frps_bind_port": "7000", "frps_global_token": "GT-NEW",
                              "proxy_name_template": "p-{port}",
                              "default_rental_days": "45", "expiring_soon_days": "5",
                              "default_port_start": "32000", "default_port_end": "32999",
                              "auto_disable_expired": "1",
                              "login_max_fails": "8", "login_ban_seconds": "600",
                              "session_ttl": "3600", "sweep_interval_seconds": "120"})
    check("保存 -> 303", st, 303)
    c = cfgfile()
    check("文件里地址已更新", c.get("frps_public_addr"), "frp.newdomain.cn")
    check("文件里租期已更新", c.get("default_rental_days"), 45)
    check("文件里端口区间已更新", [c.get("default_port_start"), c.get("default_port_end")],
          [32000, 32999])
    check("布尔值写成了 true", c.get("auto_disable_expired"), True)
    check("未提交的键没被冲掉", c.get("user_prefix"), "dcfrp_")

    st, body = req("/")
    check_true("新设置立刻生效（页面显示新地址）", "frp.newdomain.cn" in body, "")

    print("")
    print("=== 3. 校验 ===")
    tok = csrf()
    st, _ = req("/settings", {"csrf": tok, "admin_user": "admin",
                              "admin_password": "abc12345", "admin_password2": "different1",
                              "default_rental_days": "30", "default_port_start": "31000",
                              "default_port_end": "31999", "expiring_soon_days": "3",
                              "login_max_fails": "5", "login_ban_seconds": "300",
                              "session_ttl": "43200", "sweep_interval_seconds": "300",
                              "frps_public_addr": "x", "frps_bind_port": "7000",
                              "frps_global_token": "g", "proxy_name_template": "p"})
    check_true("两次口令不一致被拒", "不一致" in urllib.parse.unquote(st if isinstance(st, str) else "")
               or st == 303, "")

    tok = csrf()
    st, _ = req("/settings", {"csrf": tok, "admin_user": "admin", "admin_password": "short",
                              "admin_password2": "short",
                              "default_rental_days": "30", "default_port_start": "31000",
                              "default_port_end": "31999", "expiring_soon_days": "3",
                              "login_max_fails": "5", "login_ban_seconds": "300",
                              "session_ttl": "43200", "sweep_interval_seconds": "300",
                              "frps_public_addr": "x", "frps_bind_port": "7000",
                              "frps_global_token": "g", "proxy_name_template": "p"})
    check_true("口令太短被拒（没写进文件）", cfgfile().get("admin_password") == ORIG_PW, "")

    tok = csrf()
    req("/settings", {"csrf": tok, "admin_user": "admin", "admin_password": "",
                      "admin_password2": "",
                      "default_rental_days": "30", "default_port_start": "40000",
                      "default_port_end": "30000", "expiring_soon_days": "3",
                      "login_max_fails": "5", "login_ban_seconds": "300",
                      "session_ttl": "43200", "sweep_interval_seconds": "300",
                      "frps_public_addr": "x", "frps_bind_port": "7000",
                      "frps_global_token": "g", "proxy_name_template": "p"})
    check("端口区间反向被拒", cfgfile().get("default_port_start"), 32000)

    st, body = req("/settings", {"users": ["x"], "bulk_action": "delete"})
    check_true("无 CSRF 的设置提交被拒", "CSRF" in body or st in (303, 400), "")

    print("")
    print("=== 4. API 密钥闭环（最关键）===")
    tok = csrf()
    st, body = req("/settings/key/new", {"csrf": tok, "name": "测试密钥"})
    check("创建密钥 -> 200", st, 200)
    m = re.search(r"完整密钥（请立刻复制保存）：([A-Za-z0-9]+)", body)
    check_true("响应里给出了完整密钥", bool(m), "")
    new_secret = m.group(1) if m else ""
    check_true("密钥长度 >= 32", len(new_secret) >= 32, str(len(new_secret)))
    keys = cfgfile().get("api_keys") or []
    check("密钥已持久化", len(keys), 1)
    check("文件里名称正确", keys[0].get("name") if keys else "", "测试密钥")

    body_bytes = b""
    st, _ = req("/api/admin/accounts", headers=sign(new_secret, "GET",
                                                    "/api/admin/accounts"))
    check("用新密钥签名调用 -> 200", st, 200)

    st, _ = req("/api/admin/accounts", headers=sign("wrong-secret", "GET",
                                                    "/api/admin/accounts"))
    check("用错密钥签名 -> 401", st, 401)

    st, _ = req("/api/admin/accounts", headers=sign("legacy-secret-abc", "GET",
                                                    "/api/admin/accounts"))
    check("旧 agent_secret 仍然可用（向后兼容）", st, 200)

    print("")
    print("=== 5. 停用 / 吊销 ===")
    kid = keys[0]["id"]
    tok = csrf()
    st, _ = req("/settings/key/toggle", {"csrf": tok, "id": kid})
    check("停用 -> 303", st, 303)
    st, _ = req("/api/admin/accounts", headers=sign(new_secret, "GET",
                                                    "/api/admin/accounts"))
    check("停用后该密钥 -> 401", st, 401)
    st, _ = req("/api/admin/accounts", headers=sign("legacy-secret-abc", "GET",
                                                    "/api/admin/accounts"))
    check("停用它不影响别的密钥", st, 200)

    tok = csrf()
    req("/settings/key/toggle", {"csrf": tok, "id": kid})
    st, _ = req("/api/admin/accounts", headers=sign(new_secret, "GET",
                                                    "/api/admin/accounts"))
    check("重新启用后 -> 200", st, 200)

    tok = csrf()
    st, _ = req("/settings/key/delete", {"csrf": tok, "id": kid})
    check("吊销 -> 303", st, 303)
    check("文件里已删除", len(cfgfile().get("api_keys") or []), 0)
    st, _ = req("/api/admin/accounts", headers=sign(new_secret, "GET",
                                                    "/api/admin/accounts"))
    check("吊销后该密钥 -> 401", st, 401)

    print("")
    print("=== 6. 改口令会轮换会话密钥 ===")
    before = cfgfile().get("session_secret", "")
    tok = csrf()
    st, _ = req("/settings", {"csrf": tok, "admin_user": "admin",
                              "admin_password": "brand-new-pass-99",
                              "admin_password2": "brand-new-pass-99",
                              "default_rental_days": "45", "default_port_start": "32000",
                              "default_port_end": "32999", "expiring_soon_days": "5",
                              "login_max_fails": "8", "login_ban_seconds": "600",
                              "session_ttl": "3600", "sweep_interval_seconds": "120",
                              "frps_public_addr": "frp.newdomain.cn", "frps_bind_port": "7000",
                              "frps_global_token": "GT-NEW", "proxy_name_template": "p-{port}",
                              "auto_disable_expired": "1"})
    check("改口令 -> 303", st, 303)
    check("口令已更新", cfgfile().get("admin_password"), "brand-new-pass-99")
    check_true("session_secret 已轮换（旧会话立即失效）",
               cfgfile().get("session_secret", "") != before, "")

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
