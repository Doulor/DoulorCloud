#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收：访问闸门 + 网页界面。

为什么必须测「非本机」这条路径：这个面板的兼容接口（/tokens 等）**故意不做鉴权**，
好让现有 agent 一行都不用改。所以「外部请求必须登录」这道闸门是**唯一**的安全边界 ——
它一旦失效，面板就退化成旧面板那个「未授权可读全部令牌」的漏洞。

本测试自己拉起一个**绑到非回环地址**的临时实例（端口 7211），
然后从服务器自己的 IP 访问它 —— 这样源地址就不是回环，正好走到闸门那条路径。
"""
import json
import hashlib
import hmac
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# 兼容两种布局：仓库里的 tests/ 子目录，以及测试台上和 panel.py 平铺在同一层
_CANDIDATES = [
    os.path.join(os.path.dirname(HERE), "panel.py"),   # .../frp-panel/tests/ -> .../frp-panel/panel.py
    os.path.join(HERE, "panel.py"),                    # 平铺：和测试脚本同目录
]
PANEL_PY = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[0])
if not os.path.exists(PANEL_PY):
    print("找不到 panel.py，试过：%s" % _CANDIDATES)
    sys.exit(2)
PORT = 7211


def _local_ip():
    """
    本机的非回环 IPv4。

    原来直接调 `hostname -I` —— 那是 Linux 专有命令，测试在 Windows/macOS 上根本起不来。
    改成开一个 UDP socket「连」一下外网地址再读自己的本地地址：没有真实流量，
    两个平台都能用。
    """
    if os.environ.get("EXTERNAL_HOST"):
        return os.environ["EXTERNAL_HOST"]
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:  # noqa: BLE001
        return "127.0.0.1"
    finally:
        s.close()


HOST = _local_ip()
BASE = "http://%s:%d" % (HOST, PORT)
ADMIN_USER = "admin"
ADMIN_PASS = "bench-pass-123"
SESSION_SECRET = "test-session-secret-0123456789"


def sign_session(expires, sid, secret=SESSION_SECRET):
    payload = "%d.%s" % (expires, sid)
    sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return payload + "." + sig

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-50s 期望 %-20s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def request(method, path, data=None, headers=None, follow=True):
    url = BASE + path
    body = None
    hdrs = dict(headers or {})
    if isinstance(data, dict):
        body = urllib.parse.urlencode(data).encode("utf-8")
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = data
    req = urllib.request.Request(url, data=body, method=method)
    for k, v in hdrs.items():
        req.add_header(k, v)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None

    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=8) as resp:
            return resp.status, resp.read().decode("utf-8", "replace"), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)


tmp = tempfile.mkdtemp(prefix="auth-test-")
cfg = os.path.join(tmp, "panel.json")
with open(cfg, "w", encoding="utf-8") as fh:
    json.dump({
        "listen_host": "0.0.0.0",
        "listen_port": PORT,
        "data_file": os.path.join(tmp, "accounts.json"),
        "log_file": os.path.join(tmp, "panel.log"),
        "user_prefix": "dcfrp_",
        "agent_secret": "bench-secret",
        "admin_user": ADMIN_USER,
        "admin_password": ADMIN_PASS,
        "allow_public_bind": True,
        # 固定会话密钥，好让测试自己能算签名 —— 这样才能精确区分
        # 「签名错」和「签名对但已过期」两种情况，而不是只测到「格式不对」
        "session_secret": SESSION_SECRET,
    }, fh, ensure_ascii=False)

with open(os.path.join(tmp, "accounts.json"), "w", encoding="utf-8") as fh:
    json.dump({"version": 1, "accounts": [{
        "user": "dcfrp_demo01", "token": "tok-demo-secret-value",
        "comment": "DoulorCloud | active | 到期 2026-12-31",
        "enable": True, "ports": [31000], "domains": [""], "subdomains": [""],
        "expire_at": "2026-12-31T00:00:00Z",
    }]}, fh, ensure_ascii=False)

proc = subprocess.Popen([sys.executable, PANEL_PY, "--config", cfg],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3)
    print("临时实例：%s（源地址非回环，正好命中闸门那条路径）" % BASE)
    print("")

    print("=== 1. 外部未登录：接口必须拒绝 ===")
    st, body, _ = request("GET", "/tokens")
    check("/tokens 未登录 -> 401", st, 401)
    check("/tokens 未登录不返回任何令牌", "tok-demo-secret-value" in body, False)

    print("")
    print("=== 2. 外部未登录：网页必须跳登录页 ===")
    st, body, hdr = request("GET", "/", follow=False)
    check("/ -> 303 跳转", st, 303)
    check("Location 指向 /login", hdr.get("Location"), "/login")
    st, body, _ = request("GET", "/login")
    check("登录页可打开", st, 200)
    check("登录页不含令牌", "tok-demo-secret-value" in body, False)
    check("登录页含密码框", 'type="password"' in body, True)

    print("")
    print("=== 3. 错误口令必须被拒（且不能泄露任何数据）===")
    st, body, _ = request("POST", "/login", {"user": ADMIN_USER, "password": "wrong"})
    check("错误口令 -> 401", st, 401)
    check("错误口令响应不含令牌", "tok-demo-secret-value" in body, False)

    print("")
    print("=== 4. 正确口令 -> 拿到会话 ===")
    st, body, hdr = request("POST", "/login",
                            {"user": ADMIN_USER, "password": ADMIN_PASS}, follow=False)
    check("正确口令 -> 303", st, 303)
    cookie = hdr.get("Set-Cookie") or ""
    check("下发了会话 cookie", "frp_panel_session=" in cookie, True)
    check("cookie 是 HttpOnly", "HttpOnly" in cookie, True)
    check("cookie 是 SameSite=Lax", "SameSite=Lax" in cookie, True)

    print("")
    print("=== 5. 带会话访问：接口与网页都应当放行 ===")
    sess = {"Cookie": cookie.split(";")[0]}
    st, body, _ = request("GET", "/tokens", headers=sess)
    check("带会话 /tokens -> 200", st, 200)
    check("/tokens 返回了账号", "dcfrp_demo01" in body, True)

    st, body, _ = request("GET", "/", headers=sess)
    check("带会话 / -> 200", st, 200)
    check("页面含账号名", "dcfrp_demo01" in body, True)
    check("页面里令牌默认打码", "tok-demo-secret-value" in body, False)
    check("页面含端口", "31000" in body, True)

    st, body, _ = request("GET", "/?show_tokens=1", headers=sess)
    check("show_tokens=1 时显示令牌", "tok-demo-secret-value" in body, True)

    # 令牌改成**按需取**（页面里不预置），所以这个端点必须自己扛住闸门。
    # 之前我把真令牌写进 data-* 属性做纯前端切换，"默认打码"其实是假的 ——
    # 上面那条 check 就是抓到它的。
    st, body, _ = request("GET", "/api/token/dcfrp_demo01", headers=sess)
    check("已登录按需取令牌 -> 200", st, 200)
    check("取回的令牌正确", "tok-demo-secret-value" in body, True)

    st, _, _ = request("GET", "/api/token/dcfrp_demo01")
    check("未登录（外部）取令牌 -> 401", st, 401)

    st, _, _ = request("GET", "/api/token/dcfrp_nope", headers=sess)
    check("取不存在的账号 -> 404", st, 404)

    print("")
    print("=== 6. 会话令牌的密码学边界（精确到签名与过期）===")
    future = int(time.time()) + 3600
    past = int(time.time()) - 60

    # 签名正确、但已过期 —— 测的是「过期」而不是「格式」
    tok = sign_session(past, "aabbccdd11223344")
    st, _, _ = request("GET", "/tokens", headers={"Cookie": "frp_panel_session=" + tok})
    check("签名正确但已过期 -> 401", st, 401)

    # 未过期，但用别的密钥签名
    tok = sign_session(future, "aabbccdd11223344", secret="attacker-secret")
    st, body, _ = request("GET", "/tokens", headers={"Cookie": "frp_panel_session=" + tok})
    check("密钥不对的签名 -> 401", st, 401)
    check("伪造会话不泄露令牌", "tok-demo-secret-value" in body, False)

    # 未过期、签名正确，但把 session id 改掉（签名随之失效）
    good = sign_session(future, "aabbccdd11223344")
    tampered = good.replace("aabbccdd11223344", "ffffffffffffffff")
    st, _, _ = request("GET", "/tokens", headers={"Cookie": "frp_panel_session=" + tampered})
    check("篡改 session id -> 401", st, 401)

    st, _, _ = request("GET", "/tokens", headers={"Cookie": "frp_panel_session=garbage"})
    check("格式不对 -> 401", st, 401)

    print("")
    print("=== 7. /handler 只允许本机（插件回调不该被外部调用）===")
    st, body, _ = request("POST", "/handler?op=Login&version=0.1.0",
                          json.dumps({"version": "0.1.0", "op": "Login",
                                      "content": {"user": "dcfrp_demo01",
                                                  "metas": {"token": "tok-demo-secret-value"}}}).encode(),
                          {"Content-Type": "application/json"}, follow=False)
    check("外部调用 /handler -> 403", st, 403)

    print("")
    print("=== 8. 登出必须真的吊销该会话（而不是只清 cookie）===")
    # 再登录一次，拿第二个会话 —— 用来验证吊销是「精确的」，不会误伤别的浏览器
    _, _, hdr2 = request("POST", "/login",
                         {"user": ADMIN_USER, "password": ADMIN_PASS}, follow=False)
    sess2 = {"Cookie": (hdr2.get("Set-Cookie") or "").split(";")[0]}
    st, _, _ = request("GET", "/tokens", headers=sess2)
    check("第二个会话可用", st, 200)

    st, _, _ = request("GET", "/logout", headers=sess, follow=False)
    check("/logout -> 303", st, 303)

    st, body, _ = request("GET", "/tokens", headers=sess)
    check("登出后旧会话 -> 401（真的吊销了）", st, 401)
    check("登出后旧会话拿不到令牌", "tok-demo-secret-value" in body, False)

    st, _, _ = request("GET", "/tokens", headers=sess2)
    check("另一个会话不受影响 -> 200", st, 200)

    print("")
    failed = results.count(False)
    print("结果：%d 个用例，%d 个失败" % (len(results), failed))
    if failed:
        print("→ 访问闸门或网页界面有问题，不能把这个面板暴露到公网")
    sys.exit(1 if failed else 0)
finally:
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        proc.kill()
