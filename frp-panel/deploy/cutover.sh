#!/bin/bash
# DoulorCloud frp 面板 —— 从旧面板（frps-panel）切换到自研面板
#
#   sh deploy/cutover.sh              # 只做预检与演练，不改动任何东西
#   sh deploy/cutover.sh --yes        # 真正执行切换（有秒级插件不可用窗口）
#   sh deploy/cutover.sh --rollback   # 回滚：停新面板、起旧面板
#
# 设计原则：
#   1. **默认不改动任何东西**（dry-run）。要动生产必须显式 --yes。
#   2. 切换前先把账号迁完并**核对数量**，对不上就不切。
#   3. 切换后验证失败 → **自动回滚**，不把服务停在半路。
#   4. 旧面板的 frps-tokens.toml **全程只读**，回滚后数据原样都在。
set -u

NEW_DIR="${NEW_DIR:-/home/frp/frppanel-new}"
OLD_DIR="${OLD_DIR:-/home/frp/frppanel}"
OLD_BIN="${OLD_BIN:-$OLD_DIR/frps-panel}"
OLD_TOML="${OLD_TOML:-$OLD_DIR/frps-tokens.toml}"
OLD_CFG="${OLD_CFG:-$OLD_DIR/frps-panel.toml}"
CONFIG="${CONFIG:-$NEW_DIR/panel.json}"
PORT="${PORT:-7200}"

DO_IT=0
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --yes) DO_IT=1 ;;
    --rollback) ROLLBACK=1; DO_IT=1 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

say()  { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { say "❌ $*"; exit 1; }

health() {
  curl -s --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null
}

count_accounts() {
  # 从 /tokens 数 user 个数（旧面板未授权也能拿到数据，新面板本机可直读）
  curl -s --max-time 8 "http://127.0.0.1:$PORT/tokens" 2>/dev/null | grep -o '"user"' | wc -l
}

stop_old_panel() {
  pkill -f "frps-panel.*frps-panel.toml" 2>/dev/null
  sleep 1
}

start_old_panel() {
  cd "$OLD_DIR" || return 1
  nohup "$OLD_BIN" -c "$OLD_CFG" > /dev/null 2>&1 &
  sleep 2
}

# ---------------------------------------------------------------- 回滚
if [ "$ROLLBACK" = "1" ]; then
  say "=== 回滚：停新面板，起旧面板 ==="
  pkill -f "panel.py --config $CONFIG" 2>/dev/null
  sleep 1
  if ! start_old_panel; then
    fail "旧面板启动失败，请手工处理（旧配置：$OLD_CFG）"
  fi
  N=$(count_accounts)
  say "旧面板账号数: $N"
  [ "$N" -gt 0 ] || fail "旧面板起来了但读不到账号，请检查 $OLD_TOML"
  say "✅ 已回滚到旧面板。旧面板的数据文件全程未被修改，账号原样都在。"
  exit 0
fi

# ---------------------------------------------------------------- 预检
say "=== 1/6 预检 ==="
command -v python3 >/dev/null || fail "没有 python3"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,6) else 1)' || fail "python3 版本低于 3.6"
[ -f "$CONFIG" ] || fail "新面板配置不存在: $CONFIG（先照 README 写一份）"
[ -f "$NEW_DIR/panel.py" ] || fail "新面板程序不存在: $NEW_DIR/panel.py"
[ -f "$OLD_TOML" ] || fail "旧面板数据文件不存在: $OLD_TOML"
say "  python3: $(python3 -V 2>&1)"

HOST=$(python3 -c "import json;print(json.load(open('$CONFIG')).get('listen_host',''))")
[ "$HOST" = "127.0.0.1" ] || fail "配置里的 listen_host=$HOST 不是 127.0.0.1 —— 拒绝继续"

OLD_COUNT=$(grep -c '^\s*\[tokens\.' "$OLD_TOML" 2>/dev/null || echo 0)
say "  旧面板账号段落数: $OLD_COUNT"

# ---------------------------------------------------------------- 迁移
say "=== 2/6 迁移账号（**全部**导入）==="
cd "$NEW_DIR" || fail "进不去 $NEW_DIR"
# ⚠️ 必须 --import-all，这里踩过一次：
#
#   「导入」和「可管理」是两件事：
#     · 导入 = 让插件能认出这个账号 → 必须**全部**导入，
#       否则那 46 个历史用户登录时插件会回「账号不存在」，**全部掉线**。
#     · 可管理 = 自动化能改哪些账号 → 只允许 dcfrp_ 前缀
#       （由 panel.py 的 is_managed() 在 /add /update /remove /enable /disable
#         和 /api/admin/* 上把关，与导入多少账号无关）。
#
#   如果这里只导入 dcfrp_ 前缀，新面板里就只剩 1 个账号，
#   切过去等于把那 46 个历史用户直接踢下线。
MIGRATE_OUT=$(python3 panel.py --config "$CONFIG" --import-legacy "$OLD_TOML" --import-all 2>&1 | tail -1)
say "  $MIGRATE_OUT"

# ---------------------------------------------------------------- 核对
say "=== 3/6 核对迁移结果 ==="
python3 - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
data = json.load(open(cfg["data_file"]))
print("  新面板账号数: %d" % len(data["accounts"]))
for a in data["accounts"]:
    print("    %s  ports=%s  expire=%s" % (a["user"], a["ports"], a.get("expire_at") or "(无)"))
PY

if [ "$DO_IT" = "0" ]; then
  say ""
  say "（dry-run，未改动任何东西）"
  say "确认无误后执行： sh $0 --yes"
  exit 0
fi

# ---------------------------------------------------------------- 切换
say "=== 4/6 切换（旧面板 -> 新面板）==="
OLD_BEFORE=$(count_accounts)
say "  旧面板当前账号数: $OLD_BEFORE"
stop_old_panel
cd "$NEW_DIR"
nohup python3 panel.py --config "$CONFIG" > panel.out 2>&1 &
sleep 3

# ---------------------------------------------------------------- 验证
say "=== 5/6 验证 ==="
H=$(health)
if [ -z "$H" ]; then
  say "新面板没起来，自动回滚"
  pkill -f "panel.py --config $CONFIG" 2>/dev/null
  start_old_panel
  fail "切换失败，已回滚到旧面板"
fi
say "  health: $H"
NEW_COUNT=$(count_accounts)
say "  新面板账号数: $NEW_COUNT（旧面板 $OLD_BEFORE）"

# 🔴 关键校验：新面板的账号数**不得少于**旧面板。
#    少一个就意味着有用户会登录失败（插件查不到账号 → 回「账号不存在」）。
#    这道检查本来就能拦住「迁移时只导入了 dcfrp_ 前缀」那个坑。
if [ "$NEW_COUNT" -lt "$OLD_BEFORE" ]; then
  say "❌ 新面板账号数少于旧面板（$NEW_COUNT < $OLD_BEFORE）—— 会有用户连不上，自动回滚"
  pkill -f "panel.py --config $CONFIG" 2>/dev/null
  start_old_panel
  fail "迁移不完整，已回滚。请检查 $OLD_TOML 是否被完整导入（需要 --import-all）"
fi

say "=== 6/6 判定路径自测 ==="
if [ -f tests/test-plugin-protocol.py ]; then
  python3 tests/test-plugin-protocol.py 2>&1 | tail -3
else
  say "  （跳过：tests/ 不在 $NEW_DIR）"
fi

say ""
say "✅ 切换完成。"
say "   旧面板数据文件未被修改，回滚随时可用： sh $0 --rollback"
say "   注意：$PORT 端口上不应再有残留的旧面板进程 —— 确认一下："
pgrep -af 'frps-panel' || say "   （没有旧面板进程，干净）"
