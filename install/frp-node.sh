#!/usr/bin/env bash
#
# DoulorCloud · 代理节点（内网穿透）一键捐献脚本
# ---------------------------------------------------------------------------
# 捐献者只需要在服务器上跑一条命令：
#
#     curl -fsSL https://cloud.doulor.cn/install/frp-node.sh | bash -s -- <你的IPv4> <捐献令牌>
#
# 脚本会自动做完这些事，不需要人值守：
#   1. 装依赖（python3 / curl / tar）
#   2. 下载 frps（固定版本）和面板（单文件 Python）
#   3. 生成配置（随机强口令、随机 agent 密钥，端口自动避开占用）
#   4. 用 systemd 把 frps 和面板都拉起来，并设成开机自启
#   5. **自检**：frps 真在监听、面板 /health 真的回 ok
#   6. 自检通过才回报 DoulorCloud 登记这台节点
#
# 设计上刻意做成「自检通过才回报」：宁可捐献失败让用户看到原因，
# 也不要登记一台其实没跑起来的节点 —— 那会在后台留下一堆连不上的死节点。
#
# 幂等：重复执行不会产生第二份安装，会原地更新二进制并重启。
# ---------------------------------------------------------------------------
set -euo pipefail

API_BASE="${DOULOR_API_BASE:-https://cloud.doulor.cn}"
# 面板和 frps 都从 R2 的公共只读地址取。刻意**不**走 cloud.doulor.cn 的 Worker 路由：
# 那样会在安装链路上多一个我们自己代码的依赖点 —— 面板挂了这个脚本就装不了。
# R2 是静态托管，和站点故障域分开，安装的成功率更高。
CDN_BASE="${DOULOR_CDN_BASE:-https://pub-4362b2869bc5460aa18128ac9126e59c.r2.dev}"
# 脚本自身的地址 —— 自动提权时要用它重新下载自己
SELF_URL="${DOULOR_SELF_URL:-$CDN_BASE/install/frp-node.sh}"
PANEL_DL="${DOULOR_PANEL_URL:-$CDN_BASE/install/frp-node-panel.py}"
# ---------------------------------------------------------------- 安装目录 / 模式
#
# **自动识别身份，不问用户**：
#   · root   → 装到 /opt，用 systemd（开机自启 + 崩溃自动重启）
#   · 非 root → 装到自己家目录，用 crontab 做 @reboot + 看门狗
#
# 为什么普通用户也该能装：frps(7000)、面板(7200)、用户隧道(10000-11000) 全都 > 1024，
# 本来就不需要特权。真正需要 root 的只有两件事 —— 开机自启（crontab 可以替代）
# 和改本机防火墙（交给用户在云控制台开）。没必要因为这个把捐献者挡在门外。
if [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="${DOULOR_INSTALL_DIR:-/opt/doulor-frp-node}"
  NO_SYSTEMD=0
else
  INSTALL_DIR="${DOULOR_INSTALL_DIR:-$HOME/.doulor-frp-node}"
  NO_SYSTEMD=1
fi
FRPS_VERSION="0.65.0"
FRPS_PORT="${DOULOR_FRPS_PORT:-7000}"
PANEL_PORT="${DOULOR_PANEL_PORT:-7200}"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; NC=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$NC" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

cleanup_on_fail() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    printf '\n%s安装中断（退出码 %s）%s\n' "$RED" "$code" "$NC" >&2
    printf '%s排查：journalctl -u doulor-frps -n 50 / journalctl -u doulor-frp-panel -n 50%s\n' "$DIM" "$NC" >&2
  fi
  exit "$code"
}
trap cleanup_on_fail EXIT

# ---------------------------------------------------------------- 参数
IP="${1:-}"
TOKEN="${2:-}"

say ""
say "DoulorCloud · 代理节点一键捐献"
say "--------------------------------------------"

[ -n "$IP" ] || die "缺少 IPv4 地址。用法： bash -s -- <你的IPv4> <捐献令牌>"
[ -n "$TOKEN" ] || die "缺少捐献令牌。请回到 DoulorCloud 的「捐献」页面复制完整命令。"

# IPv4 形状校验 —— 提前挡住手滑，比跑完一半再报错好
if ! printf '%s' "$IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  die "「$IP」看起来不是 IPv4 地址。"
fi
IFS=. read -r o1 o2 o3 o4 <<EOF
$IP
EOF
for part in "$o1" "$o2" "$o3" "$o4"; do
  [ "$part" -ge 0 ] 2>/dev/null && [ "$part" -le 255 ] || die "IPv4 段「$part」超出 0-255。"
done
ok "IPv4 格式正确：$IP"

if [ "$(id -u)" -ne 0 ]; then
  # ---------------------------------------------------------------- 自动提权
  #
  # 为什么必须由脚本自己做这件事：
  # 站长交给用户的只有**一条**命令 ——
  #
  #     curl -fsSL <脚本地址> | bash -s -- <IPv4> <令牌>
  #
  # 这条管道里的 bash 是**当前用户**身份。用户没有"规矩地用 sudo 跑"的办法：
  #   · `curl ... | sudo bash` 只是给 bash 提了权，而脚本正文是从 stdin（管道）
  #     读进去的，提权后的进程拿不到"重新读一遍自己"的能力；
  #   · 写成 `sudo bash -c "$(curl ...)"` 又长又容易在引号上出错。
  #
  # 所以脚本自己重来一次：把自己重新下载成临时文件，用 sudo 跑那个文件。
  # 这样用户永远只需要粘那一条命令 —— 第一次遇到的失败不该由用户来消化。
  #
  # ⚠️ 必须有这个标记，否则会**无限重跑自己**：
  #    如果 sudo 因为任何原因没有真正变成 root（sudoers 配错、sudo 是个包装脚本、
  #    或者用户其实已经在某种受限容器里），脚本会再次判定"我不是 root"→ 再次提权
  #    → 再次失败 …… 用户看到的是刷屏，而永远不成功。
  #    带着标记回来还不是 root，就直接报错说清楚，让人能去查 sudo 本身。
  if [ "${DOULOR_ELEVATED:-}" = "1" ]; then
    die "已经尝试用 sudo 提权，但仍然不是 root。请检查 sudo 配置，或直接用 root 运行。"
  fi

  # 只有**免密** sudo 可用才走提权这条路（sudo -n = 不提示密码）。
  #
  # 为什么不做成"弹密码让人输"：站长的要求是**自动识别身份** ——
  #   是 root / 有免密 sudo → 完整安装（systemd 开机自启 + 自动开防火墙）
  #   否则                → 直接走无 root 模式（装家目录 + crontab + 看门狗）
  # 弹一次密码换来的收益很小（无 root 模式同样能用），却会让"一条命令搞定"
  # 变成"先理解一下为什么问我要密码"。
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    say "检测到免密 sudo，用管理员权限做完整安装…"
    if [ -z "$SELF_URL" ]; then
      die "需要 root 运行，且拿不到脚本地址、无法自动提权。请用 root 重跑。"
    fi
    SELF_TMP="$(mktemp /tmp/doulor-frp-node.XXXXXXXX.sh)"
    if ! curl -fsSL --connect-timeout 15 --max-time 120 -o "$SELF_TMP" "$SELF_URL"; then
      rm -f "$SELF_TMP"
      die "自动提权失败：重新下载脚本失败（$SELF_URL）"
    fi
    chmod +x "$SELF_TMP"
    # -E 保留环境变量：用户可能用 DOULOR_FRPS_PORT / DOULOR_PANEL_PORT
    #    指定端口，提权后不能丢，否则会退回默认端口、和生产服务撞号。
    # 用 env 显式传入标记：sudo -E 只保留已有变量，不能凭空设置新变量。
    #
    # ⚠️ 这里刻意**不用 exec**：exec 会让脚本自身的进程被替换掉，sudo 失败时
    #    我们就没有机会再打印指引了 —— 用户只会看到 sudo 那句
    #    「xxx is not in the sudoers file」，然后一脸茫然地回到提示符。
    #    跑完再看退出码，失败就给出明确的下一步。
    if sudo -E env DOULOR_ELEVATED=1 bash "$SELF_TMP" "$@"; then
      rm -f "$SELF_TMP"
      exit 0
    fi
    rm -f "$SELF_TMP"
    say ""
    warn "免密 sudo 没能提权成功（当前用户 ${USER:-$(id -un)}）。"
    say "${DIM}改用无 root 模式继续安装（不需要管理员权限）…${NC}"
    say ""
    say "${DIM}（完整安装需要 root：能配开机自启的服务、能自动开本机防火墙。"
    say "  无 root 模式用 crontab 做开机自启和看门狗，防火墙需要你自己在云控制台开。）${NC}"

  fi
  # 走到这里说明：既不是 root，也没有免密 sudo —— 那就用无 root 模式继续。
  # 这里**不能 die**：普通用户本来就装得了（端口都 > 1024），
  # 把他挡在门外等于让"捐献"这件事先要求他搞定权限。
  say "${DIM}没有管理员权限，改用无 root 模式继续…${NC}"
fi

# ---------------------------------------------------------------- 系统
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  ok "系统：${PRETTY_NAME:-unknown}"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) FRP_ARCH="amd64" ;;
  aarch64|arm64) FRP_ARCH="arm64" ;;
  armv7l) FRP_ARCH="armv7" ;;
  *) die "不支持的架构：$ARCH（目前支持 x86_64 / aarch64 / armv7l）" ;;
esac
ok "架构：$ARCH → frp_${FRP_ARCH}"

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
elif command -v yum >/dev/null 2>&1; then PKG="yum"
elif command -v apk >/dev/null 2>&1; then PKG="apk"
fi

need_pkg() { ! command -v "$1" >/dev/null 2>&1; }

if need_pkg python3 || need_pkg curl || need_pkg tar; then
  say "${DIM}安装依赖…${NC}"
  case "$PKG" in
    apt) export DEBIAN_FRONTEND=noninteractive
         apt-get update -qq >/dev/null 2>&1 || true
         apt-get install -y -qq python3 curl tar ca-certificates >/dev/null 2>&1 || die "apt 装依赖失败" ;;
    dnf) dnf install -y -q python3 curl tar ca-certificates >/dev/null 2>&1 || die "dnf 装依赖失败" ;;
    yum) yum install -y -q python3 curl tar ca-certificates >/dev/null 2>&1 || die "yum 装依赖失败" ;;
    apk) apk add --no-cache python3 curl tar ca-certificates >/dev/null 2>&1 || die "apk 装依赖失败" ;;
    *)   die "认不出包管理器，请先手动装好 python3 / curl / tar" ;;
  esac
fi
need_pkg python3 && die "python3 装不上，面板跑不起来"
need_pkg curl && die "curl 装不上，无法下载"
ok "依赖就绪：$(python3 -V 2>&1)"

PYV="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 6) else 1)' \
  || die "需要 Python 3.6 或更高（当前 $PYV）"
ok "Python $PYV"

# ---------------------------------------------------------------- 端口占用
port_used() {
  if command -v ss >/dev/null 2>&1; then ss -lnt 2>/dev/null | grep -q ":$1 "
  elif command -v netstat >/dev/null 2>&1; then netstat -lnt 2>/dev/null | grep -q ":$1 "
  else return 1; fi
}

pick_port() {
  local p="$1"
  while port_used "$p"; do
    warn "端口 $p 已被占用，换一个"
    p=$((p + 1))
    [ "$p" -lt 65000 ] || die "找不到可用端口"
  done
  printf '%s' "$p"
}

# 这只在**本机没装过**的时候才换端口：已经装过的话沿用旧配置，
# 否则每次重跑都会漂移，面板和 frps 就对不上了。
if [ -f "$INSTALL_DIR/panel.json" ]; then
  PANEL_PORT="$(python3 -c "import json;print(json.load(open('$INSTALL_DIR/panel.json')).get('listen_port',$PANEL_PORT))" 2>/dev/null || echo "$PANEL_PORT")"
  FRPS_PORT="$(grep -E '^bindPort' "$INSTALL_DIR/frps.toml" 2>/dev/null | head -1 | tr -dc '0-9' || true)"
  [ -n "$FRPS_PORT" ] || FRPS_PORT=7000
  ok "检测到已有安装，沿用端口：frps=$FRPS_PORT 面板=$PANEL_PORT"
else
  FRPS_PORT="$(pick_port "$FRPS_PORT")"
  PANEL_PORT="$(pick_port "$PANEL_PORT")"
  [ "$PANEL_PORT" = "$FRPS_PORT" ] && PANEL_PORT="$(pick_port $((PANEL_PORT + 1)))"
  ok "选定端口：frps=$FRPS_PORT 面板=$PANEL_PORT"
fi

# ---------------------------------------------------------------- 防火墙
#
# ⚠️ 这里只能处理**本机防火墙**。云厂商的「安全组 / 网络 ACL」在厂商那一侧，
#    服务器内部读不到（没有厂商 API 凭据），所以那一半只能给清单让用户自己去控制台开。
#    但本机这一半能自动做掉，就顺手做掉 —— 少一个让捐献失败的坑。
FW_OPENED=""
FW_RANGES=""
open_fw_port() {
  # 无 root 时直接返回：改不了防火墙，而且 iptables -C 之类的探测会返回非零，
  # 在 set -e 下会把整个脚本打断（实测退出码 4）。这里短路最干净。
  [ "$NO_SYSTEMD" -eq 0 ] || return 0
  local p="$1"
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if ! firewall-cmd --query-port="$p/tcp" >/dev/null 2>&1; then
      firewall-cmd --permanent --add-port="$p/tcp" >/dev/null 2>&1 &&
        firewall-cmd --reload >/dev/null 2>&1 && FW_OPENED="$FW_OPENED $p"
    fi
    return
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
    ufw allow "$p/tcp" >/dev/null 2>&1 && FW_OPENED="$FW_OPENED $p"
    return
  fi
  # 裸 iptables：默认策略是 ACCEPT 就**不动**，避免往用户规则表里塞多余规则
  if command -v iptables >/dev/null 2>&1; then
    if ! iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; then
      if ! iptables -L INPUT -n 2>/dev/null | head -1 | grep -q 'policy ACCEPT'; then
        iptables -I INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null &&
          FW_OPENED="$FW_OPENED $p"
      fi
    fi
  fi
}

# 放行一个端口段 —— 用户隧道的 remote_port 就是在这一段里**真实绑定**的
open_fw_range() {
  # 同 open_fw_port：无 root 时不做任何防火墙操作
  [ "$NO_SYSTEMD" -eq 0 ] || return 0
  local lo="$1" hi="$2"
  [ "$lo" -gt "$hi" ] && return 0
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if ! firewall-cmd --query-port="$lo-$hi/tcp" >/dev/null 2>&1; then
      firewall-cmd --permanent --add-port="$lo-$hi/tcp" >/dev/null 2>&1 &&
        firewall-cmd --reload >/dev/null 2>&1 && FW_RANGES="$FW_RANGES $lo-$hi"
    fi
    return
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
    ufw allow "$lo:$hi/tcp" >/dev/null 2>&1 && FW_RANGES="$FW_RANGES $lo-$hi"
    return
  fi
  if command -v iptables >/dev/null 2>&1; then
    if ! iptables -C INPUT -p tcp --dport "$lo:$hi" -j ACCEPT 2>/dev/null; then
      if ! iptables -L INPUT -n 2>/dev/null | head -1 | grep -q 'policy ACCEPT'; then
        iptables -I INPUT -p tcp --dport "$lo:$hi" -j ACCEPT 2>/dev/null &&
          FW_RANGES="$FW_RANGES $lo-$hi"
      fi
    fi
  fi
}

say "${DIM}检查本机防火墙…${NC}"
if [ "$NO_SYSTEMD" -eq 1 ]; then
  # 非 root 改不了防火墙，别假装做了 —— 明确说清楚，并把它算进"你要自己做的事"
  warn "无 root 权限，跳过本机防火墙配置"
  FW_SKIPPED=1
fi
open_fw_port "$FRPS_PORT"
open_fw_port "$PANEL_PORT"
if [ -n "$FW_OPENED" ]; then
  ok "已在本机防火墙放行：$FW_OPENED（frps 接入 + 面板）"
else
  ok "frps/面板 端口无需改动（未启用，或已放行）"
fi
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ---------------------------------------------------------------- 下载
say "${DIM}下载 frps ${FRPS_VERSION}…${NC}"
TARBALL="frp_${FRPS_VERSION}_linux_${FRP_ARCH}.tar.gz"
# ---------------------------------------------------------------- 下载源
#
# **优先自己的 CDN，GitHub 只作兜底。**
#
# 为什么必须这样：GitHub 的 release 下载走 objects.githubusercontent.com，
# 国内服务器访问它时通时不通（实测同一台机器：网页 200、二进制下载超时）。
# 一次超时用户就装不下去，而他只会以为"是我网络的问题" —— 这种失败最难查。
# 把二进制放自己桶里，整条安装就彻底不依赖 GitHub 了。
#
# 保留 GitHub 兜底是为了 R2 出问题时还有退路，而不是让用户卡死。
URL="${DOULOR_FRPS_URL:-$CDN_BASE/frp/${TARBALL}}"
FALLBACK_URL="https://github.com/fatedier/frp/releases/download/v${FRPS_VERSION}/${TARBALL}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 先试 CDN；失败就把 URL 换成 GitHub 的，让下面那段下载逻辑再跑一次。
# ⚠️ 这段必须放在 TMP 定义之后 —— 它要用 $TMP。我第一次插错了位置，
#    结果 set -u 下报 "TMP: unbound variable"，安装直接中断。
if ! curl -fsSL --connect-timeout 15 --max-time 180 -o "$TMP/$TARBALL" "$URL"; then
  warn "从 CDN 下载失败，回退 GitHub…"
  URL="$FALLBACK_URL"
fi

if ! curl -fsSL --connect-timeout 15 --max-time 300 -o "$TMP/$TARBALL" "$URL"; then
  die "下载 frps 失败（CDN 和 GitHub 都试过了）。若服务器在国内，可能是 GitHub 被墙；请稍后重跑，或联系管理员。"
fi
tar -xzf "$TMP/$TARBALL" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 2 -type f -name frps | head -1)"
[ -n "$SRC" ] || die "压缩包里没找到 frps 可执行文件"
install -m 0755 "$SRC" "$INSTALL_DIR/frps"
ok "frps $( "$INSTALL_DIR/frps" --version 2>/dev/null | head -1 )"

say "${DIM}下载面板…${NC}"
if ! curl -fsSL --connect-timeout 15 --max-time 120 -o "$INSTALL_DIR/panel.py.new" "$PANEL_DL"; then
  die "下载面板失败：$PANEL_DL"
fi
head -c 200 "$INSTALL_DIR/panel.py.new" | grep -q 'python' \
  || die "下载到的面板不是 Python 脚本（可能被网络中间页替换了）"
mv "$INSTALL_DIR/panel.py.new" "$INSTALL_DIR/panel.py"
ok "面板 $( wc -c < "$INSTALL_DIR/panel.py" ) 字节"

# ---------------------------------------------------------------- 配置
# 面板口令/密钥只在首次生成；重跑沿用，避免把已发给管理端的凭据换掉
if [ -f "$INSTALL_DIR/panel.json" ]; then
  ok "沿用已有面板配置"
else
  say "${DIM}生成配置…${NC}"
  python3 - "$INSTALL_DIR" "$IP" "$FRPS_PORT" "$PANEL_PORT" <<'PY'
import json, os, secrets, string, sys

d, ip, frps_port, panel_port = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

def pw(n=24):
    a = string.ascii_letters + string.digits
    return "".join(secrets.choice(a) for _ in range(n))

frps_token = pw(32)
panel_pw = pw(24)
agent_secret = pw(40)

# frps：插件指向本机面板。回环访问，所以面板不用对公网开放插件端点。
with open(os.path.join(d, "frps.toml"), "w") as f:
    f.write(
        "bindPort = %d\n\n"
        "# 仪表盘只监听回环：它自带的鉴权很弱，不能暴露到公网。\n"
        "webServer.addr = \"127.0.0.1\"\n"
        "webServer.port = %d\n"
        "webServer.user = \"admin\"\n"
        "webServer.password = \"%s\"\n\n"
        "auth.method = \"token\"\n"
        "auth.token = \"%s\"\n"
        "# 客户端和服务端都要声明这两个作用域，Ping 心跳才会回调插件 ——\n"
        "# 到期踢人靠的就是它（HeartBeats 的 B 是大写，写错就静默失效）。\n"
        "auth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]\n\n"
        "[[httpPlugins]]\n"
        "name = \"doulor-panel\"\n"
        "addr = \"127.0.0.1:%d\"\n"
        "path = \"/handler\"\n"
        "ops = [\"Login\", \"NewProxy\", \"CloseProxy\", \"Ping\", \"NewWorkConn\", \"NewUserConn\"]\n"
        % (frps_port, panel_port + 100, pw(24), frps_token, panel_port)
    )

cfg = {
    "listen_host": "0.0.0.0",
    "listen_port": panel_port,
    "allow_public_bind": True,
    "data_file": os.path.join(d, "accounts.json"),
    "log_file": os.path.join(d, "panel.log"),
    "user_prefix": "DC_",
    "agent_secret": agent_secret,
    "admin_user": "admin",
    "admin_password": panel_pw,
    "session_secret": pw(40),
    "frps_public_addr": ip,
    "frps_bind_port": frps_port,
    "frps_global_token": frps_token,
    "default_rental_days": 30,
    "default_port_start": 10000,
    "default_port_end": 10010,
    "expiring_soon_days": 3,
    "auto_disable_expired": False,
    "sweep_interval_seconds": 300,
}
p = os.path.join(d, "panel.json")
with open(p, "w") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=1)
os.chmod(p, 0o600)

with open(os.path.join(d, "credentials.txt"), "w") as f:
    f.write("DoulorCloud 代理节点 · 本机凭据\n")
    f.write("面板地址   http://%s:%d\n" % (ip, panel_port))
    f.write("面板用户名 admin\n")
    f.write("面板口令   %s\n" % panel_pw)
    f.write("frps 端口  %d\n" % frps_port)
    f.write("frps token %s\n" % frps_token)
    f.write("agent 密钥 %s\n" % agent_secret)
os.chmod(os.path.join(d, "credentials.txt"), 0o600)
print("已生成 frps.toml / panel.json / credentials.txt")
PY
  ok "配置已生成（凭据在 $INSTALL_DIR/credentials.txt，权限 600）"
  # frps 需要读自己的 token；面板要读 panel.json
  chmod 0600 "$INSTALL_DIR/frps.toml"
fi

FRPS_TOKEN="$(python3 -c "import json;print(json.load(open('$INSTALL_DIR/panel.json'))['frps_global_token'])")"
PANEL_PW="$(python3 -c "import json;print(json.load(open('$INSTALL_DIR/panel.json'))['admin_password'])")"
AGENT_SECRET="$(python3 -c "import json;print(json.load(open('$INSTALL_DIR/panel.json'))['agent_secret'])")"

# ---------------------------------------------------------------- 守护进程
#
# 两种模式共用这一个入口，调用方不用关心自己是不是 root。
#
# 非 root 模式为什么也要"立刻起一次"：后面的自检要求 frps 和面板**正在监听**，
# 没通过就不回报。所以必须先起来再自检，不能等 crontab。
install_daemon() {
  local name="$1" exec_cmd="$2" desc="$3"
  if [ "$NO_SYSTEMD" -eq 0 ]; then
    cat > "/etc/systemd/system/doulor-${name}.service" <<UNIT
[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=${exec_cmd}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable "doulor-${name}.service" >/dev/null 2>&1
    systemctl restart "doulor-${name}.service"
  else
    # 幂等：重跑脚本时不要把已经在跑的再起一个
    if pgrep -f "$exec_cmd" >/dev/null 2>&1; then
      ok "${desc} 已在运行，跳过启动"
    else
      ( cd "$INSTALL_DIR" && nohup bash -c "$exec_cmd" >> "$INSTALL_DIR/${name}.out" 2>&1 & )
    fi
  fi
}

say "${DIM}启动守护进程…${NC}"
install_daemon frps "$INSTALL_DIR/frps -c $INSTALL_DIR/frps.toml" "frps"
install_daemon frp-panel "/usr/bin/env python3 $INSTALL_DIR/panel.py --config $INSTALL_DIR/panel.json" "面板"
if [ "$NO_SYSTEMD" -eq 0 ]; then
  ok "服务已启动并设为开机自启"
else
  ok "进程已启动（无 root 模式）"
fi

# ------------------------------------------------ 无 root 模式：开机自启 + 看门狗
#
# 没有 systemd，就没有"崩了自动重启"。用 crontab 补两件事：
#   · @reboot          开机把三件事拉起来
#   · 每 5 分钟一次     看门狗：哪个进程没了就补上（start-all.sh 本身幂等）
# 少了看门狗的话，frps 半夜崩一次，节点会静默失效到下次人工介入。
if [ "$NO_SYSTEMD" -eq 1 ]; then
  cat > "$INSTALL_DIR/start-all.sh" <<START
#!/usr/bin/env bash
# 拉起所有守护进程。幂等 —— 已经在跑的不动。crontab 每 5 分钟调一次当看门狗。
cd "$INSTALL_DIR" || exit 1
up() { pgrep -f "\$1" >/dev/null 2>&1; }
up "$INSTALL_DIR/frps -c"      || nohup "$INSTALL_DIR/frps" -c "$INSTALL_DIR/frps.toml" >> frps.out 2>&1 &
up "$INSTALL_DIR/panel.py"     || nohup python3 "$INSTALL_DIR/panel.py" --config "$INSTALL_DIR/panel.json" >> panel.out 2>&1 &
# agent 是登记成功之后才装的 —— 第一次跑（或登记失败）时它还不存在，
# 所以这里必须先判存在，否则看门狗会对着一个不存在的文件反复起进程。
if [ -f "$INSTALL_DIR/frp-agent.py" ]; then
  up "$INSTALL_DIR/frp-agent.py" || nohup python3 -u "$INSTALL_DIR/frp-agent.py" --config "$INSTALL_DIR/agent-config.json" >> frp-agent.out 2>&1 &
fi
START
  chmod +x "$INSTALL_DIR/start-all.sh"
  # 先干掉上一次留下的同名条目（重跑时不要越积越多）。
  #
  # ⚠️ `|| true` 不能省：**空的 crontab 时 `crontab -l` 返回非零**，
  #    `grep -v` 没匹配到也返回非零。脚本开头是 set -e（还开了 pipefail），
  #    于是这个子 shell 会在两个 echo **之前**就退出 —— 结果是往 crontab 里
  #    灌了个空管道，看起来"执行了"，实际什么都没写。
  #    而且**只有第一次安装才会踩到**（那时 crontab 是空的），最难发现。
  (
    { crontab -l 2>/dev/null || true; } | { grep -v 'doulor-frp-node/start-all.sh' || true; }
    echo "@reboot $INSTALL_DIR/start-all.sh"
    echo "*/5 * * * * $INSTALL_DIR/start-all.sh"
  ) | crontab - || warn "写入 crontab 失败"
  if crontab -l 2>/dev/null | grep -q 'start-all.sh'; then
    ok "已加入 crontab：开机自启 + 每 5 分钟看门狗"
  else
    warn "写入 crontab 失败 —— 请手动加这两行："
    say "    @reboot $INSTALL_DIR/start-all.sh"
    say "    */5 * * * * $INSTALL_DIR/start-all.sh"
  fi
fi

# ⚠️ 这段**必须放在这里**，不能挪到 agent 安装之后：
#    开机自启是"安装"的基本保证，而 agent 只在**登记成功**之后才装。
#    如果自启依赖登记成功，那么一旦登记失败（令牌过期/网络问题），
#    节点会"看起来装好了"，但重启后就静默消失 —— 没有任何提示。
#    我第一次就是这么放的，在真实机器上用假令牌一测就露出来了。


# ---------------------------------------------------------------- 自检
# 这一段是整条链路的关键：**没通过就不回报**。
# 登记一台没跑起来的节点，只会在后台制造连不上的死节点。
say ""
say "自检中…"
sleep 3

deadline=$(( $(date +%s) + 25 ))
panel_ok=0; frps_ok=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$panel_ok" -eq 0 ]; then
    if curl -fsS --max-time 4 "http://127.0.0.1:$PANEL_PORT/health" 2>/dev/null | grep -q '"ok"'; then
      panel_ok=1; ok "面板 /health 正常"
    fi
  fi
  if [ "$frps_ok" -eq 0 ]; then
    if port_used "$FRPS_PORT"; then frps_ok=1; ok "frps 正在监听 $FRPS_PORT"; fi
  fi
  [ "$panel_ok" -eq 1 ] && [ "$frps_ok" -eq 1 ] && break
  sleep 2
done

if [ "$panel_ok" -ne 1 ]; then
  if [ "$NO_SYSTEMD" -eq 0 ]; then
    systemctl status doulor-frp-panel --no-pager -l 2>&1 | tail -20 >&2 || true
  else
    tail -20 "$INSTALL_DIR/frp-panel.out" >&2 || true
  fi
  die "面板没起来。上面是它的输出。"
fi
if [ "$frps_ok" -ne 1 ]; then
  if [ "$NO_SYSTEMD" -eq 0 ]; then
    systemctl status doulor-frps --no-pager -l 2>&1 | tail -20 >&2 || true
  else
    tail -20 "$INSTALL_DIR/frps.out" >&2 || true
  fi
  die "frps 没在监听 $FRPS_PORT。上面是它的输出。"
fi

# 面板能读到账号文件，才算真的可用（只起进程但数据目录坏掉的情况也要拦住）
curl -fsS --max-time 5 "http://127.0.0.1:$PANEL_PORT/health" | grep -q 'accounts' \
  || die "面板返回的 /health 不含账号信息，数据文件可能有问题"
ok "面板能读到账号数据"

# ---------------------------------------------------------------- 回报
say ""
say "回报 DoulorCloud…"

# ---------------------------------------------------------------- 隧道端口探测
#
# 为什么要探测：用户隧道的 remote_port 是在**这台机器上真实绑定**的。
# 捐献者的机器上往往已经跑着别的东西，一旦撞上，被分到那个端口的用户
# 永远连不上自己的服务 —— 而报错只会出现在用户那边，节点这边看不出问题。
#
# 实测案例：一台机器把 10000-10019 **连续 20 个**端口占满了，
# 而默认套餐段恰好是 10000-10010 —— 全部不可用。
# 只看"第一个端口"是不够的，必须找**连续可用**的一段。
#
# 用 ss 而不是逐个 /dev/tcp 连接：ss 解析只要 15ms，扫 1000 个端口也瞬间完成。
TUN_SCAN_MIN="${DOULOR_TUN_MIN:-10000}"
TUN_SCAN_MAX="${DOULOR_TUN_MAX:-11000}"
NEED_PORTS="${DOULOR_NEED_PORTS:-11}"

BUSY_LIST="$(ss -lntH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -n | uniq || true)"

is_busy() {
  printf '%s\n' "$BUSY_LIST" | grep -qx "$1"
}

TUN_MIN=""; TUN_RUN=0; BEST_MIN=""; BEST_RUN=0
p="$TUN_SCAN_MIN"
while [ "$p" -le "$TUN_SCAN_MAX" ]; do
  if is_busy "$p"; then
    TUN_RUN=0; TUN_MIN=""
  else
    [ -z "$TUN_MIN" ] && TUN_MIN="$p"
    TUN_RUN=$((TUN_RUN + 1))
    if [ "$TUN_RUN" -gt "$BEST_RUN" ]; then
      BEST_RUN="$TUN_RUN"; BEST_MIN="$TUN_MIN"
    fi
  fi
  p=$((p + 1))
done

if [ "$BEST_RUN" -ge "$NEED_PORTS" ]; then
  TUN_PMIN="$BEST_MIN"
  TUN_PMAX=$((BEST_MIN + BEST_RUN - 1))
  ok "隧道端口段：$TUN_PMIN-$TUN_PMAX（连续 $BEST_RUN 个空闲）"
else
  TUN_PMIN=""; TUN_PMAX=""
  warn "在 $TUN_SCAN_MIN-$TUN_SCAN_MAX 里没有连续 $NEED_PORTS 个空闲端口"
  warn "本机会把「无可用端口段」上报，套餐端口需要管理员手工指定"
fi

REPORT="$(python3 - "$IP" "$FRPS_PORT" "$PANEL_PORT" "$FRPS_TOKEN" "$AGENT_SECRET" "$TOKEN" "$TUN_PMIN" "$TUN_PMAX" <<'PY'
import json, sys
ip, frps_port, panel_port, frps_token, agent_secret, token = sys.argv[1:7]
tun_min, tun_max = sys.argv[7], sys.argv[8]
# 把本机**实际可用**的隧道端口段一并上报：服务端会用它来上架套餐，
# 免得给用户分配一个这台机器上已经占用的端口（那会让用户永远连不上，
# 而节点侧看不出任何问题）。
body = {
    "ip": ip,
    "frpsPort": int(frps_port),
    "panelPort": int(panel_port),
    "frpsToken": frps_token,
    "agentSecret": agent_secret,
    "token": token,
}
if tun_min and tun_max:
    body["tunnelPortMin"] = int(tun_min)
    body["tunnelPortMax"] = int(tun_max)
print(json.dumps(body))
PY
)"

HTTP_CODE="$(curl -sS -o /tmp/doulor-report.json -w '%{http_code}' --max-time 25 \
  -X POST "$API_BASE/api/frp/donate/register" \
  -H 'Content-Type: application/json' \
  -d "$REPORT" 2>/dev/null || echo 000)"

if [ "$HTTP_CODE" != "200" ]; then
  warn "回报失败（HTTP $HTTP_CODE）"
  if [ -f /tmp/doulor-report.json ]; then
    cat /tmp/doulor-report.json; say ""
  fi
  say ""
  say "${YEL}节点本机已经跑起来了，但没有登记成功。${NC}"
  say "把下面这段发给管理员，可以手动登记："
  say "  IP=$IP  frps端口=$FRPS_PORT  面板端口=$PANEL_PORT"
  say "  ${DIM}（完整凭据在 $INSTALL_DIR/credentials.txt）${NC}"
  trap - EXIT
  exit 1
fi

ok "回报成功"

# ---------------------------------------------------------------- 装 agent
#
# 为什么需要 agent（而不是让 DoulorCloud 主动推）：
#   实测 Cloudflare Workers 的出站 fetch 打到「裸 IP + 任意端口」会被 Cloudflare
#   接管（返回的是站点本身，不是目标服务），所以**推不过去**。
#   改成节点自己拉：agent 每 20 秒拉一次期望状态，写进本地面板。
#   这条路在站长自己那台机器上已经稳定跑了很久，是**已验证**的方案。
#
# 密钥是**这个节点专属**的（登记响应里的 agentKey）—— 不是全局密钥。
# 用全局密钥的话，任何捐献者都能拉取别的节点的期望状态（那里面有别人的 frp 令牌）。
# ---------------------------------------------------------------- 用户隧道端口段
#
# 这一句对应的是**用户真正连的那个口**。
#   frps 的 bindPort 只是「客户端接入」，而用户隧道的 remote_port 是在
#   **这台服务器上真实绑定**的 —— 这段不开，捐献节点等于没用：
#   用户登得上 frps、面板里也有账号，就是连不到自己的服务。
#
# 段从登记响应里取（就是管理面板里可改的那两个值），取不到用 10000-11000。
# openPortMin/Max 是**服务器要放行的**段（比套餐段宽），由管理面板控制。
# 取不到就退回套餐段，再取不到用 10000-11000。
TUN_MIN=$(python3 -c "
import json
try:
    r = json.load(open('/tmp/doulor-report.json'))
    v = r.get('openPortMin')
    if v is None:
        v = (r.get('plan') or {}).get('portMin')
    print(v if v is not None else 10000)
except Exception:
    print(10000)
" 2>/dev/null || echo 10000)
TUN_MAX=$(python3 -c "
import json
try:
    r = json.load(open('/tmp/doulor-report.json'))
    v = r.get('openPortMax')
    if v is None:
        v = (r.get('plan') or {}).get('portMax')
    print(v if v is not None else 11000)
except Exception:
    print(11000)
" 2>/dev/null || echo 11000)
case "$TUN_MIN" in ''|*[!0-9]*) TUN_MIN=10000 ;; esac
case "$TUN_MAX" in ''|*[!0-9]*) TUN_MAX=11000 ;; esac
[ "$TUN_MAX" -lt "$TUN_MIN" ] && TUN_MAX=$TUN_MIN

say "${DIM}放行用户隧道端口段 $TUN_MIN-$TUN_MAX…${NC}"
open_fw_range "$TUN_MIN" "$TUN_MAX"
if [ -n "$FW_RANGES" ]; then
  ok "已放行隧道端口段：$FW_RANGES"
else
  ok "隧道端口段无需改动（未启用，或已放行）"
fi

say ""
say "安装节点 agent…"

AGENT_DL="$CDN_BASE/install/frp-agent.py"
if ! curl -fsSL --connect-timeout 15 --max-time 120 -o "$INSTALL_DIR/frp-agent.py.new" "$AGENT_DL"; then
  die "下载 agent 失败：$AGENT_DL"
fi
mv "$INSTALL_DIR/frp-agent.py.new" "$INSTALL_DIR/frp-agent.py"

python3 - "$INSTALL_DIR" "$API_BASE" "$PANEL_PORT" <<'PY'
import json, os, sys

d, api_base, panel_port = sys.argv[1], sys.argv[2], int(sys.argv[3])
report_path = "/tmp/doulor-report.json"
if not os.path.exists(report_path):
    raise SystemExit("找不到登记响应，无法生成 agent 配置")

resp = json.load(open(report_path))
node_id = resp.get("nodeIdForAgent")
agent_key = resp.get("agentKey")
if not node_id:
    raise SystemExit("登记响应里缺少 nodeIdForAgent")

# 复用分支（2026-10-17 安全修复 #8 之后）：登记接口对**已登记过的机器**不再回显
# agentKey —— 否则任何人提交别人已登记的 IP 就能拿到那把密钥、冒充该节点。
# 所以这里不能当成错误：agent 配置不重新生成，退出码 0，
# 让外层跳过 agent 安装、**保留机器上原有的 agent 与密钥不动**。
if not agent_key:
    print("注意：该机器此前已登记过，登记响应里不含 agent 密钥（安全策略）。")
    print("      本次跳过 agent 配置生成，机器上原有的 agent 与密钥保持不变。")
    print("      如确实需要重新签发密钥，请联系管理员。")
    # 留一个标记：python 是以子进程方式跑的，SystemExit(0) 只结束 python，
    # 外层的 bash 仍会继续执行到 install_daemon —— 那会把机器上原有的 agent
    # 用一份**没被更新过**的配置重启（虽然配置还在，但重启本身是多余动作，
    # 且若用户删过配置文件就会把一个空转的 agent 装上去）。用标记文件让 bash 显式跳过。
    try:
        open("/tmp/doulor-agent-skip", "w").write("1")
    except OSError:
        pass
    raise SystemExit(0)

cfg = {
    "cloud_base": api_base,
    "node_id": node_id,
    "panel_base": "http://127.0.0.1:%d" % panel_port,
    "user_prefix": "DC_",
    "agent_secret": agent_key,
    "interval_seconds": 20,
    "dry_run": False,
    "timeout_seconds": 20,
    "log_file": os.path.join(d, "agent.log"),
    "state_file": os.path.join(d, "agent-state.json"),
}
p = os.path.join(d, "agent-config.json")
with open(p, "w") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=1)
os.chmod(p, 0o600)
print("agent 配置已生成")
PY

# 复用分支（上面 python 里 raise SystemExit(0) + 标记文件）不安装/不重启 agent：
# 那台机器上原本就有一个跑着的 agent，配置也没变，重启它没有意义。
if [ -f /tmp/doulor-agent-skip ]; then
  rm -f /tmp/doulor-agent-skip
  ok "机器上已有 agent（本次未重新生成配置，保留原样）"
else
  install_daemon frp-agent "/usr/bin/env python3 -u $INSTALL_DIR/frp-agent.py --config $INSTALL_DIR/agent-config.json" "agent"
  sleep 6
fi

if pgrep -f "$INSTALL_DIR/frp-agent.py" >/dev/null 2>&1; then
  ok "agent 已启动（每 20 秒同步一次）"
else
  if [ "$NO_SYSTEMD" -eq 0 ]; then
    warn "agent 没能起来，看日志：journalctl -u doulor-frp-agent -n 30"
  else
    warn "agent 没能起来，看日志：$INSTALL_DIR/frp-agent.out"
  fi
  tail -5 "$INSTALL_DIR/agent.log" 2>/dev/null | sed 's/^/    /' || true
fi

# 最后确认一次 agent 真的在同步：日志里出现「无变更」或「已处理」才算通
if grep -qE '无变更|已处理|回报成功' "$INSTALL_DIR/agent.log" 2>/dev/null; then
  ok "agent 与 DoulorCloud 通信正常"
else
  warn "agent 还没打出同步记录（可能要等下一轮，20 秒后再看 $INSTALL_DIR/agent.log）"
fi

# 登记响应里有 agentKey（凭据），装完就删掉，别留在 /tmp 里
rm -f /tmp/doulor-report.json

say ""
# ---------------------------------------------------------------- 安全组提醒
#
# 本机防火墙我们已经开好了，但**云厂商的安全组在厂商侧，服务器内部读不到**。
# 这里做一次「自己连自己公网 IP」的探测 —— 它**不能证明**安全组是开的
# （很多云的公网 IP 是 NAT 映射，自己连自己会走不到，即所谓 hairpin 失败），
# 但能给出一个方向；说不准的时候就老实说是"测不出来"。
say ""
say "检查外网可达性…"
probe_ok=0
if timeout 6 bash -c "exec 3<>/dev/tcp/$IP/$FRPS_PORT" 2>/dev/null; then
  probe_ok=1
  ok "从本机连 $IP:$FRPS_PORT 成功"
else
  warn "从本机连 $IP:$FRPS_PORT 失败"
fi

if [ "$probe_ok" -eq 0 ]; then
  say ""
  say "${YEL}这一步不代表安全组没开${NC} —— 很多云的公网 IP 是 NAT 映射，"
  say "服务器自己连自己的公网 IP 会走不到（hairpin 失败），这很正常。"
fi

say ""
say "${DIM}────────────────────────────────────────────${NC}"
say "  ${YEL}还需要你在云控制台确认「安全组 / 防火墙」放行这两个端口：${NC}"
say ""
say "    ${GRN}TCP $FRPS_PORT${NC}   ← frps 接入（客户端连这个，必须开）"
say "    ${GRN}TCP $TUN_MIN-$TUN_MAX${NC}   ← 用户隧道端口段（最常被漏掉的一个：不开就连不到自己的服务）"
say "    ${GRN}TCP $PANEL_PORT${NC}   ← 面板管理地址（建议设成只允许你的 IP 访问）"
say ""
say "  阿里云 / 腾讯云 / 华为云：控制台 → 安全组 → 入方向 → 添加规则"
say "  AWS / GCP：安全组 / 防火墙规则 → 入站"
say "${DIM}────────────────────────────────────────────${NC}"
say ""printf '%s========== 捐献成功 ==========%s\n' "$GRN" "$NC"
say "  节点地址   $IP"
say "  frps 端口  $FRPS_PORT"
say "  面板端口  $PANEL_PORT"
say "  面板账号  admin"
say "  面板口令  $PANEL_PW"
say ""
say "  已自动为你上架默认套餐（30 天 / 100 积分 / 端口 10000-10010）"
say "  你可以随时登录面板改端口区间、改口令、看谁在用。"
say ""
say "  ${DIM}凭据也存了一份： $INSTALL_DIR/credentials.txt（权限 600）${NC}"
if [ "$NO_SYSTEMD" -eq 0 ]; then
  say "  ${DIM}卸载： systemctl disable --now doulor-frps doulor-frp-panel doulor-frp-agent && rm -rf $INSTALL_DIR${NC}"
else
  say "  ${DIM}卸载： crontab -l | grep -v start-all.sh | crontab - && pkill -f \"$INSTALL_DIR\" ; rm -rf $INSTALL_DIR${NC}"
fi
say ""

trap - EXIT
exit 0
