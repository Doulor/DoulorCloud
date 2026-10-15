#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DoulorCloud 自研 frp 面板服务 —— 替代第三方 `frps-panel`。

它同时是两个东西：
  1. **frps 的 httpPlugin 服务端**：实现 `/handler` 上的 6 种回调
     （Login / NewProxy / CloseProxy / Ping / NewWorkConn / NewUserConn）
  2. **账号管理 API**：与旧面板**逐字兼容**的 JSON 接口
     （GET /tokens、POST /add|/update|/remove|/enable|/disable），
     这样现有的 frp-agent **一行都不用改**就能接过来

为什么自己写（而不是继续用第三方面板）：
  · 第三方面板 2.0.0 有**未授权读取全部账号令牌**的漏洞
    （它的鉴权中间件发 307 跳登录，但**没有中断后续 handler**，
      于是响应体里连数据一起发出来了；
      实测：外网 `curl http://IP:7200/tokens` 能拿到全部 user+token）
  · 它只会绑 0.0.0.0（配置注释写明默认 127.0.0.1，但现场被改成了 0.0.0.0）
  · 我们要的「到期即拒」语义要握在自己手里

============================= 实测踩过的坑 =============================

🔴 **坑 1：放行时必须回 `unchange: true`**（这条最贵，花了很久才定位）

frp 的 `pkg/plugin/server/manager.go`：
    res = &Response{Reject: false, Unchange: true}      // 默认值
    res, retContent, err = p.Handle(ctx, op, *content)  // 插件响应**整体覆盖** res
    if !res.Unchange {
        content = retContent.(*T)                       // 用插件返回的 content 覆盖原消息
    }
而 `pkg/plugin/server/http.go` 里 `res.Content` 被预分配成一个**空的** `*LoginContent`。
所以插件若回 `{"unchange": false, "content": {}}`，frps 会拿这个空结构**把 Login 消息整个覆盖**
（`privilege_key` 变空串、`timestamp` 变 0），随后 frps 自己的 token 校验必然失败：

    token in login doesn't match token from configuration

表现为「换什么 auth.token 都没用」，极易误判成配置问题。
→ 结论：**放行且不修改内容时，必须回 `unchange: true`**。

🔴 **坑 2：鉴权字段是 `content.metas["token"]`，不是 privilege_key**

实测抓包（frpc 配 `user` + `metadatas.token`）：
    Login content = {
      version, os, arch, user,
      privilege_key,        # = md5(auth.token + timestamp)，frps 自己校验用，与账号无关
      timestamp,
      metas: {"token": "..."},   # ← 每用户的账号凭据在这里
      client_spec, pool_count, client_address
    }
`privilege_key` 是 **frps 全局 auth.token** 的派生值（已实测反推出 md5(token+ts)），
不是账号凭据，**不要拿它当用户令牌**。

🔴 **坑 3：服务器 python3 是 3.6.8**

没有 `http.server.ThreadingHTTPServer`（3.7+ 才有）、没有 dataclasses（3.7+）、
没有海象运算符（3.8+）。整个文件守 3.6 语法。

🔴 **坑 4：Ping 回调的触发条件很苛刻，而且很容易误判成「它不工作」**

Ping **会**被回调 —— 但需要**双端**都配：

    # frps.toml 与 frpc.toml 都要有
    auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

只配客户端不够（`VerifyPing` 读的是 frps 自己那份 scopes，不在 scopes 里就直接返回、
根本走不到插件）。实测抓包（双端都配 + `transport.heartbeatInterval = 10`）：

    op=Login / op=NewProxy / op=Ping / op=NewWorkConn     ← Ping 确实来了

⚠️ **我在这里栽过一次**：上面这份「Ping 不来」的结论曾经是错的 —— 因为我只看**面板日志**，
而当时面板的成功路径（Ping/NewWorkConn）**没有打日志**，于是「没看到」被误读成「没发生」。
教训：**凡是回调，进出都要留痕**，否则排查时会得出反向结论。

三种强制点（都已实测存在）：

  | 回调 | 触发时机 | 拒绝的效果 |
  |---|---|---|
  | `Login` | 客户端登录 / 断线重连 | 隧道建立不起来 |
  | `NewWorkConn` | **每次访客连入隧道** | frps **立刻重置**该访客连接（实测 2ms） |
  | `Ping` | 连接建立时 + 每 `heartbeatInterval` | frps 断开该客户端 |

三者**互补**：`Ping` 负责把已在线但已失效的客户端踢下线，`NewWorkConn` 负责让
「还挂在线上」的隧道立刻搬不动数据，`Login` 负责挡住重连。
**不管 Ping 是否被配置出来，到期语义都不会失效** —— 因为 `NewWorkConn` 一定会来。

============================= 运行 =============================
    python3 panel.py --config panel.json
默认只监听 127.0.0.1:7200（**绝不绑 0.0.0.0**）。
"""
import argparse
import base64
import hashlib
import hmac
import html
import json
import os
import re
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn


# ---------------------------------------------------------------- Python 3.6 兼容
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """3.6 没有 http.server.ThreadingHTTPServer，自己拼一个。"""

    daemon_threads = True
    allow_reuse_address = True


# ---------------------------------------------------------------- 配置
DEFAULT_CONFIG = {
    "listen_host": "127.0.0.1",       # 🔴 默认只监听本机
    "listen_port": 7200,
    "data_file": "accounts.json",
    "log_file": "panel.log",
    # agent 通道 HMAC 密钥（与 DoulorCloud 的 FRP_AGENT_SECRET 一致）；
    # 留空则 agent 专用端点全部 503，不会退化成「无鉴权可用」
    "agent_secret": "",
    # 只管理这个前缀的账号：面板里可能有管理员手工建的历史账号，绝不能被自动流程碰
    "user_prefix": "dcfrp_",
    # frps 的全局 auth.token，仅用于日志/体检，不参与账号鉴权
    "frps_global_token": "",
    # ---- 网页界面 / 登录 ----
    # 管理员登录网页界面用的账号口令。**留空则网页界面整体不可用**（不会退化成无鉴权页面）。
    "admin_user": "",
    "admin_password": "",
    # 会话 cookie 的签名密钥；留空会自动生成一个随机值（重启后旧会话失效，无妨）
    "session_secret": "",
    # 会话有效期（秒）
    "session_ttl": 12 * 3600,
    # 登录失败次数上限与封禁时长（防暴力破解）
    "login_max_fails": 8,
    "login_ban_seconds": 900,
    # 🔴 是否允许监听非本机地址。
    #    默认 false。只有**同时**配好了网页登录口令，才允许打开 ——
    #    否则这个服务一暴露出去就是「未授权可读全部令牌」。
    "allow_public_bind": False,
    # ---- 生成 frpc config.toml 用 ----
    # 用户客户端该连的地址/端口（一般是服务器的公网域名或 IP + frps 的 bindPort）
    "frps_public_addr": "",
    "frps_bind_port": 7000,
    # 下发给用户的 frpc.toml 里是否带上这两个作用域（Ping 心跳要靠它才会回调）
    "config_additional_scopes": ["HeartBeats", "NewWorkConns"],
    # ---- 外部 API 密钥 ----
    # 多个具名密钥，可在面板「设置」里创建/吊销。每个：
    #   {id, name, secret, created_at, enabled}
    # ⚠️ 保留 agent_secret 作为单个旧密钥继续可用（向后兼容，别把现有调用方弄断）。
    "api_keys": [],
    # 代理名模板；frps 会在前面自动加上 "<user>." 前缀
    "proxy_name_template": "port-{port}",
    # ---- 租期默认值 ----
    "default_rental_days": 30,
    # 网页新建账号时默认分配的端口区间（留空则要求手工填）
    "default_port_start": 0,
    "default_port_end": 0,
    # ---- 定时机制 ----
    # 到期后是否自动把账号置为「停用」（默认关）。
    # ⚠️ 关着也有强制力：插件在 Login/NewWorkConn/Ping 上会**按 expire_at 直接拒绝**
    #    到期账号，所以访问控制不依赖这个开关。
    #    之所以默认关：如果 D1（唯一真值）里该账号仍算有效，agent 下一轮就会把它改回来，
    #    两边来回改没有意义。要开就明确地开。
    "auto_disable_expired": False,
    # 到期前多少天在界面上标成「即将到期」
    "expiring_soon_days": 3,
    # 后台巡检间隔（秒）
    "sweep_interval_seconds": 300,
}

CONFIG = dict(DEFAULT_CONFIG)

# 面板启动时用 --config 指定的文件（main() 里设置）。
# 设置页改完配置要写回这里，所以必须是能拿到的绝对路径。
CONFIG_PATH = ""


def save_config(updates):
    """
    把若干配置键写回配置文件，并**立即生效**（同时更新内存里的 CONFIG）。

    ⚠️ 先读原文件再合并，不是直接覆盖 —— 否则会把你手写在文件里、
       而面板 UI 不管的字段（比如以后新增的键）整个冲掉。
    ⚠️ 用 os.replace 而不是 os.rename：Windows 上 rename 目标已存在会抛异常
       （这个坑踩过一次，见 README）。
    """
    if not CONFIG_PATH:
        return False, "面板启动时没指定配置文件（--config），改动无法持久化"
    try:
        raw = {}
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                raw = json.load(fh) or {}
        if not isinstance(raw, dict):
            raw = {}
        raw.update(updates)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(raw, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, CONFIG_PATH)
        try:
            os.chmod(CONFIG_PATH, 0o600)
        except OSError:
            pass
        CONFIG.update(updates)
        return True, ""
    except Exception as exc:  # noqa: BLE001
        return False, "%s: %s" % (type(exc).__name__, exc)
LOG_LOCK = threading.Lock()


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    with LOG_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
        path = CONFIG.get("log_file")
        if path:
            try:
                with open(path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except IOError:
                pass


# ---------------------------------------------------------------- 账号存储
class Store(object):
    """
    账号存储：一个 JSON 文件 + 原子写 + 内存缓存。

    为什么不塞数据库：这份数据**很小**（几十~几千行）、**读极频繁**（每次登录都读）、
    **写极少**（只有购买/续费/回收时写）。文件 + 内存缓存足够，且运维上可直接
    `cat` 出来排障。写用「临时文件 + rename」保证不会读到半个文件。
    """

    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.accounts = {}       # user -> dict
        self.mtime = 0.0
        self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except IOError:
            raw = {}
        except ValueError as exc:
            log("WARN 账号文件解析失败，按空处理（原文件保留）: %s" % exc)
            raw = {}
        accounts = {}
        if isinstance(raw, dict) and isinstance(raw.get("accounts"), list):
            items = raw["accounts"]
        elif isinstance(raw, list):
            items = raw
        else:
            items = []
        for item in items:
            if isinstance(item, dict) and item.get("user"):
                accounts[str(item["user"])] = normalise_account(item)
        with self.lock:
            self.accounts = accounts
            try:
                self.mtime = os.path.getmtime(self.path)
            except OSError:
                self.mtime = 0.0
        log("账号文件已载入：%d 个账号（%s）" % (len(accounts), self.path))

    def reload_if_changed(self):
        """外部直接改文件时也能生效（排障友好）。"""
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            return
        if mtime != self.mtime:
            log("检测到账号文件被外部修改，重新载入")
            self._load()

    def _save_locked(self):
        tmp = self.path + ".tmp"
        payload = {
            "version": 1,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "accounts": list(self.accounts.values()),
        }
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        # ⚠️ 必须用 os.replace 而不是 os.rename：
        #    POSIX 的 rename 目标已存在会静默覆盖，**Windows 会直接抛 FileExistsError**。
        #    用 rename 的话，这个面板在 Windows 上第一次之后的每次写盘都会失败
        #    （表现是"操作成功但数据没变"），而 Linux 上完全看不出来。
        os.replace(tmp, self.path)
        try:
            self.mtime = os.path.getmtime(self.path)
        except OSError:
            pass

    def all(self):
        self.reload_if_changed()
        with self.lock:
            return list(self.accounts.values())

    def get(self, user):
        self.reload_if_changed()
        with self.lock:
            return self.accounts.get(user)

    def put(self, account):
        """新增或整体覆盖一个账号（/add 与 /update 都走它）。"""
        with self.lock:
            self.accounts[account["user"]] = account
            self._save_locked()
        return account

    def remove(self, user):
        with self.lock:
            existed = self.accounts.pop(user, None)
            if existed is not None:
                self._save_locked()
        return existed is not None

    def set_enabled(self, user, enabled):
        with self.lock:
            account = self.accounts.get(user)
            if account is None:
                return False
            account["enable"] = bool(enabled)
            self._save_locked()
            return True


# ---------------------------------------------------------------- 账号模型
#
# 🔴 端口可以是**整数**，也可以是**区间字符串**（`"1000-55555"`）。
#
# 为什么必须支持区间：旧面板就是这么存的。有两个真实账号用的是
# `["1000-55555"]` 和 `["2025-30000"]` —— 每个都是几万个端口。
# 早期版本在导入时把它们**展开成整数列表**，还设了 2000 个的上限，
# 结果这两个账号的端口列表变成**空的** → 插件按"端口是否分配给我"判定 →
# 这个账号的所有隧道全被拒。所以区间必须原样保留并参与匹配。
PORT_RANGE_RE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*$")


def port_allowed(ports, port):
    """
    这个端口是否分配给了该账号。ports 里可以混着整数和区间字符串。
    """
    try:
        port = int(port)
    except (TypeError, ValueError):
        return False
    for item in ports or []:
        if isinstance(item, int):
            if item == port:
                return True
            continue
        m = PORT_RANGE_RE.match(str(item))
        if m:
            try:
                if int(m.group(1)) <= port <= int(m.group(2)):
                    return True
            except ValueError:
                continue
        else:
            try:
                if int(str(item)) == port:
                    return True
            except (TypeError, ValueError):
                continue
    return False


def normalise_account(raw):
    """
    统一账号形状 —— 与第三方面板**逐字兼容**：
      {user, token, comment, enable, ports[], domains[], subdomains[]}
    另外加一个我们自己的字段：
      expire_at —— 显式到期时间（ISO8601）。不靠解析 comment 里的中文日期。
    ports 里整数和区间字符串都保留（见上面 PORT_RANGE_RE 的说明）。
    """
    ports = []
    for p in raw.get("ports") or []:
        if isinstance(p, bool):
            continue
        if isinstance(p, int):
            ports.append(p)
            continue
        text = str(p).strip()
        m = PORT_RANGE_RE.match(text)
        if m:
            ports.append("%d-%d" % (int(m.group(1)), int(m.group(2))))
            continue
        try:
            ports.append(int(text))
        except (TypeError, ValueError):
            continue
    # 去重但不排序 —— 排序会把区间字符串和整数混在一起比较（Python 3 会直接报错）
    seen, uniq = set(), []
    for p in ports:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return {
        "user": str(raw.get("user") or ""),
        "token": str(raw.get("token") or ""),
        "comment": str(raw.get("comment") or ""),
        "enable": bool(raw.get("enable", True)),
        "ports": uniq,
        "domains": [str(d) for d in (raw.get("domains") or [""])],
        "subdomains": [str(s) for s in (raw.get("subdomains") or [""])],
        "expire_at": raw.get("expire_at") or "",
    }


EXPIRED_RE = re.compile(r"到期\s*(\d{4}-\d{2}-\d{2})")


def account_expired(account, now=None):
    """
    到没到期。两条依据，任一命中就算过期：
      1. 显式字段 expire_at（推荐，我们自己的数据用它）
      2. 从 comment 里解析 `到期 YYYY-MM-DD`（兼容旧面板写下的格式）

    返回 (是否过期, 说明)。到期**判定按当天结束**：写 2026-11-12 就到当天 23:59:59 为止。
    """
    now = now or time.time()
    today = time.strftime("%Y-%m-%d", time.localtime(now))

    raw = (account.get("expire_at") or "").strip()
    if raw:
        day = raw[:10]
        if len(day) == 10 and day < today:
            return True, "已于 %s 到期" % day
        return False, ""

    m = EXPIRED_RE.search(account.get("comment") or "")
    if m:
        day = m.group(1)
        if day < today:
            return True, "已于 %s 到期" % day
    return False, ""


def check_account(account, token, now=None):
    """
    账号能不能用。返回 (ok, 原因)。

    ⚠️ 这里刻意做成**单一判定入口**：Login / NewProxy / Ping 三处都调它，
    避免「登录时查了、后续动作忘了查」这种最典型的口子。
    """
    if account is None:
        return False, "账号不存在"
    if not account.get("enable", True):
        return False, "账号已被停用"
    expired, why = account_expired(account, now)
    if expired:
        return False, why
    if not account.get("token"):
        return False, "账号缺少令牌（数据异常，请联系管理员）"
    if not hmac.compare_digest(str(account["token"]), str(token or "")):
        return False, "令牌不匹配"
    return True, ""


# ---------------------------------------------------------------- HMAC 私有管理 API
#
# 与 DoulorCloud Worker 现有的 agent 通道**完全同一套签名**，Worker 侧不用改代码：
#   请求头:  X-Frp-Agent-Ts: <unix 秒>
#            X-Frp-Agent-Signature: <hex>
#   canonical = "\n".join([ts, METHOD, pathname+search, sha256hex(body)])
#   signature = HMAC-SHA256(agent_secret, canonical) 的十六进制小写
#   时间容差 300 秒；比较用 timing-safe；未配密钥一律 503（**绝不退化成无鉴权**）。
#
# 有了它，Worker 就能**直接**管理账号，不必再依赖服务器上的 agent 轮询进程
# （agent 仍然保留，作为可回退路径 —— 见 README）。
AGENT_TS_TOLERANCE_SEC = 300


def _sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def _active_secrets():
    """
    当前可用的 HMAC 密钥列表 [(id, secret), ...]。支持两种来源：
      · agent_secret —— 单个密钥（老配置，继续兼容）
      · api_keys[]   —— 多个具名密钥，可在面板里创建/吊销
    """
    out = []
    legacy = (CONFIG.get("agent_secret") or "").strip()
    if legacy:
        out.append(("agent_secret", legacy))
    for item in CONFIG.get("api_keys") or []:
        if not isinstance(item, dict):
            continue
        if not item.get("enabled", True):
            continue
        secret = (item.get("secret") or "").strip()
        if secret:
            out.append((item.get("name") or item.get("id") or "unnamed", secret))
    return out


def verify_agent_request(method, path_with_query, headers, body):
    """
    校验 HMAC 签名。返回 (ok, 原因)。
    ok 为 True 时第二个值是**命中的密钥名**（用于日志里区分是谁调的）；
    ok 为 False 时是失败原因。任何一步不满足都失败，且**不泄漏**是密钥错还是签名错。
    """
    secrets = _active_secrets()
    if not secrets:
        return False, "disabled"
    ts = headers.get("X-Frp-Agent-Ts") or ""
    sig = headers.get("X-Frp-Agent-Signature") or ""
    if not ts or not sig:
        return False, "missing"
    try:
        ts_int = int(ts)
    except (TypeError, ValueError):
        return False, "bad_ts"
    if abs(time.time() - ts_int) > AGENT_TS_TOLERANCE_SEC:
        return False, "stale_ts"
    canonical = "\n".join([str(ts), method.upper(), path_with_query, _sha256_hex(body or b"")])
    sig = sig.lower()
    # 逐个密钥试。用 compare_digest 做常数时间比较；命中就返回。
    for name, secret in secrets:
        expected = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"),
                            hashlib.sha256).hexdigest()
        if hmac.compare_digest(expected, sig):
            return True, name
    return False, "bad_signature"


# ---------------------------------------------------------------- 在线状态
#
# frps 的插件回调本来就带着 user —— 每次 Login / Ping / NewWorkConn / NewUserConn
# 都等于在说「这个账号还活着」。我们只要记住最后一次看到它的时间。
#
# 为什么用「最后活动 + TTL」而不是精确的隧道计数：
#   · 计数要在 NewProxy / CloseProxy 上维护，面板一重启就全丢；而且客户端被 kill 时
#     往往收不到 CloseProxy，会留下**永远在线的幽灵**。
#   · 时间戳法自带自愈：客户端断了心跳就停，TTL 一过自然变离线；
#     面板重启也只是暂时显示全部离线，下一个心跳周期就恢复。
#
# ⚠️ 必须加锁：插件回调是多线程的（ThreadingHTTPServer）。
#    这个坑在主题/密度上踩过一次 —— 全局可变状态不加锁，高并发下会读到写坏的 dict。
ONLINE_TTL_SEC = 90
_online_lock = threading.Lock()
_online_seen = {}


def note_online(user):
    """记下这个账号刚刚活动过。插件回调的成功路径都要调它。"""
    name = str(user or "")
    if not name:
        return
    now = time.time()
    with _online_lock:
        _online_seen[name] = now
        # 长期运行时 dict 会无限增长，顺手清掉过期项
        if len(_online_seen) > 2000:
            for stale in [k for k, t in _online_seen.items() if now - t > ONLINE_TTL_SEC]:
                _online_seen.pop(stale, None)


def online_map():
    """返回 {user: 距上次活动的秒数}，只含 TTL 内的。"""
    now = time.time()
    with _online_lock:
        return {u: now - t for u, t in _online_seen.items() if now - t <= ONLINE_TTL_SEC}


def human_since(seconds):
    """把秒数说成人话。"""
    seconds = int(seconds or 0)
    if seconds < 60:
        return "%d 秒前" % seconds
    if seconds < 3600:
        return "%d 分钟前" % (seconds // 60)
    return "%d 小时前" % (seconds // 3600)


# ---------------------------------------------------------------- 插件回调
def plugin_response_allow():
    """
    🔴 `unchange: true` 是必须的 —— 见文件顶部「坑 1」。
    回 `unchange: false` + 空的 content 会把 frps 的消息清空，导致 token 校验必失败。
    """
    return {"reject": False, "reject_reason": "", "unchange": True}


def plugin_response_reject(reason):
    return {"reject": True, "reject_reason": reason, "unchange": True}


def handle_plugin_op(op, content, store):
    """处理一次插件回调，返回响应 dict。"""
    if not isinstance(content, dict):
        content = {}

    if op == "Login":
        user = str(content.get("user") or "")
        metas = content.get("metas") or {}
        token = metas.get("token") if isinstance(metas, dict) else ""
        account = store.get(user)
        ok, why = check_account(account, token)
        if not ok:
            log("REJECT Login user=%r 原因=%s" % (user, why))
            return plugin_response_reject("登录被拒：%s" % why)
        log("ALLOW  Login user=%r 端口=%s" % (user, account.get("ports")))
        note_online(user)
        return plugin_response_allow()

    # 其余事件都带 user 子对象
    user_info = content.get("user")
    user = ""
    if isinstance(user_info, dict):
        user = str(user_info.get("user") or "")
    elif isinstance(user_info, str):
        user = user_info

    account = store.get(user)
    ok, why = check_account(account, account.get("token") if account else "")

    if op == "NewProxy":
        if not ok:
            log("REJECT NewProxy user=%r 原因=%s" % (user, why))
            return plugin_response_reject("无法建立隧道：%s" % why)
        try:
            remote_port = int(content.get("remote_port") or 0)
        except (TypeError, ValueError):
            remote_port = 0
        allowed = account.get("ports") or []
        # ⚠️ 用 port_allowed 而不是 `in` —— ports 里可能是区间字符串（如 "1000-55555"）。
        #    真实账号里就有两个是这种，用 `in` 会把它们全拒掉。
        if remote_port and allowed and not port_allowed(allowed, remote_port):
            log("REJECT NewProxy user=%r 端口 %d 不在 %s" % (user, remote_port, allowed))
            return plugin_response_reject(
                "端口 %d 未被分配给你（你的端口：%s）" % (remote_port, allowed)
            )
        log("ALLOW  NewProxy user=%r proxy=%r port=%d"
            % (user, content.get("proxy_name"), remote_port))
        return plugin_response_allow()

    if op in ("Ping", "NewWorkConn", "NewUserConn"):
        if not ok:
            # 到期/停用在这里被拒。
            #
            # Ping 每 `transport.heartbeatInterval` 秒一次（客户端 + 服务端都要在
            # auth.additionalScopes 里包含 HeartBeats 才会发生），
            # 拒绝它 frps 会断开该客户端 —— 这是「到期后把在线客户端踢下线」的通路。
            # NewWorkConn 在**每次访客连入隧道**时触发，拒绝它 frps 会立刻重置这条连接。
            log("REJECT %s user=%r 原因=%s" % (op, user, why))
            return plugin_response_reject("会话已失效：%s" % why)
        # ⚠️ 成功路径也一定要打日志。
        #    之前这里不打日志，导致「Ping 在正常工作」被我误读成「Ping 从不回调」，
        #    白白绕了很久。凡是回调，进出都要留痕。
        log("ALLOW  %s user=%r" % (op, user))
        # 心跳 = 这个账号还活着。这是「谁在线」的唯一数据来源。
        note_online(user)
        return plugin_response_allow()

    if op == "CloseProxy":
        # 关闭动作永远放行：账号已失效时更要让它关掉
        return plugin_response_allow()

    log("WARN 未知插件事件 op=%r，保守放行" % op)
    return plugin_response_allow()


# ---------------------------------------------------------------- 登录与会话
#
# 设计要点（这几条直接决定「能不能安全地开到公网」）：
#
#   1. **本机回环请求免登录**，公网请求必须登录。
#      frps 的插件回调、agent 都从 127.0.0.1 来，所以它们一行都不用改；
#      而外部请求哪怕是 /tokens 这种兼容接口，也必须先登录。
#   2. 网页口令**留空则网页整体不可用**（不会退化成无鉴权页面）。
#   3. 会话 cookie 是 HMAC 签名的「过期时间」，**服务端不存任何会话状态** ——
#      没有会话表就没有会话表被读穿的可能。
#   4. 登录失败按 IP 计数封禁，挡暴力破解。
#   5. 时间比较一律用 hmac.compare_digest（定时安全）。
SESSION_COOKIE = "frp_panel_session"
_login_fails = {}          # ip -> [连续失败次数, 封禁到什么时候]
_login_lock = threading.Lock()
_revoked_sessions = {}     # session_id -> 该会话原本的过期时间（用于清理）
_revoked_lock = threading.Lock()


def _session_secret():
    s = CONFIG.get("session_secret") or ""
    if not s:
        # 没配就随机生成一个，进程生命周期内稳定
        s = base64.b16encode(os.urandom(16)).decode("ascii")
        CONFIG["session_secret"] = s
    return s.encode("utf-8")


def _session_sig(payload):
    return hmac.new(_session_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def make_session_token(now=None):
    """
    会话令牌 = `<过期时间>.<会话id>.<签名>`。

    为什么要有「会话 id」：如果只有「签名的过期时间」，服务端什么都不存，
    那么**登出就只是清掉浏览器 cookie，令牌本身到期前照样能用** ——
    被偷走的 cookie 无法作废。带上 id 之后，登出可以把 id 记进吊销表，
    真正让那个会话立刻失效。（只吊销具体会话，不影响其它已登录的浏览器。）
    """
    expires = int((now or time.time()) + int(CONFIG.get("session_ttl") or 43200))
    sid = base64.b16encode(os.urandom(8)).decode("ascii")
    payload = "%d.%s" % (expires, sid)
    return payload + "." + _session_sig(payload)


def revoke_session_token(token):
    """把令牌标记为已吊销。返回是否成功解析。"""
    parts = (token or "").split(".")
    if len(parts) != 3:
        return False
    payload = parts[0] + "." + parts[1]
    if not hmac.compare_digest(_session_sig(payload), parts[2]):
        return False
    try:
        expires = int(parts[0])
    except ValueError:
        return False
    now = time.time()
    with _revoked_lock:
        _revoked_sessions[parts[1]] = expires
        # 顺手清掉已经自然过期的吊销记录，别让这张表无限长
        for sid in [k for k, exp in _revoked_sessions.items() if exp < now]:
            _revoked_sessions.pop(sid, None)
    return True


def verify_session_token(token, now=None):
    parts = (token or "").split(".")
    if len(parts) != 3:
        return False
    expires_text, sid, sig = parts
    payload = expires_text + "." + sid
    if not hmac.compare_digest(_session_sig(payload), sig):
        return False
    try:
        expires = int(expires_text)
    except ValueError:
        return False
    if expires <= (now or time.time()):
        return False
    with _revoked_lock:
        if sid in _revoked_sessions:
            return False
    return True


def ui_enabled():
    """网页界面是否可用。口令没配就整体关闭 —— 绝不退化成无鉴权页面。"""
    return bool(CONFIG.get("admin_user")) and bool(CONFIG.get("admin_password"))


def check_password(user, password):
    if not ui_enabled():
        return False
    ok_user = hmac.compare_digest(str(CONFIG["admin_user"]), str(user or ""))
    ok_pass = hmac.compare_digest(str(CONFIG["admin_password"]), str(password or ""))
    return ok_user and ok_pass


def login_banned(ip):
    with _login_lock:
        rec = _login_fails.get(ip)
        return bool(rec and rec[1] > time.time())


def note_login_fail(ip):
    with _login_lock:
        rec = _login_fails.setdefault(ip, [0, 0])
        rec[0] += 1
        if rec[0] >= int(CONFIG.get("login_max_fails") or 8):
            rec[1] = time.time() + int(CONFIG.get("login_ban_seconds") or 900)
            rec[0] = 0
            log("WARN 登录失败过多，暂时封禁来源 %s" % ip)


def note_login_ok(ip):
    with _login_lock:
        _login_fails.pop(ip, None)


# ---------------------------------------------------------------- CSRF
#
# 这个面板的写操作**改了就等于改生产**（改账号=改谁能连隧道），所以必须防 CSRF。
# 用标准做法「double-submit cookie」：表单里带一个签名过的随机串，
# cookie 里也放同一个；服务端校验两者一致且签名有效。
# 这样**本机回环（免登录）那条路径也有保护** —— 否则在服务器上开个网页
# 被人诱导点一下就改了账号。
CSRF_COOKIE = "frp_panel_csrf"


def new_csrf_token():
    nonce = base64.b16encode(os.urandom(16)).decode("ascii")
    sig = hmac.new(_session_secret(), b"csrf:" + nonce.encode("utf-8"),
                   hashlib.sha256).hexdigest()
    return nonce + "." + sig


def csrf_token_valid(token):
    if not token or "." not in token:
        return False
    nonce, _, sig = token.partition(".")
    expected = hmac.new(_session_secret(), b"csrf:" + nonce.encode("utf-8"),
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


# ---------------------------------------------------------------- 账号字段解析与校验
USER_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")


def parse_ports(text):
    """
    解析用户输入的端口：支持 `31000 31001`、`31000,31001`、`31200-31202` 混写。
    返回 (端口列表, 错误列表)。区间会展开 —— 判定用的是「这个端口是否分配给我」。
    """
    ports = []
    errors = []
    for chunk in re.split(r"[,\s;，、]+", (text or "").strip()):
        if not chunk:
            continue
        if "-" in chunk:
            left, _, right = chunk.partition("-")
            try:
                start, end = int(left), int(right)
            except ValueError:
                errors.append("端口区间写法不对：%s" % chunk)
                continue
            if end < start or end - start > 200:
                errors.append("端口区间不合理（最多 200 个）：%s" % chunk)
                continue
            ports.extend(range(start, end + 1))
        else:
            try:
                ports.append(int(chunk))
            except ValueError:
                errors.append("不是合法端口：%s" % chunk)
    for p in ports:
        if not (1 <= p <= 65535):
            errors.append("端口超出范围：%d" % p)
    return sorted(set(ports)), errors


def compute_expire_at(mode, days, date_text, base=None):
    """
    算出 expire_at（ISO8601，带当天 23:59:59）。
    mode: 'days'（从现在起 N 天）| 'date'（指定日期）| 'keep'（不改）| 'forever'（清空）
    返回 (expire_at, 错误)
    """
    now = base or time.time()
    if mode == "forever":
        return "", ""
    if mode == "keep":
        return None, ""
    if mode == "date":
        text = (date_text or "").strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", text):
            return None, "到期日格式应为 YYYY-MM-DD"
        return text + "T23:59:59Z", ""
    # days
    try:
        n = int(str(days).strip())
    except (TypeError, ValueError):
        return None, "天数必须是整数"
    if n < 1 or n > 3650:
        return None, "天数应在 1~3650 之间"
    # 从**当天**往后算 n 天（含今天），避免"买 1 天立刻过期"这种坑
    today = time.mktime(time.strptime(time.strftime("%Y-%m-%d", time.localtime(now)),
                                      "%Y-%m-%d"))
    return time.strftime("%Y-%m-%d", time.localtime(today + (n - 1) * 86400)) + "T23:59:59Z", ""


def days_left(account, now=None):
    """还剩多少天（负数=已过期，None=无到期日）。"""
    now = now or time.time()
    raw = (account.get("expire_at") or "")[:10]
    if not raw:
        m = EXPIRED_RE.search(account.get("comment") or "")
        raw = m.group(1) if m else ""
    if not raw:
        return None
    try:
        target = time.mktime(time.strptime(raw, "%Y-%m-%d"))
    except ValueError:
        return None
    today = time.mktime(time.strptime(time.strftime("%Y-%m-%d", time.localtime(now)),
                                      "%Y-%m-%d"))
    return int(round((target - today) / 86400))


def new_token():
    """生成一个 32 字符的账号令牌。"""
    return base64.b64encode(os.urandom(24)).decode("ascii").replace("+", "").replace("/", "")[:32]


def next_free_ports(store, count, start=None, end=None):
    """从默认区间里挑几个没被占用的端口。"""
    start = int(start or CONFIG.get("default_port_start") or 0)
    end = int(end or CONFIG.get("default_port_end") or 0)
    if not (start and end and end >= start):
        return []
    used = set()
    for a in store.all():
        for p in (a.get("ports") or []):
            try:
                used.add(int(p))
            except (TypeError, ValueError):
                pass
    out = []
    for p in range(start, end + 1):
        if p not in used:
            out.append(p)
            if len(out) >= count:
                break
    return out


# ---------------------------------------------------------------- 生成 frpc config.toml
def render_frpc_config(account):
    """
    生成用户可以**直接拿去用**的 frpc.toml。

    形状照抄线上真实在用的那份（实测抓过报文确认字段名）：
      serverAddr / serverPort / auth.method / auth.token / user / metadatas.token
      + 每个端口一个 [[proxies]]
    """
    def q(s):
        return '"%s"' % str(s).replace("\\", "\\\\").replace('"', '\\"')

    addr = CONFIG.get("frps_public_addr") or "<你的服务器地址>"
    port = int(CONFIG.get("frps_bind_port") or 7000)
    gt = CONFIG.get("frps_global_token") or ""

    lines = [
        "# DoulorCloud 内网穿透 —— 客户端配置",
        "# 账号: %s" % account.get("user", ""),
        "# 到期: %s" % ((account.get("expire_at") or "")[:10] or "无"),
        "",
        "serverAddr = %s" % q(addr),
        "serverPort = %d" % port,
        "",
        'auth.method = "token"',
        "auth.token = %s" % q(gt),
    ]
    scopes = CONFIG.get("config_additional_scopes") or []
    if scopes:
        lines.append("auth.additionalScopes = [%s]"
                     % ", ".join(q(s) for s in scopes))
    lines += [
        "",
        "user = %s" % q(account.get("user", "")),
        "metadatas.token = %s" % q(account.get("token", "")),
        "",
        'log.level = "info"',
        "",
        "# 下面每条对应一个已分配给你的端口。",
        "# 把 localIP / localPort 改成你本机真正要暴露的服务。",
    ]

    for p in (account.get("ports") or []):
        name = str(CONFIG.get("proxy_name_template") or "port-{port}").replace("{port}", str(p))
        lines += [
            "",
            "[[proxies]]",
            "name = %s" % q(name),
            'type = "tcp"',
            'localIP = "127.0.0.1"',
            "localPort = %d" % p,
            "remotePort = %d" % p,
        ]
    lines.append("")
    return "\n".join(lines)


def expiry_histogram(accounts, weeks=12, now=None):
    """
    未来 N 周每周到期的账号数。

    回答的是"接下来会不会有一批人同时掉线"—— 表格里散着看不出这个规律。
    返回 (桶, 已过期数, 无到期日数, 更远数)，桶是 [(第几周, 起始日, 数量), ...]。
    """
    now = now or time.time()
    today = time.mktime(time.strptime(time.strftime("%Y-%m-%d", time.localtime(now)),
                                      "%Y-%m-%d"))
    counts = [0] * weeks
    overdue = forever = later = 0
    for a in accounts:
        left = days_left(a, now)
        if left is None:
            forever += 1
        elif left < 0:
            overdue += 1
        elif left // 7 >= weeks:
            later += 1
        else:
            counts[int(left // 7)] += 1
    buckets = []
    for i, n in enumerate(counts):
        start = time.strftime("%m-%d", time.localtime(today + i * 7 * 86400))
        buckets.append((i + 1, start, n))
    return buckets, overdue, forever, later


def render_histogram(buckets, overdue, later):
    """把分布画成一排柱子。纯 CSS，没有图表库。"""
    peak = max([n for _i, _d, n in buckets] + [1])
    bars = []
    for idx, start, n in buckets:
        pct = int(round(n * 100.0 / peak)) if n else 0
        # 0 也留一条 2% 的底座，否则"没有"和"没有柱子"分不清
        h = max(2, pct)
        kind = "warn" if n else "empty"
        bars.append(
            '<div class="hist-col" title="第 %d 周（%s 起）：%d 个账号到期">'
            '<span class="hist-n %s">%s</span>'
            '<div class="hist-track"><i class="%s" style="height:%d%%"></i></div>'
            '<span class="hist-x">%s</span></div>'
            % (idx, start, n, "" if n else "dim", n if n else "",
               kind, h, start))

    legend = []
    if overdue:
        legend.append('<span class="pill bad"><i></i>已过期 %d</span>' % overdue)
    legend.append('<span class="pill"><i></i>12 周内 %d</span>'
                  % sum(n for _i, _d, n in buckets))
    if later:
        legend.append('<span class="pill off"><i></i>12 周以外 %d</span>' % later)

    return """<section class="histcard">
  <div class="hist-head"><h2>到期分布</h2>
    <span class="dim" style="font-size:12px">未来 12 周，按周</span>
    <span class="spacer"></span>%s</div>
  <div class="hist">%s</div>
</section>""" % ("".join(legend), "".join(bars))


# ---------------------------------------------------------------- 网页界面
#
# 设计取向（一次有意识的取舍，不是默认样式堆叠）：
#
#   色彩  一套**冷灰**体系 + **单一低饱和强调色**（HSL 约 227°/68%/63%，饱和度压在 80% 以下）。
#         不用高饱和蓝紫，也不用渐变 —— 那是「一眼 AI」的指纹。
#         状态色（正常/即将到期/已到期/停用）单独一套，刻意和强调色拉开。
#
#   字体  中文走系统优质字族；**数字与代码单独走等宽**，并对齐到 tabular-nums ——
#         端口、到期日、流量这类数据在管理面板里必须能竖着扫。
#         不引外部字体：面板是内网工具，不该为了好看去依赖 CDN。
#
#   层次  1px 描边 + 极浅的**带色阴影**（阴影带背景的冷调，不是纯黑压暗）。
#         圆角分级：容器 12px、控件 8px、胶囊 999px。
#
#   交互  160ms 过渡；悬停/按下/聚焦三种状态都有；键盘可达；删除用**两步确认**而不是弹窗。
#
#   管理  工具栏搜索（按 `/` 聚焦）、状态筛选、列排序、端口折叠、一键复制令牌/配置。
#         全部是渐进增强：**禁用 JS 也照样能看能改**。
PAGE_STYLE = """
/* ============================================================================
   配色与几何取自 FLClash（github.com/chen08209/FlClash）的做法：
     · useMaterial3 = true        → 用 Material 3 的颜色角色（color roles），
                                    不是随手挑几个好看的颜色
     · .withAppShapes             → 一套成体系的圆角，而不是每处随手写
     · 种子色生成色调板 + 纯黑模式 → surfaceContainerLow/High/Highest 分层
     · success/warning 与主色协调  → 状态色不是纯绿纯橙，而是被主色"拉"过
   下面是 M3 dark 基线角色（种子 #6750A4）。
   ⚠️ 想换主色只需要改 --md-primary 那一组，其余都是它的派生。
   ============================================================================ */
:root{
  color-scheme:dark;

  /* ---- M3 颜色角色（dark baseline）---- */
  --md-primary:#d0bcff;          --md-on-primary:#381e72;
  --md-primary-container:#4f378b; --md-on-primary-container:#eaddff;
  --md-secondary:#ccc2dc;        --md-on-secondary:#332d41;
  --md-secondary-container:#4a4458; --md-on-secondary-container:#e8def8;
  --md-tertiary:#efb8c8;
  --md-error:#f2b8b5;            --md-on-error:#601410;
  --md-error-container:#8c1d18;

  --md-surface:#141218;
  --md-surface-dim:#141218;
  --md-surface-bright:#3b383e;
  --md-surface-container-lowest:#0f0d13;
  --md-surface-container-low:#1d1b20;
  --md-surface-container:#211f26;
  --md-surface-container-high:#2b2930;
  --md-surface-container-highest:#36343b;

  --md-on-surface:#e6e0e9;
  --md-on-surface-variant:#cac4d0;
  --md-outline:#938f99;
  --md-outline-variant:#49454f;
  --md-scrim:#000;

  /* ---- 状态色：按 M3 的 harmonize 思路向主色偏移（不是纯绿纯橙）---- */
  --ok:#9ed8b4;  --ok-container:#2c4a38;
  --warn:#ecc06a; --warn-container:#4d3d1c;
  --bad:#f2b8b5;  --bad-container:#5c2b28;

  /* ---- M3 shapes（对应 .withAppShapes 的体系）---- */
  --sh-xs:4px; --sh-sm:8px; --sh-md:12px; --sh-lg:16px; --sh-xl:28px; --sh-full:999px;

  /* ---- 海拔：M3 用表面色调表示层级，阴影很轻 ---- */
  --el-1:0 1px 2px rgba(0,0,0,.30),0 1px 3px 1px rgba(0,0,0,.15);
  --el-2:0 1px 2px rgba(0,0,0,.30),0 2px 6px 2px rgba(0,0,0,.15);
  --el-3:0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.30);
}

/* ============================================================================
   亮色主题：M3 的 light 基线（同一颗种子 #6750A4）。
   只覆盖**颜色角色**，不动任何布局/几何 —— 所以两套主题的间距、圆角、
   交互完全一致，不会出现"换个主题就错位"。
   ============================================================================ */
html[data-theme="light"]{
  color-scheme:light;
  --md-primary:#6750a4;          --md-on-primary:#ffffff;
  --md-primary-container:#eaddff; --md-on-primary-container:#21005d;
  --md-secondary:#625b71;        --md-on-secondary:#ffffff;
  --md-secondary-container:#e8def8; --md-on-secondary-container:#1d192b;
  --md-tertiary:#7d5260;
  --md-error:#b3261e;            --md-on-error:#ffffff;
  --md-error-container:#f9dedc;

  --md-surface:#fef7ff;
  --md-surface-dim:#ded8e1;
  --md-surface-bright:#fef7ff;
  --md-surface-container-lowest:#ffffff;
  --md-surface-container-low:#f7f2fa;
  --md-surface-container:#f3edf7;
  --md-surface-container-high:#ece6f0;
  --md-surface-container-highest:#e6e0e9;

  --md-on-surface:#1d1b20;
  --md-on-surface-variant:#49454f;
  --md-outline:#79747e;
  --md-outline-variant:#cac4d0;
  --md-scrim:#000;

  /* 状态色同样向主色协调过，不是纯绿纯橙 */
  --ok:#1f6b45;  --ok-container:#d7f0e0;
  --warn:#7a5b12; --warn-container:#fbeecb;
  --bad:#a33a38;  --bad-container:#f9dedc;

  /* 亮色下阴影要更实一点才看得出层级（暗色靠表面色调就够了） */
  --el-1:0 1px 2px rgba(0,0,0,.10),0 1px 3px 1px rgba(0,0,0,.06);
  --el-2:0 1px 2px rgba(0,0,0,.10),0 2px 6px 2px rgba(0,0,0,.07);
  --el-3:0 4px 8px 3px rgba(0,0,0,.07),0 1px 3px rgba(0,0,0,.10);
}
html[data-theme="light"] a{color:#5b4b9e}
html[data-theme="light"] button,
html[data-theme="light"] .btn{color:var(--md-on-primary)}
html[data-theme="light"] button.ghost,
html[data-theme="light"] .btn.ghost{color:var(--md-on-secondary-container)}
html[data-theme="light"] button.quiet,
html[data-theme="light"] .btn.quiet{color:var(--md-on-surface-variant)}
html[data-theme="light"] button.danger,
html[data-theme="light"] .btn.danger{color:var(--md-error)}
html[data-theme="light"] pre{background:#f2ecf6;color:#1d1b20}
html[data-theme="light"] pre .c{color:#79747e}
html[data-theme="light"] pre .k{color:#6750a4}
html[data-theme="light"] pre .s{color:#1f6b45}
html[data-theme="light"] .toast{background:var(--md-surface-container-high)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
button,a,label,input,select,textarea,.chip{touch-action:manipulation}
button,a,.chip{-webkit-tap-highlight-color:rgba(208,188,255,.12)}
/* 顶栏(65px) + 吸顶表头(~44px) 会盖住滚动到视口顶部的元素 ——
   键盘 Tab 到行内按钮/勾选框时，它会藏在吸顶元素下面点不到。
   scroll-margin-top 让浏览器多滚一段，把它留在可视区里。 */
tbody tr,.acts a,.acts button,.col-sel input,#rows input{
  scroll-margin-top:120px;scroll-margin-bottom:24px}

body{
  margin:0;background:var(--md-surface);color:var(--md-on-surface);
  /* M3 typography：中文字族用系统优质字族；标签/正文分开定字重与字距 */
  font:400 14px/20px "Segoe UI Variable Text","Segoe UI","PingFang SC","Hiragino Sans GB",
       "Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
  letter-spacing:.01785714em;
  -webkit-font-smoothing:antialiased;
}
main,header.top{position:relative;z-index:2}
h1,h2,h3{text-wrap:balance;margin:0}
a{color:var(--md-primary);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:3px solid var(--md-primary);outline-offset:2px;border-radius:var(--sh-xs)}
.skip{position:absolute;left:-9999px;padding:10px 16px;display:inline-flex;align-items:center}
.skip:focus{left:12px;top:12px;z-index:99;background:var(--md-primary);
  color:var(--md-on-primary);border-radius:var(--sh-full);font-weight:600;text-decoration:none}

/* ---------- 顶栏：M3 的 surfaceContainer，靠色调分层而不是阴影 ---------- */
header.top{
  position:sticky;top:0;z-index:10;background:var(--md-surface-container);
  border-bottom:1px solid var(--md-outline-variant);
}
.top-in{max-width:1360px;margin:0 auto;padding:14px 26px;display:flex;gap:18px;align-items:center}
.brand{display:flex;align-items:baseline;gap:10px;min-width:0}
.brand h1{font-size:22px;line-height:28px;font-weight:400;letter-spacing:0;white-space:nowrap}
.brand .dot{width:10px;height:10px;border-radius:50%;background:var(--ok);flex:none}
.stats{display:flex;gap:16px;flex-wrap:wrap;color:var(--md-on-surface-variant);
  font-size:12px;line-height:16px;letter-spacing:.0333333em;margin-left:8px}
.stats b{color:var(--md-on-surface);font-weight:600}
.stats .n{font-variant-numeric:tabular-nums}
.spacer{flex:1}
.top-actions{display:flex;gap:8px;align-items:center}

.wrap{max-width:1360px;margin:0 auto;padding:22px 26px 72px}

/* ---------- 按钮：M3 的 filled / tonal / outlined / text 四档 ---------- */
button,.btn{
  font:inherit;font-size:14px;font-weight:500;line-height:20px;letter-spacing:.1px;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:10px 24px;min-height:40px;border-radius:var(--sh-full);
  border:1px solid transparent;background:var(--md-primary);color:var(--md-on-primary);
  cursor:pointer;white-space:nowrap;position:relative;overflow:hidden;
  transition:box-shadow .2s ease,background-color .2s ease,color .2s ease;
}
button:hover,.btn:hover{box-shadow:var(--el-1)}
button:active,.btn:active{box-shadow:none}
/* M3 的 state layer：悬停是在现有色上叠一层 onSurface 的 8%，
   而不是换一个颜色 —— 这样任何底色都自动有正确的对比度。 */
button::after,.btn::after{
  content:"";position:absolute;inset:0;background:currentColor;opacity:0;
  transition:opacity .15s ease;pointer-events:none;
}
button:hover::after,.btn:hover::after{opacity:.08}
button:focus-visible::after,.btn:focus-visible::after{opacity:.10}
button:active::after,.btn:active::after{opacity:.12}

/* tonal：次要动作 */
button.ghost,.btn.ghost{
  background:var(--md-secondary-container);color:var(--md-on-secondary-container);border-color:transparent;
}
/* outlined：低强调动作 */
button.quiet,.btn.quiet{
  background:transparent;color:var(--md-on-surface-variant);border-color:var(--md-outline);
}
button.quiet:hover,.btn.quiet:hover{color:var(--md-on-surface)}
button.danger,.btn.danger{background:transparent;color:var(--md-error);border-color:var(--md-error)}
button.mini,.btn.mini{padding:5px 14px;min-height:32px;font-size:13px;gap:6px}
button.mini.top,.btn.mini.top{min-height:40px;padding:8px 16px}
button[disabled],.btn[disabled]{opacity:.38;pointer-events:none;box-shadow:none}
a.btn,a.btn:hover{text-decoration:none}
a.btn{color:var(--md-on-primary)}
a.btn.ghost{color:var(--md-on-secondary-container)}
a.btn.quiet{color:var(--md-on-surface-variant)}
a.btn.quiet:hover{color:var(--md-on-surface)}
a.btn.danger{color:var(--md-error)}

/* ---------- 工具条 ---------- */
.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
.search{position:relative;flex:1;min-width:240px;max-width:420px}
.search svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);
  color:var(--md-on-surface-variant);pointer-events:none}
.search input{
  width:100%;padding:12px 44px 12px 44px;background:var(--md-surface-container-high);
  color:var(--md-on-surface);border:1px solid transparent;border-radius:var(--sh-full);
  font:inherit;font-size:14px;line-height:20px;letter-spacing:.01785714em;
}
.search input::placeholder{color:var(--md-on-surface-variant)}
/* ⚠️ outline:none 必须配一个替代的可见焦点，否则键盘用户看不到自己在哪。
   这里用 1px 主色描边 + 3px 光环。 */
.search input:focus{outline:none;border-color:var(--md-primary);
  box-shadow:0 0 0 3px rgba(208,188,255,.32)}
.search kbd{
  position:absolute;right:12px;top:50%;transform:translateY(-50%);
  font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;color:var(--md-on-surface-variant);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-xs);
  padding:4px 6px;background:var(--md-surface-container-highest);
}
.seg{display:inline-flex;background:var(--md-surface-container-high);
  border-radius:var(--sh-full);padding:4px;gap:2px}
.seg button{background:transparent;color:var(--md-on-surface-variant);
  padding:8px 16px;min-height:40px;font-size:14px;border-radius:var(--sh-full);box-shadow:none}
.seg button:hover::after{opacity:.08}
.seg button[aria-pressed="true"]{background:var(--md-secondary-container);
  color:var(--md-on-secondary-container)}
select.sort{
  background:var(--md-surface-container-high);color:var(--md-on-surface);
  border:1px solid transparent;border-radius:var(--sh-full);
  padding:11px 16px;font:inherit;font-size:14px;min-height:44px;
}

/* ---------- 表格：M3 用 surfaceContainer + outlineVariant 分隔 ---------- */
/* ⚠️ 这里必须是 overflow:clip 而不是 hidden。
   overflow:hidden 会让 .table-wrap **变成滚动容器**，于是下面 th 的 position:sticky
   就变成"相对 wrap 定位"而不是相对视口 —— top:65px 会把表头**往下推 65px**，
   正好压住第一行，第一行的勾选框和按钮就点不到了。
   overflow:clip 同样裁剪圆角，但不创建滚动容器，sticky 才按视口算。 */
.table-wrap{background:var(--md-surface-container-low);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-lg);
  overflow:clip;box-shadow:var(--el-1)}
table{width:100%;border-collapse:separate;border-spacing:0}
thead th{
  position:sticky;top:71px;z-index:5;background:var(--md-surface-container);
  font-size:11px;font-weight:500;letter-spacing:.5px;text-transform:uppercase;
  color:var(--md-on-surface-variant);text-align:left;padding:14px 16px;
  border-bottom:1px solid var(--md-outline-variant);white-space:nowrap;
}
tbody td{padding:14px 16px;border-bottom:1px solid var(--md-outline-variant);
  vertical-align:middle;font-size:14px}
tbody tr:last-child td{border-bottom:none}
tbody tr{transition:background-color .15s ease}
tbody tr:hover{background:var(--md-surface-container)}
tbody tr.expired{background:rgba(242,184,181,.06)}
tbody tr.expired:hover{background:rgba(242,184,181,.10)}
tbody tr.disabled td{color:var(--md-on-surface-variant)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.who{font:500 14px/20px ui-monospace,Menlo,Consolas,monospace;color:var(--md-on-surface);
  letter-spacing:0}
.who-sub{font-size:12px;line-height:16px;color:var(--md-on-surface-variant);margin-top:4px;
  font-family:inherit;max-width:26ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;
  font-variant-numeric:tabular-nums;color:var(--md-on-surface-variant)}
.dim{color:var(--md-on-surface-variant)}

/* 状态：M3 的 assist chip 样式 */
.pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;line-height:16px;
  font-weight:500;letter-spacing:.5px;padding:5px 12px 5px 10px;border-radius:var(--sh-sm);
  border:1px solid var(--md-outline-variant);
  background:var(--md-surface-container-high);color:var(--md-on-surface-variant);white-space:nowrap}
.pill i{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.pill.ok{color:var(--ok);border-color:var(--ok-container);background:var(--ok-container)}
.pill.warn{color:var(--warn);border-color:var(--warn-container);background:var(--warn-container)}
.pill.bad{color:var(--bad);border-color:var(--bad-container);background:var(--bad-container)}
.pill.off{color:var(--md-on-surface-variant)}

.ports{display:flex;gap:6px;flex-wrap:wrap;max-width:280px}
.chip{font:500 12px/16px ui-monospace,Menlo,Consolas,monospace;
  font-variant-numeric:tabular-nums;letter-spacing:.4px;
  padding:4px 10px;border-radius:var(--sh-sm);background:var(--md-surface-container-high);
  border:1px solid var(--md-outline-variant);color:var(--md-on-surface-variant)}
.chip.more{color:var(--md-primary);background:transparent;border-color:var(--md-outline);
  cursor:pointer;min-height:26px;display:inline-flex;align-items:center}
.chip.more:hover{background:var(--md-surface-container-highest)}

.left{font-variant-numeric:tabular-nums;font-weight:600;font-size:14px}
.left.ok{color:var(--md-on-surface-variant)}
.left.warn{color:var(--warn)}
.left.bad{color:var(--bad)}
.bar{height:4px;border-radius:var(--sh-full);background:var(--md-surface-container-highest);
  margin-top:6px;overflow:hidden;width:72px}
.bar i{display:block;height:100%;background:var(--md-primary);border-radius:var(--sh-full)}
.bar.warn i{background:var(--warn)}
.bar.bad i{background:var(--bad)}

.tok{display:inline-flex;align-items:center;gap:6px}
.tok .v{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;
  color:var(--md-on-surface-variant);letter-spacing:.14em}
.tok .v.shown{letter-spacing:0}

.acts{display:flex;gap:4px;justify-content:flex-end;opacity:.40;transition:opacity .18s ease}
tr:hover .acts,.acts:focus-within{opacity:1}
.acts form{display:inline;margin:0}
.acts button{background:transparent;border-color:transparent;color:var(--md-on-surface-variant);
  padding:6px 10px;min-height:32px;font-size:13px;box-shadow:none}
.acts button:hover{background:var(--md-surface-container-highest);color:var(--md-on-surface)}
.acts button.danger{color:var(--md-error);border-color:transparent}
.acts button.danger:hover{background:var(--md-error-container);color:var(--md-on-surface)}

/* ---------- 卡片 / 表单：M3 outlined card ---------- */
.card{background:var(--md-surface-container-low);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-lg);
  padding:8px 24px 24px;max-width:760px;box-shadow:var(--el-1)}
fieldset{border:0;border-top:1px solid var(--md-outline-variant);padding:0;margin:0}
fieldset:first-of-type{border-top:0}
legend{font-size:11px;font-weight:500;letter-spacing:.5px;text-transform:uppercase;
  color:var(--md-primary);padding:22px 0 4px}
label{display:block;color:var(--md-on-surface-variant);font-size:12px;line-height:16px;
  font-weight:500;letter-spacing:.4px;margin:20px 0 8px}
label .req{color:var(--md-error);margin-left:3px}
input,textarea,select{
  width:100%;background:var(--md-surface-container-high);color:var(--md-on-surface);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-xs);
  padding:14px 16px;font:inherit;font-size:14px;line-height:20px;letter-spacing:.01785714em;
  transition:border-color .15s ease,box-shadow .15s ease;
}
input:hover,textarea:hover,select:hover{border-color:var(--md-on-surface)}
input:focus,textarea:focus,select:focus{
  outline:none;border-color:var(--md-primary);box-shadow:inset 0 0 0 1px var(--md-primary)}
input:disabled{color:var(--md-on-surface-variant);background:transparent;border-style:dashed}
textarea{min-height:88px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;
  line-height:20px;resize:vertical}
.hint{color:var(--md-on-surface-variant);font-size:12px;line-height:16px;
  letter-spacing:.4px;margin-top:8px}
.hint code{background:var(--md-surface-container-highest);border-radius:var(--sh-xs);
  padding:1px 6px;font-size:12px}
.radios{display:flex;gap:10px;flex-wrap:wrap}
.radios label{display:inline-flex;align-items:center;gap:8px;margin:0;padding:11px 18px;
  border:1px solid var(--md-outline);border-radius:var(--sh-full);
  background:transparent;cursor:pointer;color:var(--md-on-surface-variant);
  font-size:14px;line-height:20px;letter-spacing:.1px;font-weight:500;
  min-height:44px;transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.radios label:hover{background:var(--md-surface-container-high)}
.radios input{width:18px;height:18px;flex:none;accent-color:var(--md-primary);
  margin:0}
.radios input:focus-visible{outline:3px solid var(--md-primary);outline-offset:3px}
.radios label:has(input:checked){background:var(--md-secondary-container);
  color:var(--md-on-secondary-container);border-color:transparent}
.form-actions{display:flex;gap:10px;align-items:center;padding-top:24px;margin-top:24px;
  border-top:1px solid var(--md-outline-variant)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px}

/* ---------- 提示 ---------- */
.toast-host{position:fixed;right:24px;bottom:24px;z-index:40;display:flex;flex-direction:column;gap:10px}
.toast{background:var(--md-surface-container-high);color:var(--md-on-surface);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-sm);
  padding:14px 18px;font-size:14px;line-height:20px;box-shadow:var(--el-3);
  max-width:440px;animation:slidein .22s cubic-bezier(.2,0,0,1)}
.toast.err{border-left:4px solid var(--md-error)}
.toast.ok{border-left:4px solid var(--ok)}
@keyframes slidein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.banner{border-radius:var(--sh-sm);padding:14px 18px;margin-bottom:18px;font-size:14px;
  line-height:20px;border:1px solid var(--md-outline-variant);
  background:var(--md-surface-container-high);color:var(--md-on-surface)}
.banner.err{border-color:var(--md-error);color:var(--md-error)}
.banner.ok{border-color:var(--ok-container);background:var(--ok-container);color:var(--ok)}
.banner code{background:rgba(0,0,0,.25);border-radius:var(--sh-xs);padding:1px 6px}

/* ---------- 空态 ---------- */
.empty{text-align:center;padding:80px 24px;background:var(--md-surface-container-low);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-xl);box-shadow:var(--el-1)}
.empty .ico{width:52px;height:52px;margin:0 auto 20px;color:var(--md-primary);opacity:.75}
.empty h2{font-size:24px;line-height:32px;font-weight:400;margin:0 0 8px}
.empty p{color:var(--md-on-surface-variant);font-size:14px;line-height:20px;margin:0 0 24px}
.empty .tips{margin-top:32px;color:var(--md-on-surface-variant);font-size:12px;line-height:16px;
  letter-spacing:.4px;text-align:left;display:inline-block}
.empty .tips b{color:var(--md-on-surface)}

/* ---------- 代码块 ---------- */
pre{background:var(--md-surface-container-lowest);border:1px solid var(--md-outline-variant);
  border-radius:var(--sh-lg);padding:20px 22px;overflow:auto;
  font:400 13px/22px ui-monospace,Menlo,Consolas,monospace;color:var(--md-on-surface);
  box-shadow:var(--el-1)}
pre .c{color:var(--md-outline)}
pre .k{color:var(--md-primary)}
pre .s{color:var(--ok)}
.code-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.code-head h2{font-size:16px;line-height:24px;font-weight:500;letter-spacing:.15px;
  color:var(--md-on-surface)}
.code-head .spacer{flex:1}

/* ---------- 登录 ---------- */
.login-body{display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:24px}
.login-card{width:100%;max-width:400px;background:var(--md-surface-container-low);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-xl);
  padding:36px 32px 32px;box-shadow:var(--el-2);text-align:center}
.login-card .mark{width:56px;height:56px;border-radius:var(--sh-lg);
  background:var(--md-primary-container);display:grid;place-items:center;
  color:var(--md-on-primary-container);margin:0 auto 22px}
.login-card h1{font-size:24px;line-height:32px;font-weight:400;margin:0 0 6px}
.login-card p{color:var(--md-on-surface-variant);font-size:14px;line-height:20px;
  margin:0 0 26px}
.login-card form{text-align:left}
.login-card label{text-align:left}
.login-card button{width:100%;margin-top:28px}

/* ---------- 概览指标卡（M3 的卡片：色调分层 + 极轻阴影）---------- */
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(156px,1fr));
  gap:14px;margin:0 0 20px}
.metric{background:var(--md-surface-container-low);border:1px solid var(--md-outline-variant);
  border-radius:var(--sh-lg);padding:16px 18px 18px;box-shadow:var(--el-1)}
.metric .k{font-size:11px;font-weight:500;letter-spacing:.5px;text-transform:uppercase;
  color:var(--md-on-surface-variant)}
.metric .v{font-size:34px;line-height:42px;font-weight:400;margin-top:8px;letter-spacing:-.5px;
  font-variant-numeric:tabular-nums;color:var(--md-on-surface)}
.metric.ok .v{color:var(--ok)}
.metric.warn .v{color:var(--warn)}
.metric.bad .v{color:var(--bad)}
.metric .sub{font-size:12px;line-height:16px;color:var(--md-on-surface-variant);margin-top:2px}
.metric .track{height:5px;border-radius:var(--sh-full);overflow:hidden;margin-top:12px;
  background:var(--md-surface-container-highest)}
.metric .track i{display:block;height:100%;border-radius:var(--sh-full);
  background:var(--md-primary);transition:width .4s ease}
.metric.warn .track i{background:var(--warn)}
.metric.bad .track i{background:var(--bad)}
/* 行内链接也要够得着：WCAG 2.2 的 24px 最小点击目标 */
.metric a{font-size:12px;display:inline-flex;align-items:center;min-height:26px;margin-top:6px}

/* ---------- 批量操作条 ---------- */
.bulkbar{display:none;position:sticky;top:73px;z-index:6;margin:0 0 14px;
  background:var(--md-secondary-container);color:var(--md-on-secondary-container);
  border-radius:var(--sh-full);padding:8px 10px 8px 22px;align-items:center;gap:10px;
  box-shadow:var(--el-2);flex-wrap:wrap}
.bulkbar.on{display:flex}
.bulkbar .n{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.bulkbar .grow{flex:1}
.bulkbar button{background:transparent;border-color:transparent;
  color:var(--md-on-secondary-container);min-height:36px;padding:6px 14px;font-size:13px}
.bulkbar button:hover{background:var(--md-surface-container-highest)}
.bulkbar input[type=number]{width:76px;padding:7px 10px;min-height:36px;
  background:var(--md-surface-container-highest);border-color:transparent;
  color:var(--md-on-secondary-container);font-size:13px}

/* ---------- 选择列 ---------- */
.col-sel{width:46px;padding-right:0 !important}
.col-sel input{width:18px;height:18px;accent-color:var(--md-primary);cursor:pointer;
  display:block;margin:0}
.col-sel input:focus-visible{outline:3px solid var(--md-primary);outline-offset:3px}
tbody tr.picked{background:var(--md-secondary-container)}
tbody tr.picked:hover{background:var(--md-secondary-container)}

/* ---------- 端口分配视图 ---------- */
.port-grid{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.port{font:500 11.5px/1 ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;
  padding:7px 9px;border-radius:var(--sh-xs);min-width:58px;text-align:center;
  border:1px solid var(--md-outline-variant);background:var(--md-surface-container);
  color:var(--md-on-surface-variant)}
.port.taken{background:var(--md-secondary-container);color:var(--md-on-secondary-container);
  border-color:transparent}
.port.free{opacity:.42;border-style:dashed}
.port.dis{background:var(--md-surface-container-high);color:var(--md-outline);opacity:.6}

/* ---------- 操作日志 ---------- */
.loglist{list-style:none;margin:0;padding:0;background:var(--md-surface-container-low);
  border:1px solid var(--md-outline-variant);border-radius:var(--sh-lg);
  overflow:clip;box-shadow:var(--el-1)}
.logline{display:flex;gap:12px;align-items:flex-start;padding:11px 16px;
  border-bottom:1px solid var(--md-outline-variant);font-size:13px}
.logline:last-child{border-bottom:none}
.logline:hover{background:var(--md-surface-container)}
.logline .ts{color:var(--md-on-surface-variant);flex:none;
  font-variant-numeric:tabular-nums;min-width:66px}
.logline .pill{flex:none;min-width:54px;justify-content:center}
.logline .msg{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;
  color:var(--md-on-surface)}
.logline.err .msg{color:var(--md-error)}
.logline.bad .msg{color:var(--bad)}
.logline .logstack{display:block;color:var(--md-on-surface-variant);font-size:12px;
  margin-top:5px;font-family:ui-monospace,Menlo,Consolas,monospace;
  white-space:pre-wrap;word-break:break-all}

/* ---------- 导航栏（M3：桌面左侧 rail，窄屏底部 navigation bar）---------- */
body.has-rail header.top{margin-left:88px}
body.has-rail main.wrap{margin-left:88px}
.rail{position:fixed;left:0;top:0;bottom:0;width:88px;z-index:20;
  background:var(--md-surface-container);border-right:1px solid var(--md-outline-variant);
  display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px 0 14px}
.rail .mark{width:44px;height:44px;border-radius:var(--sh-md);flex:none;
  background:var(--md-primary-container);color:var(--md-on-primary-container);
  display:grid;place-items:center;margin-bottom:14px}
.rail .grow{flex:1}
.rail a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;
  width:68px;min-height:56px;padding:10px 0;border-radius:var(--sh-lg);
  text-decoration:none;color:var(--md-on-surface-variant);
  font-size:11px;font-weight:500;letter-spacing:.4px;
  transition:background-color .15s ease,color .15s ease}
.rail a:hover{background:var(--md-surface-container-high);color:var(--md-on-surface);
  text-decoration:none}
.rail a[aria-current="page"]{background:var(--md-secondary-container);
  color:var(--md-on-secondary-container)}

/* 小屏：rail 变成底部 bar */
@media (max-width:900px){
  .rail{top:auto;bottom:0;left:0;right:0;width:auto;height:64px;
    flex-direction:row;justify-content:space-evenly;align-items:stretch;
    border-right:0;border-top:1px solid var(--md-outline-variant);padding:0 8px}
  .rail .mark,.rail .grow{display:none}
  .rail a{flex-direction:row;gap:8px;width:auto;min-height:52px;padding:8px 14px;
    font-size:13px;letter-spacing:.1px}
  body.has-rail header.top{margin-left:0}
  body.has-rail main.wrap{margin-left:0;padding-bottom:96px}
}

/* ---------- 到期分布（纯 CSS 柱状图，不引图表库）---------- */
.histcard{background:var(--md-surface-container-low);border:1px solid var(--md-outline-variant);
  border-radius:var(--sh-lg);padding:16px 20px 18px;margin:0 0 20px;box-shadow:var(--el-1)}
.hist-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.hist-head h2{font-size:16px;line-height:24px;font-weight:500;letter-spacing:.15px}
.hist-head .spacer{flex:1}
.hist{display:flex;align-items:flex-end;gap:6px}
.hist-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0}
.hist-n{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--md-on-surface);line-height:1}
.hist-n.dim{color:transparent}
.hist-track{width:100%;height:64px;display:flex;align-items:flex-end;
  background:var(--md-surface-container-highest);border-radius:var(--sh-xs);overflow:hidden}
.hist-track i{display:block;width:100%;background:var(--md-primary);
  border-radius:var(--sh-xs);transition:height .35s ease}
.hist-track i.warn{background:var(--warn)}
.hist-track i.empty{background:var(--md-outline-variant)}
.hist-x{font-size:10.5px;line-height:1;color:var(--md-on-surface-variant);
  font-variant-numeric:tabular-nums;letter-spacing:.2px}

/* ---------- 行密度：紧凑模式（账号多的时候一屏多看几行）---------- */
html[data-density="compact"] tbody td{padding:7px 16px}
html[data-density="compact"] thead th{padding:9px 16px}
html[data-density="compact"] .who{font-size:13px}
html[data-density="compact"] .who-sub{display:none}
html[data-density="compact"] .bar{display:none}
html[data-density="compact"] .ports{max-width:210px}
html[data-density="compact"] .rail a{min-height:48px;padding:6px 0}

/* 正文里的行内链接：必须有下划线和主色，
   否则混在段落里根本看不出能点（之前的审计就是因为没样式才发现不了）。 */
main a:not(.btn){color:var(--md-primary);text-decoration:underline;
  text-underline-offset:2px;text-decoration-thickness:1px}
main a:not(.btn):hover{text-decoration-thickness:2px}
main a:not(.btn):focus-visible{outline:3px solid var(--md-primary);outline-offset:2px;border-radius:2px}

/* 在线指示：贴着账号名，绿点 + 文字。
   不用纯色圆点 —— 只靠颜色区分状态对色觉障碍用户不友好，必须同时有文字。 */
.live{display:inline-flex;align-items:center;margin-left:8px;font-size:11px;
  font-weight:500;color:var(--md-ok,#3ddc84);letter-spacing:.2px}
.live::before{content:"";width:6px;height:6px;border-radius:50%;
  background:currentColor;margin-right:4px;
  box-shadow:0 0 0 3px color-mix(in srgb,currentColor 22%,transparent)}
.metric.good .v{color:var(--md-ok,#3ddc84)}

/* ---------- 设置行 ---------- */
.setrow{margin:16px 0}
.setrow > label{display:block;color:var(--md-on-surface-variant);font-size:12.5px;
  font-weight:500;margin:0 0 6px}
.setrow.ro{padding:12px 0;border-bottom:1px solid var(--md-outline-variant)}
.setrow.ro:last-child{border-bottom:none}
.setrow.ro .k{font-size:12.5px;color:var(--md-on-surface-variant);display:block}
.setrow.ro .v{display:block;margin-top:3px;word-break:break-all;font-size:13px}
fieldset .setrow:first-of-type{margin-top:16px}
main h2{font-size:17px;font-weight:500;margin:30px 0 8px;letter-spacing:.1px}

/* 小屏 */
@media (max-width:860px){
  .top-in,.wrap{padding-left:16px;padding-right:16px}
  /* 顶栏按不动就把操作按钮折到第二行 —— 宁可顶栏高一点，也不要横向溢出整页跟着滚 */
  .top-in{flex-wrap:wrap;row-gap:8px}
  .top-actions{flex-wrap:wrap;justify-content:flex-end;row-gap:8px}
  .top-actions .btn.mini.top{padding:8px 12px}
  .stats{display:none}
  .col-ports,.col-comment,.col-token{display:none}
  .acts{opacity:1}
  /* 窄屏要横向滚，于是 wrap 又变回滚动容器 —— 此时 sticky 会再次错位，
     干脆在窄屏关掉吸顶（宁可不要，也不要压住第一行点不到）。 */
  .table-wrap{overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
  thead th{position:static}
  table{min-width:520px}
  .brand h1{font-size:18px}
}
@media print{header.top{display:none}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;
    transition-duration:.001ms !important;scroll-behavior:auto !important}
}
"""



def _ico(name, size=14, stroke=1.7):
    """内联 SVG 图标。

    刻意**不用 Lucide/Feather**（那是默认选择、一眼就是模板味）。
    这里的形状是按用途自己挑的：箭头、括号、方块这类「结构性」符号，
    而不是火箭、盾牌那类陈词滥调的隐喻。
    """
    p = {
        "plus": '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
        "search": '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.6 10.6 14 14"/>',
        "edit": '<path d="M11.4 2.6 13.4 4.6 6 12H4v-2z"/>',
        "clock": '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.3 1.5"/>',
        "code": '<path d="M5.6 4.6 2.2 8l3.4 3.4M10.4 4.6 13.8 8l-3.4 3.4"/>',
        "power": '<path d="M8 2.6v5.2"/><path d="M12 4.6a5.6 5.6 0 1 1-8 0"/>',
        "trash": '<path d="M3.4 4.4h9.2M6.2 4.4V3.2h3.6v1.2M4.6 4.4l.6 8.2h5.6l.6-8.2"/>',
        "copy": '<rect x="5.6" y="5.6" width="8" height="8" rx="1.6"/><path d="M10.4 5.6V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v4.8A1.6 1.6 0 0 0 4 10.4h1.6"/>',
        "download": '<path d="M8 2.6v7.2M5 7l3 3 3-3M3 12.6h10"/>',
        "back": '<path d="M9.6 3.6 5.2 8l4.4 4.4"/>',
        "db": '<ellipse cx="8" cy="4.2" rx="5" ry="2"/><path d="M3 4.2v7.6c0 1.1 2.2 2 5 2s5-.9 5-2V4.2"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
        "inbox": '<path d="M2.6 9.4 4.6 3.4h6.8l2 6v3.2H2.6z"/><path d="M2.6 9.4h3l.7 1.4h3.4l.7-1.4h3"/>',
        "grid": '<rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.2"/><rect x="9" y="2.4" width="4.6" height="4.6" rx="1.2"/><rect x="2.4" y="9" width="4.6" height="4.6" rx="1.2"/><rect x="9" y="9" width="4.6" height="4.6" rx="1.2"/>',
        "sun": '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.3v1.7M8 13v1.7M1.3 8h1.7M13 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2"/>',
        "moon": '<path d="M13.3 9.7A5.7 5.7 0 0 1 6.3 2.7a5.7 5.7 0 1 0 7 7z"/>',
        "gear": '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.7v1.8M8 12.5v1.8M1.7 8h1.8M12.5 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>',
        "book": '<path d="M2.6 3.2h4.2c.7 0 1.2.5 1.2 1.2v8.4c0-.7-.5-1.2-1.2-1.2H2.6z"/><path d="M13.4 3.2H9.2c-.7 0-1.2.5-1.2 1.2v8.4c0-.7.5-1.2 1.2-1.2h4.2z"/>',
    }.get(name, "")
    return ('<svg width="%d" height="%d" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
            'stroke-width="%s" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%s</svg>'
            % (size, size, stroke, p))


FAVICON = ("data:image/svg+xml,"
           "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
           "%3Crect width='32' height='32' rx='8' fill='%23141218'/%3E"
           "%3Cpath d='M9 21V11h5.5a3.2 3.2 0 0 1 0 6.4H12' stroke='%23d0bcff' stroke-width='2.4' "
           "fill='none' stroke-linecap='round'/%3E"
           "%3Ccircle cx='22.5' cy='20.5' r='2' fill='%239ed8b4'/%3E%3C/svg%3E")


def _rail(active):
    """
    M3 的导航栏：桌面是左侧 rail，窄屏自动变成底部 navigation bar（纯 CSS 切换）。

    为什么值得单独做：顶栏上原本挤了「端口 / 显示令牌 / 新建账号 / 退出」，
    再加「日志」就放不下了 —— 而且"去哪一页"和"在这一页做什么"本来就是两回事，
    混在一条 bar 上会一直互相挤。
    """
    items = [
        ("accounts", "/", "账号", "db"),
        ("ports", "/ports", "端口", "grid"),
        ("logs", "/logs", "日志", "clock"),
        ("settings", "/settings", "设置", "gear"),
        ("docs", "/docs", "文档", "book"),
    ]
    links = []
    for key, href, label, icon in items:
        cur = ' aria-current="page"' if key == active else ""
        links.append('<a href="%s"%s>%s<span>%s</span></a>'
                     % (href, cur, _ico(icon, 20, 1.6), label))
    links.append('<span class="grow"></span>')
    # 主题切换：标签写的是"切过去会变成什么"，不是当前状态（按钮上写当前状态最容易点错）
    cur_theme = current_theme()
    to = "dark" if cur_theme == "light" else "light"
    links.append('<a class="rail-theme" href="/theme?to=%s" '
                 'aria-label="切换到%s主题">%s<span>%s</span></a>'
                 % (to, "暗色" if to == "dark" else "亮色",
                    _ico("moon" if to == "dark" else "sun", 20, 1.6),
                    "暗色" if to == "dark" else "亮色"))
    links.append('<a class="rail-exit" href="/logout">%s<span>退出</span></a>'
                 % _ico("back", 20, 1.6))
    return ('<nav class="rail" aria-label="主导航">'
            '<div class="mark">%s</div>%s</nav>'
            % (_ico("db", 22, 1.7), "".join(links)))


# 主题偏好存在浏览器 cookie 里（每台设备各自记），服务端只负责把它渲染出去。
# ⚠️ 用 thread-local 而不是模块级全局变量：面板是 ThreadingHTTPServer，
#    全局变量会被并发请求互相覆盖 —— 一个人切亮色，别人的页面也会跟着变。
_req_theme = threading.local()
THEME_COOKIE = "frp_panel_theme"
DENSITY_COOKIE = "frp_panel_density"
THEME_COLOR = {"dark": "#141218", "light": "#fef7ff"}


def current_theme():
    return getattr(_req_theme, "value", "dark")


def set_current_theme(value):
    _req_theme.value = "light" if value == "light" else "dark"


def current_density():
    """行密度：账号多的时候紧凑一点，一屏能多看几行。"""
    return getattr(_req_theme, "density", "comfortable")


def set_current_density(value):
    _req_theme.density = "compact" if value == "compact" else "comfortable"


def _shell(title, body, csrf="", cls="", script="", extra="", nav=None):
    """页面外壳：语义化结构 + 无 JS 也不影响使用。"""
    holder = ('<form id="csrf-holder" hidden>%s</form>' % csrf_field(csrf)) if csrf else ""
    rail = _rail(nav) if nav else ""
    if nav and "has-rail" not in cls:
        cls = (cls + " has-rail").strip()
    theme = current_theme()
    return """<!doctype html><html lang="zh-CN" data-theme="%(theme)s" data-density="%(density)s"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="%(themecolor)s">
<meta name="robots" content="noindex,nofollow">
<title>%(title)s</title>
<link rel="icon" href="%(favicon)s">
<style>%(css)s</style>
</head><body class="%(cls)s">
<a class="skip" href="#main">跳到内容</a>
%(holder)s
%(rail)s
%(body)s
%(extra)s
<div class="toast-host" id="toasts" aria-live="polite" aria-atomic="true"></div>
<script>%(script)s</script>
</body></html>""" % {
        "title": html.escape(title), "css": PAGE_STYLE, "cls": cls,
        "body": body, "holder": holder, "favicon": FAVICON, "rail": rail,
        "theme": theme, "themecolor": THEME_COLOR.get(theme, "#141218"),
        "density": current_density(),
        "script": script or COMMON_JS, "extra": extra,
    }


COMMON_JS = r"""
(function(){
  // 复制按钮
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-copy]');
    if(!b) return;
    e.preventDefault();
    var t = b.getAttribute('data-copy');
    var done = function(){ toast('已复制到剪贴板','ok'); };
    if(navigator.clipboard && window.isSecureContext){
      navigator.clipboard.writeText(t).then(done, function(){ fallback(t, done); });
    } else { fallback(t, done); }
  });
  function fallback(text, cb){
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); cb(); } catch(err){ toast('复制失败，请手动选择','err'); }
    document.body.removeChild(ta);
  }
  // 显示/隐藏令牌：**按需**去服务端取，不在页面里预置
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-token]');
    if(!b) return;
    var v = b.querySelector('.v'); if(!v) return;
    if(b.dataset.loaded === '1'){
      var shown = v.classList.toggle('shown');
      v.textContent = shown ? b.dataset.real : new Array(b.dataset.real.length+1).join('•');
      return;
    }
    fetch('/api/token/' + encodeURIComponent(b.getAttribute('data-token')), {
      headers: {'Accept': 'application/json'}
    }).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(d){
      if(!d.ok) throw new Error(d.message || '取令牌失败');
      b.dataset.real = d.token; b.dataset.loaded = '1';
      v.textContent = d.token; v.classList.add('shown');
    }).catch(function(err){ toast('取令牌失败：' + err.message, 'err'); });
  });
  // 端口「+N」展开
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-ports]');
    if(!b) return;
    var wrap = b.closest('.ports');
    wrap.querySelectorAll('[data-more]').forEach(function(n){ n.hidden = false; });
    b.remove();
  });
  // 两步确认删除（不用 window.confirm）
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-confirm]');
    if(!b) return;
    if(b.dataset.armed === '1'){ b.closest('form').submit(); return; }
    e.preventDefault();
    b.dataset.armed = '1';
    var old = b.textContent;
    b.textContent = b.getAttribute('data-confirm');
    b.classList.remove('ghost'); b.classList.add('danger');
    setTimeout(function(){
      if(!b.isConnected) return;
      b.dataset.armed='0'; b.textContent = old;
    }, 4000);
  });
  window.toast = function(msg, kind){
    var host = document.getElementById('toasts'); if(!host) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind||'');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function(){ el.style.opacity='0'; el.style.transform='translateY(6px)';
      setTimeout(function(){ el.remove(); }, 220); }, 2600);
  };
  // 把服务端渲染的提示变成 toast（无 JS 时它就是页面上的一条横幅，照样能看到）
  document.querySelectorAll('[data-flash]').forEach(function(n){
    var el = n.querySelector('.banner') || n;
    var text = el.textContent.trim();
    if(text) toast(text, n.getAttribute('data-flash'));
    n.hidden = true;
  });
})();
"""


def csrf_field(csrf):
    return '<input type="hidden" name="csrf" value="%s">' % html.escape(csrf or "")


def render_login(message="", is_error=False):
    msg = ('<div class="banner %s">%s</div>'
           % ("err" if is_error else "ok", html.escape(message))) if message else ""
    body = """<div class="login-body"><main class="login-card" id="main">
  <div class="mark">%s</div>
  <h1>frp 面板</h1>
  <p>DoulorCloud 内网穿透 · 账号与隧道管理</p>
  %s
  <form method="POST" action="/login">
    <label for="u">用户名</label>
    <input id="u" name="user" autocomplete="username" autofocus>
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">登录</button>
  </form>
</main></div>""" % (_ico("db", 20), msg)
    return _shell("登录 · DoulorCloud frp 面板", body, cls="login")


def render_accounts(accounts, now=None, show_tokens=False, csrf="", message="",
                    is_error=False):
    now = now or time.time()
    soon_days = int(CONFIG.get("expiring_soon_days") or 3)
    # 在线状态只在渲染开始时取一次快照 —— 每行都去问一次既慢，同一页里还可能前后不一致。
    online = online_map()
    # ⚠️ 指标卡只能统计「账号列表里真实存在的」在线账号。
    #    在线表可能有已删除账号的残留（删除不会清在线表，等 TTL 自然过期），
    #    直接 len(online) 会出现「指标说有 2 个在线，列表里只看得到 1 个」——
    #    管理员会以为界面漏画了，实际上是在线表里有个已经不存在的账号。
    account_names = {str(a.get("user") or "") for a in accounts}
    online_here = {u: age for u, age in online.items() if u in account_names}
    rows = []
    active = expired = disabled = expiring = 0

    for a in sorted(accounts, key=lambda x: (x.get("user") or "").lower()):
        user = a.get("user") or ""
        esc_user = html.escape(user)
        # 端口可以是整数，也可以是区间字符串（旧数据里有 "1000-55555" 这种），
        # 显示时两种都要留 —— 只显示整数的话，那种账号在界面上看着像"没有端口"。
        ports = list(a.get("ports") or [])
        left = days_left(a, now)
        is_expired = left is not None and left < 0
        is_soon = left is not None and 0 <= left <= soon_days
        enabled = bool(a.get("enable", True))
        token = a.get("token") or ""

        if not enabled:
            state, cls, dot = "已停用", "off", "off"
            disabled += 1
            row_cls = "disabled"
        elif is_expired:
            state, cls, dot = "已到期", "bad", "bad"
            expired += 1
            row_cls = "expired"
        elif is_soon:
            state, cls, dot = "即将到期", "warn", "warn"
            expiring += 1
            row_cls = ""
        else:
            state, cls, dot = "正常", "ok", "ok"
            active += 1
            row_cls = ""

        # 端口：最多平铺 4 个，其余折叠成 +N（超大端口列表不该把表格撑烂）
        # %s 而不是 %d —— 端口可能是个区间字符串
        chips = "".join('<span class="chip" translate="no">%s</span>'
                        % html.escape(str(p)) for p in ports[:4])
        more = ""
        if len(ports) > 4:
            extra = "".join('<span class="chip" data-more hidden translate="no">%s</span>'
                            % html.escape(str(p)) for p in ports[4:])
            chips += extra + ('<button type="button" class="chip more" data-ports>+%d</button>'
                              % (len(ports) - 4))

        # 剩余天数 + 进度条
        if left is None:
            left_html = '<span class="dim">—</span>'
        else:
            total = max(1, int(CONFIG.get("default_rental_days") or 30))
            pct = 0 if left < 0 else min(100, int(left * 100 / total))
            if left < 0:
                left_html = ('<span class="left bad">已过 %d 天</span>'
                             '<div class="bar bad"><i style="width:100%%"></i></div>' % (-left))
            elif left == 0:
                left_html = ('<span class="left warn">今天到期</span>'
                             '<div class="bar warn"><i style="width:6%%"></i></div>')
            else:
                left_html = ('<span class="left %s">%d 天</span>'
                             '<div class="bar %s"><i style="width:%d%%"></i></div>'
                             % ("warn" if is_soon else "ok", left,
                                "warn" if is_soon else "", pct))

        expire = (a.get("expire_at") or "")[:10]
        if not expire:
            m = EXPIRED_RE.search(a.get("comment") or "")
            expire = m.group(1) if m else ""

        # ⚠️ 令牌默认**不进页面**，点「显示」时才按需去 /api/token/<user> 取。
        #    之前图方便把真令牌塞进 data-* 属性做纯前端切换 —— 那样"默认打码"
        #    就是假的：页面源码里每个账号的令牌都在。test-auth-ui 有一条专守这个契约。
        token_html = ('<button type="button" class="quiet" data-token="%s" '
                      'aria-label="显示或隐藏 %s 的令牌" title="点击显示/隐藏">'
                      '<span class="v" translate="no">%s</span></button>'
                      % (urllib.parse.quote(user), esc_user,
                         html.escape(token) if show_tokens else "•" * 10))

        comment = (a.get("comment") or "").strip()
        # 勾选框用 form="bulkform" 关联到表格外的批量表单 ——
        # 如果把整张表包进 <form>，行内的启停/删除表单就成了嵌套表单（无效 HTML）。
        rows.append(
            '<tr class="%(row)s" data-search="%(search)s">'
            '<td class="col-sel"><input type="checkbox" name="users" value="%(user_raw)s" '
            'form="bulkform" aria-label="选择账号 %(user)s"></td>'
            '<td><div class="who" translate="no">%(user)s%(live)s</div>%(csub)s</td>'
            '<td class="col-ports"><div class="ports">%(ports)s</div></td>'
            '<td><span class="pill %(cls)s"><i></i>%(state)s</span></td>'
            '<td><div class="mono">%(expire)s</div>%(left)s</td>'
            '<td class="col-token">%(token)s</td>'
            '<td class="col-comment dim" style="max-width:26ch;overflow:hidden;'
            'text-overflow:ellipsis;white-space:nowrap">%(comment)s</td>'
            '<td><div class="acts">'
            '<a class="btn quiet mini" href="/account/%(u)s">%(ico_edit)s编辑</a>'
            '<a class="btn quiet mini" href="/account/%(u)s/renew">%(ico_clock)s续期</a>'
            '<a class="btn quiet mini" href="/account/%(u)s/config">%(ico_code)s配置</a>'
            '<form method="POST" action="/account/%(u)s/toggle">%(csrf)s'
            '<button class="quiet mini" aria-label="%(togglet)s账号 %(user)s" '
            'title="%(togglet)s">%(ico_power)s</button></form>'
            '<form method="POST" action="/account/%(u)s/delete">%(csrf)s'
            '<button class="danger mini" data-confirm="确认删除？" '
            'aria-label="删除账号 %(user)s" title="删除">%(ico_trash)s</button></form>'
            '</div></td></tr>' % {
                "row": row_cls, "user": esc_user, "user_raw": html.escape(user, True),
                # 在线指示：只在 TTL 内显示。用 title 说明"多久前活动过"，
                # 免得管理员分不清"刚断"和"断了很久"。
                "live": ('<span class="live" title="%s">· 在线</span>' % human_since(online[user]))
                        if user in online else "",
                "search": html.escape(
                    ("%s %s %s" % (user, comment, " ".join(str(p) for p in ports))).lower(), True),
                "csub": ('<div class="who-sub">%s</div>' % html.escape(comment)) if comment else "",
                "ports": chips or '<span class="dim">—</span>',
                "cls": cls, "state": state, "expire": html.escape(expire or "—"),
                "left": left_html, "token": token_html,
                "comment": html.escape(comment or "—"),
                "u": urllib.parse.quote(user), "csrf": csrf_field(csrf),
                "togglet": "停用" if enabled else "启用",
                "ico_edit": _ico("edit", 13), "ico_clock": _ico("clock", 13),
                "ico_code": _ico("code", 13), "ico_power": _ico("power", 13),
                "ico_trash": _ico("trash", 13),
            })

    flash = ""
    if message:
        flash = ('<div data-flash="%s"><div class="banner %s" role="%s">%s</div></div>'
                 % ("err" if is_error else "ok", "err" if is_error else "ok",
                    "alert" if is_error else "status", html.escape(message)))

    # ---- 概览指标：把"现在什么情况"一眼说完，不用去数表格 ----
    used_ports = set()
    for a in accounts:
        for p in (a.get("ports") or []):
            try:
                used_ports.add(int(p))
            except (TypeError, ValueError):
                pass
    p_start = int(CONFIG.get("default_port_start") or 0)
    p_end = int(CONFIG.get("default_port_end") or 0)
    if p_start and p_end and p_end >= p_start:
        span = p_end - p_start + 1
        in_range = sum(1 for p in used_ports if p_start <= p <= p_end)
        util = int(round(in_range * 100.0 / span))
        port_sub = "区间 %d–%d，%d 个在用" % (p_start, p_end, in_range)
    else:
        util = 0
        port_sub = "共分配 %d 个端口" % len(used_ports)

    def metric(label, value, sub, tone="", extra=""):
        return ('<div class="metric %s"><div class="k">%s</div><div class="v">%s</div>'
                '<div class="sub">%s</div>%s</div>'
                % (tone, label, value, sub, extra))

    metrics = '<div class="metrics">%s%s%s%s%s</div>' % (
        metric("账号总数", len(accounts),
               "启用 %d · 停用 %d" % (active + expiring + expired, disabled)),
        # 「谁在线」—— 数据来自插件心跳（Login/Ping/NewWorkConn 都算），90 秒没动静就算离线
        # （这里不放"只看这些 →"筛选链接：列表页并没有 live 这个筛选值，
        #   放一个点了没反应的链接比不放更糟。）
        metric("在线", len(online_here),
               "刚刚有心跳" if online_here else "暂无客户端连接",
               "good" if online_here else ""),
        metric("即将到期", expiring, "%d 天内" % soon_days, "warn",
               ('<a href="/?st=warn">只看这些 →</a>') if expiring else ""),
        metric("已到期", expired, "插件已拒绝其连接", "bad",
               ('<a href="/?st=bad">只看这些 →</a>') if expired else ""),
        metric("端口占用", "%d%%" % util, port_sub,
               "", '<div class="track"><i style="width:%d%%"></i></div>' % util),
    )

    # 到期分布：表格里散着看不出"接下来会不会有一批人同时掉线"
    buckets, overdue_n, forever_n, later_n = expiry_histogram(accounts)
    histogram = render_histogram(buckets, overdue_n, later_n)

    top = """<header class="top"><div class="top-in">
  <div class="brand"><span class="dot"></span><h1>账号</h1></div>
  <span class="spacer"></span>
  <div class="top-actions">
    <a class="btn quiet mini top" href="/?show_tokens=%s">%s</a>
    <a class="btn" href="/account/new">%s新建账号</a>
  </div>
</div></header>""" % ("0" if show_tokens else "1",
                      "隐藏令牌" if show_tokens else "显示令牌", _ico("plus", 14))

    if not accounts:
        table = """<div class="empty">
  <div class="ico">%s</div>
  <h2>还没有账号</h2>
  <p>建第一个账号，给它分配端口和租期，然后把生成的 frpc.toml 发给用户。</p>
  <a class="btn" href="/account/new">%s新建账号</a>
  <div class="tips">
    服务器地址：<b class="mono">%s</b> &nbsp;·&nbsp; 默认租期 %s 天<br>
    自动化过来的账号（<b class="mono">%s</b> 前缀）会自己出现在这里。
  </div>
</div>""" % (_ico("inbox", 46, 1.2), _ico("plus", 14),
             html.escape(CONFIG.get("frps_public_addr") or "（未配置 frps_public_addr）"),
             CONFIG.get("default_rental_days") or 30,
             html.escape(CONFIG.get("user_prefix") or "dcfrp_"))
    else:
        cur_density = current_density()
        d_to = "comfortable" if cur_density == "compact" else "compact"
        d_label = "舒适" if d_to == "comfortable" else "紧凑"
        table = """<div class="toolbar">
  <div class="search">%s<input id="q" type="search" placeholder="搜索账号、备注、端口…"
    autocomplete="off"><kbd>/</kbd></div>
  <div class="seg" role="group" aria-label="按状态筛选">
    <button type="button" data-filter="all" aria-pressed="true">全部</button>
    <button type="button" data-filter="ok" aria-pressed="false">正常</button>
    <button type="button" data-filter="warn" aria-pressed="false">即将到期</button>
    <button type="button" data-filter="bad" aria-pressed="false">已到期</button>
    <button type="button" data-filter="off" aria-pressed="false">停用</button>
  </div>
  <select class="sort" id="sort" aria-label="排序">
    <option value="name">按账号名</option>
    <option value="left">按剩余天数</option>
    <option value="ports">按端口数</option>
  </select>
  <a class="btn quiet mini top" href="/density?to=%s"
     title="切换行密度（当前：%s）">%s%s</a>
  <span class="spacer"></span>
  <span class="dim" id="count">%d 条</span>
</div>
<form id="bulkform" method="POST" action="/bulk">
  %s
  <div class="bulkbar" id="bulkbar">
    <span class="n"><b id="seln">0</b> 个已选</span>
    <span class="grow"></span>
    <label for="bulkdays" style="margin:0;font-size:12px">续期天数</label>
    <input id="bulkdays" type="number" name="days" value="30" min="1" max="3650"
      aria-label="续期天数">
    <button name="bulk_action" value="renew">%s续期</button>
    <button name="bulk_action" value="enable">%s启用</button>
    <button name="bulk_action" value="disable">%s停用</button>
    <button name="bulk_action" value="delete" data-confirm="确认删除？">%s删除</button>
    <button type="button" class="quiet" id="bulkclear">取消选择</button>
  </div>
</form>
<div class="table-wrap"><table>
<thead><tr>
  <th class="col-sel"><input type="checkbox" id="selall" aria-label="全选可见账号"></th>
  <th>账号</th><th class="col-ports">端口</th><th>状态</th><th>到期 / 剩余</th>
  <th class="col-token">令牌</th><th class="col-comment">备注</th>
  <th style="text-align:right">操作</th>
</tr></thead>
<tbody id="rows">%s</tbody></table></div>
<script>
(function(){
  var q=document.getElementById('q'), rows=[].slice.call(document.querySelectorAll('#rows tr'));
  var count=document.getElementById('count'), seg=[].slice.call(document.querySelectorAll('.seg button'));
  var sort=document.getElementById('sort'), filter='all';
  function apply(push){
    var s=(q.value||'').trim().toLowerCase(), n=0;
    rows.forEach(function(r){
      var hitText = !s || (r.dataset.search||'').indexOf(s)>=0;
      var hitFilt = filter==='all' || r.querySelector('.pill').classList.contains(filter);
      var show = hitText && hitFilt;
      r.hidden = !show; if(show) n++;
    });
    count.textContent = n + ' 条' + (n!==rows.length ? '（共 '+rows.length+'）' : '');
    // 状态写进 URL：刷新/收藏/发给同事都能还原同一个视图
    if(push!==false){
      var p=new URLSearchParams(location.search);
      if(q.value) p.set('q',q.value); else p.delete('q');
      if(filter!=='all') p.set('st',filter); else p.delete('st');
      if(sort.value!=='name') p.set('sort',sort.value); else p.delete('sort');
      var qs=p.toString();
      history.replaceState(null,'',location.pathname+(qs?'?'+qs:''));
    }
  }
  // 首次进页面：从 URL 还原
  (function(){
    var p=new URLSearchParams(location.search);
    if(p.get('q')) q.value=p.get('q');
    var st=p.get('st');
    if(st){ filter=st; seg.forEach(function(x){ x.setAttribute('aria-pressed', String(x.dataset.filter===st)); }); }
    if(p.get('sort')){ sort.value=p.get('sort'); sort.dispatchEvent(new Event('change')); }
  })();
  q.addEventListener('input', function(){ apply(); });
  seg.forEach(function(b){ b.addEventListener('click', function(){
    filter=b.dataset.filter;
    seg.forEach(function(x){ x.setAttribute('aria-pressed', String(x===b)); });
    apply();
  });});
  sort.addEventListener('change', function(){
    var k=sort.value;
    rows.sort(function(a,b){
      if(k==='name') return a.querySelector('.who').textContent.localeCompare(
        b.querySelector('.who').textContent);
      if(k==='ports') return b.querySelectorAll('.chip').length - a.querySelectorAll('.chip').length;
      var l=function(r){ var e=r.querySelector('.left'); if(!e) return 1e9;
        var m=e.textContent.match(/([0-9]+)/); var v=m?+m[1]:0;
        return e.classList.contains('bad') ? -v : v; };
      return l(a)-l(b);
    });
    var tb=document.getElementById('rows');
    rows.forEach(function(r){ tb.appendChild(r); });
    apply();
  });
  document.addEventListener('keydown', function(e){
    if(e.key==='/' && document.activeElement!==q){ e.preventDefault(); q.focus(); }
    if(e.key==='Escape' && document.activeElement===q){ q.value=''; apply(); q.blur(); }
  });
  apply(false);

  // ---- 批量选择 ----
  // 勾选框通过 form="bulkform" 关联到表格外的表单，所以**没有 JS 也能提交**；
  // 这一段只是让选中状态可见（高亮行、显示操作条、全选）。
  var bar=document.getElementById('bulkbar'), seln=document.getElementById('seln');
  var all=document.getElementById('selall');
  var boxes=[].slice.call(document.querySelectorAll('#rows input[name=users]'));
  function visible(b){ return !b.closest('tr').hidden; }
  function syncSel(){
    var n=0;
    boxes.forEach(function(b){
      b.closest('tr').classList.toggle('picked', b.checked);
      if(b.checked) n++;
    });
    if(seln) seln.textContent=n;
    if(bar) bar.classList.toggle('on', n>0);
    if(all) all.checked = n>0 && boxes.every(function(b){ return b.checked || !visible(b); })
                          && boxes.some(function(b){ return b.checked; });
  }
  boxes.forEach(function(b){ b.addEventListener('change', syncSel); });
  if(all) all.addEventListener('change', function(){
    boxes.forEach(function(b){ if(visible(b)) b.checked=all.checked; });
    syncSel();
  });
  var clr=document.getElementById('bulkclear');
  if(clr) clr.addEventListener('click', function(){
    boxes.forEach(function(b){ b.checked=false; }); syncSel();
  });
  // 筛选变化后，全选框的状态要跟着重算
  var _apply=apply;
  apply=function(push){ _apply(push); syncSel(); };
  syncSel();
})();
</script>""" % (_ico("search", 14), d_to, cur_density, _ico("grid", 13), d_label,
        len(accounts), csrf_field(csrf),
        _ico("clock", 13), _ico("power", 13), _ico("power", 13), _ico("trash", 13),
        "".join(rows))

    # ⚠️ csrf 必须传下去：外壳里那个隐藏令牌是**空列表时唯一的令牌来源**。
    #    漏了它，账号列表为空时页面上一个 csrf 都没有 —— 你就永远建不了第一个账号。
    return _shell("frp 面板 · DoulorCloud",
                  top + '<main class="wrap" id="main">'
                  + ((metrics + histogram) if accounts else "")
                  + flash + table + "</main>",
                  csrf=csrf, nav="accounts")


def render_account_form(account=None, csrf="", message="", is_error=False, is_new=False):
    a = account or {}
    user = a.get("user") or ""
    token = a.get("token") or ""
    comment = a.get("comment") or ""
    ports_text = ", ".join(str(p) for p in (a.get("ports") or []))
    enabled = bool(a.get("enable", True))
    left = None if is_new else days_left(a)
    expire = (a.get("expire_at") or "")[:10]

    msg = ('<div class="banner %s" role="%s">%s</div>'
           % ("err" if is_error else "ok", "alert" if is_error else "status",
              html.escape(message))) if message else ""
    title = "新建账号" if is_new else user
    action = "/account/new" if is_new else "/account/%s" % urllib.parse.quote(user)

    user_field = ('<input name="user" value="%s" required autofocus '
                  'pattern="[A-Za-z0-9_.\\-]{1,64}" autocomplete="off" spellcheck="false" '
                  'translate="no" placeholder="例如 dcfrp_demo01…">'
                  % html.escape(user)) if is_new else \
        ('<input value="%s" disabled>' % html.escape(user))

    def radio(value, label, checked, hint=""):
        return ('<label><input type="radio" name="rental_mode" value="%s"%s> %s%s</label>'
                % (value, " checked" if checked else "", label,
                   ('<span class="dim" style="font-size:11.5px">%s</span>' % hint) if hint else ""))

    default_days = int(CONFIG.get("default_rental_days") or 30)
    radios = "".join([
        radio("days", "按天数", is_new, "从今天起"),
        radio("date", "指定到期日", False),
        radio("forever", "永久", False, "不过期"),
        radio("keep", "保持不变", not is_new),
    ])

    quick = ""
    if not is_new:
        if left is None:
            left_text = "无到期日"
        elif left < 0:
            left_text = "已过期 %d 天" % (-left)
        else:
            left_text = "剩余 %d 天" % left
        quick = """
<section class="card" style="margin-bottom:16px;padding:16px 20px">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <form method="POST" action="/account/%s/renew" style="margin:0">%s
      <input type="hidden" name="days" value="30">
      <button class="ghost">%s续期 30 天</button></form>
    <form method="POST" action="/account/%s/renew" style="margin:0">%s
      <input type="hidden" name="days" value="90">
      <button class="ghost">%s续期 90 天</button></form>
    <form method="POST" action="/account/%s/toggle" style="margin:0">%s
      <button class="ghost">%s%s</button></form>
    <a class="btn ghost" href="/account/%s/config">%s客户端配置</a>
    <span class="spacer"></span>
    <span class="dim" style="font-size:12.5px">当前到期 <b class="mono">%s</b> · %s</span>
  </div>
</section>""" % (
            urllib.parse.quote(user), csrf_field(csrf), _ico("clock", 13),
            urllib.parse.quote(user), csrf_field(csrf), _ico("clock", 13),
            urllib.parse.quote(user), csrf_field(csrf), _ico("power", 13),
            "停用该账号" if enabled else "启用该账号",
            urllib.parse.quote(user), _ico("code", 13),
            html.escape(expire or "无"), left_text)

    body = """<header class="top"><div class="top-in">
  <div class="brand"><span class="dot" style="background:%(dot)s"></span>
    <h1>%(title)s</h1>%(crumb)s</div>
  <span class="spacer"></span>
  <div class="top-actions">
    <a class="btn quiet mini top" href="/">返回列表</a>
  </div>
</div></header>
<main class="wrap" id="main">
%(msg)s
%(quick)s
<form method="POST" action="%(action)s" class="card">
  %(csrf)s
  <fieldset><legend>基本信息</legend>
    <label for="user">账号名%(req)s</label>
    %(user_field)s
    <div class="hint">字母、数字、下划线、点、中划线；客户端配置里的 <code>user</code> 就是它。</div>

    <label for="token">令牌（客户端凭据）</label>
    <div style="display:flex;gap:8px">
      <input id="token" name="token" value="%(token_attr)s" autocomplete="off" spellcheck="false">
      <button type="button" class="ghost" data-copy="%(token_attr)s" title="复制">%(ico_copy)s</button>
    </div>
    <div class="hint">留空则自动生成一个新的。改这个值会让用户手上的旧配置立刻失效。</div>

    <label for="ports">端口</label>
    <textarea id="ports" name="ports" spellcheck="false" autocomplete="off"
      translate="no" placeholder="31200, 31201-31203…">%(ports)s</textarea>
    <div class="hint">空格或逗号分隔，支持区间写法（<code>31200-31202</code>）。
      只有这里列出的端口，该账号的隧道才能用；其它端口会被插件直接拒绝。</div>

    <label for="comment">备注</label>
    <input id="comment" name="comment" value="%(comment)s" autocomplete="off"
      placeholder="例如：客户名 / 用途…">

    <label>状态</label>
    <div class="radios"><label><input type="checkbox" name="enable" value="1"%(checked)s>
      <span>启用</span></label></div>
    <div class="hint">停用后该账号立即无法登录，也无法新建隧道。</div>
  </fieldset>

  <fieldset><legend>租期</legend>
    <div class="radios">%(radios)s</div>
    <div class="grid2" style="margin-top:14px">
      <div><label for="rd">天数</label>
        <input id="rd" name="rental_days" value="%(days)d" inputmode="numeric"
          autocomplete="off"></div>
      <div><label for="ed">指定到期日</label>
        <input id="ed" name="expire_date" placeholder="2026-12-31…" value="%(expire)s"
          autocomplete="off" translate="no"></div>
    </div>
    <div class="hint">到期那一刻插件就开始拒绝该账号的心跳与新建隧道 ——
      用户的服务当刻不可访问，已连上的客户端会被断开。</div>
  </fieldset>

  <div class="form-actions">
    <button type="submit">保存</button>
    <a class="btn ghost" href="/">取消</a>
    <span class="spacer"></span>
    <span class="dim" style="font-size:12px">端口冲突、非法账号名会在保存时直接报在这里</span>
  </div>
</form>
</main>""" % {
        "dot": "var(--ink-3)" if is_new else "var(--ok)",
        "title": html.escape(title),
        "crumb": "" if is_new else '<span class="dim" style="font-size:12.5px">· 编辑中</span>',
        "back": _ico("back", 13),
        "msg": msg, "quick": quick, "action": action, "csrf": csrf_field(csrf),
        "req": '<span class="req">*</span>' if is_new else "",
        "user_field": user_field,
        "token_attr": html.escape(token, True),
        "ico_copy": _ico("copy", 13),
        "ports": html.escape(ports_text),
        "comment": html.escape(comment),
        "checked": " checked" if enabled else "",
        "radios": radios, "days": default_days, "expire": html.escape(expire),
    }

    return _shell(("%s · frp 面板" % title), body, csrf=csrf, nav="accounts")


def render_config(account, config_text, csrf=""):
    user = account.get("user") or ""
    esc = html.escape(user)
    qu = urllib.parse.quote(user)
    left = days_left(account)
    if left is None:
        left_text = "无到期日"
    elif left < 0:
        left_text = "已过期 %d 天" % (-left)
    else:
        left_text = "剩余 %d 天" % left

    # 给 TOML 做个轻量高亮（纯正则替换，不引库）
    def hl(line):
        s = html.escape(line)
        if s.lstrip().startswith("#"):
            return '<span class="c">%s</span>' % s
        m = re.match(r'^(\s*)([A-Za-z_][\w.]*)(\s*=\s*)(.*)$', s)
        if m:
            return '%s<span class="k">%s</span>%s<span class="s">%s</span>' % (
                m.group(1), m.group(2), m.group(3), m.group(4))
        return s

    code = "\n".join(hl(l) for l in config_text.rstrip("\n").split("\n"))

    body = """<header class="top"><div class="top-in">
  <div class="brand"><span class="dot" style="background:var(--accent)"></span>
    <h1>客户端配置</h1><span class="mono dim">%s</span></div>
  <span class="spacer"></span>
  <div class="top-actions">
    <a class="btn quiet mini" href="/account/%s">%s编辑账号</a>
    <a class="btn quiet mini" href="/">返回列表</a>
  </div>
</div></header>
<main class="wrap" id="main">
<div class="banner ok">把下面内容存成 <code>frpc.toml</code>，放在 frpc 同目录后运行
  <code>./frpc -c frpc.toml</code>。记得把 <code>localPort</code> 改成你本机真正要暴露的服务。</div>
<div class="code-head">
  <h2>frpc.toml</h2>
  <span class="dim" style="font-size:12.5px">%s</span>
  <span class="spacer"></span>
  <button type="button" class="ghost mini" data-copy="%s">%s复制</button>
  <a class="btn mini" href="/account/%s/config.toml">%s下载 .toml</a>
</div>
<pre>%s</pre>
</main>""" % (esc, qu, _ico("edit", 13), left_text,
              html.escape(config_text, True), _ico("copy", 13),
              qu, _ico("download", 13), code)

    return _shell("客户端配置 · %s" % user, body, csrf=csrf, nav="accounts")


def render_ports(accounts, csrf=""):
    """
    端口分配视图。

    回答的是运营里最常被问的一句：「这个端口是谁的？」以及「还有哪些端口空着？」
    表格看端口是散的，这里给一张完整的分配图。
    """
    owner = {}
    for a in sorted(accounts, key=lambda x: (x.get("user") or "").lower()):
        for p in (a.get("ports") or []):
            try:
                owner[int(p)] = a.get("user") or ""
            except (TypeError, ValueError):
                pass

    p_start = int(CONFIG.get("default_port_start") or 0)
    p_end = int(CONFIG.get("default_port_end") or 0)
    has_range = bool(p_start and p_end and p_end >= p_start)
    span = (p_end - p_start + 1) if has_range else 0
    in_range = sorted(p for p in owner if has_range and p_start <= p <= p_end)
    outside = sorted(p for p in owner if p not in set(in_range))
    util = int(round(len(in_range) * 100.0 / span)) if span else 0

    # 区间太长就不逐个画（1000 个格子没有意义），只列已占用的
    draw_all = has_range and span <= 400
    if draw_all:
        cells = []
        taken_set = set(owner)
        for p in range(p_start, p_end + 1):
            if p in taken_set:
                cells.append('<span class="port taken" title="%s：%s" translate="no">%d</span>'
                             % (p, html.escape(owner[p], True), p))
            else:
                cells.append('<span class="port free" translate="no" title="空闲">%d</span>' % p)
        grid = '<div class="port-grid">%s</div>' % "".join(cells)
        grid_hint = "区间 %d–%d 共 %d 个端口，实心=已分配，虚线=空闲。" % (p_start, p_end, span)
    else:
        cells = "".join(
            '<span class="port taken" title="%s" translate="no">%d</span>'
            % (html.escape(owner[p], True), p) for p in sorted(owner))
        grid = ('<div class="port-grid">%s</div>' % cells) if cells \
            else '<div class="dim">还没有分配任何端口。</div>'
        grid_hint = ("已分配的端口（%d 个）。区间 %d–%d 太长，未逐个画出空闲端口。"
                     % (len(owner), p_start, p_end)) if has_range else \
            "未配置默认端口区间（default_port_start / default_port_end）。"

    # 区间外单独提醒：这些端口不在默认区间里，通常意味着手工分配过
    outside_html = ""
    if outside:
        outside_html = ('<div class="banner" style="margin-top:20px">'
                        '<b>%d 个端口在默认区间之外</b>：<span class="mono" translate="no">%s</span>'
                        '<div class="hint">这些多半是历史账号手工分配的，仍然有效 —— '
                        '判定只看"这个端口是否分配给我"，与区间无关。</div></div>'
                        % (len(outside), html.escape(", ".join(str(p) for p in outside[:40]))))

    metrics = '<div class="metrics">%s</div>' % "".join([
        '<div class="metric"><div class="k">已分配端口</div><div class="v">%d</div>'
        '<div class="sub">%d 个账号</div></div>' % (len(owner), len(accounts)),
        '<div class="metric"><div class="k">区间内占用</div><div class="v">%d%%</div>'
        '<div class="sub">%d / %d</div>'
        '<div class="track"><i style="width:%d%%"></i></div></div>'
        % (util, len(in_range), span, util),
        '<div class="metric"><div class="k">区间内空闲</div><div class="v">%d</div>'
        '<div class="sub">%s</div></div>'
        % (max(0, span - len(in_range)),
           ("%d–%d" % (p_start, p_end)) if has_range else "未配置区间"),
        '<div class="metric warn"><div class="k">区间外端口</div><div class="v">%d</div>'
        '<div class="sub">历史分配</div></div>' % len(outside),
    ])

    body = """<header class="top"><div class="top-in">
  <div class="brand"><span class="dot" style="background:var(--md-primary)"></span>
    <h1>端口分配</h1></div>
  <span class="spacer"></span>
  <div class="top-actions">
    <a class="btn" href="/account/new">%s新建账号</a>
  </div>
</div></header>
<main class="wrap" id="main">
%s
<div class="code-head"><h2>分配图</h2>
  <span class="dim" style="font-size:12.5px">%s</span></div>
%s
%s
</main>""" % (_ico("plus", 14), metrics,
              html.escape(grid_hint), grid, outside_html)

    return _shell("端口分配 · frp 面板", body, csrf=csrf, nav="ports")


# ---------------------------------------------------------------- 操作日志视图
# 面板一直在记日志（谁改了哪个账号、谁把令牌取走了、插件放行/拒绝了谁），
# 但以前只能 SSH 上去 tail —— 运营要的就是"刚才那次改动是谁做的"，界面上看不到等于没有。
LOG_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+(.*)$")

# 按消息内容判断级别。日志里没有结构化级别字段，用关键词分类够用且不改动写入侧。
LOG_KINDS = [
    ("err", "错误", lambda m: "ERROR" in m or "异常" in m),
    ("bad", "拒绝", lambda m: "REJECT" in m or "拒绝" in m),
    ("warn", "警告", lambda m: "WARN" in m or "巡检" in m),
    ("ok", "放行", lambda m: "ALLOW" in m),
    ("info", "管理", lambda m: m.startswith(("WEB", "ADMIN", "查看令牌", "管理员"))),
]


def classify_log(message):
    for key, label, pred in LOG_KINDS:
        try:
            if pred(message):
                return key, label
        except Exception:  # noqa: BLE001
            continue
    return "info", "其他"


def tail_log(path, max_bytes=262144, max_lines=500):
    """
    只读日志文件末尾一段（不把整个文件读进内存 —— 日志可能是几百 MB）。
    返回 [(日期, 时间, 消息), ...]，新的在前。
    """
    if not path:
        return []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
                fh.readline()          # 丢掉被截断的半行
            raw = fh.read()
    except (OSError, ValueError):
        return []

    out = []
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.rstrip()
        if not line:
            continue
        m = LOG_TS_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2), m.group(3)))
        else:
            # 续行（比如堆栈）并到上一条里，不要当成独立事件
            if out:
                out[-1] = (out[-1][0], out[-1][1], out[-1][2] + "\n" + line)
    out.reverse()
    return out[:max_lines]


def render_logs(entries, path, filter_key="all", csrf=""):
    counts = {}
    for _, _, msg in entries:
        key, _label = classify_log(msg)
        counts[key] = counts.get(key, 0) + 1

    shown = entries
    if filter_key != "all":
        shown = [e for e in entries if classify_log(e[2])[0] == filter_key]

    rows = []
    for date, clock, msg in shown[:300]:
        key, label = classify_log(msg)
        first, _, rest = msg.partition("\n")
        extra = ('<span class="logstack">%s</span>' % html.escape(rest)) if rest else ""
        rows.append(
            '<li class="logline %s"><span class="ts mono" translate="no">%s</span>'
            '<span class="pill %s">%s</span>'
            '<span class="msg">%s%s</span></li>'
            % (key, html.escape(clock), key, label, html.escape(first), extra))

    if not rows:
        rows.append('<li class="logline"><span class="msg dim">'
                    '这个筛选下没有记录。</span></li>')

    def seg(value, label):
        n = counts.get(value, 0) if value != "all" else len(entries)
        active = "true" if filter_key == value else "false"
        return ('<a class="btn quiet mini top" href="/logs?kind=%s" '
                'aria-pressed="%s" style="%s">%s <b>%d</b></a>'
                % (value, active, "background:var(--md-secondary-container)" if active == "true" else "",
                   label, n))

    metrics = '<div class="metrics">%s</div>' % "".join([
        '<div class="metric"><div class="k">日志条数</div><div class="v">%d</div>'
        '<div class="sub">最多显示最近 500 条</div></div>' % len(entries),
        '<div class="metric bad"><div class="k">拒绝</div><div class="v">%d</div>'
        '<div class="sub">插件挡掉的连接</div></div>' % counts.get("bad", 0),
        '<div class="metric warn"><div class="k">错误 / 警告</div><div class="v">%d</div>'
        '<div class="sub">需要看的</div></div>'
        % (counts.get("err", 0) + counts.get("warn", 0)),
        '<div class="metric"><div class="k">管理操作</div><div class="v">%d</div>'
        '<div class="sub">改账号 / 取令牌</div></div>' % counts.get("info", 0),
    ])

    body = """<header class="top"><div class="top-in">
  <div class="brand"><span class="dot" style="background:var(--md-primary)"></span>
    <h1>操作日志</h1><span class="mono dim" translate="no">%s</span></div>
  <span class="spacer"></span>
  <div class="top-actions">
    <a class="btn quiet mini top" href="/logs?kind=%s">%s刷新</a>
  </div>
</div></header>
<main class="wrap" id="main">
%s
<div class="toolbar">
  %s %s %s %s %s
  <span class="spacer"></span>
  <span class="dim" style="font-size:12.5px">共 %d 条匹配</span>
</div>
<ul class="loglist">%s</ul>
<div class="hint">日志文件：<code translate="no">%s</code>。
  插件对每次登录/心跳/新建隧道的放行与拒绝都在这里；账号改动也留痕。</div>
</main>""" % (html.escape(os.path.basename(path or "panel.log")), filter_key,
              _ico("clock", 13), metrics,
              seg("all", "全部"), seg("bad", "拒绝"), seg("err", "错误"),
              seg("info", "管理"), seg("ok", "放行"),
              len(shown), "".join(rows), html.escape(path or "（未配置）"))

    return _shell("操作日志 · frp 面板", body, csrf=csrf, nav="logs")


# ---------------------------------------------------------------- 设置页
# 哪些键能在面板里改、哪些不能，是刻意分开的：
#   · 可改的：改完立刻生效，写回配置文件，重启后仍在
#   · 只读的：改了会影响监听/存储/安全边界，必须在文件里改 + 重启（面板里只展示）
#     —— 尤其是 listen_host 和 user_prefix：前者能一句话把面板暴露到公网，
#        后者是"自动化只能碰 dcfrp_ 前缀"那条安全边界。
SETTINGS_FIELDS = [
    ("front", "对外展示（生成客户端配置用）", [
        ("frps_public_addr", "服务器地址", "text",
         "用户 frpc.toml 里 serverAddr 填的地址，写域名或公网 IP"),
        ("frps_bind_port", "frps 端口", "int",
         "frps 的 bindPort，用户连这个端口"),
        ("frps_global_token", "全局 auth.token", "text",
         "frps 的 auth.token；生成配置时写进 auth.token。改它要同时改 frps 并重启"),
        ("proxy_name_template", "代理名模板", "text",
         "生成 [[proxies]].name 用，{port} 会替换成端口号"),
    ]),
    ("rental", "租期与端口", [
        ("default_rental_days", "默认租期（天）", "int",
         "新建账号时租期输入框的默认值"),
        ("expiring_soon_days", "「即将到期」阈值（天）", "int",
         "距到期还剩这么多天就在列表里标黄"),
        ("default_port_start", "默认端口区间起", "int", "新建账号时建议分配的区间起始"),
        ("default_port_end", "默认端口区间止", "int", "同上，含两端"),
        ("auto_disable_expired", "巡检时把已到期账号的 enable 也置为停用", "bool",
         "**这个开关是冗余的，开不开效果一样**，可以留着也可以不管它。"
         "到期停用其实由 DoulorCloud 侧完成：Worker 在 /frp/agent/desired 里按 "
         "expires_at 算出 enable（只有 active 且未到期才为 true），agent 每 20 秒同步过来，"
         "所以到期那一刻账号就会被停用 —— **不依赖这个开关**。"
         "另外插件在 Login / Ping 上按 expire_at 也会直接拒绝，双保险。"),
    ]),
    ("security", "登录与安全", [
        ("login_max_fails", "登录失败上限", "int", "连续失败这么多次就临时封禁该来源 IP"),
        ("login_ban_seconds", "封禁时长（秒）", "int", "封禁多久后允许重试"),
        ("session_ttl", "会话有效期（秒）", "int", "登录后多久需要重新登录"),
        ("sweep_interval_seconds", "巡检间隔（秒）", "int", "后台记录到期账号的频率"),
    ]),
]

# 只读展示：改了这些要编辑文件并重启，面板里不给改
SETTINGS_READONLY = [
    ("listen_host", "监听地址", "改它可能一句话把面板暴露到公网 —— 请编辑配置文件后重启"),
    ("listen_port", "监听端口", "同上"),
    ("allow_public_bind", "允许非本机监听", "安全开关，必须改文件"),
    ("user_prefix", "可管理前缀", "自动化只能碰这个前缀的账号（安全边界），必须改文件"),
    ("data_file", "账号数据文件", "改它会指向另一份账号数据"),
    ("log_file", "日志文件", "操作日志页读的就是它"),
    ("session_secret", "会话签名密钥", "改它会让所有已登录会话立即失效"),
]


def render_settings(csrf="", message="", is_error=False):
    def field_html(key, label, kind, hint):
        value = CONFIG.get(key)
        if kind == "bool":
            checked = " checked" if value else ""
            widget = ('<div class="radios"><label><input type="checkbox" name="%s" '
                      'value="1"%s><span>启用</span></label></div>' % (key, checked))
        else:
            widget = ('<input name="%s" value="%s" autocomplete="off" translate="no">'
                      % (key, html.escape(str(value if value is not None else ""), True)))
        return ('<div class="setrow"><label for="%s">%s</label>%s'
                '<div class="hint">%s</div></div>' % (key, html.escape(label), widget,
                                                      html.escape(hint)))

    sections = []
    for _sid, title, fields in SETTINGS_FIELDS:
        sections.append('<fieldset><legend>%s</legend>%s</fieldset>'
                        % (html.escape(title),
                           "".join(field_html(*f) for f in fields)))

    readonly = "".join(
        '<div class="setrow ro"><span class="k">%s</span>'
        '<span class="v mono" translate="no">%s</span>'
        '<div class="hint">%s</div></div>'
        % (html.escape(label), html.escape(str(CONFIG.get(key))), html.escape(hint))
        for key, label, hint in SETTINGS_READONLY)

    # ---- API 密钥 ----
    keys = CONFIG.get("api_keys") or []
    legacy = (CONFIG.get("agent_secret") or "").strip()
    if keys:
        rows = []
        for k in keys:
            kid = html.escape(str(k.get("id") or ""), True)
            on = bool(k.get("enabled", True))
            rows.append(
                '<tr><td><b>%s</b><div class="who-sub">%s</div></td>'
                '<td><code>%s…</code></td>'
                '<td>%s</td>'
                '<td><div class="acts">'
                '<form method="POST" action="/settings/key/toggle">%s'
                '<input type="hidden" name="id" value="%s">'
                '<button class="quiet mini">%s</button></form>'
                '<form method="POST" action="/settings/key/delete">%s'
                '<input type="hidden" name="id" value="%s">'
                '<button class="danger mini" data-confirm="确认吊销？">吊销</button></form>'
                '</div></td></tr>'
                % (html.escape(str(k.get("name") or "")),
                   html.escape(str(k.get("created_at") or "")[:19]),
                   html.escape((k.get("secret") or "")[:8]),
                   '<span class="pill ok"><i></i>启用</span>' if on
                   else '<span class="pill off"><i></i>停用</span>',
                   csrf_field(csrf), kid, "停用" if on else "启用",
                   csrf_field(csrf), kid))
        keytable = ('<div class="table-wrap" style="margin-top:14px"><table>'
                    '<thead><tr><th>名称</th><th>密钥（前 8 位）</th><th>状态</th>'
                    '<th style="text-align:right">操作</th></tr></thead>'
                    '<tbody>%s</tbody></table></div>' % "".join(rows))
    else:
        keytable = '<div class="hint" style="margin-top:12px">还没有 API 密钥。</div>'

    legacy_note = ""
    if legacy:
        legacy_note = ('<div class="hint" style="margin-top:12px">另外还有一个旧式单密钥 '
                       '<code>agent_secret</code> 仍在使用中（前 8 位 '
                       '<code>%s…</code>）。它只能改配置文件，面板里不展示完整值。</div>'
                       % html.escape(legacy[:8]))

    msg = ('<div class="banner %s" role="%s">%s</div>'
           % ("err" if is_error else "ok", "alert" if is_error else "status",
              html.escape(message))) if message else ""

    body = """<header class="top"><div class="top-in">
  <div class="brand"><span class="dot" style="background:var(--md-primary)"></span>
    <h1>设置</h1><span class="dim" style="font-size:12.5px">%s</span></div>
</div></header>
<main class="wrap" id="main">
%s
<form method="POST" action="/settings">
  %s
  <fieldset><legend>管理员登录</legend>
    <div class="setrow"><label for="admin_user">用户名</label>
      <input id="admin_user" name="admin_user" value="%s" autocomplete="off" translate="no"></div>
    <div class="setrow"><label for="admin_password">新口令</label>
      <input id="admin_password" name="admin_password" type="password"
        autocomplete="new-password" placeholder="留空 = 不修改…"></div>
    <div class="setrow"><label for="admin_password2">再输一次</label>
      <input id="admin_password2" name="admin_password2" type="password"
        autocomplete="new-password" placeholder="留空 = 不修改…"></div>
    <div class="hint">改口令会让**其它浏览器上已登录的会话失效**（本机回环免登录不受影响）。</div>
  </fieldset>
  %s
  <div class="form-actions">
    <button type="submit">保存设置</button>
    <a class="btn quiet" href="/docs">查看文档</a>
    <span class="spacer"></span>
    <span class="dim" style="font-size:12px">配置文件：<code translate="no">%s</code></span>
  </div>
</form>

<h2 style="margin:28px 0 6px;font-size:16px">外部 API 密钥</h2>
<div class="hint">用这些密钥对 <code>/api/admin/*</code> 做 HMAC 签名调用（口径见<a
  href="/docs#api">文档</a>）。可以给不同调用方各发一个，泄漏了单独吊销，不用全体换。</div>
<form method="POST" action="/settings/key/new" class="card" style="margin-top:14px;
  padding:16px 20px;max-width:760px">
  %s
  <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
    <div style="flex:1;min-width:200px"><label for="keyname">新密钥名称</label>
      <input id="keyname" name="name" placeholder="例如：Worker / 定时脚本…"
        autocomplete="off"></div>
    <button type="submit">创建密钥</button>
  </div>
</form>
%s
%s

<h2 style="margin:28px 0 6px;font-size:16px">只读配置</h2>
<div class="hint">这些改了会影响监听、存储或安全边界，只能在配置文件里改并重启面板。</div>
<div class="card" style="margin-top:14px;padding:6px 20px 18px;max-width:760px">%s</div>
</main>""" % (html.escape(CONFIG_PATH or "（未指定）"), msg, csrf_field(csrf),
              html.escape(str(CONFIG.get("admin_user") or "")),
              "".join(sections), html.escape(CONFIG_PATH or ""),
              csrf_field(csrf), keytable, legacy_note, readonly)

    return _shell("设置 · frp 面板", body, csrf=csrf, nav="settings")


def render_docs(csrf=""):
    rows = []
    for _sid, title, fields in SETTINGS_FIELDS:
        for key, label, _kind, hint in fields:
            rows.append("<tr><td><code translate=\"no\">%s</code></td><td>%s</td>"
                        "<td>%s</td><td>面板</td></tr>"
                        % (html.escape(key), html.escape(label), html.escape(hint)))
    for key, label, hint in SETTINGS_READONLY:
        rows.append("<tr><td><code translate=\"no\">%s</code></td><td>%s</td>"
                    "<td>%s</td><td>文件+重启</td></tr>"
                    % (html.escape(key), html.escape(label), html.escape(hint)))

    body = """<header class="top"><div class="top-in">
  <div class="brand"><span class="dot" style="background:var(--md-primary)"></span>
    <h1>文档</h1></div>
  <span class="spacer"></span>
  <div class="top-actions"><a class="btn quiet mini top" href="/settings">去设置</a></div>
</div></header>
<main class="wrap" id="main">

<h2>面板能做什么</h2>
<table><thead><tr><th>功能</th><th>在哪</th></tr></thead><tbody>
<tr><td>新建 / 编辑 / 删除账号，改令牌、端口、备注、启停</td><td>账号页</td></tr>
<tr><td>设置租期（按天数 / 指定日期 / 永久）、续期、批量续期</td><td>账号页</td></tr>
<tr><td>一键生成并下载用户要用的 <code>frpc.toml</code></td><td>账号页 →「配置」</td></tr>
<tr><td>看端口分配：谁占了哪个、哪些空着、哪些在默认区间外</td><td>端口页</td></tr>
<tr><td>看操作日志：谁改了什么、插件放行/拒绝了谁、谁取走了令牌</td><td>日志页</td></tr>
<tr><td>改面板口令、租期默认值、API 密钥</td><td>设置页</td></tr>
</tbody></table>

<h2>到期是怎么生效的</h2>
<p>插件在 <code>Login</code> / <code>NewWorkConn</code> / <code>Ping</code> 上按
<code>expire_at</code> <b>直接拒绝</b> —— 到期那一刻用户就连不上了，
<b>不依赖任何定时任务</b>。已经连上的客户端会在下一次心跳时被断开。</p>

<h2 id="api">外部 API（HMAC 签名）</h2>
<p>用于让 Worker、脚本等从外部管理账号。签名口径：</p>
<pre><span class="c"># canonical 用换行连接这四段</span>
canonical = "\\n".join([ts, METHOD, path含query, sha256hex(原始请求体)])
signature = HMAC_SHA256(<span class="k">密钥</span>, canonical).hexdigest()

<span class="c"># 两个请求头</span>
X-Frp-Agent-Ts: <span class="s">&lt;Unix 秒&gt;</span>
X-Frp-Agent-Signature: <span class="s">&lt;上面算出的十六进制&gt;</span></pre>
<p class="hint">时间戳容差 300 秒。签名必须对<b>原始请求体字节</b>取 sha256 ——
对"解析后重新序列化"的结果签名，键顺序一变就永远对不上。</p>

<table><thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead><tbody>
<tr><td>GET</td><td><code>/api/admin/accounts</code></td><td>列出全部（含剩余天数）</td></tr>
<tr><td>GET</td><td><code>/api/admin/accounts/&lt;user&gt;</code></td><td>查单个</td></tr>
<tr><td>PUT</td><td><code>/api/admin/accounts/&lt;user&gt;</code></td><td>新增/覆盖；可传 <code>days</code> 直接设租期</td></tr>
<tr><td>DELETE</td><td><code>/api/admin/accounts/&lt;user&gt;</code></td><td>删除</td></tr>
<tr><td>POST</td><td><code>/api/admin/accounts/&lt;user&gt;/enable</code></td><td>启用</td></tr>
<tr><td>POST</td><td><code>/api/admin/accounts/&lt;user&gt;/disable</code></td><td>停用</td></tr>
<tr><td>POST</td><td><code>/api/admin/accounts/&lt;user&gt;/renew</code></td><td><code>{"days":30}</code> 续期</td></tr>
<tr><td>GET</td><td><code>/api/admin/accounts/&lt;user&gt;/config</code></td><td>生成 frpc.toml 文本</td></tr>
</tbody></table>

<h2>访问控制</h2>
<table><thead><tr><th>来源</th><th>端点</th><th>要求</th></tr></thead><tbody>
<tr><td>本机回环</td><td>全部</td><td>免登录（frps 插件和 agent 都从回环来）</td></tr>
<tr><td>外部</td><td><code>/handler</code></td><td><b>403</b>，插件回调只收本机</td></tr>
<tr><td>外部</td><td><code>/api/admin/*</code></td><td>HMAC 签名</td></tr>
<tr><td>外部</td><td><code>/health</code></td><td>放行（不含敏感信息）</td></tr>
<tr><td>外部</td><td>其它（网页、<code>/tokens</code>、<code>/api/token/&lt;user&gt;</code>）</td>
<td>必须登录；令牌默认不上屏，点「显示」才按需取且每次记日志</td></tr>
</tbody></table>

<h2>配置项一览</h2>
<table><thead><tr><th>键</th><th>含义</th><th>说明</th><th>改法</th></tr></thead>
<tbody>%s</tbody></table>

<h2>账号前缀那条线</h2>
<p><code>user_prefix</code>（默认 <code>dcfrp_</code>）是给<b>自动化</b>用的边界：
agent 走兼容接口（<code>/tokens</code>、<code>/add</code>、<code>/update</code>…）
只会碰这个前缀的账号，历史人工账号永不被自动流程误改。
而<b>网页和 HMAC 管理接口</b>是管理员通道，可以管理任何账号。</p>
</main>""" % "".join(rows)

    return _shell("文档 · frp 面板", body, csrf=csrf, nav="docs")


# ---------------------------------------------------------------- HTTP 服务
class PanelHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store = None

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        """
        🔴 **每个请求开始前必须清掉请求体缓存。**

        HTTP/1.1 keep-alive 下，BaseHTTPRequestHandler 会用**同一个实例**连续处理
        同一条连接上的多个请求。如果把请求体缓存在 `self._body_cache` 上而不在每个
        请求开头清空，第 N 个请求就会拿到**第 N-1 个请求的 body**。

        后果非常严重：`self.path`（→ op）是新请求的，`content` 却是旧请求的，
        于是会出现「op=NewProxy、content 却是 NewWorkConn」这种错配，
        **授权判定会基于错误的对象做出**。实测症状：
          · 面板日志里 op/content 系统性错配
          · frpc 每 ~13 秒被断开重连一次（因为拿到了不对的判定结果）
        而同时用抓包插件（无状态、不做分支）看，一切正常 —— 这就是定位的关键对照。
        """
        self._body_cache = None
        self._raw_body = b""
        BaseHTTPRequestHandler.handle_one_request(self)

    def parse_request(self):
        """
        主题偏好要等**请求头解析完**才能读 —— `self.headers` 是
        `BaseHTTPRequestHandler.parse_request()` 里才设置的。
        （第一版我把它写在 `handle_one_request` 里，结果每次请求都
        `AttributeError: no attribute 'headers'`，面板能起但全挂。）
        """
        ok = BaseHTTPRequestHandler.parse_request(self)
        if ok:
            set_current_theme(self._cookie(THEME_COOKIE) or "dark")
            set_current_density(self._cookie(DENSITY_COOKIE) or "comfortable")
        return ok

    # ---- 工具
    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        """
        读请求体并缓存。

        ⚠️ 两件事都必须在这里做对：
          1. **只读一次** —— HTTP 流读第二次会阻塞。
          2. **保留原始字节** `self._raw_body` —— HMAC 签名是对**原始 body 字节**
             取 sha256 的；如果我们拿解析后再 `json.dumps` 的结果去算，
             键顺序/空格/转义都会和 Worker 侧不一致，签名永远对不上。
        """
        if getattr(self, "_body_cache", None) is not None:
            return self._body_cache
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self._raw_body = raw
        if not raw:
            self._body_cache = {}
        else:
            try:
                self._body_cache = json.loads(raw.decode("utf-8"))
            except ValueError:
                self._body_cache = {"__parse_error__": True}
        return self._body_cache

    def _query(self):
        q = {}
        if "?" in self.path:
            for pair in self.path.split("?", 1)[1].split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    q[k] = v
        return q

    def _path(self):
        return self.path.split("?", 1)[0]

    # ---- 访问控制
    def _client_ip(self):
        return (self.client_address[0] or "").split("%")[0]

    def _is_loopback(self):
        ip = self._client_ip()
        return ip in ("127.0.0.1", "::1", "localhost") or ip.startswith("127.")

    def _session_token(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            key, _, value = part.strip().partition("=")
            if key == SESSION_COOKIE:
                return value
        return ""

    def _session_ok(self):
        return verify_session_token(self._session_token())

    # ---- CSRF / 页面
    def _cookie(self, name):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return ""

    def _same_origin_back(self):
        """
        从 Referer 里算出"改完偏好跳回哪一页"。**只接受同源**。

        不校验的话 `/theme?to=x` 就是个开放重定向 —— 攻击者能构造
        `/theme?to=light` 让用户从你的域名被带去钓鱼站。
        主题和行密度**共用这一份**：复制两份的话，改了一处忘了另一处就是漏洞。
        """
        ref = self.headers.get("Referer") or ""
        if not ref:
            return "/"
        parts = urllib.parse.urlsplit(ref)
        host = self.headers.get("Host") or ""
        if parts.netloc and parts.netloc != host:
            return "/"
        back = parts.path or "/"
        if parts.query:
            back += "?" + parts.query
        return back

    def _csrf(self):
        """当前 CSRF 令牌；没有（或已失效）就发一个新的。"""
        existing = self._cookie(CSRF_COOKIE)
        if existing and csrf_token_valid(existing):
            return existing
        return new_csrf_token()

    def _csrf_cookie_header(self, token):
        return ("Set-Cookie",
                "%s=%s; Path=/; HttpOnly; SameSite=Lax" % (CSRF_COOKIE, token))

    def _check_csrf(self, form):
        """
        校验 CSRF。**本机回环也要校验**：
        面板在 127.0.0.1 上、回环免登录，如果不校验，
        管理员浏览器里打开的任意网页都能往 http://127.0.0.1:7210 发写请求。
        """
        submitted = ""
        v = form.get("csrf")
        if isinstance(v, list) and v:
            submitted = v[0]
        cookie = self._cookie(CSRF_COOKIE)
        if not (cookie and submitted and csrf_token_valid(submitted)):
            return False
        return hmac.compare_digest(cookie, submitted)

    def _page_form(self, account=None, is_new=False, message="", is_error=False):
        csrf = self._csrf()
        return self._html(render_account_form(account, csrf=csrf, message=message,
                                              is_error=is_error, is_new=is_new),
                          extra_headers=[self._csrf_cookie_header(csrf)])

    def _page_config(self, account):
        csrf = self._csrf()
        return self._html(render_config(account, render_frpc_config(account), csrf=csrf),
                          extra_headers=[self._csrf_cookie_header(csrf)])

    def _page_list(self, message="", is_error=False):
        csrf = self._csrf()
        return self._html(render_accounts(self.store.all(), csrf=csrf, message=message,
                                          is_error=is_error),
                          extra_headers=[self._csrf_cookie_header(csrf)])

    def _download(self, filename, text):
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Disposition",
                         'attachment; filename="%s"' % filename.replace('"', ""))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _form(self):
        """读并解析 application/x-www-form-urlencoded 请求体。"""
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        return urllib.parse.parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)

    # ---- 账号写操作（网页）
    def _settings_redirect(self, err=None):
        q = "/settings"
        if err:
            q += "?err=" + urllib.parse.quote(err)
        else:
            q += "?ok=1"
        return self._redirect(q)

    def _settings_page(self, message="", is_error=False):
        csrf = self._csrf()
        return self._html(render_settings(csrf=csrf, message=message, is_error=is_error),
                          extra_headers=[self._csrf_cookie_header(csrf)])

    def _handle_settings(self, path):
        """设置页的写操作：保存设置、创建/启停/吊销 API 密钥。"""
        if path not in ("/settings", "/settings/key/new",
                        "/settings/key/toggle", "/settings/key/delete"):
            return False

        def one(key, default=""):
            v = form.get(key)
            return v[0] if isinstance(v, list) and v else default

        form = self._form()
        if not self._check_csrf(form):
            log("WARN 拒绝 CSRF 校验不通过的设置提交（来源 %s）" % self._client_ip())
            return self._settings_redirect("表单校验失败（CSRF），请刷新页面重试")

        # ---- API 密钥 ----
        if path.startswith("/settings/key/"):
            keys = [dict(k) for k in (CONFIG.get("api_keys") or []) if isinstance(k, dict)]
            kid = one("id").strip()

            if path == "/settings/key/new":
                name = one("name").strip() or "未命名密钥"
                secret = "%s%s" % (new_token(), new_token())   # 64 字符
                new_id = new_token()[:12]
                keys.append({
                    "id": new_id, "name": name, "secret": secret,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "enabled": True,
                })
                ok, why = save_config({"api_keys": keys})
                if not ok:
                    log("ERROR 创建密钥写盘失败：%s" % why)
                    return self._settings_redirect("写盘失败：%s" % why)
                log("WEB 创建 API 密钥 %r（id=%s）" % (name, new_id))
                # 完整密钥只在这次响应里出现（不过它本来也明文存在 600 的配置文件里）
                return self._settings_page(
                    "密钥「%s」已创建。完整密钥（请立刻复制保存）：%s" % (name, secret))

            target = next((k for k in keys if k.get("id") == kid), None)
            if target is None:
                return self._settings_redirect("找不到这个密钥")
            if path == "/settings/key/toggle":
                target["enabled"] = not bool(target.get("enabled", True))
                action = "启用" if target["enabled"] else "停用"
            else:
                keys = [k for k in keys if k.get("id") != kid]
                action = "吊销"
            ok, why = save_config({"api_keys": keys})
            if not ok:
                return self._settings_redirect("写盘失败：%s" % why)
            log("WEB %s API 密钥 %r（id=%s）" % (action, target.get("name"), kid))
            return self._settings_redirect(None)

        # ---- 保存设置 ----
        updates = {}
        errors = []

        new_user = one("admin_user").strip()
        if not new_user:
            errors.append("用户名不能为空")
        else:
            updates["admin_user"] = new_user

        pw1, pw2 = one("admin_password"), one("admin_password2")
        if pw1 or pw2:
            if pw1 != pw2:
                errors.append("两次输入的口令不一致")
            elif len(pw1) < 8:
                errors.append("口令至少 8 位")
            else:
                updates["admin_password"] = pw1

        for _sid, _title, fields in SETTINGS_FIELDS:
            for key, label, kind, _hint in fields:
                if kind == "bool":
                    updates[key] = one(key) == "1"
                elif kind == "int":
                    text = one(key).strip()
                    try:
                        value = int(text)
                    except (TypeError, ValueError):
                        errors.append("%s 必须是整数" % label)
                        continue
                    if value < 0 or value > 10 ** 9:
                        errors.append("%s 超出合理范围" % label)
                        continue
                    updates[key] = value
                else:
                    updates[key] = one(key).strip()

        for key, label, lo, hi in (("default_port_start", "默认端口起点", 1, 65535),
                                   ("default_port_end", "默认端口止点", 1, 65535)):
            value = updates.get(key)
            if isinstance(value, int) and value and not (lo <= value <= hi):
                errors.append("%s 应在 %d–%d 之间" % (label, lo, hi))
        ps, pe = updates.get("default_port_start"), updates.get("default_port_end")
        if isinstance(ps, int) and isinstance(pe, int) and ps and pe and pe < ps:
            errors.append("默认端口区间的「止」不能小于「起」")

        if errors:
            log("WARN 设置未保存：%s" % "；".join(errors))
            return self._settings_redirect("；".join(errors))

        # 🔴 改口令时**同时轮换 session_secret**：
        #    无状态会话令牌在到期前一直有效，不轮换密钥的话，
        #    旧口令泄露期间登录的会话在改完口令后仍然能用 —— 那改口令就没意义了。
        #    （本机回环免登录，所以 frps 插件和 agent 不受影响。）
        if "admin_password" in updates:
            updates["session_secret"] = new_token() + new_token()
            log("管理员口令已修改，已轮换 session_secret（其它已登录会话立即失效）")

        ok, why = save_config(updates)
        if not ok:
            log("ERROR 设置写盘失败：%s" % why)
            return self._settings_redirect("写盘失败：%s" % why)
        log("WEB 保存设置：%s" % ", ".join(sorted(updates)))
        return self._settings_redirect(None)

    def _handle_bulk(self, path):
        """
        批量操作：一次对多个账号续期 / 启用 / 停用 / 删除。

        日常运营里最常见的就是"这一批人该续期了"，逐个点开编辑页太慢。
        """
        if path != "/bulk":
            return False

        form = self._form()
        if not self._check_csrf(form):
            log("WARN 拒绝 CSRF 校验不通过的批量操作（来源 %s）" % self._client_ip())
            self._page_list("表单校验失败（CSRF），请刷新页面重试", True)
            return True

        users = [u for u in (form.get("users") or []) if u]
        action = (form.get("bulk_action") or [""])[0]
        if not users:
            self._page_list("没有选中任何账号 —— 先勾选左边的复选框再点操作", True)
            return True
        if action not in ("renew", "enable", "disable", "delete"):
            self._page_list("未知的批量操作：%s" % action, True)
            return True

        days = 0
        if action == "renew":
            try:
                days = int((form.get("days") or ["30"])[0])
            except (TypeError, ValueError):
                days = 0
            if days < 1 or days > 3650:
                self._page_list("续期天数应在 1~3650 之间", True)
                return True

        done, missing = 0, []
        for user in users:
            account = self.store.get(user)
            if account is None:
                missing.append(user)
                continue
            if action == "delete":
                self.store.remove(user)
            elif action in ("enable", "disable"):
                self.store.set_enabled(user, action == "enable")
            else:
                account["expire_at"] = extend_expire(account, days)
                self.store.put(account)
            done += 1

        label = {"renew": "续期", "enable": "启用", "disable": "停用",
                 "delete": "删除"}[action]
        log("WEB 批量%s %d 个账号（%s）" % (label, done, ", ".join(users[:12])))
        msg = "已批量%s %d 个账号" % (label, done)
        if action == "renew":
            msg += "，各 +%d 天" % days
        if missing:
            msg += "；%d 个账号已不存在，跳过" % len(missing)
        self._page_list(msg)
        return True

    def _handle_account_post(self, path):
        """
        处理网页上的账号写操作；**已经处理就写在响应里并返回 True**。

        注意：这里和 HMAC API 都**不受 user_prefix 限制** ——
        前缀边界是给「自动化」用的（agent 走 /add 等兼容接口），
        管理员在网页上有权编辑任何账号（包括那 46 个历史账号）。
        """
        m = ACCOUNT_PATH_RE.match(path)
        is_new = path == "/account/new"
        if not (is_new or m):
            return False

        form = self._form()
        if not self._check_csrf(form):
            log("WARN 拒绝 CSRF 校验不通过的表单提交（%s，来源 %s）" % (path, self._client_ip()))
            self._page_list("表单校验失败（CSRF），请刷新页面重试", True)
            return True

        # --- 删除 / 启停 / 续期 ---
        # ⚠️ `if m and not is_new`：`/account/new` 同样能匹配 ACCOUNT_PATH_RE
        #    （user="new"），不排除掉的话它会先走进「查这个账号」的分支，
        #    结果新建请求被当成「账号 new 不存在」——首次使用直接建不了账号。
        if m and not is_new:
            user = urllib.parse.unquote(m.group(1))
            action = m.group(2) or ""
            account = self.store.get(user)
            if account is None:
                self._page_list("账号不存在：%s" % user, True)
                return True

            if action == "delete":
                self.store.remove(user)
                log("WEB 删除账号 %s" % user)
                self._page_list("已删除账号 %s" % user)
                return True

            if action == "toggle":
                now_enabled = not bool(account.get("enable", True))
                self.store.set_enabled(user, now_enabled)
                log("WEB %s账号 %s" % ("启用" if now_enabled else "停用", user))
                self._page_list("已%s账号 %s" % ("启用" if now_enabled else "停用", user))
                return True

            if action == "renew":
                try:
                    days = int((form.get("days") or ["0"])[0])
                except (TypeError, ValueError):
                    days = 0
                if days < 1 or days > 3650:
                    self._page_form(account, message="续期天数应在 1~3650 之间", is_error=True)
                    return True
                account["expire_at"] = extend_expire(account, days)
                self.store.put(account)
                log("WEB 续期 %s +%d 天 -> %s" % (user, days, account["expire_at"]))
                self._page_list("已为 %s 续期 %d 天，新到期日 %s"
                                % (user, days, account["expire_at"][:10]))
                return True

            if action in ("config", "config.toml"):
                self._page_config(account)
                return True

        # --- 新建 / 保存 ---
        current = None
        if not is_new:
            current = self.store.get(urllib.parse.unquote(m.group(1)))
            if current is None:
                self._page_list("账号不存在", True)
                return True

        account, errors = account_from_form(form, self.store, current, is_new=is_new)
        if errors:
            self._page_form(account, is_new=is_new, message="；".join(errors), is_error=True)
            return True

        existed = self.store.get(account["user"]) is not None
        self.store.put(account)
        log("WEB %s %s ports=%s expire=%s"
            % ("更新" if existed else "新建", account["user"], account["ports"],
               account["expire_at"] or "无"))
        self._page_list("%s账号 %s（端口 %s，到期 %s）"
                        % ("已更新" if existed else "已新建", account["user"],
                           ", ".join(str(p) for p in account["ports"]),
                           account["expire_at"][:10] or "无"))
        return True

    def _redirect(self, location, extra_headers=None):
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()

    def _html(self, page, status=200, extra_headers=None):
        body = page.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # 面板是内部工具，禁止被搜索引擎收录、禁止被 iframe 嵌套
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _gate(self):
        """
        统一访问闸门。返回 True = 已经拒绝（响应已写出），调用方立刻返回。

        规则：
          · /handler          —— frps 插件回调，**只允许本机**（它本来就走回环）
          · /api/admin/*      —— 自带 HMAC 鉴权，交给自己处理
          · /health           —— 不敏感，留给监控
          · /login /logout    —— 放行（登录页本身必须能打开）
          · 其余本机请求      —— 放行（agent 走这条，所以 agent 一行不用改）
          · 其余外部请求      —— **必须已登录**
        """
        path = self._path()

        if path == "/handler":
            if not self._is_loopback():
                log("WARN 拒绝来自 %s 的 /handler（插件回调只允许本机）" % self._client_ip())
                self._json({"reject": True, "reject_reason": "forbidden",
                            "unchange": True}, 403)
                return True
            return False

        if path.startswith("/api/admin/") or path == "/health":
            return False

        if path in ("/login", "/logout"):
            return False

        if self._is_loopback():
            return False

        if self._session_ok():
            return False

        # 外部未登录：**网页路径一律跳登录页**，只有接口路径才回 401。
        # ⚠️ 这里原来只判断 "/" 和 "/ui"，结果 /ports /logs /settings /docs
        #    /account/* 这些页面在外部直接访问时返回光秃秃的 401 JSON，
        #    而不是登录页 —— 从书签或分享的链接点进去根本不知道要登录。
        #    判断反过来了：**默认当网页**，只有明确是接口的才回 401。
        if path.startswith("/api/") or path in ("/tokens", "/health"):
            log("WARN 拒绝未登录的外部接口请求 %s %s（来源 %s）"
                % (self.command, path, self._client_ip()))
            self._json({"error": "UNAUTHORIZED", "message": "需要登录"}, 401)
            return True
        log("外部未登录访问 %s，跳转登录页（来源 %s）" % (path, self._client_ip()))
        self._redirect("/login")
        return True

    # ---- 插件回调
    # ---- 登录
    def _handle_login(self):
        ip = self._client_ip()
        if not ui_enabled():
            return self._html(render_login(
                "网页界面未启用：配置里没有设置 admin_user / admin_password", True), 403)
        if login_banned(ip):
            mins = int(CONFIG.get("login_ban_seconds") or 900) // 60
            log("WARN 来源 %s 已被封禁，仍尝试登录" % ip)
            return self._html(render_login("尝试次数过多，请约 %d 分钟后再试" % mins, True), 429)

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        form = urllib.parse.parse_qs(raw.decode("utf-8", "replace"))
        user = (form.get("user") or [""])[0]
        password = (form.get("password") or [""])[0]

        if check_password(user, password):
            note_login_ok(ip)
            ttl = int(CONFIG.get("session_ttl") or 43200)
            log("管理员登录成功（来源 %s）" % ip)
            return self._redirect("/", [(
                "Set-Cookie",
                "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d"
                % (SESSION_COOKIE, make_session_token(), ttl))])

        note_login_fail(ip)
        log("WARN 登录失败（来源 %s，用户名 %r）" % (ip, user[:32]))
        return self._html(render_login("用户名或密码不正确", True), 401)

    def _handle_plugin(self):
        op = self._query().get("op", "")
        started = time.time()
        try:
            body = self._read_body()
            content = body.get("content") if isinstance(body, dict) else None
            res = handle_plugin_op(op, content, self.store)
        except Exception as exc:  # noqa: BLE001
            # 🔴 **fail-closed**：判定过程中出任何错，都必须拒绝，绝不放行。
            #    这个服务的定位是「授权关口」——出问题时宁可挡住用户，
            #    也不能因为异常把没有权限的人放进来。
            log("ERROR 插件 op=%s 处理异常：%s: %s" % (op, type(exc).__name__, exc))
            res = plugin_response_reject("面板内部错误，请联系管理员")
        if res.get("reject"):
            log("插件 op=%s 用时 %dms 已拒绝" % (op, (time.time() - started) * 1000))
        self._json(res)

    # ---- HMAC 私有管理 API（供 Worker 直接调用）
    def _admin(self, method):
        """包一层异常保护：内部错误返回 500，不要让连接被直接掐断。"""
        try:
            return self._admin_dispatch(method)
        except Exception as exc:  # noqa: BLE001
            log("ERROR 管理接口异常：%s: %s" % (type(exc).__name__, exc))
            return self._json({"ok": False, "message": "面板内部错误"}, 500)

    def _admin_dispatch(self, method):
        """
        外部管理 API（HMAC 签名）。供 Worker / 脚本 / 运维调用。

          GET    /api/admin/accounts                 列出全部
          GET    /api/admin/accounts/<user>          查单个（含剩余天数）
          PUT    /api/admin/accounts/<user>          新增/覆盖
          DELETE /api/admin/accounts/<user>          删除
          POST   /api/admin/accounts/<user>/enable   启用
          POST   /api/admin/accounts/<user>/disable  停用
          POST   /api/admin/accounts/<user>/renew    {"days": 30} 续期
          GET    /api/admin/accounts/<user>/config   生成 frpc.toml（text/plain）

        ⚠️ 这里**不受 user_prefix 限制**：前缀边界是给「自动化」用的
           （agent 走 /tokens、/add、/update… 那套兼容接口），
           而这个接口是签名鉴权的管理通道，管理员有权管理任何账号。
        """
        # `_read_body()` 会顺便把**原始请求体字节**存进 self._raw_body。
        # ⚠️ 签名必须对原始字节取 sha256；若改用「解析后重新 json.dumps」的结果，
        #    键顺序/空格/转义都会和调用方不一致，签名永远对不上。
        body = self._read_body()
        ok, why = verify_agent_request(method, self.path, self.headers, self._raw_body)
        if not ok:
            if why == "disabled":
                return self._json({"error": "FRP_AGENT_DISABLED",
                                   "message": "面板未配置 agent_secret，管理接口已禁用"}, 503)
            log("管理接口鉴权失败：%s（%s %s）" % (why, method, self.path))
            return self._json({"error": "UNAUTHORIZED", "message": "签名校验失败"}, 401)

        rest = self._path()[len("/api/admin/accounts"):].strip("/")
        parts = [p for p in rest.split("/") if p]
        user = urllib.parse.unquote(parts[0]) if parts else ""
        action = parts[1] if len(parts) > 1 else ""

        if not user:
            if method == "GET":
                accounts = self.store.all()
                for a in accounts:
                    a["days_left"] = days_left(a)
                return self._json({"ok": True, "count": len(accounts), "accounts": accounts})
            return self._json({"ok": False, "message": "缺少 user"}, 400)

        account = self.store.get(user)

        # --- 查单个 ---
        if method == "GET" and not action:
            if account is None:
                return self._json({"ok": False, "message": "账号不存在"}, 404)
            out = dict(account)
            out["days_left"] = days_left(account)
            return self._json({"ok": True, "account": out})

        # --- 生成配置（不需要账号存在也能给，但一般是存在的）---
        if method == "GET" and action == "config":
            if account is None:
                return self._json({"ok": False, "message": "账号不存在"}, 404)
            return self._json({"ok": True, "user": user,
                               "config": render_frpc_config(account)})

        # --- 新增 / 覆盖 ---
        if method == "PUT" and not action:
            if not USER_RE.match(user):
                return self._json({"ok": False, "message": "账号名不合法"}, 400)
            incoming = normalise_account(body if isinstance(body, dict) else {})
            incoming["user"] = user
            # 没给 token 就沿用旧值；全新账号则自动生成
            if not incoming.get("token"):
                incoming["token"] = (account or {}).get("token") or new_token()
            # 没给 ports 就沿用旧值
            if not incoming.get("ports") and account:
                incoming["ports"] = account.get("ports") or []
            # 没给 expire_at 就沿用旧值（避免续期信息被覆盖掉）
            if not incoming.get("expire_at"):
                incoming["expire_at"] = (account or {}).get("expire_at") or ""
            # 支持直接给 days 表示租期
            days = body.get("days") if isinstance(body, dict) else None
            if days:
                try:
                    incoming["expire_at"] = compute_expire_at("days", days, "")[0] \
                        or incoming["expire_at"]
                except Exception:  # noqa: BLE001
                    pass
            existed = account is not None
            self.store.put(incoming)
            log("ADMIN PUT %s ports=%s expire=%s"
                % (user, incoming["ports"], incoming["expire_at"] or "无"))
            return self._json({"ok": True, "created": not existed, "account": incoming})

        if account is None:
            return self._json({"ok": False, "message": "账号不存在"}, 404)

        # --- 删除 ---
        if method == "DELETE" and not action:
            removed = self.store.remove(user)
            log("ADMIN DELETE %s removed=%s" % (user, removed))
            return self._json({"ok": True, "removed": removed})

        # --- 启停 ---
        if method == "POST" and action in ("enable", "disable"):
            changed = self.store.set_enabled(user, action == "enable")
            log("ADMIN %s %s changed=%s" % (action.upper(), user, changed))
            return self._json({"ok": True, "changed": changed})

        # --- 续期 ---
        if method == "POST" and action == "renew":
            days = (body or {}).get("days", 30) if isinstance(body, dict) else 30
            try:
                days = int(days)
            except (TypeError, ValueError):
                return self._json({"ok": False, "message": "days 必须是整数"}, 400)
            if days < 1 or days > 3650:
                return self._json({"ok": False, "message": "days 应在 1~3650 之间"}, 400)
            account["expire_at"] = extend_expire(account, days)
            self.store.put(account)
            log("ADMIN 续期 %s +%d 天 -> %s" % (user, days, account["expire_at"]))
            return self._json({"ok": True, "expire_at": account["expire_at"],
                               "days_left": days_left(account)})

        return self._json({"ok": False, "message": "不支持的路径或方法"}, 404)

    # ---- 面板兼容 API
    def do_GET(self):
        if self._gate():
            return
        path = self._path()
        if path == "/handler":
            return self._handle_plugin()
        if path.startswith("/api/admin/"):
            return self._admin("GET")
        if path == "/login":
            if not ui_enabled():
                return self._html(render_login(
                    "网页界面未启用：配置里没有设置 admin_user / admin_password", True))
            return self._html(render_login())
        if path == "/logout":
            # ⚠️ 只清 cookie 是不够的：无状态令牌在到期前照样能用。
            #    这里把当前会话真的吊销掉，登出才算数。
            token = self._session_token()
            if token and revoke_session_token(token):
                log("管理员登出，会话已吊销")
            return self._redirect("/login", [(
                "Set-Cookie",
                "%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" % SESSION_COOKIE)])
        if path == "/":
            if not ui_enabled():
                return self._html(render_login(
                    "网页界面未启用：配置里没有设置 admin_user / admin_password", True))
            show = self._query().get("show_tokens") == "1"
            csrf = self._csrf()
            return self._html(render_accounts(self.store.all(), show_tokens=show, csrf=csrf),
                              extra_headers=[self._csrf_cookie_header(csrf)])
        # 显示偏好（主题 / 行密度）：写 cookie 后跳回来。
        # 这是**显示偏好**不是数据写入，所以用 GET（可以直接收藏/发链接），
        # 也不做 CSRF —— 最坏结果是"自己看到另一个主题"，没有实际危害。
        if path in ("/theme", "/density"):
            back = self._same_origin_back()
            if path == "/theme":
                to = "light" if (self._query().get("to") or "").strip() == "light" else "dark"
                log("切换主题 -> %s（来源 %s）" % (to, self._client_ip()))
                cookie = (THEME_COOKIE, to)
            else:
                to = "compact" if (self._query().get("to") or "").strip() == "compact" \
                    else "comfortable"
                log("切换行密度 -> %s（来源 %s）" % (to, self._client_ip()))
                cookie = (DENSITY_COOKIE, to)
            return self._redirect(back, [(
                "Set-Cookie",
                "%s=%s; Path=/; Max-Age=31536000; SameSite=Lax" % cookie)])
        # ---- 设置 / 文档 ----
        if path == "/settings":
            csrf = self._csrf()
            ok = (self._query().get("ok") or "") == "1"
            err = self._query().get("err") or ""
            msg = err if err else ("设置已保存" if ok else "")
            return self._html(render_settings(csrf=csrf, message=msg, is_error=bool(err)),
                              extra_headers=[self._csrf_cookie_header(csrf)])
        if path == "/docs":
            csrf = self._csrf()
            return self._html(render_docs(csrf=csrf),
                              extra_headers=[self._csrf_cookie_header(csrf)])
        # ---- 账号管理页面 ----
        if path == "/logs":
            csrf = self._csrf()
            kind = (self._query().get("kind") or "all").strip() or "all"
            log_path = CONFIG.get("log_file") or ""
            entries = tail_log(log_path)
            return self._html(render_logs(entries, log_path, kind, csrf=csrf),
                              extra_headers=[self._csrf_cookie_header(csrf)])
        if path == "/ports":
            csrf = self._csrf()
            return self._html(render_ports(self.store.all(), csrf=csrf),
                              extra_headers=[self._csrf_cookie_header(csrf)])
        if path == "/account/new":
            return self._page_form(is_new=True)
        m = ACCOUNT_PATH_RE.match(path)
        if m:
            user = urllib.parse.unquote(m.group(1))
            action = m.group(2) or ""
            account = self.store.get(user)
            if account is None:
                csrf = self._csrf()
                return self._html(render_accounts(
                    self.store.all(), csrf=csrf, is_error=True,
                    message="账号不存在：%s" % user),
                    extra_headers=[self._csrf_cookie_header(csrf)])
            if action == "" or action == "renew":
                return self._page_form(account=account)
            if action == "config":
                return self._page_config(account)
            if action == "config.toml":
                return self._download("%s.toml" % user, render_frpc_config(account))
        # 单个账号的令牌（网页上点「显示」时才按需取）。
        # 受**同一套访问闸门**保护：非回环必须已登录，否则 401。
        # 每次取都留痕 —— 令牌是能直接连上隧道的凭据，谁取的、什么时候取的要有记录。
        if path.startswith("/api/token/"):
            target = urllib.parse.unquote(path[len("/api/token/"):])
            account = self.store.get(target)
            if account is None:
                return self._json({"ok": False, "message": "账号不存在"}, 404)
            log("查看令牌：%s（来源 %s）" % (target, self._client_ip()))
            return self._json({"ok": True, "user": target,
                               "token": account.get("token") or ""})
        if path == "/tokens":
            accounts = self.store.all()
            return self._json({
                "code": 0,
                "msg": "query Tokens success",
                "count": len(accounts),
                "data": accounts,
            })
        if path == "/health":
            return self._json({"ok": True, "accounts": len(self.store.all())})
        return self._json({"code": 1, "msg": "not found", "data": []}, 404)

    def do_POST(self):
        path = self._path()
        if path == "/login":
            return self._handle_login()

        if self._gate():
            return
        if path == "/handler":
            return self._handle_plugin()
        if path.startswith("/api/admin/"):
            return self._admin("POST")

        # 网页上的账号写操作（新建/编辑/删除/启停/续期/批量）
        # 兜住异常：一个 bug 不该让连接被直接掐断（浏览器只会显示「连接被重置」，
        # 排障时什么都看不到）。出错就记完整堆栈 + 给用户一个可读的提示。
        try:
            if self._handle_settings(path):
                return
            if self._handle_bulk(path):
                return
            if self._handle_account_post(path):
                return
        except Exception as exc:  # noqa: BLE001
            log("ERROR 账号写操作异常：%s: %s" % (type(exc).__name__, exc))
            log(traceback.format_exc())
            try:
                self._page_list("操作失败：%s" % exc, True)
            except Exception:  # noqa: BLE001
                pass
            return

        body = self._read_body()
        if not isinstance(body, dict) or body.get("__parse_error__"):
            return self._json({"success": False, "message": "请求体不是合法 JSON"})

        if path == "/add":
            account = normalise_account(body)
            if not account["user"]:
                return self._json({"success": False, "message": "缺少 user"})
            if not is_managed(account["user"]):
                # 安全边界：只碰 user_prefix 开头的账号
                return self._json({
                    "success": False,
                    "message": "账号 %s 不在可管理前缀（%s）内，拒绝写入"
                               % (account["user"], CONFIG["user_prefix"]),
                })
            existed = self.store.get(account["user"]) is not None
            self.store.put(account)
            log("%s %s ports=%s" % ("UPDATE" if existed else "ADD", account["user"], account["ports"]))
            return self._json({
                "success": True,
                "message": "账号已存在，已覆盖" if existed else "账号已创建",
            })

        if path == "/update":
            before = normalise_account(body.get("before") or {})
            after = normalise_account(body.get("after") or {})
            if not after["user"]:
                return self._json({"success": False, "message": "缺少 after.user"})
            if not is_managed(after["user"]):
                return self._json({"success": False, "message": "账号不在可管理前缀内，拒绝写入"})
            current = self.store.get(after["user"])
            if current is None:
                return self._json({"success": False, "message": "账号不存在"})
            # 保留 expire_at（旧面板没有这个字段，agent 也不会传，别把我们的数据冲掉）
            if not after.get("expire_at"):
                after["expire_at"] = current.get("expire_at") or ""
            self.store.put(after)
            log("UPDATE %s ports=%s" % (after["user"], after["ports"]))
            return self._json({"success": True, "message": "已更新"})

        if path in ("/remove", "/enable", "/disable"):
            users = body.get("users") or []
            if not isinstance(users, list):
                users = [users]
            changed = 0
            for item in users:
                user = item.get("user") if isinstance(item, dict) else str(item)
                if not user or not is_managed(user):
                    continue
                if path == "/remove":
                    if self.store.remove(user):
                        changed += 1
                else:
                    if self.store.set_enabled(user, path == "/enable"):
                        changed += 1
            verb = {"remove": "REMOVE", "enable": "ENABLE", "disable": "DISABLE"}[path.strip("/")]
            log("%s 影响 %d 个账号" % (verb, changed))
            return self._json({"success": True, "message": "%s 已处理 %d 个" % (verb, changed)})

        return self._json({"success": False, "message": "not found"}, 404)

    def do_PUT(self):
        if self._path().startswith("/api/admin/"):
            return self._admin("PUT")
        return self._json({"ok": False, "message": "not found"}, 404)

    def do_DELETE(self):
        if self._path().startswith("/api/admin/"):
            return self._admin("DELETE")
        return self._json({"ok": False, "message": "not found"}, 404)


def managed_prefixes():
    """
    哪些前缀算「归自动流程管的账号」。支持逗号分隔的多个前缀。

    ⚠️ 2026-10-14：新账号改用 `DC_` 前缀，但**已经发出去的 `dcfrp_` 账号必须继续被认** ——
       否则它们会掉出管理范围，agent 再也同步不到（续期/停用/回收全部失效）。
       所以这里不是把前缀换掉，而是**同时认两个**：
           user_prefix = "dcfrp_,DC_"
    """
    raw = CONFIG.get("user_prefix") or ""
    return [p.strip() for p in str(raw).split(",") if p.strip()]


def is_managed(user):
    """只有这些前缀开头的账号归自动流程管；历史账号绝不能被碰。"""
    text = str(user)
    return any(text.startswith(p) for p in managed_prefixes())


# ---------------------------------------------------------------- 迁移
# 真实文件长这样（第三方面板 2.0.0 写出来的）：
#
#     [tokens]
#         [tokens.123]
#             user = "123"
#             token = "741852963"
#             comment = ""
#             ports = [22245, 22256, 22278, 22289, 23456]
#             domains = [""]
#             subdomains = [""]
#             enable = true
#         [tokens.AOS]
#             user = "AOS"
#             ports = ["28888-28890"]        # ← 端口还能写成区间字符串
#
# 所以：段落是**单**方括号 `[tokens.X]`（不是 `[[...]]`），且 ports 里可能有区间。
SECTION_RE = re.compile(r"^\s*\[\[?\s*tokens\s*\.\s*([^\]]+?)\s*\]\]?\s*$")


def _parse_toml_array(value):
    """把 `[a, b, "c"]` 解析成字符串列表。"""
    inner = value.strip()
    if inner.startswith("["):
        inner = inner[1:]
    if inner.endswith("]"):
        inner = inner[:-1]
    items = []
    for part in inner.split(","):
        part = part.strip().strip('"').strip("'").strip()
        if part:
            items.append(part)
    return items


def _expand_ports(items):
    """
    端口可能是单个数字，也可能是 `"28888-28890"` 这样的区间。

    小区间**展开成单个端口**（界面上显示成一个个 chip 更直观）；
    大区间**保留成区间字符串** —— 因为旧面板里真有 `"1000-55555"` 这种。

    ⚠️ 早期版本对大区间直接 `continue` 跳过，结果那个账号的端口列表变成空的，
       插件按"端口是否分配给我"判定 → 它的所有隧道全被拒。
       这是切换前必须修的：真实数据里 `Doulor` 和 `Tianya` 正是这种情况。
    """
    ports = []
    for item in items:
        text = str(item).strip()
        m = PORT_RANGE_RE.match(text)
        if m:
            start, end = int(m.group(1)), int(m.group(2))
            if end < start:
                log("WARN 跳过反向端口区间 %r" % text)
                continue
            if end - start > 2000:
                # 太大不展开，原样保留区间 —— 匹配逻辑支持它
                ports.append("%d-%d" % (start, end))
            else:
                ports.extend(range(start, end + 1))
        else:
            try:
                ports.append(int(text))
            except (TypeError, ValueError):
                continue
    seen, uniq = set(), []
    for p in ports:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def import_legacy_toml(path, store, only_managed=True):
    """
    从第三方面板的 frps-tokens.toml 导入账号（迁移用）。

    ⚠️ 默认**只导入 user_prefix 开头的账号** —— 面板里还有管理员手工建的历史账号，
    它们要继续由人工维护，不能被自动流程接管。
    """
    if not os.path.exists(path):
        return 0, "文件不存在：%s" % path
    imported = 0
    skipped = 0
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except IOError as exc:
        return 0, "读不到：%s" % exc

    def settle(account):
        """结算一个段落。"""
        nonlocal imported, skipped
        if not account or not account.get("user"):
            return
        if only_managed and not is_managed(account["user"]):
            skipped += 1
            return
        # 旧面板把到期日写在 comment 里（形如 "DoulorCloud | active | 到期 2026-11-12"）。
        # 导入时抽成显式字段：既让数据自描述、便于直接查看，
        # 也免得以后一直依赖「解析中文 comment」这条兜底路径。
        m2 = EXPIRED_RE.search(account.get("comment") or "")
        if m2 and not account.get("expire_at"):
            account["expire_at"] = m2.group(1) + "T23:59:59Z"
        store.put(normalise_account(account))
        imported += 1

    current = None
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        m = SECTION_RE.match(line)
        if m:
            settle(current)
            current = {}
            continue

        if current is None or "=" not in line:
            continue

        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()

        if key in ("name", "user"):
            current["user"] = value.strip().strip('"')
        elif key == "token":
            current["token"] = value.strip().strip('"')
        elif key == "comment":
            current["comment"] = value.strip().strip('"')
        elif key == "enable":
            current["enable"] = value.strip().lower() in ("true", "1")
        elif key == "ports":
            current["ports"] = _expand_ports(_parse_toml_array(value))
        elif key in ("domains", "subdomains"):
            current[key] = _parse_toml_array(value) or [""]

    settle(current)
    return imported, "导入 %d 个，跳过 %d 个（不归自动流程管）" % (imported, skipped)


# ---------------------------------------------------------------- 表单 → 账号
ACCOUNT_PATH_RE = re.compile(
    r"^/account/([^/]+?)(?:/(config\.toml|config|renew|delete|toggle))?$")


def extend_expire(account, days, now=None):
    """
    续期：在**现有到期日**基础上加 N 天（已过期则以今天为准，不会"倒扣"）。
    没有到期日的账号续期后从今天开始算。
    """
    now = now or time.time()
    today = time.mktime(time.strptime(time.strftime("%Y-%m-%d", time.localtime(now)),
                                      "%Y-%m-%d"))
    raw = (account.get("expire_at") or "")[:10]
    if not raw:
        m = EXPIRED_RE.search(account.get("comment") or "")
        raw = m.group(1) if m else ""
    base = today
    if raw:
        try:
            cur = time.mktime(time.strptime(raw, "%Y-%m-%d"))
            base = max(today, cur)   # 已过期的从今天续，而不是接着过去的日子
        except ValueError:
            pass
    return time.strftime("%Y-%m-%d", time.localtime(base + days * 86400)) + "T23:59:59Z"


def account_from_form(form, store, current=None, is_new=False):
    """
    把网页表单解析成账号对象。返回 (account, errors)。
    form 来自 urllib.parse.parse_qs（值是 list）。
    """
    def one(key, default=""):
        v = form.get(key)
        if isinstance(v, list) and v:
            return v[0]
        return default

    errors = []
    user = (one("user") or (current or {}).get("user") or "").strip()

    if is_new or not user:
        if not user:
            errors.append("账号名不能为空")
        elif not USER_RE.match(user):
            errors.append("账号名只能包含字母、数字、下划线、点、中划线，长度 1~64")
        elif store.get(user) is not None:
            errors.append("账号 %s 已存在" % user)

    token = one("token").strip()
    if not token:
        token = new_token()          # 留空自动生成

    ports, port_errors = parse_ports(one("ports"))
    errors.extend(port_errors)
    if not ports:
        errors.append("至少要分配一个端口")

    # 端口不能和别的账号冲突（否则 frps 那边会 "port already used"）
    taken_by = {}
    for a in store.all():
        if a.get("user") == user:
            continue
        for p in (a.get("ports") or []):
            try:
                taken_by[int(p)] = a.get("user")
            except (TypeError, ValueError):
                pass
    for p in ports:
        if p in taken_by:
            errors.append("端口 %d 已被账号 %s 占用" % (p, taken_by[p]))

    expire_at, err = compute_expire_at(one("rental_mode", "keep"),
                                       one("rental_days"), one("expire_date"))
    if err:
        errors.append(err)
    if expire_at is None:            # mode=keep
        expire_at = (current or {}).get("expire_at") or ""

    account = normalise_account({
        "user": user,
        "token": token,
        "comment": one("comment"),
        "enable": one("enable") == "1",
        "ports": ports,
        "domains": (current or {}).get("domains") or [""],
        "subdomains": (current or {}).get("subdomains") or [""],
        "expire_at": expire_at,
    })
    return account, errors


# ---------------------------------------------------------------- 后台巡检
def start_sweeper(store):
    """
    定时巡检到期情况：

      · 总是做的：把「刚刚到期」的账号写进日志（便于事后追溯），
        并让界面上立刻显示成「已到期」。
      · 可选做的：`auto_disable_expired = true` 时把到期账号置为停用。

    为什么自动停用默认关着：

        这张面板上，D1（Cloudflare D1）才是唯一真值，agent 每 20 秒会把期望状态
        投影过来。如果面板自己把某账号停用了，而 D1 里它仍算有效，agent 下一轮
        就会把它改回来 —— 两边拉锯没有意义，还会污染日志。

    **访问控制完全不依赖这个线程**：插件在 Login / NewWorkConn / Ping 上会按
    `expire_at` **直接拒绝**到期账号 —— 到期那一刻就生效，不用等巡检周期。
    """
    def loop():
        known = set()
        while True:
            try:
                time.sleep(max(30, int(CONFIG.get("sweep_interval_seconds") or 300)))
                now = time.time()
                for a in store.all():
                    left = days_left(a, now)
                    if left is None or left >= 0:
                        continue
                    user = a.get("user")
                    if user not in known:
                        known.add(user)
                        log("巡检：账号 %s 已于 %s 到期" % (user, (a.get("expire_at") or "")[:10]))
                    if CONFIG.get("auto_disable_expired") and a.get("enable", True):
                        store.set_enabled(user, False)
                        log("巡检：已自动停用到期账号 %s" % user)
            except Exception as exc:  # noqa: BLE001
                log("WARN 巡检异常：%s: %s" % (type(exc).__name__, exc))

    t = threading.Thread(target=loop)
    t.daemon = True
    t.start()
    return t


# ---------------------------------------------------------------- 入口
def build_server():
    store = Store(CONFIG["data_file"])
    PanelHandler.store = store
    host = CONFIG.get("listen_host") or "127.0.0.1"
    port = int(CONFIG.get("listen_port") or 7200)
    if host not in ("127.0.0.1", "localhost", "::1"):
        # 想绑公网必须**同时**满足两条，缺一不可：
        #   1. 显式打开 allow_public_bind（默认关）
        #   2. **配好了网页登录口令** —— 否则外部请求没有任何东西可挡，
        #      那就和旧面板「未授权可读全部令牌」的漏洞一模一样。
        if not CONFIG.get("allow_public_bind"):
            log("🔴 拒绝启动：listen_host=%r 不是本机地址，且未显式打开 allow_public_bind。"
                % host)
            log("   默认只允许监听 127.0.0.1 —— 暴露到公网等于把全部账号令牌送出去。")
            sys.exit(2)
        if not ui_enabled():
            log("🔴 拒绝启动：allow_public_bind=true，但没有配 admin_user / admin_password。")
            log("   没有口令就没有任何东西能挡住外部请求 —— 这与旧面板的漏洞是同一个问题。")
            sys.exit(2)
        log("⚠️  已允许监听 %s：非本机请求一律要求登录（本机回环请求免登录）" % host)
    return ThreadingHTTPServer((host, port), PanelHandler), store


def main():
    parser = argparse.ArgumentParser(description="DoulorCloud 自研 frp 面板")
    parser.add_argument("--config", default="panel.json")
    parser.add_argument("--import-legacy", metavar="FRPS_TOKENS_TOML",
                        help="从第三方面板的 frps-tokens.toml 导入账号后退出")
    parser.add_argument("--import-all", action="store_true",
                        help="配合 --import-legacy：连非 dcfrp_ 前缀的历史账号也导入")
    args = parser.parse_args()

    # 设置页要把改动写回这个文件，所以记下**绝对路径**
    global CONFIG_PATH
    CONFIG_PATH = os.path.abspath(args.config)

    if os.path.exists(args.config):
        with open(args.config, encoding="utf-8") as fh:
            CONFIG.update(json.load(fh))
    else:
        log("配置文件不存在：%s（用默认值，只监听 127.0.0.1:7200）" % args.config)

    if args.import_legacy:
        store = Store(CONFIG["data_file"])
        n, why = import_legacy_toml(args.import_legacy, store, only_managed=not args.import_all)
        log("迁移结果：%s" % why)
        print(why)
        return

    server, store = build_server()
    start_sweeper(store)
    log("启动：监听 http://%s:%d  数据文件=%s  可管理前缀=%r"
        % (CONFIG["listen_host"], CONFIG["listen_port"], CONFIG["data_file"],
           CONFIG["user_prefix"]))
    log("插件回调端点：POST /handler?op=Login|NewProxy|CloseProxy|Ping|NewWorkConn|NewUserConn")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")


if __name__ == "__main__":
    main()
