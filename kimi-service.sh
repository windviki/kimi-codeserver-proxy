#!/usr/bin/env bash
#
# kimi-codeserver-proxy 服务控制脚本
#
#   ./kimi-service.sh start    启动 proxy（会自动拉起 kimi web）
#   ./kimi-service.sh stop     停止 proxy + kimi web
#   ./kimi-service.sh restart  重启
#   ./kimi-service.sh status   查看状态
#   ./kimi-service.sh url      打印 code-server 下的访问地址
#   ./kimi-service.sh logs     跟踪 proxy 日志（Ctrl-C 退出）
#
# 说明：proxy 会自动 spawn `kimi web`（PROXY_SPAWN_KIMI 默认开启），因此本脚本
# 只直接管理 proxy 进程；stop 时 proxy 会带掉它 spawn 的 kimi，脚本再做一次兜底
# 清理，保证两个服务都停止。
#
# 进程托管：start 用 setsid 启动 proxy —— 自建会话/进程组、脱离控制终端与父进程，
# 父 shell 退出或其所在会话被清理时不会被连带杀死（kimi web 是 proxy 的子进程，
# 一并受保护）。start 同时剥掉父环境里残留的 PROXY_* 变量，保证 .env 是本服务
# 唯一配置源。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# ---------- 配置（.env 可覆盖，默认与 proxy.js 一致） ----------
PROXY_PORT=3101
UPSTREAM_PORT=58627
EXTERNAL_HOST=""
BASE="/proxy/$PROXY_PORT"
# 与 proxy.js 的默认值保持一致：默认让 kimi web 关闭自带的 bearer 认证
#（由 code-server 统一认证兜底），UI 不再弹 token 输入框。
KIMI_BYPASS_AUTH=1
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    case "$k" in
      PROXY_PORT)              PROXY_PORT="$v" ;;
      PROXY_UPSTREAM_PORT)     UPSTREAM_PORT="$v" ;;
      PROXY_EXTERNAL_HOST)     EXTERNAL_HOST="$v" ;;
      PROXY_BASE)              BASE="$v" ;;
      PROXY_KIMI_BYPASS_AUTH)  KIMI_BYPASS_AUTH="$v" ;;
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
  if [[ "$KIMI_BYPASS_AUTH" != "0" ]]; then
    # bypass 模式下 UI 不再需要 token（proxy 会自动完成认证注入）
    info "访问地址：https://${EXTERNAL_HOST}${BASE}/"
  elif [[ -n "$tok" ]]; then
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
    # setsid：自建会话/进程组并脱离控制终端，父 shell 退出或其会话被清理时
    # 不会被连带杀死；无 setsid 的环境退化为 nohup（同样屏蔽 SIGHUP）。
    # env -u：剥掉父环境里残留的 PROXY_* 变量（proxy 规定真实环境变量优先于
    # .env，外部注入会把 BASE/PORT/上游端口改乱），保证 .env 是本服务唯一配置源。
    local launcher=(nohup node)
    if command -v setsid >/dev/null 2>&1; then launcher=(setsid nohup node); fi
    env -u PROXY_BASE -u PROXY_PORT -u PROXY_UPSTREAM_HOST \
        -u PROXY_UPSTREAM_PORT -u PROXY_SPAWN_KIMI -u PROXY_KIMI_BYPASS_AUTH \
        -u PROXY_EXTERNAL_HOST \
        "${launcher[@]}" "$SCRIPT_DIR/proxy.js" >>"$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    for _ in {1..90}; do
      is_up "$PROXY_PORT" && break
      sleep 0.5
    done
    is_up "$PROXY_PORT" || die "proxy 未就绪，请查看 $LOG_FILE"
    # setsid 在少数环境（自身已是进程组组长）会 fork 出真正的服务进程，$! 记录的
    # 可能只是中间进程；就绪后用精确 pgrep 把真实 PID 写回，stop 时不会杀错。
    local real
    real="$(proxy_pids | head -1)"
    [[ -n "$real" ]] && echo "$real" > "$PID_FILE"
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
  local pid="" p c
  if [[ -s "$PID_FILE" ]]; then pid="$(cat "$PID_FILE")"; fi
  [[ -z "$pid" ]] && pid="$(proxy_pids | head -1)"

  # 先按父子关系精准停掉 proxy spawn 的 kimi web：正常路径下不依赖 proxy 的退出
  # 处理，proxy 被 SIGKILL 时也不会留下孤儿占着上游端口。注意不要无条件执行
  # `pkill -x kimi-code` —— 交互式 kimi CLI 会话的进程名同样是 kimi-code。
  for p in $(proxy_pids); do
    for c in $(pgrep -P "$p" 2>/dev/null || true); do
      [[ "$(cat "/proc/$c/comm" 2>/dev/null || true)" == "kimi-code" ]] || continue
      kill "$c" 2>/dev/null && info "已停止 kimi web（pid $c）" || true
    done
  done

  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null && info "已向 proxy 发送 SIGTERM" || true
  fi
  rm -f "$PID_FILE"
  # 兜底：只清理精确匹配本工程 proxy.js 的残留进程
  pkill -f "node $SCRIPT_DIR/proxy\.js$" 2>/dev/null && info "已清理残留 proxy" || true

  for _ in {1..20}; do
    ! is_up "$PROXY_PORT" && ! is_up "$UPSTREAM_PORT" && break
    sleep 0.5
  done

  # 上游端口仍被占用 = 有孤儿 kimi web（proxy 未走正常退出路径时）。只杀真正
  # 占用该端口的进程；fuser 不可用时才退回进程名匹配。
  if is_up "$UPSTREAM_PORT"; then
    local holders
    holders="$(fuser -n tcp "$UPSTREAM_PORT" 2>/dev/null | sed 's/^[^:]*://' | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)"
    if [[ -n "$holders" ]]; then
      for c in $holders; do
        kill "$c" 2>/dev/null && info "已清理占用端口 $UPSTREAM_PORT 的残留进程（pid $c）" || true
      done
    else
      pkill -x kimi-code 2>/dev/null && info "已清理残留 kimi web" || true
    fi
  fi
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
