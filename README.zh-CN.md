# kimi-codeserver-proxy

[English](README.md) | **中文**

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
- 它输出的前端资源（HTML/JS/CSS）全部是**根绝对路径**（`/assets/...`、`/boot.js`、`/favicon.ico`），而 JS 里的 API/WebSocket 地址又从 `window.location.origin` 出发拼 `api/v1/...`。

而 code-server 的端口转发把服务挂载在 `https://host/proxy/<port>/` 这个**子路径**下。于是浏览器打开转发地址后，页面里的 `/assets/...` 被解析到主机根路径，API 请求也打到 `https://host/api/v1/...` 而不是转发子树——整个 SPA 加载不出来。

本工程就是架在两者之间的适配器：**它转发一切到 kimi web，同时改写 HTML/JS/CSS 里的根绝对引用和 origin 推导逻辑，统一加上 `/proxy/<port>/` 前缀**，让 UI 在 code-server 下开箱即用。

## 它还解决的几件事

1. **DNS-rebinding Host 栅栏**。代理把每个请求的 `Host`/`Origin` 改写成 loopback 上游（`127.0.0.1:58627`），绕过 Host 检查，等价于本机浏览器直连，无需 `KIMI_CODE_ALLOWED_HOSTS`。同时剥离 `x-forwarded-*` 转发痕迹。
2. **前端 origin 解析**。Kimi 前端从 `window.location.origin` 推导 API/WS 地址，代理在 JS bundle 的 `Wke()` 函数里注入 base 前缀（`window.location.origin+"/proxy/3101"`），让 `api/v1/...` 和 `/api/v1/ws` 落到转发子树。
3. **token 免弹框**。适合前面已有统一认证（code-server 登录）的部署：代理默认以 `kimi web --dangerous-bypass-auth` 拉起上游（kimi 原生支持，专为"自有认证代理之后"的场景设计），UI 不再索要 token；同时代理向页面注入一小段脚本，把 `~/.kimi-code/server.token` 里已知的 token 预写进前端凭证存储——即使 kimi 没开 bypass（例如外部自己拉起的老实例）也不会弹 token 输入框。token 支持用 `PROXY_KIMI_TOKEN` 显式覆盖；设 `PROXY_KIMI_BYPASS_AUTH=0` 可保留 kimi 自身的 bearer 认证（token 预写依旧生效）。
4. **SPA 路由子路径**。选择会话后前端会 `history.pushState` 到根绝对路径（`/sessions/<id>`、`/admin/sessions`、`/devices/<id>`），不加处理的话地址栏会跳出转发子树变成 `https://host/session/...`。代理对 bundle 里的路由常量做前缀改写（构造与解析共用同一组常量，刷新/前进/后退一致），注入的脚本还会兜底修正 `pushState/replaceState`，保证地址始终停在 `/proxy/3101/` 子树下。

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

代理默认监听 `3101`。若上游 `127.0.0.1:58627` 没有 kimi web，它会自动 `spawn` 一个 `kimi web --port 58627 --no-open --dangerous-bypass-auth`（可用 `PROXY_KIMI_BYPASS_AUTH=0` 关闭 bypass）。

### 3. 在 code-server 里开启端口转发

在 code-server 中把本机端口 `3101` 转发出去，转发地址形如：

```
https://code.your-host/proxy/3101/
```

浏览器直接打开这个地址即进入 Kimi Web UI——统一认证由 code-server 负责，无需再手动拼 `#token=`。

> 提示：如果在旧版代理下打开过 UI，浏览器可能缓存了旧的前端 bundle（kimi 对 bundle 标了 immutable），改造后请强制刷新一次（Ctrl+Shift+R）。

## 服务脚本

```bash
./kimi-service.sh start      # 启动 proxy（自动拉起 kimi web）
./kimi-service.sh stop       # 停止 proxy + kimi web
./kimi-service.sh restart    # 重启
./kimi-service.sh status     # 查看 proxy / kimi web 状态
./kimi-service.sh url        # 打印 code-server 下的访问地址
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
| `PROXY_KIMI_BYPASS_AUTH` | `1` | 拉起 kimi web 时附加 `--dangerous-bypass-auth`（kimi 侧免 token，认证交给 code-server）。设为 `0` 保留 kimi 的 bearer 认证 |
| `PROXY_KIMI_TOKEN` | 空 | 显式指定用于前端凭证预写的 token；默认读 `~/.kimi-code/server.token`（kimi 老实例兜底场景） |
| `PROXY_EXTERNAL_HOST` | 空 | 设为 code-server 域名后，脚本会打印完整可点击的访问地址 |

## 工作原理

- **改写 HTML/JS/CSS**：只在 `200` 响应且 `content-type` 为 HTML / JavaScript / CSS / Web App Manifest 时执行。根绝对引用（`/boot.js`、`/assets/...`、`/favicon.ico`）在开引号之后加上 base 前缀，双引号、单引号都覆盖，改写后仍是合法 HTML/JS/CSS；CSS 里 `url(/assets/...)` 加前缀，`data:` 内联不受影响。
- **SPA 路由常量前缀**：JS bundle 里 `"/sessions/"`、`"/admin/sessions"`、`"/devices/"` 三个路由常量（构造与解析共用）被加上 base 前缀；REST 客户端的 `"/sessions"`（无尾斜杠）等服务端路径不受影响。
- **注入客户端引导脚本**：代理自身伺服 `<base>/__kimi-proxy/inject.js`（`no-cache`），并在每个 HTML 页面 `</head>` 前注入引用。脚本先于 bundle 执行：预写 `kimi-web.server-credential` 凭证（应用自身的存储格式，7 天 TTL，每次加载刷新）免 token 弹框，并给 `history.pushState/replaceState` 套一层前缀修正，兜底覆盖路由常量之外的跳转（如关闭会话跳 `"/"`）。
- **懒加载 chunk 无需改写**：Vite 的动态 `import("./chunk.js")` 用相对路径，天然落在 base 子树下。
- **其余响应零缓冲透传**：二进制、JSON API、重定向、错误响应等直接管道转发，不整包缓冲进内存。
- **请求头**：`Host`/`Origin` 改写成 loopback 上游；剥离 `hop-by-hop` 头与 `x-forwarded-*` 转发痕迹；强制 `accept-encoding: identity` 保证可做字节级改写。
- **WebSocket**：`/api/v1/ws` 的 `101` 升级头（含 `Sec-WebSocket-Protocol`）原样透传，token subprotocol 经过 base 子树正常握手。
- **错误安全**：上游失联返回 `502`；客户端中途断连、RST、WS 升级失败都不致代理进程崩溃。
- **优雅退出**：收到 `SIGINT`/`SIGTERM` 时关闭监听并结束由代理拉起的 `kimi web`，不留孤儿进程。

## 版本适用性与资源 patch

代理的改写分几类，对 kimi 前端版本的敏感度不同：

1. **版本无关的通用前缀改写（HTML/CSS/JS）与注入脚本**。根绝对资源引用用纯字符串替换加前缀；客户端引导脚本由代理自己生成，与 bundle 无关。这类引用是结构性写法，不随版本变化。
2. **路由常量值替换（JS）**。`"/sessions/"` 等三个路由常量按"带引号的完整值"匹配——值是语义化的路由路径，跨版本比压缩变量名稳定得多（0.37.2、0.39.1 与 0.41.0 一致）。若某天 kimi 改了路由，深链接恢复会失效，但 URL 修正由注入脚本的 history 兜底，导航本身不会跳出子树。
3. **针对特定 bundle 的 JS patch（`Wke()` origin 推导）**。为了让 API/WS 落到转发子树，代理需要改写 kimi 前端 origin 解析函数里的压缩表达式。这个匹配针对的是某个具体前端构建产出的压缩字符串。

**已验证版本：Kimi Code `0.37.2`、`0.39.1` 与 `0.41.0`**（前端 bundle `index-yKYHPeXU.js` / `index-ClWTW3HX.js` / `index-CiHMlsuo.js`）。0.41.0 只改了被补丁表达式周围的压缩标识符（如 `Wke`→`Yvt`），表达式本身逐字节未变，代理无需任何改动。`--dangerous-bypass-auth` 选项要求 kimi >= 0.39；旧版本代理会自动识别启动失败并退回不带该参数的拉起方式（token 预写仍然生效）。

**如果后续 kimi 版本换了 bundle：** patch 匹配失败时，代理会在日志里打印一次 WARN（warn-once，boot.js 等小文件不再刷屏），**绝不会静默带出一个坏 UI**。此时：

1. **临时兜底**：打开 UI 时在地址上加 `?kimi_origin=<code-server 的 base URL>`——kimi 前端原生读取这个 query 参数并写入 `sessionStorage`，API/WS 请求即打到正确 origin，无需任何 patch。
2. **正式修复**：更新 `proxy.js` 里的 `WKE_QUOTED` / `WKE_PATCH_RE` / `ROUTE_CONSTANTS` 常量以匹配新的产物，并在 `tests/fixtures/` 下补一份对应 fixture，让回归被测试覆盖。

带内容 hash 的资产文件名（`index-*.js`）代理从不匹配，可以随构建自由变化。

## 测试

```bash
npm test
```

- `tests/unit/`：改写逻辑单元测试（HTML/JS/CSS 前缀、`Wke()` patch、路由常量、客户端引导脚本的沙箱执行、路径归一化、请求/响应头）。
- `tests/integration/`：全链路集成测试——以 mock 上游模拟 kimi 的 Host 检查与 token 认证，验证 base 改写、API 鉴权、二进制逐字节透传、Host 重写与 WS 握手。
- `tests/helpers/`：mock 上游与 proxy 子进程启动工具。

## 许可

MIT
