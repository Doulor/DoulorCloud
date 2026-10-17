#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
frp-agent —— 把 DoulorCloud 的「期望状态」投影到本机 frps-panel。

为什么需要它（2026-10-13 实测确认，别再想着让 Worker 直连面板）：
    Cloudflare Worker 到不了这台服务器上的 frps-panel —— 裸 IP
    (http://1.2.3.4:7200) 被 Cloudflare 出网策略拦截（1ms 返回 403，请求根本没有
    离开边缘）；改走域名时北京节点返回「Non-compliance ICP Filing」未备案拦截，
    香港节点 520。所以方向必须反过来：**由本机主动出网去拉**。

分工：
    · D1 是唯一真值 —— 谁可以用、用到什么时候、占哪些端口都由 DoulorCloud 决定
    · 本 agent 只负责把期望状态投影到面板，并把实际结果回报
    · 面板（frps-panel）退化成纯鉴权插件

安全边界（重要）：
    只处理**以 user_prefix 开头**的账号。面板里还有 46 个管理员人工建的历史账号，
    它们绝不能被本 agent 触碰 —— 见 diff_plan() 里的 managed 集合。

面板现状提醒（2026-10-13 实测）：
    面板的 HTML 页面与 /login **全部 panic**（gin-contrib/i18n 的
    `index out of range [0] with length 0`），所以本 agent **不使用会话登录**，
    只用那些正常的 JSON 端点：GET /tokens、POST /add|/update|/remove|/disable|/enable。

用法：
    python3 frp-agent.py --config config.json --once --dry-run    # 看一次计划，不落地
    python3 frp-agent.py --config config.json                     # 常驻
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_CONFIG = {
    "cloud_base": "https://cloud.doulor.cn",
    "agent_secret": "",
    "node_id": "",
    "panel_base": "http://127.0.0.1:7200",
    "user_prefix": "dcfrp_",
    "interval_seconds": 20,
    "dry_run": True,
    "timeout_seconds": 20,
    "log_file": "/home/frp/frpagent/frp-agent.log",
    "state_file": "/home/frp/frpagent/state.json",
}


# 默认 User-Agent。
#
# ⚠️ 必须显式设置，否则 Cloudflare 会回 `403 error code: 1010`（浏览器完整性检查）。
# 实测（2026-10-13，从服务器上逐个试）：
#     默认 urllib UA            -> 403 error code: 1010
#     DoulorCloud-FrpAgent/1.0  -> 401（到了 Worker，只是没带签名）
#     curl/8.0                  -> 401
#     浏览器 UA                  -> 401
# 所以这不是「要不要伪装浏览器」的问题：**任意非空 UA 都能过，空的才被拦**。
DEFAULT_USER_AGENT = "DoulorCloud-FrpAgent/1.0 (+https://cloud.doulor.cn)"


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    sys.stdout.flush()
    path = CONFIG.get("log_file")
    if path:
        try:
            with open(path, "a") as fh:
                fh.write(line + "\n")
        except OSError:
            pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """
    禁止自动跟随重定向。

    ⚠️ 这不是洁癖，是必需品：面板对**未登录**的 /tokens 回 `307 Location: /login`，
    但**响应体里照样带着完整的用户 JSON**。而 /login 正是那个会 panic 的路由
    （gin-contrib/i18n 的 index out of range），所以：
        · curl 默认不跟随 → 看得到 307 + JSON，一切正常
        · urllib 默认跟随   → 跟到 /login → 连接被服务端关掉
                             → `RemoteDisconnected: Remote end closed connection without response`
    第一版就踩了这个坑：agent 在服务器上读不到面板，而手工 curl 却是好的。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http_request(method, url, body=None, headers=None, timeout=20):
    """发起一次 HTTP 请求，返回 (status, text)。不抛网络异常，由调用方判断。"""
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method)
    # 先设默认 UA，再让调用方覆盖（见 DEFAULT_USER_AGENT 的注释：空 UA 会被 Cloudflare 1010 拦）
    req.add_header("User-Agent", DEFAULT_USER_AGENT)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        # 307/302 这类被 _NoRedirect 拦下后会走到这里 —— 正常读取其响应体
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return None, "%s: %s" % (type(exc).__name__, exc)


def sign(secret, ts, method, path_with_query, body):
    """与 Worker 侧 requireAgent() 逐字对应：ts\\nMETHOD\\npath+query\\nsha256(body)"""
    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    canonical = "\n".join([ts, method.upper(), path_with_query, body_hash])
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def cloud_request(method, path_with_query, payload=None):
    """调 DoulorCloud 的 agent 端点，带 HMAC 签名。"""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) if payload is not None else ""
    ts = str(int(time.time()))
    sig = sign(CONFIG["agent_secret"], ts, method, path_with_query, body)
    headers = {
        "X-Frp-Agent-Ts": ts,
        "X-Frp-Agent-Signature": sig,
    }
    if body:
        headers["Content-Type"] = "application/json"
    url = CONFIG["cloud_base"].rstrip("/") + path_with_query
    return http_request(method, url, body or None, headers, CONFIG["timeout_seconds"])


def panel_get_tokens():
    """读面板全部账号。返回 list，失败返回 None。"""
    status, text = http_request("GET", CONFIG["panel_base"] + "/tokens", timeout=CONFIG["timeout_seconds"])
    # 面板对未登录请求固定回 307 + Location: /login，**但响应体里就是完整的用户 JSON**
    # （它的 session 中间件没有中断后续 handler）。所以 200/301/302/307 都当成功处理。
    if status not in (200, 301, 302, 307):
        log("WARN 读取面板 /tokens 失败: status=%s body=%s" % (status, (text or "")[:200]))
        return None
    # 响应体前面可能带着 "<a href=\"/login\">Temporary Redirect</a>.\n\n" 这类重定向提示，
    # 所以从第一个 { 开始解析。
    start = text.find("{")
    if start < 0:
        log("WARN /tokens 响应里找不到 JSON（status=%s）" % status)
        return None
    try:
        data = json.loads(text[start:])
    except ValueError as exc:
        log("WARN /tokens JSON 解析失败: %s" % exc)
        return None
    return data.get("data") or []


def panel_post(path, payload):
    status, text = http_request(
        "POST",
        CONFIG["panel_base"] + path,
        json.dumps(payload, ensure_ascii=False),
        {"Content-Type": "application/json"},
        CONFIG["timeout_seconds"],
    )
    body = (text or "").strip()
    try:
        parsed = json.loads(body[body.find("{"):])
        return bool(parsed.get("success")), parsed.get("message") or ""
    except ValueError:
        return False, "status=%s body=%s" % (status, body[:160])


def fetch_desired():
    path = "/api/frp/agent/desired"
    if CONFIG["node_id"]:
        path += "?node=" + urllib.parse.quote(CONFIG["node_id"])
    status, text = None, ""
    for attempt in range(3):
        status, text = cloud_request("GET", path)
        if status == 200:
            break
        log("WARN 拉取期望状态失败（第 %d 次）: status=%s body=%s" % (attempt + 1, status, (text or "")[:200]))
        time.sleep(3)
    if status != 200:
        return None
    try:
        return json.loads(text)
    except ValueError as exc:
        log("WARN 期望状态 JSON 解析失败: %s" % exc)
        return None


def norm_ports(value):
    """面板的 ports 可能是 int / "30001" / "30001-30010"，统一成可比较的字符串集合。"""
    out = []
    for item in value or []:
        out.append(str(item).strip())
    return sorted(out)


def managed_prefixes():
    """
    哪些前缀算「归自动流程管的账号」。支持逗号分隔的多个前缀。

    ⚠️ 2026-10-14：新账号改用 `DC_` 前缀，但**已经发出去的 `dcfrp_` 账号必须继续被认**，
       否则它们会掉出管理范围（续期/停用/回收全部失效）。
       所以这里是「同时认两个」，不是把前缀换掉：user_prefix = "dcfrp_,DC_"
    """
    raw = CONFIG.get("user_prefix") or ""
    return tuple(p.strip() for p in str(raw).split(",") if p.strip())


def is_managed(name):
    """这个账号名归不归自动流程管。历史人工账号永远为 False。"""
    text = str(name)
    return any(text.startswith(p) for p in managed_prefixes())


def diff_plan(desired_users, panel_users):
    """
    产出要执行的动作列表。

    ⚠️ managed 只包含 managed_prefixes() 开头的账号 —— 面板里 46 个历史账号永远不在其中，
       因此下面的 REMOVE 不可能误删别人的账号。
    """
    panel_by_user = {}
    for row in panel_users:
        name = row.get("user")
        if isinstance(name, str):
            panel_by_user[name] = row

    managed = {name: row for name, row in panel_by_user.items() if is_managed(name)}
    desired_by_user = {}
    for row in desired_users:
        name = row.get("user")
        if isinstance(name, str) and is_managed(name):
            desired_by_user[name] = row

    actions = []

    for name, want in desired_by_user.items():
        have = managed.get(name)
        if have is None:
            actions.append(("ADD", name, {"want": want}))
            continue
        if bool(have.get("enable")) != bool(want.get("enable")):
            actions.append(("ENABLE" if want.get("enable") else "DISABLE", name, {"have": have, "want": want}))
        # 端口或 comment 变了 → /update。
        #
        # 为什么必须比 comment：到期日是写在 comment 里的（"DoulorCloud | active | 到期 2026-10-27"），
        # 而**续期只改到期日、不改 enable 也不改端口**。不比较 comment 的话，用户续了期，
        # 面板上仍显示旧的到期日 —— 管理员一看就以为没续上。
        if (
            norm_ports(have.get("ports")) != norm_ports(want.get("ports"))
            or str(have.get("comment") or "") != str(want.get("comment") or "")
        ):
            actions.append(("PUPDATE", name, {"have": have, "want": want}))

    # 只对「本站前缀 + 已不在期望列表里」的账号做清理（desired 侧 prune=true 才做）
    if CONFIG.get("_prune", True):
        for name, have in managed.items():
            if name not in desired_by_user:
                actions.append(("REMOVE", name, {"have": have}))

    return actions


def want_to_panel_user(want):
    return {
        "user": want["user"],
        "token": want["token"],
        "comment": want.get("comment", ""),
        "enable": bool(want.get("enable")),
        "ports": want.get("ports", []),
        "domains": [""],
        "subdomains": [""],
    }


def apply_actions(actions):
    """执行动作。dry_run 时只打印。返回 (已落地用户列表, 错误列表)。"""
    landed = []
    errors = []

    for kind, name, ctx in actions:
        if CONFIG["dry_run"]:
            log("DRY   %-8s %s" % (kind, name))
            landed.append({"user": name, "present": kind != "REMOVE", "enable": True})
            continue

        if kind == "ADD":
            ok, msg = panel_post("/add", want_to_panel_user(ctx["want"]))
        elif kind in ("ENABLE", "DISABLE"):
            endpoint = "/enable" if kind == "ENABLE" else "/disable"
            ok, msg = panel_post(endpoint, {"users": [ctx["have"]]})
        elif kind == "PUPDATE":
            ok, msg = panel_post("/update", {"before": ctx["have"], "after": want_to_panel_user(ctx["want"])})
        elif kind == "REMOVE":
            ok, msg = panel_post("/remove", {"users": [ctx["have"]]})
        else:
            ok, msg = False, "unknown action"

        log("%-8s %s -> %s %s" % (kind, name, "ok" if ok else "FAIL", msg))
        if ok:
            landed.append({"user": name, "present": kind != "REMOVE", "enable": ctx.get("want", {}).get("enable", False)})
        else:
            errors.append("%s %s: %s" % (kind, name, msg))
            landed.append({"user": name, "present": False, "error": msg})

    return [u for u in landed if is_managed(u["user"])], errors


def report(desired, landed, errors):
    payload = {
        "node": CONFIG["node_id"] or desired.get("node", {}).get("id"),
        "revision": desired.get("revision"),
        "users": landed,
    }
    if errors:
        payload["error"] = "; ".join(errors)[:1000]
    status, text = cloud_request("POST", "/api/frp/agent/report", payload)
    if status != 200:
        log("WARN 回报失败: status=%s body=%s" % (status, (text or "")[:200]))
    else:
        log("回报成功（%d 个账号，%d 个错误）" % (len(landed), len(errors)))


def save_state(desired, actions):
    try:
        with open(CONFIG["state_file"], "w") as fh:
            json.dump(
                {
                    "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "revision": desired.get("revision"),
                    "actions": [[a[0], a[1]] for a in actions],
                },
                fh,
                ensure_ascii=False,
                indent=2,
            )
    except OSError as exc:
        log("WARN 写状态文件失败: %s" % exc)


def managed_snapshot(panel_users):
    """
    把面板上所有**本前缀**账号的实际状态整理成回报体。

    为什么要回报全部而不是只回报「刚改过的」：管理端的「同步状态」是靠这份回报
    对账的。只报变化的话，某个订阅一旦没触发动作就会永远停在「待同步」；
    而且重新读一遍面板，顺带**验证了刚才那次写真的落地了**（而不是只信接口返回的 ok）。
    """
    out = []
    for row in panel_users or []:
        name = row.get("user")
        if isinstance(name, str) and is_managed(name):
            out.append({"user": name, "present": True, "enable": bool(row.get("enable"))})
    return out


def tick():
    desired = fetch_desired()
    if desired is None:
        return
    panel_users = panel_get_tokens()
    if panel_users is None:
        return

    CONFIG["_prune"] = bool(desired.get("prune", True))
    actions = diff_plan(desired.get("users", []), panel_users)

    if not actions:
        log("无变更（revision=%s，面板共 %d 个账号）" % (desired.get("revision"), len(panel_users)))
        report(desired, managed_snapshot(panel_users), [])
        return

    log("revision=%s 需要 %d 个动作：%s" % (
        desired.get("revision"),
        len(actions),
        ", ".join("%s:%s" % (a[0], a[1]) for a in actions),
    ))
    landed, errors = apply_actions(actions)
    save_state(desired, actions)
    after = panel_get_tokens()
    report(desired, managed_snapshot(after) if after is not None else landed, errors)


CONFIG = dict(DEFAULT_CONFIG)


def main():
    parser = argparse.ArgumentParser(description="frp-agent：把 DoulorCloud 的期望状态投影到本机 frps-panel")
    parser.add_argument("--config", default="/home/frp/frpagent/config.json")
    parser.add_argument("--once", action="store_true", help="只跑一轮就退出")
    parser.add_argument("--dry-run", action="store_true", help="强制 dry-run（只打印计划，不落地）")
    parser.add_argument("--live", action="store_true", help="强制落地（覆盖配置里的 dry_run）")
    args = parser.parse_args()

    if os.path.exists(args.config):
        with open(args.config) as fh:
            CONFIG.update(json.load(fh))
    else:
        log("配置文件不存在：%s" % args.config)
        sys.exit(1)

    if not CONFIG.get("agent_secret"):
        log("配置缺少 agent_secret，无法签名")
        sys.exit(1)

    if args.dry_run:
        CONFIG["dry_run"] = True
    if args.live:
        CONFIG["dry_run"] = False

    log("启动：cloud=%s node=%s prefix=%s dry_run=%s interval=%ss"
        % (CONFIG["cloud_base"], CONFIG["node_id"] or "(默认)", CONFIG["user_prefix"],
           CONFIG["dry_run"], CONFIG["interval_seconds"]))

    if args.once:
        tick()
        return

    while True:
        try:
            tick()
        except Exception as exc:  # noqa: BLE001
            log("ERROR 轮次异常（已吞掉，不影响下一轮）：%s: %s" % (type(exc).__name__, exc))
        time.sleep(int(CONFIG["interval_seconds"]))


if __name__ == "__main__":
    main()
