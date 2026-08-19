# kimi-codeserver-proxy

Base-path 适配代理：让 [Kimi CLI](https://moonshotai.github.io/kimi-cli/) 的官方 Web UI（`kimi web`）能在**自部署的 code-server** 的端口转发下正常工作，浏览器里一点即达。

```
你的浏览器
   │  https://code.your-host/proxy/3101/
   ▼
code-server  (端口转发: 把 /proxy/3101/ 转发到本机 127.0.0.1:3101)
   ▼
kimi-codeserver-proxy   (本工程: 监听 3101, 转发 + 重写)
   ▼
kimi web               (官方 UI, 绑定 127.0.0.1:58627, Bearer token 认证)
```

## 背景：为什么要这个代理

`kimi web` 是**本地优先**的 Web 服务：

- 它只绑定 loopback（`127.0.0.1:58627`），默认只给本机浏览器用；
- 它有一个 **DNS-rebinding Host 检查**：任何非 loopback 的 `Host` 都返回 `403`——即便你设了 `KIMI_CODE_ALLOWED_HOSTS` 放行 code-server 域名，SPA 也打不开；
- 它输出的前端资源（HTML/JS/CSS）全部是**根绝对路径**（`/assets/...`、`/favicon.ico`），而 JS 里的 API/WebSocket 地址又从 `window.location.origin` 出发拼 `api/v1/...`。

而 code-server 的端口转发把服务挂载在 `https://host/proxy/<port>/` 这个**子路径**下。于是浏览器打开转发地址后，页面里的 `/assets/...` 被解析到主机根路径，API 请求也打到 `https://host/api/v1/...` 而不是转发子树——整个 SPA 加载不出来。

本工程就是架在两者之间的适配器：**它转发一切到 kimi web，同时改写 HTML/JS/CSS 里的根绝对引用和 origin 推导逻辑，统一加上 `/proxy/<port>/` 前缀**，让 UI 在 code-server 下开箱即用。

## 它还解决的三件事

1. **DNS-rebinding Host 栅栏**。代理把每个请求的 `Host`/`Origin` 改写成 loopback 上游（`127.0.0.1:58627`），绕过 Host 检查，等价于本机浏览器直连，无需 `KIMI_CODE_ALLOWED_HOSTS`。同时剥离 `x-forwarded-*` 转发痕迹。
2. **前端 origin 解析**。Kimi 前端从 `window.location.origin` 推导 API/WS 地址，代理在 JS bundle 的 `Wke()` 函数里注入 base 前缀（`window.location.origin+"/proxy/3101"`），让 `api/v1/...` 和 `/api/v1/ws` 落到转发子树。
3. **token 认证**。kimi 的 token 通过 URL fragment（`#token=`）进入前端，再以 `Authorization: Bearer` 头 / `kimi-code.bearer.<token>` WS subprotocol 上行。代理原样透传，并在启动/`url` 命令时从 `~/.kimi-code/server.token` 读出 token 拼出可点击的访问地址。

## 快速开始

前置要求：

- Node.js >= 18
- 已安装 `kimi` CLI（本代理可以替你拉起 `kimi web`；或者你自己单独起好）
- 一个自部署的 code-server，并配置好端口转发

### 1. 配置

```bash
cp .env.example .env
# 按需编辑 .env
```

### 2. 启动

```bash
./kimi-service.sh start
# 或直接: node proxy.js
```

代理默认监听 `3101`。若上游 `127.0.0.1:58627` 没有 kimi web，它会自动 `spawn` 一个 `kimi web --port 58627 --no-open` 并沿用 `~/.kimi-code/server.token`。

### 3. 在 code-server 里开启端口转发

在 code-server 中把本机端口 `3101` 转发出去，转发地址形如：

```
https://code.your-host/proxy/3101/
```

浏览器打开这个地址即进入 Kimi Web UI（`#token=` 已自动携带）。

## 服务脚本

```bash
./kimi-service.sh start      # 启动 proxy（自动拉起 kimi web）
./kimi-service.sh stop       # 停止 proxy + kimi web
./kimi-service.sh restart    # 重启
./kimi-service.sh status     # 查看 proxy / kimi web 状态
./kimi-service.sh url        # 打印 code-server 下的访问地址（含 token）
./kimi-service.sh logs       # 跟踪 proxy 日志（Ctrl-C 退出）
```

## 配置项

所有配置可通过环境变量或 `.env` 设置（`.env` 已 gitignore，请勿提交）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PROXY_BASE` | `/proxy/3101` | 代理在 code-server 下被访问的 base 路径，即端口转发挂载的子树 |
| `PROXY_PORT` | `3101` | 代理自己监听的端口 |
| `PROXY_UPSTREAM_HOST` | `127.0.0.1` | kimi web 所在主机 |
| `PROXY_UPSTREAM_PORT` | `58627` | kimi web 端口 |
| `PROXY_SPAWN_KIMI` | `1` | 设为 `0` 时不自动拉起 `kimi web`（例如 kimi 由 systemd/pm2 托管） |
| `PROXY_EXTERNAL_HOST` | 空 | 设为 code-server 域名后，脚本会打印完整可点击的访问地址 |

## 工作原理

- **改写 HTML/JS/CSS**：只在 `200` 响应且 `content-type` 为 HTML / JavaScript / CSS 时执行。HTML 里根绝对引用（`/boot.js`、`/assets/...`、`/favicon.ico`）统一加上 base 前缀；JS 里先 patch 掉 origin 推导函数 `Wke()`（注入 `window.location.origin+"<base>"`），再把 4 处根绝对 `/assets/` 引用加前缀；CSS 里 `url(/assets/...)` 加前缀，`data:` 内联不受影响。base 插在开引号之后，双引号、单引号都覆盖，改写后仍是合法 HTML/JS/CSS。
- **懒加载 chunk 无需改写**：Vite 的动态 `import("./chunk.js")` 用相对路径，天然落在 base 子树下。
- **其余响应零缓冲透传**：二进制、JSON API、重定向、错误响应等直接管道转发，不整包缓冲进内存。
- **请求头**：`Host`/`Origin` 改写成 loopback 上游；剥离 `hop-by-hop` 头与 `x-forwarded-*` 转发痕迹；强制 `accept-encoding: identity` 保证可做字节级改写。
- **WebSocket**：`/api/v1/ws` 的 `101` 升级头（含 `Sec-WebSocket-Protocol`）原样透传，token subprotocol 经过 base 子树正常握手。
- **错误安全**：上游失联返回 `502`；客户端中途断连、RST、WS 升级失败都不致代理进程崩溃。
- **优雅退出**：收到 `SIGINT`/`SIGTERM` 时关闭监听并结束由代理拉起的 `kimi web`，不留孤儿进程。

## 测试

```bash
npm test
```

- `tests/unit/`：改写逻辑单元测试（HTML/JS/CSS 前缀、`Wke` patch、路径归一化、请求/响应头）。
- `tests/integration/`：全链路集成测试——以 mock 上游模拟 kimi 的 Host 检查与 token 认证，验证 base 改写、API 鉴权、二进制透传、Host 重写与 WS 握手。
- `tests/helpers/`：mock 上游与 proxy 子进程启动工具。

## 许可

MIT
