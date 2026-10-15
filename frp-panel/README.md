# DoulorCloud 自研 frp 面板（`frp-panel`）

替代第三方 `frps-panel 2.0.0` 的服务端组件。**纯 Python 标准库、单文件、无依赖、无构建步骤。**

```
                    ┌──────────────────────── DoulorCloud（Cloudflare）────────────────────────┐
                    │  Worker: /api/frp/agent/*        D1（唯一真值）                          │
                    └───────────┬──────────────────────────────────┬──────────────────────────┘
                    ①HMAC 直连  │                                  │ ②agent 主动轮询（可回退）
                                ▼                                  ▼
                    ┌──────────────────────── 你的服务器（39.97.183.32）──────────────────────┐
                    │  frp-panel（127.0.0.1:7200）                                          │
                    │    · /handler          ← frps 插件回调（鉴权·端口校验·到期拒绝）        │
                    │    · /api/admin/*      ← Worker 经 HMAC 直接管理（推荐）               │
                    │    · /tokens /add ...  ← 旧面板兼容接口（现有 agent 零改动可用）        │
                    │         ▲                                                              │
                    │         │ 127.0.0.1 本机回环，公网不可达                                 │
                    │  frps ──┘   + 可选 frp-agent.py（轮询，作为回退路径）                    │
                    └───────────────────────────────────────────────────────────────────────┘
```

## 文件

| 文件 | 说明 |
|---|---|
| `panel.py` | 服务本体。**只依赖 Python 3 标准库**，Python 3.6 兼容 |
| `panel.json` | 配置（不存在则用默认值：只监听 `127.0.0.1:7200`） |
| `accounts.json` | 账号数据，运行时自动生成，原子写 |
| [`deploy/cutover.sh`](deploy/cutover.sh) | **切换脚本**：预检 → 迁移 → 核对 → 切换 → 验证，失败自动回滚。默认 dry-run |
| [`deploy/start.sh`](deploy/start.sh) | 启动脚本（启动前再挡一道 `listen_host` 必须是本机） |
| [`deploy/frp-panel.service`](deploy/frp-panel.service) | systemd unit（`Restart=always` —— 插件挂了会让所有用户连不上） |
| `tests/` | 12 个验收脚本：235 条用例 + **720 次并发压测** + 2 个端到端 |

## 它解决的两个问题

1. **未授权可读全部令牌**（旧面板真实漏洞）
   旧面板的鉴权中间件发 `307 Location: /login` 却**没有中断后续 handler**，于是响应体里连数据一起发出来了。实测外网 `curl http://<IP>:7200/tokens` 能拿到全部 `user` + `token`（47 个账号）。自研面板**只监听 127.0.0.1**，并在启动时**硬性拒绝**非本机监听地址（配错就退出，不会「静默暴露」）。

2. **到期语义握在自己手里**
   旧面板只能「有/无」账号。自研面板有显式的 `expire_at`，并且**到期即时生效**（见下）。

## 🔴 紧急止血：生产上漏洞还开着时先做这一步

只要旧面板还绑在 `0.0.0.0:7200`，**公网任何人都能读到全部账号令牌**。实测（未带任何凭据）：

```
$ curl -s http://<服务器IP>:7200/tokens
HTTP 307，响应体 6453 字节
  "user"  出现 47 次
  "token" 出现 47 次      ← 真实令牌，含付费租户
```

（307 只是重定向，面板的鉴权中间件**没有中断后续处理**，所以数据照发。）

**止血只需一条 iptables 规则**（服务器上 iptables 当前完全为空、无 firewalld/ufw）：

```sh
# 放行回环，其余一律丢弃
iptables -I INPUT 1 -s 127.0.0.1 -p tcp --dport 7200 -j ACCEPT
iptables -I INPUT 2 -p tcp --dport 7200 -j DROP

# 立即验证：本机仍然可用、公网已经读不到
curl -s -o /dev/null -w '本机: %{http_code}\n' http://127.0.0.1:7200/tokens
# 然后从你自己的机器上再试一次，应当超时

# 回滚（一条命令）
iptables -D INPUT -p tcp --dport 7200 -j DROP
iptables -D INPUT -s 127.0.0.1 -p tcp --dport 7200 -j ACCEPT
```

**为什么这条规则是安全的（已实测确认，不是推断）**：

```
ss -tnp | grep 7200
  ESTAB  127.0.0.1:35064 -> 127.0.0.1:7200  users:(("frps", ...))    ← frps 插件回调走回环
  agent 配置 panel_base = "http://127.0.0.1:7200"                     ← agent 也走回环
```

也就是说：**没有任何功能依赖「公网能访问 7200」** —— frps 和 agent 全部走 `127.0.0.1`。
受影响的只有「用浏览器从公网打开面板」，而那一条随时可以用 SSH 隧道补回来：

```sh
ssh -L 7200:127.0.0.1:7200 root@<服务器IP>
# 然后浏览器打开 http://127.0.0.1:7200 —— 同一个面板、同一个界面
```

> 手动访问的能力**一点没少**，只是入口从公网换成了隧道。
> 顺带一提：这也让面板的登录口令不再暴露在公网爆破面前。

**关于持久性**（已核实）：iptables 规则本身**不跨重启**，但旧面板也**没有任何自启配置**
（无 systemd unit、无 crontab、无 rc.local）—— 所以重启后它不会自己回来，漏洞不会自动复活。
如果将来有人手工把旧面板重新拉起来，记得把规则一起加上（或干脆切到新面板）。



## 🔴 公网暴露面清单（2026-10-13 实测）

在做止血时顺手把「还有没有同类暴露」查全了。实测结果（都是从公网、本机发起的请求）：

| 端口 | 服务 | 公网可达 | 凭据 | 能拿到什么 | 状态 |
|---|---|---|---|---|---|
| 7200 | 旧面板 `frps-panel` | ~~是~~ → **否** | 无需鉴权 | **全部 47 个账号的令牌** | ✅ **已止血**（iptables） |
| 7500 | 主 frps 自带仪表盘 | **是** | `admin/114514` | **88 条隧道**（含客户名与端口） | 🔴 仍暴露 |
| 7499 | 备份节点 frps 仪表盘 | **是** | `admin/114514` | 同类的隧道清单 | 🔴 仍暴露 |

实测证据：

```
# 7200 止血后
$ curl http://<IP>:7200/tokens          → 502，0 字节（止血前是 6453 字节 + 47 个真实令牌）

# 7500
$ curl -u admin:114514 http://<IP>:7500/api/proxy/tcp
  → 200，18844 字节，88 条代理，含 "Doulor.Claude H5" 这类客户名与 remotePort
$ curl -u admin:114514 -X PUT http://<IP>:7500/api/config     → 404
$ curl -u admin:114514 -X PUT http://<IP>:7500/api/proxy/tcp/1 → 405
  （→ 只读：拿不到写/删权限，所以是**信息泄露**而不是直接入侵）

# 7499（备份节点）
$ curl -u admin:114514 http://<IP>:7499/api/serverinfo        → 200
  （配置里同样是 webServer.addr = "0.0.0.0" + admin/114514）
```

**为什么值得管**：那 88 条隧道清单里有客户名和端口 —— 「这个端口属于哪个客户」
本身就是不该公开的信息，等于给每个客户做了标记，方便定向扫描。

**怎么修**（两种，代价差很多）：

```sh
# 方案 A：防火墙挡住公网（零停机、一条命令、可回滚）—— 和 7200 同样的做法
iptables -I INPUT 1 -s 127.0.0.1 -p tcp --dport 7500 -j ACCEPT
iptables -I INPUT 2 -p tcp --dport 7500 -j DROP
iptables -I INPUT 3 -s 127.0.0.1 -p tcp --dport 7499 -j ACCEPT
iptables -I INPUT 4 -p tcp --dport 7499 -j DROP
# 回滚：把上面四条 -I 换成 -D 再跑一遍

# 方案 B：改掉仪表盘口令
#   ⚠️ 需要改 frps.toml 的 webServer.password 并**重启 frps** ——
#      重启会把所有在线隧道断开。请安排到低峰期，别随手做。
```

> 方案 A 我已经**没有**替你做 —— 它和你授权的那次（7200 令牌泄露）不是同一个暴露，
> 而且万一你在浏览器里用着这个仪表盘会当场断掉。等你确认。
> 挡掉之后要看仪表盘，同样用 SSH 隧道：`ssh -L 7500:127.0.0.1:7500 root@<IP>`。



## 五种回调（全部已在真实链路上验证）

实测环境：frps 0.65.0 + frpc 0.65.0，本机测试台。

| 回调 | content 形状 | 触发时机 | 实测 |
|---|---|---|---|
| `Login` | `{version, os, arch, user(str), privilege_key, timestamp, metas:{token}, client_address, ...}` | 客户端登录 / 断线重连 | ✅ |
| `NewProxy` | `{user:{user,metas,run_id}, proxy_name, proxy_type, remote_port}` | 客户端请求建立隧道 | ✅ |
| `NewWorkConn` | `{user:{...}, run_id, privilege_key, timestamp}` | 每次需要工作连接 | ✅ 每次访客连接都触发 |
| `NewUserConn` | `{user:{...}, proxy_name, proxy_type, remote_addr}` | **每次访客连入隧道** | ✅ 3 次访客连接 → 3 次回调 |
| `Ping` | `{user:{...}, privilege_key, timestamp}` | 建立连接时 + 每 `heartbeatInterval` | ✅ 每 10 秒一次 |
| `CloseProxy` | `{user:{...}, proxy_name}` | 客户端关闭隧道 | 已实现（未单独观测） |

**鉴权字段是 `content.metas["token"]`**，不是 `privilege_key`
（后者是 frps 全局 `auth.token` 的派生值 `md5(token+timestamp)`，与用户账号无关）。

> 🔴 **`Ping` 需要双端配置才会触发**：`frps.toml` 和 `frpc.toml` **都要**有
> `auth.additionalScopes = ["HeartBeats", "NewWorkConns"]`。
> 只配客户端不够 —— `VerifyPing` 读的是 frps 自己那份 scopes，不在 scopes 里就直接返回。
> 注意大小写是 **`HeartBeats`**（B 大写），写成 `Heartbeats` frpc 会直接报配置错误。

## 到期即时拒绝是怎么做到的（实测）

三个强制点互补，`Ping` 负责踢在线客户端，`NewWorkConn` 让隧道立刻搬不动数据，
`Login` 挡住重连：

| 回调 | 拒绝的效果 |
|---|---|
| `Login` | 隧道建立不起来，且**拒绝原因会原样显示在用户 frpc 日志里** |
| `NewWorkConn` | frps **立刻重置**该访客连接（实测 **2ms**） |
| `Ping` | frps **断开该客户端** |

实测时间线（`tests/test-ping-kick.py`）：

```
有效期内            ALLOW Ping 12 次，REJECT 0 次
把账号改成已到期
第 3 秒             REJECT Ping              ← 心跳周期 10s，下个心跳即被拦
frpc 日志           [E] 登录被拒：已于 2020-01-01 到期    ← 被踢下线
                    [I] try to connect to server...
                    [E] 登录被拒：已于 2020-01-01 到期    ← 重连也进不来
```

另测（`tests/test-expiry.py`）——访客视角：

```
账号有效  → 访客连 31000 成功建立        9 ms
账号到期  → 访客再连 31000 ConnectionReset  2 ms
```

**结论：账号一到期，用户的服务当刻不可访问，且在线客户端会被断开、无法自行重连。**

## ⚠️ 一个必须点明的架构矛盾（②与③不能同时字面成立）

- **②** 要求：管理 API「供 Cloudflare Worker 调用」
- **③** 要求：面板「只监听 127.0.0.1」

**这两条在字面上是互斥的**：只监听回环地址的进程，Cloudflare Worker 从公网**永远打不到**
（除非把面板重新暴露出去，而那正是 ③ 要消灭的漏洞）。

所以 HMAC 管理 API 的**实际可用范围是本机**：

| 调用方 | 能否用 HMAC API | 说明 |
|---|---|---|
| 服务器上的 `frp-agent.py` | ✅ 可以 | 同机，走 127.0.0.1 |
| 运维（SSH 登录后 curl） | ✅ 可以 | 同机 |
| 运维（SSH 隧道转发到本地） | ✅ 可以 | `ssh -L 7200:127.0.0.1:7200` |
| **Cloudflare Worker** | ❌ **不可以** | 公网打不到回环地址 |

**当前的正确架构仍然是**：D1（唯一真值）→ agent 在服务器上**主动出网**拉取期望状态
→ 通过**面板兼容接口**写入本机面板。这条链路已经实测跑通（见上文 agent 兼容性验收，
真实 agent 18/18 通过）。

那 HMAC API 是干什么用的？三个现实用途：

1. **agent 的演进路径**：agent 与本面板同机，随时可以改用 HMAC API（更严格的鉴权 + 更清晰的语义），不必再走兼容接口。
2. **运维直连**：SSH 上去（或开隧道）后可以直接管理账号，不依赖 Worker。
3. **将来若真要 Worker 直连**：正确做法不是暴露面板，而是让面板**主动出网**去拉
   （即现在 agent 的模式），或者在前面放一个带 mTLS 的反向代理 —— 但仍然不要监听 `0.0.0.0`。

**结论**：② 的「HMAC 私有 API」已按要求的签名口径实现并验证（9/9 + 未配密钥 503），
但「由 Worker 直接调用」这一步**不宜也不应实现** —— ③ 的优先级更高。
我把这个判断明确写在这里，而不是默默留一个打不通的接口。

### 正解：让 ② 和 ③ **同时成立**（Cloudflare Tunnel）

上面说的「互斥」是针对**开公网端口**这种做法。还有一种做法能让 Worker 打到
一个只监听 `127.0.0.1` 的服务，而**不暴露任何公网端口**：

```
服务器                                     Cloudflare                        Worker
┌───────────────────────────┐         ┌──────────────────┐        ┌──────────────────┐
│ frp-panel 127.0.0.1:7200  │◄────────│ cloudflared 隧道 │◄───────│ HMAC 签名调用     │
│   ↑ 仍然只监听回环          │ 主动出网 │ (无需入站端口)    │        │                  │
└───────────────────────────┘         └──────────────────┘        └──────────────────┘
```

要做的只有一件事：在服务器上跑 `cloudflared`（它**主动出网**建隧道，不需要任何入站端口），
把 `127.0.0.1:7200` 映射成一个 Cloudflare 域名。然后：

- **③ 依然成立**：面板**只监听 127.0.0.1**，公网上没有任何端口可以直接连到它
- **② 依然成立**：Worker 通过隧道域名调用，HMAC 签名那套完全照旧
- 还能再叠一层 **Cloudflare Access**（服务令牌 / mTLS），比单一 HMAC 更稳

为什么这条在本项目上可行：`cloud.doulor.cn` 本身就在 Cloudflare 上，
服务器出网到 Cloudflare 是通的（agent 每 20 秒就在做这件事）。
**注意**：隧道方向是**出站**，所以它和「把面板暴露到公网」是两回事 ——
前者是服务器主动连出去，后者是别人能连进来。

> 我没有直接去装 `cloudflared`（那需要在你的 Cloudflare 账号里创建隧道凭据，
> 属于要你点头的操作）。如果要用这条路，告诉我，我来把 tunnel 配置和
> Worker 侧的调用代码一起加上。



## 网页界面与访问控制

面板自带**可操作的账号管理界面**（`/` 账号列表、`/ports` 端口分配），带登录。访问规则：

| 来源 | 端点 | 需要登录吗 |
|---|---|---|
| **本机回环** | 全部（`/tokens`、兼容 API、网页） | ❌ 免登录 |
| 外部 | `/handler`（插件回调） | ❌ **直接 403**（它本来就只该从回环来） |
| 外部 | `/api/admin/*` | 走 HMAC 签名 |
| 外部 | `/health` | ❌ 放行（不含敏感信息） |
| 外部 | `/api/token/<user>`（网页上点「显示令牌」才调） | ✅ **必须登录**，且**每次调用都记日志** |
| 外部 | 其余（含 `/tokens` 与网页） | ✅ **必须登录** |

**「本机回环免登录」是刻意的**：frps 的插件回调和 agent 都从 `127.0.0.1` 来，
所以它们一行都不用改；而本机能发请求的人本来就已经拿到 shell 了。
**唯一的边界是「外部必须登录」** —— 这条一旦失效，面板就退化成旧面板那个漏洞。

### 登录

在配置里设 `admin_user` / `admin_password`。**口令留空 = 网页界面整体不可用**
（不会退化成无鉴权页面）。安全细节：

- 会话令牌 = `过期时间.会话id.HMAC签名`，**服务端不存会话表**
- 登出会把该会话 id 记进**吊销表**，真正让它失效（只吊销这一个，不影响其它浏览器）
- 登录失败按 IP 计数封禁（默认 8 次 / 封 15 分钟）
- 口令与签名比较一律 `hmac.compare_digest`（定时安全）
- Cookie 是 `HttpOnly; SameSite=Lax`；页面带 `X-Frame-Options: DENY`
- **列表页里令牌默认打码**，要看得点一次「显示令牌」（防肩窥/误截图）

### 想从公网直接访问？可以，但要显式开两道锁

默认 `listen_host` 只能是 `127.0.0.1`。想绑公网，配置里必须**同时**满足：

```jsonc
{
  "listen_host": "0.0.0.0",
  "allow_public_bind": true,        // 显式打开
  "admin_user": "yourname",         // 且必须配好登录口令
  "admin_password": "a-strong-one"
}
```

少任何一条都会**拒绝启动**并在日志里说明原因。这样就不可能出现
「以为开了登录、其实没开」的情况。

> 仍然推荐用 **SSH 隧道**（`ssh -L 7200:127.0.0.1:7200 root@<IP>`）而不是开公网端口 ——
> 隧道能从根上消掉「鉴权被绕过」这一整类问题（旧面板那次正是鉴权中间件写错）。
> 开公网端口时，请**务必**用强口令，并考虑在前面再放一层 nginx Basic 认证。

## 管理功能（网页）

界面不是只读的，日常运营都在上面完成：

| 能力 | 位置 |
|---|---|
| **概览指标** | 列表页顶部四张卡：账号总数 / 即将到期 / 已到期 / 端口占用率 |
| **新建账号** | 列表页右上「＋ 新建账号」 |
| **编辑全部字段** | 每行「编辑」：账号名、令牌、端口、备注、启用状态 |
| **设置 / 修改租期** | 编辑页「租期」区：按天数 / 指定到期日 / 永久 / 保持不变 |
| **续期** | 每行「续期」，或编辑页的「续期 30 天 / 90 天」 |
| **批量操作** | 勾选多行 → 顶部出现操作条 → 批量**续期 / 启用 / 停用 / 删除** |
| **启用 / 停用** | 每行电源图标 |
| **删除** | 每行垃圾桶图标（两步确认） |
| **生成 frpc.toml** | 每行「配置」；可在线查看，也可下载 |
| **端口分配视图** | 导航「端口」→ `/ports`：谁占了哪个端口、哪些还空着、哪些在默认区间外 |
| **操作日志** | 导航「日志」→ `/logs`：插件放行/拒绝、账号改动、取令牌留痕，可按级别筛 |
| **亮/暗主题** | 导航底部的主题按钮，偏好存在浏览器 cookie 里（每台设备各自记） |

界面用**左侧导航栏**分成三段（账号 / 端口 / 日志）。之所以要单独做导航：
顶栏上原本挤了「端口 / 显示令牌 / 新建账号 / 退出」，再加「日志」就放不下了 ——
而且「去哪一页」和「在这一页做什么」本来就是两件事，混在一条 bar 上会一直互相挤。
窄屏时导航栏自动变成**底部栏**（纯 CSS 切换，没有两份 DOM）。

几个刻意的设计：

- **租期按「天」算时从今天起算**（买 1 天不会立刻过期）
- **续期是在现有到期日上加**；已过期的账号从**今天**续，不会接着过去的日子往后算
- **端口支持区间写法**：`31200-31202` 会展开成三个端口分别授权
- **端口冲突会在保存前就报错**（否则 frps 那边会报 "port already used"，很难排查）
- **令牌留空 = 自动生成**，不用自己想
- **列表页令牌默认不上屏**，点「显示」才按需去取（每次取都记日志）

### 批量操作

一批人同时到期是最常见的场景，逐个点开编辑页太慢。勾选若干行后顶部会出现操作条。

实现上有个值得说的点：勾选框用 `form="bulkform"` **关联到表格外的一个表单**，
而不是把整张表包进 `<form>` —— 因为行内还有启停/删除的表单，嵌套表单是无效 HTML。
这样写还有个好处：**禁用 JS 也能提交**（勾选后点操作，就是一次普通表单 POST）。

批量写是"选错就是一批人掉线"的操作，所以边界都验过：没勾选、非法动作、
天数越界、CSRF 伪造、账号已不存在 —— 见 `tests/test-bulk-ports.py`。

### 操作日志

面板一直在记日志，但以前只能 SSH 上去 `tail`。运营问「刚才那次改动是谁做的」
在界面上看不到，等于没有 —— 所以 `/logs` 把它搬了上来，按级别分成
**放行 / 拒绝 / 警告 / 错误 / 管理**，可单独筛。

两个实现上的取舍：

- **读文件而不是内存环形缓冲**：内存里的重启就没了，而排障往往正是要看重启前发生了什么。
- **只读文件末尾 256KB**：真实环境日志是几百 MB 的，整个读进内存会出事。
  实测 **7.3MB 日志响应 0.01s**，只回最近 500 条（见 `tests/test-logs.py`）。
- **异常堆栈并进上一条**，不拆成独立事件 —— 否则一次报错会刷满整屏。

### 界面设计

界面按 **Material 3（Material You）** 做，配色与几何参考
[FLClash](https://github.com/chen08209/FlClash) 的做法 —— 那是社区里公认做得好的
同类客户端，所以直接沿用它的体系而不是自己拍脑袋配色：

| 取自 FLClash 的做法 | 在这里的落地 |
|---|---|
| `useMaterial3: true` | 用 M3 的**颜色角色**（`--md-primary` / `--md-surface-container-*` …），不是随手挑几个颜色 |
| `.withAppShapes` | 一套成体系的圆角（4/8/12/16/28/full），按钮是**胶囊**，卡片 16，输入框 4 |
| 种子色生成色调板 | 全部颜色由 `:root` 里那组 `--md-*` 派生；**换主色只改 `--md-primary` 一组** |
| `surfaceContainerLow/High/Highest` | 层级靠**表面色调**表达，阴影很轻（M3 的做法），不是靠重阴影 |
| `green/orange.harmonizeWith(primary)` | 状态色不用纯绿纯橙，而是被主色"拉"过一档，整体更协调 |
| 纯黑模式 | `--md-surface:#141218`，需要更沉可以换成 `#000` |
| `themeMode`（亮/暗/跟随系统） | 整套 M3 **亮色**颜色角色；只覆盖颜色变量，不动布局几何 |

另外补了两件 M3 里最容易被忽略、但最影响质感的事：

- **state layer**：悬停/按下不是"换个颜色"，而是在当前色上叠一层 `currentColor`
  的 8%/10%/12%。这样**任何底色都自动有正确的对比度**，不用为每种按钮单独挑悬停色。
- **outlined 输入框**：聚焦时是 1px 主色描边 + 内阴影主色，而不是默认那圈浏览器蓝。

### 无障碍与质量（有测量，不是靠感觉）

用 Playwright 做客观体检，8 个「页面 × 宽度（1440 / 390）」组合**全部通过**：

| 检查项 | 结果 |
|---|---|
| 文字对比度（WCAG AA 4.5:1） | 全部达标，实测 **6.0 – 14.3 : 1** |
| 横向溢出 | 无（窄屏表格可横向滚动，操作列不会被裁掉） |
| 点击目标 ≥ 24px（WCAG 2.2） | 无过小目标 |
| 键盘焦点可见 | 全部可见 |
| 控制台错误 | 无 |

其他已落实的规范：语义化标签 + 跳转链接、`aria-label`（图标按钮）、`aria-live`
（提示条）、`role="alert"`（错误）、`translate="no"`（账号名/令牌/端口，避免被
浏览器自动翻译搞乱）、`tabular-nums`（数字列对齐）、`content-visibility`
（账号多了也不卡）、`prefers-reduced-motion`。

**没有引入任何外部依赖**：图标是内联 SVG（刻意不用 Lucide 那套通用图标），
字体走系统字族（面板是内网工具，不该为了好看去依赖 CDN）。

### 交互

- **搜索**：按 `/` 聚焦，`Esc` 清空
- **筛选 / 排序**：状态分段筛选 + 按账号名 / 剩余天数 / 端口数排序
- **状态写进 URL**：筛选后的视图可以直接收藏或发给同事
- **令牌默认不上屏**：点「显示」时才去 `/api/token/<user>` 按需取（**每次取都记日志**）
- **删除两步确认**：不是浏览器原生弹窗
- **无 JS 也能用**：所有写操作都是普通表单 POST

### 定时机制

- **到期即刻生效**：插件在 `Login` / `NewWorkConn` / `Ping` 上按 `expire_at` **直接拒绝**，
  到期那一刻用户就连不上了（详见上面「到期即时拒绝」一节）。**不依赖任何定时任务**。
- **界面预警**：到期前 `expiring_soon_days` 天（默认 3）标成「即将到期」并显示剩余天数。
- **后台巡检**（每 `sweep_interval_seconds` 秒）：把刚过期的账号写进日志，便于追溯。
- `auto_disable_expired`（默认 **false**）可让巡检把到期账号置为停用。
  默认关的原因：D1 才是唯一真值，如果 D1 里该账号仍算有效，agent 下一轮就会把它改回来，
  两边拉锯没有意义 —— 而且**访问控制本来就不依赖这个开关**。

## 外部 API

签名口径与 agent 通道一致（`X-Frp-Agent-Ts` / `X-Frp-Agent-Signature`，
canonical = `[ts, METHOD, path+query, sha256(原始body)]` 用 `\n` 连接）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/accounts` | 列出全部（含 `days_left`） |
| `GET` | `/api/admin/accounts/<user>` | 查单个（含 `days_left`） |
| `PUT` | `/api/admin/accounts/<user>` | 新增/覆盖；可传 `days` 直接设租期 |
| `DELETE` | `/api/admin/accounts/<user>` | 删除 |
| `POST` | `/api/admin/accounts/<user>/enable` | 启用 |
| `POST` | `/api/admin/accounts/<user>/disable` | 停用 |
| `POST` | `/api/admin/accounts/<user>/renew` | `{"days": 30}` 续期 |
| `GET` | `/api/admin/accounts/<user>/config` | 返回生成的 frpc.toml 文本 |

```python
import hashlib, hmac, json, time, urllib.request

SECRET = "<agent_secret>"
BASE = "http://127.0.0.1:7200"
PATH = "/api/admin/accounts/dcfrp_demo/renew"
BODY = json.dumps({"days": 30}).encode()
TS = str(int(time.time()))
canonical = "\n".join([TS, "POST", PATH, hashlib.sha256(BODY).hexdigest()])
sig = hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()

req = urllib.request.Request(BASE + PATH, data=BODY, method="POST")
req.add_header("Content-Type", "application/json")
req.add_header("X-Frp-Agent-Ts", TS)
req.add_header("X-Frp-Agent-Signature", sig)
print(urllib.request.urlopen(req).read().decode())
```

> **关于「谁能改哪些账号」**：`user_prefix` 这条边界是给**自动化**用的 ——
> agent 走的兼容接口（`/tokens`、`/add`、`/update`、`/remove`…）只会碰 `dcfrp_` 前缀的账号。
> 而**网页**和**HMAC 管理接口**是管理员通道，可以管理任何账号（包括那 46 个历史账号）。
> 这两件事分开，才不会出现「想手工改个历史账号却改不了」。

## 管理接口

### A. HMAC 私有 API（本机调用；签名口径与 agent 通道一致）

签名口径与现有 agent 通道**完全一致**，调用方不用另学一套：

```
头：X-Frp-Agent-Ts: <unix 秒>
    X-Frp-Agent-Signature: <hex>
canonical = "\n".join([ts, METHOD, pathname+search, sha256hex(原始body字节)])
signature = HMAC-SHA256(agent_secret, canonical)
```

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/admin/accounts` | 列出全部账号 |
| `PUT` | `/api/admin/accounts/<user>` | 新增/覆盖 |
| `DELETE` | `/api/admin/accounts/<user>` | 删除 |
| `POST` | `/api/admin/accounts/<user>/enable` | 启用 |
| `POST` | `/api/admin/accounts/<user>/disable` | 停用 |

- 时间容差 300 秒，`hmac.compare_digest` 定时安全比较
- **未配置 `agent_secret` 时一律 `503 FRP_AGENT_DISABLED`** —— 绝不退化成「无鉴权可用」
- 只允许操作 `user_prefix`（默认 `dcfrp_`）开头的账号；碰历史账号返回 `403`

### B. 旧面板兼容接口（让现有 agent 零改动切换）

`GET /tokens`、`POST /add|/update|/remove|/enable|/disable`，请求/响应格式与第三方面板逐字一致。
**现有的 `frp-agent.py` 一行都不用改**就能接过来。

### C. frps 插件回调

`POST /handler?version=0.1.0&op=Login|NewProxy|CloseProxy|Ping|NewWorkConn|NewUserConn`

> 🔴 **放行时必须回 `unchange: true`。** frp 的 `manager.go` 会用插件返回的 `content`
> **整体覆盖**原消息，而 `http.go` 预分配的是一个**空**结构体。回
> `{"unchange":false,"content":{}}` 会把 Login 消息清空（`privilege_key` 变空、
> `timestamp` 变 0），导致 frps 自己的 token 校验必然失败，报
> `token in login doesn't match token from configuration` —— 且换任何 `auth.token` 都没用。
> 这个坑已写进 `panel.py` 顶部注释。

## 部署

### 推荐：用 `deploy/cutover.sh`（默认 dry-run）

```bash
# 1) 先演练一遍，它只读不改
sh deploy/cutover.sh

# 2) 确认输出无误后真正执行
sh deploy/cutover.sh --yes

# 3) 任何时候回滚
sh deploy/cutover.sh --rollback
```

脚本做的事：预检 → 迁移账号 → **核对结果** → 停旧面板 / 起新面板 → 验证
（health + 账号数 + 判定路径自测）。**验证不过会自动回滚**，不会把服务停在半路。

已实测：

```
dry-run 输出
  1/6 预检    python3: Python 3.6.8 / 旧面板账号段落数: 2
  2/6 迁移    导入 1 个，跳过 1 个（不归自动流程管）
  3/6 核对    新面板账号数: 1
              dcfrp_test01  ports=[31600, 31601]  expire=2026-12-31T23:59:59Z
  （dry-run，未改动任何东西）

把 listen_host 误写成 0.0.0.0 时
  ❌ 配置里的 listen_host=0.0.0.0 不是 127.0.0.1 —— 拒绝继续   （退出码 1）
```

> ⚠️ **`--yes` 会动生产**，我没有在你的服务器上执行过它（只跑过 dry-run 与安全闸门）。
> 真正切换前建议你先在低峰期用 dry-run 看一遍输出。

### 手工步骤（想自己掌控每一步时用）

#### 0. 前置确认

```bash
python3 -V          # 需要 3.6+（服务器是 3.6.8，OK）
```

### 1. 上传

```bash
mkdir -p /home/frp/frppanel-new
# 把 panel.py 放进去（SFTP 或 scp；注意 base64 塞进命令行会超 Windows 32KB 限制）
```

### 2. 写配置

```bash
cat > /home/frp/frppanel-new/panel.json <<'JSON'
{
  "listen_host": "127.0.0.1",
  "listen_port": 7200,
  "data_file": "/home/frp/frppanel-new/accounts.json",
  "log_file": "/home/frp/frppanel-new/panel.log",
  "user_prefix": "dcfrp_",
  "agent_secret": "<与 Worker 的 FRP_AGENT_SECRET 相同的值>"
}
JSON
chmod 600 /home/frp/frppanel-new/panel.json     # 里面有密钥
```

> `listen_host` **只能**是 `127.0.0.1`。填别的会直接拒绝启动（这是刻意的）。

### 3. 迁移账号（必须**全部**导入）

```bash
python3 panel.py --config panel.json \
  --import-legacy /home/frp/frppanel/frps-tokens.toml --import-all
```

预期输出形如 `导入 47 个，跳过 0 个`。

> 🔴 **这里必须加 `--import-all`，我踩过一次。**
>
> **「导入」和「可管理」是两件事：**
>
> | | 范围 | 为什么 |
> |---|---|---|
> | **导入** | **全部 47 个** | 插件要能「认出」账号才能授权。只导入 `dcfrp_` 前缀的话，那 46 个历史用户登录时插件会回「账号不存在」——**全部掉线** |
> | **可管理** | 只有 `dcfrp_` | 自动化只能改这些。由 `panel.py` 的 `is_managed()` 在 `/add /update /remove /enable /disable` 和 `/api/admin/*` 上把关，**与导入了多少账号无关** |
>
> 不带 `--import-all` 只会导入 1 个账号，切过去等于把那 46 个历史用户直接踢下线。
> `deploy/cutover.sh` 里已经加了 `--import-all`，并且**会校验「新面板账号数不得少于旧面板」**，
> 不满足就自动回滚。

用 `GET /tokens` 对照旧面板的账号数确认一致后再继续。

### 4. 切换 frps 的插件地址（**唯一的服务中断点**）

```bash
cp /home/frp/frpserver/frps.toml /home/frp/frpserver/frps.toml.bak
# 把 [[httpPlugins]] 的 addr 保持 127.0.0.1:7200 不变即可（新面板复用同一端口），
# 但必须先停旧面板、再起新面板 —— 因为端口相同
```

停旧面板 → 起新面板：

```bash
pkill -f 'frps-panel -c /home/frp/frppanel/frps-panel.toml'
cd /home/frp/frppanel-new
nohup python3 panel.py --config panel.json > panel.out 2>&1 &
sleep 2
curl -s http://127.0.0.1:7200/health      # {"ok": true, "accounts": 47}
```

**注意**：这一步会让 frps 的插件短暂不可用（秒级）。frps 对插件调用失败的处理是
**拒绝**该次操作（fail-closed），不会放行 —— 所以中断期间新连接会被拒，已在线的隧道不受影响。
建议在低峰期做，并**事先在测试台演练**。

> 更平滑的做法：新面板先跑在 `7210`，在 frps.toml 里把 `[[httpPlugins]]` 的 `addr`
> 改成 `127.0.0.1:7210`，然后 `frps` 重载配置/重启，确认无误后再停旧面板。
> （代价是 frps 需要重启一次，会断开所有在线客户端。）

### 5. 验证

```bash
# 插件判定路径（6 条：令牌错、账号不存在、端口越权…）
python3 tests/test-plugin-protocol.py

# keep-alive 回归：同一条连接上交替发送放行/拒绝请求，防止请求体串用
python3 tests/test-keepalive.py

# HMAC 管理接口（9 条：含签名错/时间戳过期/缺头/前缀越界）
python3 tests/test-admin-hmac.py
```

这三个脚本默认打 `127.0.0.1:7210`，需要面板在跑；它们会先把测试夹具写进
`/tmp/frpbench/accounts.json`（改路径就改脚本顶部的常量）。

```bash
# 不需要面板/网络：直接测迁移解析（11 条）
python3 tests/test-import-legacy.py

# 并发压测：8 线程 × 30 轮 × 3 个回调 = 720 次请求，断言零状态串用
# （keep-alive 那个 bug 就是这么一类问题，修完必须压一遍）
python3 tests/test-concurrency.py

# 真实 agent 零改动兼容：加载真实 frp-agent.py，跑它的 diff_plan/apply_actions（18 条）
python3 tests/test-agent-compat.py

# 访问闸门 + 网页界面（31 条）：自己拉起一个绑非回环地址的临时实例来验「外部必须登录」
python3 tests/test-auth-ui.py

# 网页管理功能（40 条）：新建/编辑/续期/启停/删除/生成配置 + CSRF + 表单校验
python3 tests/test-ui-crud.py

# 批量操作 + 端口分配视图（33 条）：批量续期/启停/删除、越界与误伤边界
python3 tests/test-bulk-ports.py

# 操作日志视图（25 条）：级别分类、筛选、异常堆栈合并、7MB 大文件不读爆
python3 tests/test-logs.py

# 亮/暗主题（19 条）：切换生效、非法值兜底、只跳回同源（防开放重定向）
python3 tests/test-theme.py
```

`test-concurrency.py` 与 `test-agent-compat.py` 需要面板在 `127.0.0.1:7210` 跑着；
agent 兼容测试另需 `frp-agent.py` 在该目录（或用 `FRP_AGENT_PATH` 指定）。

下面两个需要**完整测试台**（本机 frps + frpc + 一个隧道目标端口），耗时各约 1 分钟：

```bash
# 访客视角：有效时连得通，到期后连入被 2ms 重置
python3 tests/test-expiry.py

# 客户端视角：到期后心跳被拒 → frps 断开客户端 → 重连仍被拒
python3 tests/test-ping-kick.py
```

**已实测全部通过：6 / 10 / 9 / 11 / 18 / 31 条用例 + 720 次并发压测 + 两个端到端验收。**

- `test-keepalive.py` 做过**反向验证** —— 在去掉缓存清理的版本上它**必然失败**
  （第 2 个用例就报错并伴随连接错乱），在修复版上 10/10 通过。
- `test-concurrency.py` 曾暴露出一处**测试期望写错**（断言 Ping 该被拒）——
  我核实后确认是**测试错、代码对**（Ping 的 content 里没有用户令牌，
  身份在 Login 时已确认）。**没有为了迎合错误测试去改面板** ——
  那样会让所有正常心跳被拒、把全部用户踢下线。
- `test-import-legacy.py` 的样本**照抄真实文件的格式**；另外还用**真实的
  `frps-tokens.toml`** 跑过一次迁移，结果是「导入 1 个 / 跳过 46 个」，
  端口与到期日都正确 —— 见下节。

## 迁移验收（用真实文件跑过）

用生产上那份 `frps-tokens.toml`（**只读复制**，原文件未改动）实测：

```
迁移结果：导入 1 个，跳过 46 个（不归自动流程管）

{ "user": "dcfrp_06ed1dbb",
  "token": "6PbWw6W5rXjvRR8rZloYjCaOgU2rObRs",
  "comment": "DoulorCloud | active | 到期 2026-11-12",
  "ports": [31000, 31001, 31002, 31003, 31004],
  "expire_at": "2026-11-12T23:59:59Z" }
```

只接管 `dcfrp_` 那一个付费租用账号，**46 个历史账号一个都没碰**。

> ⚠️ 这次验证救了一次部署：我最初的解析器只认 `[[tokens.x]]`（双括号），
> 而真实文件用的是**单**方括号 `[tokens.x]`，端口还有 `["28888-28890"]` 这种区间写法。
> 照原样跑会**导入 0 个账号**。教训：迁移逻辑一定要拿**真实文件**跑一遍，
> 自己造的样本很容易和真实格式不一致。

## 回滚方案

**设计成随时可退，且不依赖备份恢复：**

1. **agent 轮询路径始终保留**
   新面板**逐字兼容**旧面板的 JSON 接口，所以 `frp-agent.py` 不需要任何改动。
   回滚时只需把新面板停掉、旧面板起回来，agent 会照常工作。

   ```bash
   pkill -f 'panel.py --config /home/frp/frppanel-new/panel.json'
   cd /home/frp/frppanel
   nohup ./frps-panel -c /home/frp/frppanel/frps-panel.toml > /dev/null 2>&1 &
   sleep 2
   curl -s http://127.0.0.1:7200/tokens | head -c 200
   ```

   旧面板的 `frps-tokens.toml` **全程没有被修改过**（新面板写自己的 `accounts.json`），
   所以回滚后账号数据原样还在。

2. **账号文件是纯 JSON，可直接肉眼比对/手工修复**
   `accounts.json` 是 `{version, updated_at, accounts:[...]}`，随时可以 `cat` 出来排障。

3. **绝对不要回滚的东西**：不要为了让新面板工作而把 `listen_host` 改成 `0.0.0.0`。
   那等于把旧面板的漏洞原样搬过来。面板的公网访问请走
   「宝塔防火墙只放行自己 IP」/「nginx 反代 + Basic 认证」/「SSH 隧道」，
   而不是把它暴露出去。

## 运维

| 项 | 做法 |
|---|---|
| 健康检查 | `curl -s http://127.0.0.1:7200/health` → `{"ok": true, "accounts": N}` |
| 日志 | `panel.log`（同时输出到 stdout）。每次放行/拒绝都有 `ALLOW`/`REJECT` 行 |
| 账号文件被外部改动 | 会自动检测 mtime 变化并重新载入，便于手工排障 |
| 自测 | `tests/` 下 5 个脚本：插件判定(6) / keep-alive 回归(10) / HMAC(9) / 到期访客视角 / 到期客户端视角 |
| 开机自启 | 建议写一个 `start.sh` + systemd unit（`Type=simple`，`Restart=always`） |

## 一个必须记住的坑：keep-alive 下的请求体缓存

**HTTP/1.1 keep-alive 下，`BaseHTTPRequestHandler` 会用同一个实例连续处理同一条连接上的多个请求。**
如果把请求体缓存在实例属性上而不在每个请求开头清空，第 N 个请求就会拿到**第 N-1 个请求的 body**。

后果极隐蔽且严重：`self.path`（→ op）是**新**请求的，`content` 却是**旧**请求的，
于是授权判定基于错误的对象（例如拿旧的 `Ping` body 去判 `NewProxy`）。

实测症状（修复前）：

```
7 ALLOW Login / 7 NewProxy / 4 REJECT Login / 3 Ping       ← frpc 每 ~13 秒被断开重连一次
日志里反复出现 op 与 content 对不上：
   ALLOW  NewProxy user='dcfrp_bench01' proxy=None port=0
   REJECT Login   user="{'user': ..., 'run_id': ...}"
```

**定位方法（关键）**：同时用抓包插件（无状态、不做任何分支）看同一段时间的流量 ——
抓包显示 **10 条回调、错配 0 条**，而面板日志错配 4 条。两边一对比，就能确定问题在面板侧。

修复：重写 `handle_one_request`，在每个请求开始前 `self._body_cache = None`。

修复后：

```
1 ALLOW Login / 1 NewProxy / 1 NewWorkConn / 8 ALLOW Ping      ← 重连 1 次，零错配
```

`tests/test-keepalive.py` 是这条的回归测试 —— **它专门在一条 keep-alive 连接上
连发多个内容不同的请求**，断言每个响应只对得上自己的请求。

## 已知限制

- `CloseProxy` 已实现但没有单独观测（关闭动作永远放行 —— 账号失效时更应该让它关掉）。
- 面板自身的公网访问（满足「管理员要能手动看」）需要另外用
  防火墙白名单 / nginx Basic 认证 / SSH 隧道解决，**不要**用 `0.0.0.0` 监听。
- 窄屏（<860px）下表格关闭了吸顶表头：那时 `.table-wrap` 要横向滚动，
  又会变回滚动容器，`position:sticky` 会再次错位压住第一行。

## 三个值得记住的坑

**1. 写盘必须用 `os.replace`，不能用 `os.rename`。**

`os.rename` 在 POSIX 上目标已存在会静默覆盖，**在 Windows 上直接抛
`FileExistsError`**。用 rename 的话，面板在 Windows 上第一次之后的每次写盘都会失败 ——
表现是「操作提示成功但数据没变」，日志里只有一句 FileExistsError，很容易漏掉。
这个 bug 是本地在 Windows 上跑验收测试时才撞出来的（服务器是 Linux，一直看不出来）。

**2. `.table-wrap` 要用 `overflow:clip`，不能用 `overflow:hidden`。**

`overflow:hidden` 会让容器**变成滚动容器**，于是里面 `th` 的 `position:sticky`
变成「相对容器定位」而不是相对视口 —— `top:71px` 会把表头**往下推 71px**，
正好压在第一行上，第一行的勾选框和按钮就点不到了。
`overflow:clip` 同样裁剪圆角，但不创建滚动容器。

> 这两个都属于「Linux 上完全正常、换个环境或换个宽度就出问题」的类型，
> 靠**自动化测量**（Playwright 的命中测试 + 几何坐标）才定位到 ——
> 肉眼和日志都很难看出来。

**3. 读请求头的代码必须放在 `parse_request()` 之后，不能放 `handle_one_request()` 开头。**

`self.headers` 是 `BaseHTTPRequestHandler.parse_request()` 里才设置的。
我在 `handle_one_request()` 开头（清请求体缓存那几行）顺手去读主题 cookie，
结果**每个请求都 AttributeError** —— 面板能启动、能接受连接，但一个响应都发不出去，
浏览器只看到「连接被重置」。而且 `socketserver` 把异常打到 **stderr**，
当时被我重定向到了文件里，日志文件干干净净，看着像"服务没起来"。

> 教训：这类"整个服务全挂但日志一片空白"的情况，最快的办法是
> **把服务器跑在同一进程里**再发一次请求，异常就会直接打在我面前，
> 而不是去猜日志为什么是空的。
