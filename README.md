# kimi-codeserver-proxy

**English** | [中文](README.zh-CN.md)

Base-path adapter so the official [Kimi CLI](https://moonshotai.github.io/kimi-cli/) web UI (`kimi web`) works behind a **self-hosted code-server**'s port forwarding — one click in the browser, no manual URL fixing.

```
Your browser
   │  https://code.your-host/proxy/3101/
   ▼
code-server  (port forwarding: /proxy/3101/ -> 127.0.0.1:3101 on the host)
   ▼
kimi-codeserver-proxy   (this project: listens on 3101, forwards + rewrites)
   ▼
kimi web               (official UI, bound to 127.0.0.1:58627, Bearer-token auth)
```

## Why this proxy exists

`kimi web` is a **local-first** web service:

- it only binds loopback (`127.0.0.1:58627`), intended for a local browser;
- it enforces a **DNS-rebinding Host check** — any non-loopback `Host` gets `403`, so even setting `KIMI_CODE_ALLOWED_HOSTS` to allow your code-server domain is not enough for the SPA to load;
- the frontend resources it serves are **root-absolute paths** (`/assets/...`, `/boot.js`, `/favicon.ico`), and its JS derives the REST/WS base from `window.location.origin`.

code-server's port forwarding mounts the service under a **sub-path** — `https://host/proxy/<port>/`. When the browser loads the forwarded address, those `/assets/...` references resolve to `https://host/assets/...` (the host root) instead of `/proxy/<port>/assets/...`, and API/WS calls go to `https://host/api/v1/...` — the SPA never loads.

This project is the adapter in between: **it forwards everything to kimi web and rewrites the served HTML/JS/CSS so every root-absolute reference and the origin derivation are prefixed with `/proxy/<port>/`**, making the UI work out of the box under code-server.

## What else it fixes

1. **DNS-rebinding Host fence.** The proxy rewrites each request's `Host`/`Origin` to the loopback upstream (`127.0.0.1:58627`), satisfying kimi's Host check exactly like a local browser direct-connect — no `KIMI_CODE_ALLOWED_HOSTS` needed. `x-forwarded-*` forwarding traces are stripped.
2. **Frontend origin derivation.** kimi's JS computes the API/WS base from `window.location.origin`; the proxy injects the base path into the bundle's `Wke()` expression (`window.location.origin+"/proxy/3101"`), so `api/v1/...` and `/api/v1/ws` land on the forwarded subtree.
3. **Token authentication.** kimi's token enters the frontend via the URL fragment (`#token=`), then travels up as `Authorization: Bearer` / `kimi-code.bearer.<token>` WS subprotocol. The proxy passes it through verbatim and prints a clickable access URL (token included) on startup / via the `url` service command.

## Quick start

Prerequisites:

- Node.js >= 18
- the `kimi` CLI installed (the proxy can spawn `kimi web` for you; alternatively run kimi yourself)
- a self-hosted code-server with port forwarding configured

### 1. Configure

```bash
cp .env.example .env
# edit .env if needed
```

### 2. Start

```bash
./kimi-service.sh start
# or directly: node proxy.js
```

The proxy listens on `3101` by default. If no kimi web is reachable at `127.0.0.1:58627`, it automatically spawns `kimi web --port 58627 --no-open` reusing the persisted token from `~/.kimi-code/server.token`.

### 3. Forward the port in code-server

Forward host port `3101` in code-server. The forwarding address looks like:

```
https://code.your-host/proxy/3101/
```

Open that address in a browser to enter the Kimi web UI (the `#token=` fragment is carried automatically).

## Service script

```bash
./kimi-service.sh start      # start the proxy (auto-spawns kimi web)
./kimi-service.sh stop       # stop proxy + kimi web
./kimi-service.sh restart    # restart
./kimi-service.sh status     # show proxy / kimi web status
./kimi-service.sh url        # print the code-server access URL (token included)
./kimi-service.sh logs       # tail the proxy log (Ctrl-C to quit)
```

## Configuration

All settings can be provided via environment variables or a `.env` file (`.env` is gitignored — never commit it).

| Variable | Default | Description |
| --- | --- | --- |
| `PROXY_BASE` | `/proxy/3101` | Base path under which the proxy is reached on code-server, i.e. the forwarded subtree |
| `PROXY_PORT` | `3101` | Port the proxy itself listens on |
| `PROXY_UPSTREAM_HOST` | `127.0.0.1` | Host where kimi web is running |
| `PROXY_UPSTREAM_PORT` | `58627` | Port of kimi web |
| `PROXY_SPAWN_KIMI` | `1` | Set to `0` to disable auto-spawning `kimi web` (e.g. when kimi is managed by systemd/pm2) |
| `PROXY_EXTERNAL_HOST` | empty | Set to your code-server hostname to have the scripts print a full clickable access URL |

## How it works

- **HTML/JS/CSS rewriting** is applied only to `200` responses with `content-type` of HTML, JavaScript, CSS or a Web App Manifest. Root-absolute references (`/boot.js`, `/assets/...`, `/favicon.ico`) are prefixed with the base path after the opening quote, in both double-quoted and single-quoted forms, so the rewritten string stays well-formed. CSS `url(/assets/...)` refs are prefixed; `data:` inline URLs are left alone.
- **Lazy-loaded chunks need no rewrite.** Vite's dynamic `import("./chunk.js")` resolves relative to the module URL, so chunks land naturally under the base subtree.
- **Everything else streams through untouched** — binaries, JSON, redirects and error responses are piped without being buffered in memory.
- **Request headers.** `Host`/`Origin` are rewritten to the loopback upstream; hop-by-hop headers and `x-forwarded-*` forwarding traces are stripped; `accept-encoding: identity` is forced so the bytes can be rewritten.
- **WebSocket.** `/api/v1/ws` upgrade headers (including `Sec-WebSocket-Protocol`) are forwarded verbatim, so the token subprotocol handshake works through the base-prefixed subtree.
- **Error safety.** An unreachable upstream returns `502`; client disconnects, RSTs and failed WS upgrades are handled without crashing the process.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` close the listener and terminate a spawned `kimi web`, so no orphan process is left behind.

## Version applicability & resource patching

The proxy performs two kinds of rewriting, with different sensitivities to kimi frontend versions:

1. **Version-agnostic prefix rewriting (HTML/CSS/JS).** Root-absolute asset references are prefixed by plain string substitution. These references are structural, not version-specific, so this part keeps working across kimi versions regardless of bundle hashes.
2. **Bundle-specific JS patch (`Wke()` origin derivation).** To make API/WS calls land on the forwarded subtree, the proxy rewrites the minified expression inside kimi's origin-resolution function. The match targets a specific minified string.

**Verified against: Kimi Code `0.37.2`** — server `server_version: 0.37.2`, frontend bundle `index-yKYHPeXU.js` / `index-DBtc5buz.css`.

**If a future kimi version changes the bundle:** the patch match fails and the proxy prints a WARN on startup (`origin-resolution pattern was not found`) — it never silently ships a broken UI. Then:

1. **Quick workaround:** open the UI with `?kimi_origin=<code-server base URL>` in the address — kimi's frontend natively reads this query parameter and persists it in `sessionStorage`, so API/WS calls reach the right origin without any patch.
2. **Proper fix:** update `WKE_QUOTED` / `WKE_PATCH_RE` in `proxy.js` to match the new minified expression, and add a matching fixture under `tests/fixtures/` so the regression is covered by a test.

Asset filenames with content hashes (`index-*.js`) are never matched by the proxy, so they may change freely between builds.

## Testing

```bash
npm test
```

- `tests/unit/`: rewriting-logic unit tests (HTML/JS/CSS prefixing, the `Wke()` patch, path normalization, request/response header handling).
- `tests/integration/`: end-to-end tests against a mock upstream that reproduces kimi's Host check and token auth — base-prefix rewriting, API auth, byte-identical binary passthrough, Host rewriting and the WebSocket handshake.
- `tests/helpers/`: mock upstream + proxy subprocess launcher.

## License

MIT
