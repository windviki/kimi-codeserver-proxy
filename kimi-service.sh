#!/usr/bin/env bash
#
# kimi-codeserver-proxy 服务控制脚本
#
#   ./kimi-service.sh start    启动 proxy（会自动拉起 kimi web）
#   ./kimi-service.sh stop     停止 proxy + kimi web
#   ./kimi-service.sh restart  重启
#   ./kimi-service.sh status   查看状态
#   ./kimi-service.sh url      打印 code-server 下的访问地址（含 token）
#   ./kimi-service.sh logs     跟踪 proxy 日志（Ctrl-C 退出）
#
# 说明：proxy 会自动 spawn `kimi web`（PROXY_SPAWN_KIMI 默认开启），因此本脚本
# 只直接管理 proxy 进程；stop 时 proxy 会带掉它 spawn 的 kimi，脚本再做一次兜底
# 清理，保证两个服务都停止。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# ---------- 配置（.env 可覆盖，默认与 proxy.js 一致） ----------
PROXY_PORT=3101
UPSTREAM_PORT=58627
EXTERNAL_HOST=""
BASE="/proxy/$PROXY_PORT"
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    case "$k" in
      PROXY_PORT)              PROXY_PORT="$v" ;;
      PROXY_UPSTREAM_PORT)     UPSTREAM_PORT="$v" ;;
      PROXY_EXTERNAL_HOST)     EXTERNAL_HOST="$v" ;;
      PROXY_BASE)              BASE="$v" ;;
    esac
  done < .env
fi
BASE="${BASE%/}"

PID_FILE="$SCRIPT_DIR/.service.pid"
LOG_FILE="$SCRIPT_DIR/proxy.log"
TOKEN_FILE="${HOME}/.kimi-code/server.token"

info() { printf '[kimi-service] %s\n' "$*"; }
die()  { info "错误：$*"; exit 1; }

is_up() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$1/" >/dev/null 2>&1; }

# 用绝对路径精确匹配本工程的 proxy.js，避免与 dsh 等其它 proxy 误匹配
proxy_pids() { pgrep -f "node $SCRIPT_DIR/proxy\.js$" || true; }
# kimi 的进程 comm 是 kimi-code（启动参数不可见），用精确进程名匹配
kimi_pids()  { pgrep -x kimi-code || true; }

# 读取持久 token（kimi 每次启动都会沿用 ~/.kimi-code/server.token）
get_token() { cat "$TOKEN_FILE" 2>/dev/null | tr -d '[:space:]' || true; }

access_url() {
  local tok
  tok="$(get_token)"
  if [[ -z "$EXTERNAL_HOST" ]]; then
    info "未配置 PROXY_EXTERNAL_HOST，无法生成完整地址；本机地址：http://127.0.0.1:${PROXY_PORT}${BASE}/"
    return
  fi
  if [[ -n "$tok" ]]; then
    info "访问地址：https://${EXTERNAL_HOST}${BASE}/#token=${tok}"
  else
    info "访问地址：https://${EXTERNAL_HOST}${BASE}/  （尚未读取到 token，请加 #token=<kimi web token>）"
  fi
}

start() {
  if is_up "$PROXY_PORT"; then
    info "proxy 已在运行（端口 $PROXY_PORT）"
  else
    info "启动 proxy（端口 $PROXY_PORT）…"
    nohup node "$SCRIPT_DIR/proxy.js" >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    for _ in {1..20}; do
      is_up "$PROXY_PORT" && break
      sleep 0.5
    done
    is_up "$PROXY_PORT" || die "proxy 未就绪，请查看 $LOG_FILE"
    info "proxy 就绪（pid $(cat "$PID_FILE")）"
  fi

  if is_up "$UPSTREAM_PORT"; then
    info "kimi web 已在运行（端口 $UPSTREAM_PORT）"
  else
    info "等待 proxy spawn kimi web（端口 $UPSTREAM_PORT）…"
    for _ in {1..40}; do
      is_up "$UPSTREAM_PORT" && break
      sleep 0.5
    done
    if is_up "$UPSTREAM_PORT"; then
      info "kimi web 就绪（端口 $UPSTREAM_PORT）"
    else
      info "kimi web 未就绪，请查看 $LOG_FILE"
    fi
  fi

  access_url
}

stop() {
  info "停止 proxy…"
  if [[ -s "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null && info "已向 proxy 发送 SIGTERM" || true
    rm -f "$PID_FILE"
  fi
  # 兜底：proxy 退出时已 kill 它 spawn 的 kimi；这里清理任何残留进程
  pkill -f "node $SCRIPT_DIR/proxy\.js$" 2>/dev/null && info "已清理残留 proxy" || true
  pkill -x kimi-code 2>/dev/null && info "已清理残留 kimi web" || true

  for _ in {1..20}; do
    ! is_up "$PROXY_PORT" && ! is_up "$UPSTREAM_PORT" && break
    sleep 0.5
  done
  info "已停止"
}

restart() { stop; start; }

status() {
  local pp kp
  pp=$(proxy_pids | tr '\n' ' ')
  kp=$(kimi_pids | tr '\n' ' ')
  printf 'proxy    : %s（端口 %s）\n' "${pp:-未运行}" "$PROXY_PORT"
  printf 'kimi web : %s（端口 %s）\n' "${kp:-未运行}" "$UPSTREAM_PORT"
}

logs() { tail -f "$LOG_FILE"; }

case "${1:-}" in
  start|stop|restart|status|logs) "$1" ;;
  url) access_url ;;
  *) echo "用法: $0 {start|stop|restart|status|url|logs}"; exit 1 ;;
esac
