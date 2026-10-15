#!/bin/sh
# DoulorCloud frp 面板 —— 启动脚本
#
# 用法： sh deploy/start.sh /home/frp/frppanel-new/panel.json
#
# 刻意做得很朴素：不加锁、不 fork 守护、不自己实现重启逻辑。
# 常驻交给 systemd（见同目录 frp-panel.service）—— 自己写守护是本不必要的复杂度。
set -e

CONFIG="${1:-/home/frp/frppanel-new/panel.json}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$CONFIG" ]; then
  echo "配置不存在: $CONFIG" >&2
  exit 1
fi

# 先自检配置：防止把 listen_host 写成 0.0.0.0 之后才发现
HOST=$(python3 -c "import json,sys; print(json.load(open('$CONFIG')).get('listen_host','127.0.0.1'))")
if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ] && [ "$HOST" != "::1" ]; then
  echo "拒绝启动：listen_host=$HOST 不是本机地址。" >&2
  echo "这个服务只允许监听 127.0.0.1 —— 暴露到公网等于把全部账号令牌送出去。" >&2
  exit 2
fi

cd "$DIR"
exec python3 panel.py --config "$CONFIG"
