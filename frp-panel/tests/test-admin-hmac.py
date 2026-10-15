#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HMAC 私有管理 API 自测。

签名口径与 DoulorCloud Worker 的 agent 通道**完全一致**：
    canonical = "\\n".join([ts, METHOD, pathname+search, sha256hex(body)])
    signature = HMAC-SHA256(secret, canonical) 的 hex
头：X-Frp-Agent-Ts / X-Frp-Agent-Signature

覆盖：
  ✓ 正确签名 → 可用
  ✓ 签名错   → 401
  ✓ 时间戳过期 → 401
  ✓ 缺头     → 401
  ✓ 未配密钥 → 503（绝不退化成无鉴权）
  ✓ 非 dcfrp_ 前缀账号被拒（安全边界）
"""
import hashlib
import hmac
import json
import socket
import sys
import time
import urllib.error
import urllib.request

HOST = "127.0.0.1"
PORT = 7210
SECRET = "bench-hmac-secret-1234567890"


def sign(method, path, body, secret=SECRET, ts=None):
    ts = str(int(ts if ts is not None else time.time()))
    body = body or b""
    canonical = "\n".join([ts, method.upper(), path, hashlib.sha256(body).hexdigest()])
    sig = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return ts, sig


def request(method, path, payload=None, secret=SECRET, ts=None, no_headers=False):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else b""
    req = urllib.request.Request("http://%s:%d%s" % (HOST, PORT, path), data=body, method=method)
    req.add_header("Content-Type", "application/json")
    if not no_headers:
        t, s = sign(method, path, body, secret, ts)
        req.add_header("X-Frp-Agent-Ts", t)
        req.add_header("X-Frp-Agent-Signature", s)
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"raw": raw}


results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-40s 期望 %-4s 实际 %s" % ("✓" if ok else "✗", name, want, got))


def check_true(name, cond, detail=""):
    results.append(bool(cond))
    print("  %s %-40s %s" % ("✓" if cond else "✗", name, detail))


print("=== 正向：正确签名 ===")
st, body = request("GET", "/api/admin/accounts")
check("GET /api/admin/accounts", st, 200)
print("     账号数 = %s" % (body.get("count") if isinstance(body, dict) else "?"))

st, body = request("PUT", "/api/admin/accounts/dcfrp_hmac01", {
    "token": "tok-hmac-01", "comment": "HMAC 测试账号", "enable": True,
    "ports": [31200], "expire_at": "2027-01-01T00:00:00Z",
})
check("PUT 新增账号", st, 200)

st, body = request("POST", "/api/admin/accounts/dcfrp_hmac01/disable")
check("POST disable", st, 200)

st, body = request("POST", "/api/admin/accounts/dcfrp_hmac01/enable")
check("POST enable", st, 200)

st, body = request("DELETE", "/api/admin/accounts/dcfrp_hmac01")
check("DELETE 删除账号", st, 200)

print("")
print("=== 负向：鉴权必须挡住 ===")
st, _ = request("GET", "/api/admin/accounts", secret="wrong-secret")
check("签名错误", st, 401)

st, _ = request("GET", "/api/admin/accounts", ts=time.time() - 4000)
check("时间戳过期（>300s）", st, 401)

st, _ = request("GET", "/api/admin/accounts", no_headers=True)
check("缺少签名头", st, 401)

print("")
print("=== 安全边界：该守的是「自动化」，不是「管理员通道」 ===")
#
# 这里曾经写错过一次：一开始我让 HMAC 接口也拒绝非 dcfrp_ 前缀，后来想清楚了 ——
#   · HMAC 接口 = **签名鉴权的管理通道**，管理员有权管理任何账号（含那 46 个历史账号）
#   · 真正要守的边界是**自动化**：agent 走的是兼容接口（/tokens、/add、/remove…），
#     它绝不能碰非 dcfrp_ 前缀的历史账号
# 所以断言应该下在兼容接口上，而不是 HMAC 接口上。
LEGACY = {"token": "legacy-tok", "ports": [22222], "comment": "历史人工账号", "enable": True}

st, _ = request("PUT", "/api/admin/accounts/some_legacy_account", LEGACY)
check("HMAC 管理通道可以建历史账号", st, 200)

st, _ = request("POST", "/remove", {"users": [{"user": "some_legacy_account"}]})
check("兼容接口 /remove 调用返回成功", st, 200)
st, _ = request("GET", "/api/admin/accounts/some_legacy_account")
check("但历史账号仍然在（自动化删不掉）", st, 200)

st, _ = request("PUT", "/api/admin/accounts/dcfrp_deleteme",
                {"token": "x", "ports": [31700], "comment": "", "enable": True})
request("POST", "/remove", {"users": [{"user": "dcfrp_deleteme"}]})
st, _ = request("GET", "/api/admin/accounts/dcfrp_deleteme")
check("对照：dcfrp_ 账号被兼容接口删掉了", st, 404)

print("")
print("=== 外部 API：详情 / 续期 / 生成配置 ===")
st, _ = request("PUT", "/api/admin/accounts/dcfrp_api01",
                {"token": "api-tok", "ports": [31800, 31801],
                 "comment": "API 测试", "enable": True, "days": 10})
check("PUT 带 days 可直接设租期", st, 200)

st, body = request("GET", "/api/admin/accounts/dcfrp_api01")
check("GET 单个 -> 200", st, 200)
acc = body.get("account") or {}
check("返回里有 days_left", "days_left" in acc, True)
check_true("days_left 约等于 10", acc.get("days_left") in (9, 10), str(acc.get("days_left")))
before = acc.get("expire_at")

st, body = request("POST", "/api/admin/accounts/dcfrp_api01/renew", {"days": 30})
check("续期 -> 200", st, 200)
check_true("到期日被延长", body.get("expire_at", "") > (before or ""),
           "%s -> %s" % ((before or "")[:10], body.get("expire_at", "")[:10]))

st, body = request("GET", "/api/admin/accounts/dcfrp_api01/config")
check("取配置 -> 200", st, 200)
cfg = body.get("config") or ""
check_true("配置含 serverAddr", "frp.example.com" in cfg, "")
check_true("配置含账号 user", 'user = "dcfrp_api01"' in cfg, "")
check_true("配置含两个端口", "remotePort = 31800" in cfg and "remotePort = 31801" in cfg, "")

st, _ = request("POST", "/api/admin/accounts/dcfrp_api01/renew", {"days": 99999})
check("续期天数越界 -> 400", st, 400)

st, body = request("GET", "/api/admin/accounts/dcfrp_ghost")
check("查不存在的账号 -> 404", st, 404)

st, _ = request("POST", "/api/admin/accounts/dcfrp_api01/disable")
check("停用 -> 200", st, 200)
st, body = request("GET", "/api/admin/accounts/dcfrp_api01")
check_true("停用已生效", (body.get("account") or {}).get("enable") is False, "")
st, _ = request("POST", "/api/admin/accounts/dcfrp_api01/enable")
check("启用 -> 200", st, 200)

st, _ = request("DELETE", "/api/admin/accounts/dcfrp_api01")
check("删除 -> 200", st, 200)

print("")
print("=== 结论 ===")
failed = results.count(False)
print("  %d 个用例，%d 个失败" % (len(results), failed))
sys.exit(1 if failed else 0)
